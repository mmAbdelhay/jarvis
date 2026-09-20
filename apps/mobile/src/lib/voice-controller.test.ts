import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Language } from "./i18n";
import type { RecordingFiles } from "./recording-files";
import type { Credential, Endpoint, RpcError, RpcResult } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import type { SpeakOutcome, Speaker } from "./speaker";
import { REPLY_WAIT_MS, type VoiceControllerDeps, createVoiceController } from "./voice-controller";
import type { MicPermission, VoiceRecorder } from "./voice-recorder";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const CLIENT_STRING = "jarvis-mobile/1.0.0/ios";
const CAPS = ["turn:new", "turns:list", "remote:uploadAudio"];

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function sentFrames(socket: FakeSocket): Record<string, unknown>[] {
  return socket.sent.map((t) => JSON.parse(t) as Record<string, unknown>);
}

function connectAndOpen(
  client: ReturnType<typeof createRpcClient>,
  transport: ReturnType<typeof createFakeTransport>,
  capabilities: string[] = CAPS,
): FakeSocket {
  client.connect(ENDPOINT, CREDENTIAL);
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
  return socket;
}

function answerLatest(socket: FakeSocket, ch: string, value: unknown): void {
  const reqs = sentFrames(socket).filter((m) => m.t === "req" && m.ch === ch);
  const last = reqs[reqs.length - 1] as { id: number } | undefined;
  if (last === undefined) throw new Error(`no ${ch} request found`);
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: last.id, v: value }) });
}

function latestBlob(socket: FakeSocket): { id: number; ch: string; a: unknown[] } {
  const blobs = sentFrames(socket).filter((m) => m.t === "blob");
  const last = blobs[blobs.length - 1] as { id: number; ch: string; a: unknown[] } | undefined;
  if (last === undefined) throw new Error("no blob frame found");
  return last;
}

function findBlobFrame(
  socket: FakeSocket,
  ch: string,
):
  | {
      header: { id: number; ch: string; a: unknown[]; bytes: number; chunks: number };
      binaryCount: number;
    }
  | undefined {
  const frames = socket.frames;
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    if (frame === undefined || frame.kind !== "text") continue;
    const parsed = JSON.parse(frame.text) as Record<string, unknown>;
    if (parsed.t !== "blob" || parsed.ch !== ch) continue;
    let binaryCount = 0;
    for (let j = i + 1; j < frames.length; j++) {
      const next = frames[j];
      if (next === undefined || next.kind !== "binary") break;
      binaryCount += 1;
    }
    return {
      header: parsed as { id: number; ch: string; a: unknown[]; bytes: number; chunks: number },
      binaryCount,
    };
  }
  return undefined;
}

function blobMeta(socket: FakeSocket): Record<string, unknown> {
  return latestBlob(socket).a[0] as Record<string, unknown>;
}

function answerBlob(socket: FakeSocket, value: unknown): void {
  const last = latestBlob(socket);
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: last.id, v: value }) });
}

function errBlob(
  socket: FakeSocket,
  code:
    | "bad-request"
    | "unknown-channel"
    | "forbidden"
    | "internal"
    | "rate-limited"
    | "unsupported",
  text: string,
  language: Language = "en",
): void {
  const last = latestBlob(socket);
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "err", id: last.id, code, text, language }),
  });
}

function makeRandom(seedStart = 1): () => number {
  let seed = seedStart;
  return () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

// --- fakes -------------------------------------------------------------

function createFakeRecorder(clock: ReturnType<typeof createFakeClock>) {
  let permission: MicPermission = "granted";
  let requestPermissionResult: MicPermission = "granted";
  let startShouldFail = false;
  let stopShouldFail = false;
  let recording = false;
  let startedAt = 0;
  let nextUri = 0;
  const calls: string[] = [];

  const recorder: VoiceRecorder = {
    async permission() {
      calls.push("permission");
      return permission;
    },
    async requestPermission() {
      calls.push("requestPermission");
      permission = requestPermissionResult;
      return requestPermissionResult;
    },
    async start() {
      calls.push("start");
      if (startShouldFail) throw new Error("start failed");
      startedAt = clock.now();
      recording = true;
    },
    async stop() {
      calls.push("stop");
      if (stopShouldFail) throw new Error("stop failed");
      if (!recording) return undefined;
      recording = false;
      const durationMs = clock.now() - startedAt;
      nextUri += 1;
      return { uri: `file:///rec-${nextUri}.m4a`, durationMs };
    },
    elapsedMs() {
      return recording ? clock.now() - startedAt : 0;
    },
  };

  return {
    recorder,
    calls,
    setPermission(value: MicPermission): void {
      permission = value;
    },
    setRequestPermissionResult(value: MicPermission): void {
      requestPermissionResult = value;
    },
    setStartShouldFail(value: boolean): void {
      startShouldFail = value;
    },
    setStopShouldFail(value: boolean): void {
      stopShouldFail = value;
    },
  };
}

function createFakeSpeaker() {
  const speakCalls: { text: string; language: Language }[] = [];
  const hasVoiceCalls: Language[] = [];
  let pendingResolve: ((outcome: SpeakOutcome) => void) | undefined;
  let autoResolve = true;
  const voices: Partial<Record<Language, boolean>> = { ar: true, en: true };
  let stopCalls = 0;

  const speaker: Speaker = {
    speak(text: string, language: Language) {
      speakCalls.push({ text, language });
      return new Promise<SpeakOutcome>((resolve) => {
        pendingResolve = resolve;
        if (autoResolve) {
          queueMicrotask(() => {
            if (pendingResolve === resolve) {
              pendingResolve = undefined;
              resolve("done");
            }
          });
        }
      });
    },
    stop() {
      stopCalls += 1;
      if (pendingResolve !== undefined) {
        const resolve = pendingResolve;
        pendingResolve = undefined;
        resolve("stopped");
      }
    },
    async hasVoice(language: Language) {
      hasVoiceCalls.push(language);
      return voices[language] ?? true;
    },
  };

  return {
    speaker,
    speakCalls,
    hasVoiceCalls,
    setAutoResolve(value: boolean): void {
      autoResolve = value;
    },
    setHasVoice(language: Language, value: boolean): void {
      voices[language] = value;
    },
    get stopCalls(): number {
      return stopCalls;
    },
  };
}

function createFakeFiles() {
  const sizes = new Map<string, number | undefined>();
  const removed: string[] = [];
  const readCalls: string[] = [];
  let readShouldFail = false;

  const files: RecordingFiles = {
    async readBase64(uri: string) {
      readCalls.push(uri);
      if (readShouldFail) throw new Error("read failed");
      return "QQ==";
    },
    size(uri: string) {
      return sizes.has(uri) ? sizes.get(uri) : 2_048;
    },
    remove(uri: string) {
      removed.push(uri);
    },
  };

  return {
    files,
    removed,
    readCalls,
    setSize(uri: string, size: number | undefined): void {
      sizes.set(uri, size);
    },
    setReadShouldFail(value: boolean): void {
      readShouldFail = value;
    },
  };
}

function createHarness(overrides: Partial<VoiceControllerDeps> = {}) {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: CLIENT_STRING,
    log: () => {},
  });
  const recorderFake = createFakeRecorder(clock);
  const speakerFake = createFakeSpeaker();
  const filesFake = createFakeFiles();
  const voiceLogs: string[] = [];

  const controller = createVoiceController({
    client,
    clock,
    recorder: recorderFake.recorder,
    speaker: speakerFake.speaker,
    files: filesFake.files,
    random: makeRandom(),
    speakReplies: true,
    log: (line) => voiceLogs.push(line),
    ...overrides,
  });

  return { controller, transport, clock, client, voiceLogs, recorderFake, speakerFake, filesFake };
}

async function recordAndStop(h: ReturnType<typeof createHarness>, ms: number): Promise<void> {
  await h.controller.toggle();
  await flush();
  h.clock.advance(ms);
  void h.controller.toggle();
  await flush();
  // Task 5: RpcClient.upload() paces each chunk to its own scheduled
  // turn — one more clock turn delivers every chunk a short recording
  // needs (a single `advance(0)` drains the whole paced chain; see
  // rpc-client.test.ts's own upload tests for why).
  h.clock.advance(0);
  await flush();
}

// -------------------------------------------------------------------------

describe("voice-controller: brain happy path", () => {
  it("focuses, records, uploads with no targetSessionId, and speaks a matching reply", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();

    const release = h.controller.focus({ kind: "brain" });
    await flush();

    const subFrame = sentFrames(socket).find((m) => m.t === "sub") as
      | { add?: string[] }
      | undefined;
    expect(subFrame?.add).toEqual(["turn:new"]);
    const turnsListReqs = sentFrames(socket).filter((m) => m.t === "req" && m.ch === "turns:list");
    expect(turnsListReqs).toHaveLength(1);
    answerLatest(socket, "turns:list", []);
    await flush();

    await recordAndStop(h, 2_000);

    const blob = findBlobFrame(socket, "remote:uploadAudio");
    expect(blob).toBeDefined();
    const meta = blob?.header.a[0] as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["durationMs", "format", "turnId"]);
    expect(blob?.binaryCount).toBe(blob?.header.chunks);

    answerBlob(socket, { kind: "heard", route: "brain", transcript: "مرحبا", language: "ar" });
    await flush();

    expect(h.controller.get().phase).toBe("waitingReply");
    expect(h.filesFake.removed).toContain("file:///rec-1.m4a");

    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: {
          role: "assistant",
          text: "أهلًا",
          language: "ar",
          at: 1,
          replyTo: meta.turnId,
        },
      }),
    });
    await flush();

    expect(h.speakerFake.speakCalls).toEqual([{ text: "أهلًا", language: "ar" }]);
    expect(h.controller.get().phase).toBe("idle");
    // Fix round item 4: `spokenReplyIds` (distinct from the internal
    // `spoken` gate) records exactly the replies this controller actually
    // started speaking — the Voice transcript's "Spoken · HH:MM" meta line
    // reads this to decide which bubbles get it.
    expect(h.controller.get().spokenReplyIds).toEqual([meta.turnId]);

    release();
  });
});

describe("voice-controller: reply beats the upload result (I1)", () => {
  it("speaks a reply that arrives and merges before the blob's res, then exits to idle", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();

    const release = h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await recordAndStop(h, 2_000);

    const blob = findBlobFrame(socket, "remote:uploadAudio");
    expect(blob).toBeDefined();
    const meta = blob?.header.a[0] as Record<string, unknown>;

    // The laptop's assistant turn:new (fast brain / fast failure path) can
    // beat the upload's own res — exactly I1's ordering. applyTurns merges
    // it into `turns`, but `awaiting` does not have this turnId yet, so it
    // cannot be enqueued at merge time.
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "أهلًا", language: "ar", at: 1, replyTo: meta.turnId },
      }),
    });
    await flush();

    expect(h.speakerFake.speakCalls).toEqual([]);
    expect(h.controller.get().turns.some((t) => t.text === "أهلًا")).toBe(true);

    // Now the blob's own res lands — this is where handleUploadResult must
    // rescan the already-merged turns and enqueue the match.
    answerBlob(socket, { kind: "heard", route: "brain", transcript: "مرحبا", language: "ar" });
    await flush();

    expect(h.speakerFake.speakCalls).toEqual([{ text: "أهلًا", language: "ar" }]);
    expect(h.controller.get().phase).toBe("idle");

    // A duplicate delivery (e.g. from a later turns:list refresh) must not
    // speak it a second time — handleReply still gates on `spoken`.
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 2,
        p: { role: "assistant", text: "أهلًا", language: "ar", at: 1, replyTo: meta.turnId },
      }),
    });
    await flush();
    expect(h.speakerFake.speakCalls).toHaveLength(1);

    release();
  });
});

describe("voice-controller: session target", () => {
  it("uploads with targetSessionId and shows sentToSession without speaking", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "session", sessionId: "s1" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await recordAndStop(h, 2_000);

    const blob = findBlobFrame(socket, "remote:uploadAudio");
    const meta = blob?.header.a[0] as Record<string, unknown>;
    expect(meta.targetSessionId).toBe("s1");

    answerBlob(socket, {
      kind: "heard",
      route: "session",
      sessionId: "s1",
      transcript: "افتح الملف",
      language: "ar",
    });
    await flush();

    expect(h.controller.get().phase).toBe("idle");
    expect(h.controller.get().notice).toEqual({
      code: "sentToSession",
      server: { text: "افتح الملف", language: "ar" },
    });
    expect(h.speakerFake.speakCalls).toEqual([]);
  });
});

describe("voice-controller: offline at stop", () => {
  it("stays notSent across a drop and reconnect, retries only on an explicit tap", async () => {
    const h = createHarness();
    let socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await h.controller.toggle();
    await flush();
    socket.emit({ kind: "close", code: 1006, reason: "" });
    h.clock.advance(1_000);

    void h.controller.toggle(); // stop while offline
    await flush();

    expect(h.controller.get().phase).toBe("notSent");
    expect(findBlobFrame(socket, "remote:uploadAudio")).toBeUndefined();
    expect(h.filesFake.removed).toEqual([]);

    // reconnect
    h.clock.advance(5_000);
    socket = latestSocket(h.transport);
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
    });
    await flush();
    // [bite-proof target: send on onState("open") would produce a blob frame here]
    expect(findBlobFrame(socket, "remote:uploadAudio")).toBeUndefined();
    expect(h.controller.get().phase).toBe("notSent");

    void h.controller.toggle(); // no-op while notSent
    await flush();
    expect(h.recorderFake.calls.filter((c) => c === "start")).toHaveLength(1);

    void h.controller.retry();
    await flush();
    expect(findBlobFrame(socket, "remote:uploadAudio")).toBeDefined();
  });
});

describe("voice-controller: uncertain", () => {
  it("keeps the same turnId across retries and refreshes turns:list once attempt > 1 succeeds", async () => {
    const h = createHarness();
    let socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await h.controller.toggle();
    await flush();
    h.clock.advance(1_000);
    void h.controller.toggle();
    await flush();

    const firstTurnId = blobMeta(socket).turnId;

    socket.emit({ kind: "close", code: 1006, reason: "" }); // drop after the header was sent
    await flush();
    expect(h.controller.get().phase).toBe("uncertain");

    h.clock.advance(5_000);
    socket = latestSocket(h.transport);
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
    });
    await flush();

    void h.controller.retry();
    await flush();

    // [bite-proof: mint a new turnId per attempt] — would fail this equality.
    expect(blobMeta(socket).turnId).toBe(firstTurnId);

    // This is the reconnect's own onState("open") refresh (rule 2), sent
    // while still unanswered above — not the earlier focus() one, which
    // was already answered on the pre-reconnect socket instance.
    answerLatest(socket, "turns:list", []);
    await flush();

    answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "en" });
    await flush();

    const turnsListReqsAfter = sentFrames(socket).filter(
      (m) => m.t === "req" && m.ch === "turns:list",
    );
    expect(turnsListReqsAfter.length).toBeGreaterThan(1);
  });
});

describe("voice-controller: discard", () => {
  it("removes the file and returns to idle", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await h.controller.toggle();
    await flush();
    h.clock.advance(1_000);
    socket.emit({ kind: "close", code: 1006, reason: "" });
    void h.controller.toggle();
    await flush();
    expect(h.controller.get().phase).toBe("notSent");

    h.controller.discard();
    expect(h.controller.get().phase).toBe("idle");
    expect(h.controller.get().notice).toBeUndefined();
    expect(h.filesFake.removed).toContain("file:///rec-1.m4a");
  });
});

describe("voice-controller: duration rules", () => {
  it("too short: no upload, file removed, notice tooShort", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();

    await h.controller.toggle();
    await flush();
    h.clock.advance(300);
    void h.controller.toggle();
    await flush();

    expect(h.controller.get().phase).toBe("idle");
    expect(h.controller.get().notice).toEqual({ code: "tooShort" });
    expect(findBlobFrame(socket, "remote:uploadAudio")).toBeUndefined();
    expect(h.filesFake.removed).toContain("file:///rec-1.m4a");
  });

  it("auto-stops at 120000ms and uploads durationMs 120000 with no second toggle", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();

    await h.controller.toggle();
    await flush();
    // Advance in steps, keeping the connection's watchdog fed with server
    // pings (a real laptop pings every 15s) — a single 120s jump with no
    // frames would trip DEAD_SOCKET_MS and close the socket before the
    // recorder's own 120s cap is reached.
    for (let step = 0; step < 12; step++) {
      h.clock.advance(10_000);
      socket.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: step + 1 }) });
    }
    await flush();

    expect(blobMeta(socket).durationMs).toBe(120_000);
  });
});

describe("voice-controller: size cap", () => {
  it("4194305 bytes -> no upload, notice tooLarge", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();

    await h.controller.toggle();
    await flush();
    h.clock.advance(1_000);
    h.filesFake.setSize("file:///rec-1.m4a", 4_194_305);
    void h.controller.toggle();
    await flush();

    expect(h.controller.get().phase).toBe("idle");
    expect(h.controller.get().notice).toEqual({ code: "tooLarge" });
    expect(findBlobFrame(socket, "remote:uploadAudio")).toBeUndefined();
    expect(h.filesFake.removed).toContain("file:///rec-1.m4a");
  });
});

describe("voice-controller: permissions", () => {
  it("undetermined -> requestPermission called, granted recorded", async () => {
    const h = createHarness();
    connectAndOpen(h.client, h.transport);
    await flush();
    h.recorderFake.setPermission("undetermined");
    h.recorderFake.setRequestPermissionResult("granted");

    await h.controller.toggle();
    await flush();

    expect(h.recorderFake.calls).toContain("requestPermission");
    expect(h.controller.get().permission).toBe("granted");
    expect(h.controller.get().phase).toBe("recording");
  });

  it("denied -> micDenied, recorder.start never called", async () => {
    const h = createHarness();
    connectAndOpen(h.client, h.transport);
    await flush();
    h.recorderFake.setPermission("denied");

    await h.controller.toggle();
    await flush();

    expect(h.controller.get().notice).toEqual({ code: "micDenied" });
    expect(h.controller.get().phase).toBe("idle");
    expect(h.recorderFake.calls).not.toContain("start");
  });

  it("blocked -> micBlocked", async () => {
    const h = createHarness();
    connectAndOpen(h.client, h.transport);
    await flush();
    h.recorderFake.setPermission("blocked");

    await h.controller.toggle();
    await flush();

    expect(h.controller.get().notice).toEqual({ code: "micBlocked" });
    expect(h.recorderFake.calls).not.toContain("start");
  });
});

describe("voice-controller: reply correlation", () => {
  async function toWaitingReply(
    h: ReturnType<typeof createHarness>,
    socket: FakeSocket,
  ): Promise<string> {
    await recordAndStop(h, 2_000);
    const turnId = blobMeta(socket).turnId as string;
    answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "en" });
    return turnId;
  }

  it("an assistant turn with a different (or no) replyTo is merged but never spoken", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await toWaitingReply(h, socket);
    await flush();

    // [bite-proof: speak any assistant turn while waiting]
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "unrelated", language: "en", at: 1 },
      }),
    });
    await flush();

    expect(h.speakerFake.speakCalls).toEqual([]);
    expect(h.controller.get().turns.some((t) => t.text === "unrelated")).toBe(true);
  });

  // Review round 1, Important #2: the test above only ever sends a turn
  // with NO replyTo, which `turn.replyTo !== undefined` already rejects
  // on its own — it can't tell whether the `awaiting.has(turn.replyTo)`
  // gate exists at all. This one sends a well-formed, never-awaited
  // turnId so only that gate can be the thing stopping it.
  it("a different, well-formed replyTo that was never awaited is merged but never spoken [bite-proof: awaiting.has gate]", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await toWaitingReply(h, socket);
    await flush();

    const foreignTurnId = "b".repeat(32); // matches TURN_ID_PATTERN, but this device never sent it
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: {
          role: "assistant",
          text: "not mine",
          language: "en",
          at: 1,
          replyTo: foreignTurnId,
        },
      }),
    });
    await flush();

    expect(h.speakerFake.speakCalls).toEqual([]);
    expect(h.controller.get().turns.some((t) => t.text === "not mine")).toBe(true);
  });

  it("a reply for a turnId that already expired (noReply) is ignored, not spoken", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    const turnId = await toWaitingReply(h, socket);
    await flush();

    h.clock.advance(REPLY_WAIT_MS);
    await flush();
    expect(h.controller.get().notice).toEqual({ code: "noReply" });

    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "late", language: "en", at: 1, replyTo: turnId },
      }),
    });
    await flush();

    expect(h.speakerFake.speakCalls).toEqual([]);
  });

  it("the same reply pushed twice is spoken once", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    const turnId = await toWaitingReply(h, socket);
    await flush();

    const push = encodeMessage({
      t: "psh",
      ch: "turn:new",
      seq: 1,
      p: { role: "assistant", text: "hello", language: "en", at: 1, replyTo: turnId },
    });
    socket.emit({ kind: "message", text: push });
    await flush();
    socket.emit({ kind: "message", text: push });
    await flush();

    expect(h.speakerFake.speakCalls).toHaveLength(1);
  });

  it("reconnecting while waitingReply re-requests turns:list; a reply found there is spoken once", async () => {
    const h = createHarness();
    let socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    const turnId = await toWaitingReply(h, socket);
    await flush();

    socket.emit({ kind: "close", code: 1006, reason: "" });
    h.clock.advance(1_000);
    socket = latestSocket(h.transport);
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
    });
    await flush();

    answerLatest(socket, "turns:list", [
      { role: "assistant", text: "hello", language: "en", at: 5, replyTo: turnId },
    ]);
    await flush();

    expect(h.speakerFake.speakCalls).toHaveLength(1);

    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "hello", language: "en", at: 5, replyTo: turnId },
      }),
    });
    await flush();

    expect(h.speakerFake.speakCalls).toHaveLength(1);
  });

  it("no reply within REPLY_WAIT_MS -> idle, notice noReply", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await toWaitingReply(h, socket);
    await flush();
    expect(h.controller.get().phase).toBe("waitingReply");

    h.clock.advance(REPLY_WAIT_MS);
    await flush();

    expect(h.controller.get().phase).toBe("idle");
    expect(h.controller.get().notice).toEqual({ code: "noReply" });
  });
});

describe("voice-controller: reply overlap (review round 1, Important #1)", () => {
  async function toWaitingReply(
    h: ReturnType<typeof createHarness>,
    socket: FakeSocket,
  ): Promise<string> {
    await recordAndStop(h, 2_000);
    const turnId = blobMeta(socket).turnId as string;
    answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "en" });
    return turnId;
  }

  it(
    "a reply arriving while a second recording is in progress is merged but not spoken, " +
      "and the recorder stays untouched " +
      "[bite-proof: setView({phase:'speaking'}) unconditionally in handleReply]",
    async () => {
      const h = createHarness();
      const socket = connectAndOpen(h.client, h.transport);
      await flush();
      h.controller.focus({ kind: "brain" });
      await flush();
      answerLatest(socket, "turns:list", []);
      await flush();

      const turnId = await toWaitingReply(h, socket);
      await flush();
      expect(h.controller.get().phase).toBe("waitingReply");

      // Rule 3 explicitly allows starting a new recording while waitingReply.
      await h.controller.toggle();
      await flush();
      expect(h.controller.get().phase).toBe("recording");
      const startCallsBefore = h.recorderFake.calls.filter((c) => c === "start").length;
      const stopCallsBefore = h.recorderFake.calls.filter((c) => c === "stop").length;

      socket.emit({
        kind: "message",
        text: encodeMessage({
          t: "psh",
          ch: "turn:new",
          seq: 1,
          p: {
            role: "assistant",
            text: "for the first turn",
            language: "en",
            at: 1,
            replyTo: turnId,
          },
        }),
      });
      await flush();

      expect(h.speakerFake.speakCalls).toEqual([]);
      expect(h.controller.get().phase).toBe("recording");
      expect(h.recorderFake.calls.filter((c) => c === "start").length).toBe(startCallsBefore);
      expect(h.recorderFake.calls.filter((c) => c === "stop").length).toBe(stopCallsBefore);
      expect(h.controller.get().turns.some((t) => t.text === "for the first turn")).toBe(true);
    },
  );

  it(
    "a reply arriving while a second recording is notSent leaves it notSent with pending kept, " +
      "removed only on its own later terminal path " +
      "[bite-proof: setView({phase:'idle'}) unconditionally in handleReply]",
    async () => {
      const h = createHarness();
      const socket = connectAndOpen(h.client, h.transport);
      await flush();
      h.controller.focus({ kind: "brain" });
      await flush();
      answerLatest(socket, "turns:list", []);
      await flush();

      const turnId = await toWaitingReply(h, socket);
      await flush();

      await h.controller.toggle();
      await flush();
      h.clock.advance(1_000);
      socket.emit({ kind: "close", code: 1006, reason: "" });
      void h.controller.toggle();
      await flush();
      expect(h.controller.get().phase).toBe("notSent");
      expect(h.controller.get().canRetry).toBe(true);
      // Turn A's own file (rec-1) was already removed by its successful
      // heard/brain upload inside toWaitingReply(); B's (rec-2) is not.
      expect(h.filesFake.removed).toEqual(["file:///rec-1.m4a"]);

      // Reconnect so the reply push can actually reach the controller —
      // the closed socket instance above is stale (RpcClient bumps its
      // generation on close, and ignores any further event from it), and
      // nothing auto-resends B on reconnect regardless. A new socket is
      // only opened once the backoff timer fires.
      h.clock.advance(5_000);
      const reconnected = latestSocket(h.transport);
      reconnected.emit({ kind: "open" });
      reconnected.emit({
        kind: "message",
        text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
      });
      await flush();
      answerLatest(reconnected, "turns:list", []);
      await flush();
      expect(h.controller.get().phase).toBe("notSent");

      reconnected.emit({
        kind: "message",
        text: encodeMessage({
          t: "psh",
          ch: "turn:new",
          seq: 1,
          p: {
            role: "assistant",
            text: "for the first turn",
            language: "en",
            at: 1,
            replyTo: turnId,
          },
        }),
      });
      await flush();

      expect(h.controller.get().phase).toBe("notSent");
      expect(h.controller.get().canRetry).toBe(true);
      expect(h.filesFake.removed).toEqual(["file:///rec-1.m4a"]);

      h.controller.discard();
      expect(h.controller.get().phase).toBe("idle");
      expect(h.filesFake.removed).toContain("file:///rec-2.m4a");
    },
  );

  it(
    "two turns in flight: the first reply exits to waitingReply (not idle) while the second " +
      "is still awaited [bite-proof: exit straight to idle regardless of awaiting.size]",
    async () => {
      const h = createHarness();
      const socket = connectAndOpen(h.client, h.transport);
      await flush();
      h.controller.focus({ kind: "brain" });
      await flush();
      answerLatest(socket, "turns:list", []);
      await flush();

      const turnA = await toWaitingReply(h, socket);
      await flush();
      expect(h.controller.get().phase).toBe("waitingReply");

      await recordAndStop(h, 2_000);
      const turnB = blobMeta(socket).turnId as string;
      answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "en" });
      await flush();
      expect(h.controller.get().phase).toBe("waitingReply");

      socket.emit({
        kind: "message",
        text: encodeMessage({
          t: "psh",
          ch: "turn:new",
          seq: 1,
          p: { role: "assistant", text: "reply A", language: "en", at: 1, replyTo: turnA },
        }),
      });
      await flush();

      expect(h.speakerFake.speakCalls).toEqual([{ text: "reply A", language: "en" }]);
      expect(h.controller.get().phase).toBe("waitingReply");

      socket.emit({
        kind: "message",
        text: encodeMessage({
          t: "psh",
          ch: "turn:new",
          seq: 2,
          p: { role: "assistant", text: "reply B", language: "en", at: 2, replyTo: turnB },
        }),
      });
      await flush();

      expect(h.speakerFake.speakCalls).toHaveLength(2);
      expect(h.controller.get().phase).toBe("idle");
    },
  );
});

describe("voice-controller: in-flight guard (review round 1, Important #3)", () => {
  it("a double tap on stop() calls the native recorder once and uploads once [bite-proof: no recorderInFlight guard]", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();

    await h.controller.toggle();
    await flush();
    h.clock.advance(1_000);

    const p1 = h.controller.toggle();
    const p2 = h.controller.toggle(); // the "double tap" — no await between calls
    await flush();

    expect(h.recorderFake.calls.filter((c) => c === "stop")).toHaveLength(1);
    const blobHeaders = socket.frames.filter(
      (f) => f.kind === "text" && (JSON.parse(f.text) as { t?: string }).t === "blob",
    );
    expect(blobHeaders).toHaveLength(1);

    // Let the one real send() settle so neither toggle() promise is left
    // dangling at the end of the test.
    answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "en" });
    await Promise.all([p1, p2]);
  });

  it("recorder.stop() rejecting maps to recorderFailed/idle instead of leaving the phase stuck at recording", async () => {
    const h = createHarness();
    connectAndOpen(h.client, h.transport);
    await flush();

    await h.controller.toggle();
    await flush();
    h.recorderFake.setStopShouldFail(true);
    void h.controller.toggle();
    await flush();

    expect(h.controller.get().phase).toBe("idle");
    expect(h.controller.get().notice).toEqual({ code: "recorderFailed" });
  });
});

describe("voice-controller: speaking controls", () => {
  async function toWaitingReply(
    h: ReturnType<typeof createHarness>,
    socket: FakeSocket,
  ): Promise<string> {
    await recordAndStop(h, 2_000);
    const turnId = blobMeta(socket).turnId as string;
    answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "en" });
    return turnId;
  }

  it("setSpeakReplies(false) before the reply -> not spoken, idle", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    const turnId = await toWaitingReply(h, socket);
    await flush();
    h.controller.setSpeakReplies(false);

    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "hi", language: "en", at: 1, replyTo: turnId },
      }),
    });
    await flush();

    expect(h.speakerFake.speakCalls).toEqual([]);
    expect(h.controller.get().phase).toBe("idle");
    // Fix round item 4: never spoken aloud (speakReplies was off), so it
    // never joins spokenReplyIds either.
    expect(h.controller.get().spokenReplyIds).toEqual([]);
  });

  it("hasVoice(ar) false -> not spoken, notice noVoiceAr once across two replies", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();
    h.speakerFake.setHasVoice("ar", false);

    // Review round 1, Minor #4: capture every *transition* into a notice
    // this controller emits so "once" is an actual count of how many
    // times noVoiceAr was set, not a raw tally of every notification
    // where `view.notice` still happens to read noVoiceAr (it stays in
    // the view, unchanged, across unrelated notifications like the
    // elapsed-time ticker until something next overwrites it).
    const noticeCodes: string[] = [];
    let previousCode: string | undefined;
    const unsubscribe = h.controller.subscribe((view) => {
      const code = view.notice?.code;
      if (code !== undefined && code !== previousCode) {
        noticeCodes.push(code);
      }
      previousCode = code;
    });

    const turnId1 = await toWaitingReply(h, socket);
    await flush();
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "مرحبا", language: "ar", at: 1, replyTo: turnId1 },
      }),
    });
    await flush();
    expect(h.controller.get().notice).toEqual({ code: "noVoiceAr" });

    // second recording/reply, same language
    await recordAndStop(h, 2_000);
    const turnId2 = blobMeta(socket).turnId as string;
    answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "ar" });
    await flush();
    expect(h.speakerFake.speakCalls).toEqual([]);

    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 2,
        p: { role: "assistant", text: "أهلا", language: "ar", at: 2, replyTo: turnId2 },
      }),
    });
    await flush();

    expect(h.speakerFake.speakCalls).toEqual([]);
    expect(h.speakerFake.hasVoiceCalls.filter((l) => l === "ar")).toHaveLength(2);
    // [bite-proof: drop the `noticedNoVoice` once-per-language guard and
    // this becomes 2]
    expect(noticeCodes.filter((code) => code === "noVoiceAr")).toHaveLength(1);
    unsubscribe();
  });

  it("appStateChanged(false) while waitingReply, then the reply arrives -> not spoken", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    const turnId = await toWaitingReply(h, socket);
    await flush();

    h.controller.appStateChanged(false);
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "hi", language: "en", at: 1, replyTo: turnId },
      }),
    });
    await flush();

    expect(h.speakerFake.speakCalls).toEqual([]);
  });

  it("toggle() during speaking -> speaker.stop() then recording", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    h.speakerFake.setAutoResolve(false); // hold the speak() promise open
    const turnId = await toWaitingReply(h, socket);
    await flush();
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "hi", language: "en", at: 1, replyTo: turnId },
      }),
    });
    await flush();
    expect(h.controller.get().phase).toBe("speaking");

    void h.controller.toggle();
    await flush();

    expect(h.speakerFake.stopCalls).toBeGreaterThan(0);
    expect(h.controller.get().phase).toBe("recording");
  });
});

describe("voice-controller: backgrounding while recording", () => {
  it("appStateChanged(false) while recording -> notSent, stoppedInBackground, never uploaded", async () => {
    const h = createHarness();
    let socket = connectAndOpen(h.client, h.transport);
    await flush();

    await h.controller.toggle();
    await flush();
    expect(h.controller.get().phase).toBe("recording");

    h.controller.appStateChanged(false);
    await flush();

    expect(h.controller.get().phase).toBe("notSent");
    expect(h.controller.get().notice).toEqual({ code: "stoppedInBackground" });

    h.clock.advance(10 * 60_000);
    socket.emit({ kind: "close", code: 1006, reason: "" });
    h.clock.advance(1_000);
    socket = latestSocket(h.transport);
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
    });
    h.clock.advance(1_000);
    socket.emit({ kind: "close", code: 1006, reason: "" });
    h.clock.advance(1_000);
    socket = latestSocket(h.transport);
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
    });
    await flush();

    expect(findBlobFrame(socket, "remote:uploadAudio")).toBeUndefined();
    expect(h.controller.get().phase).toBe("notSent");
  });
});

describe("voice-controller: laptop errors", () => {
  it("err unknown-channel -> laptopTooOld, file removed", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();

    await recordAndStop(h, 2_000);
    errBlob(socket, "unknown-channel", "no such channel");
    await flush();

    expect(h.controller.get().phase).toBe("idle");
    expect(h.controller.get().notice).toEqual({ code: "laptopTooOld" });
    expect(h.filesFake.removed).toContain("file:///rec-1.m4a");
  });

  it("res busy -> notSent, canRetry", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();

    await recordAndStop(h, 2_000);
    answerBlob(socket, { kind: "busy", text: "already handling a turn", language: "en" });
    await flush();

    expect(h.controller.get().phase).toBe("notSent");
    expect(h.controller.get().canRetry).toBe(true);
  });

  it("res failed -> notice server 'X', file removed", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();

    await recordAndStop(h, 2_000);
    answerBlob(socket, { kind: "failed", text: "X", language: "en" });
    await flush();

    expect(h.controller.get().notice).toEqual({
      code: "server",
      server: { text: "X", language: "en" },
    });
    expect(h.filesFake.removed).toContain("file:///rec-1.m4a");
  });
});

describe("voice-controller: RpcClient busy/cancelled upload outcomes (fix round 2)", () => {
  it(
    "upload() busy (the socket already has another upload in flight — rpc-client.ts's own busy/drain " +
      "latch) -> notSent, notSentBusy, canRetry; never reaches the wire; a retry after the socket frees " +
      "up succeeds [bite-proof: drop the busy case; the switch falls through with no return, `notice` " +
      "stays whatever it was before]",
    async () => {
      const h = createHarness();
      const socket = connectAndOpen(h.client, h.transport);
      await flush();

      // Occupies the socket with an unrelated upload that is deliberately
      // never drained before voice's own attempt below — upload()'s busy
      // check is synchronous, so voice's own call sees it immediately,
      // without ever reaching the wire itself.
      const occupying = h.client.upload("remote:uploadAudio", [{ occupying: true }], "QQ==");
      const occupyingHeader = latestBlob(socket);

      await h.controller.toggle();
      await flush();
      h.clock.advance(2_000);
      void h.controller.toggle();
      await flush();

      expect(h.controller.get().phase).toBe("notSent");
      expect(h.controller.get().notice).toEqual({ code: "notSentBusy" });
      expect(h.controller.get().canRetry).toBe(true);
      // Voice's own upload never reached the wire: only the occupying
      // upload's header was ever sent.
      expect(sentFrames(socket).filter((m) => m.t === "blob")).toHaveLength(1);

      // Free the socket, then retry — this time it goes through normally.
      socket.emit({
        kind: "message",
        text: encodeMessage({ t: "res", id: occupyingHeader.id, v: null }),
      });
      await occupying;

      void h.controller.retry();
      await flush();
      h.clock.advance(0);
      await flush();
      answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "en" });
      await flush();
      expect(h.controller.get().phase).toBe("waitingReply");
    },
  );

  it(
    "upload() cancelled -> notSent, notSentBusy, canRetry; a retry against the real client succeeds " +
      "[bite-proof: drop the cancelled case; the switch falls through with no return]",
    async () => {
      // rpc-client.ts never hands voice a `cancelled()` predicate today
      // (voice-controller.ts's own upload() call has none), so this
      // outcome is exercised directly by wrapping the real client's
      // upload() to force it once — RpcError's union still includes
      // "cancelled", and handleUploadResult's switch must cover every
      // member whether or not the real client can currently produce it.
      // Built by hand (not createHarness()) so the wrapped client can be
      // injected before createVoiceController ever sees it.
      const transport = createFakeTransport();
      const clock = createFakeClock();
      const realClient = createRpcClient({
        transport,
        clock,
        random: () => 0.5,
        client: CLIENT_STRING,
        log: () => {},
      });
      let forced: RpcError | undefined = { kind: "cancelled" };
      const client: typeof realClient = {
        ...realClient,
        upload: (...args) => {
          if (forced !== undefined) {
            const error = forced;
            forced = undefined;
            return Promise.resolve({ ok: false, error } satisfies RpcResult);
          }
          return realClient.upload(...args);
        },
      };
      const recorderFake = createFakeRecorder(clock);
      const speakerFake = createFakeSpeaker();
      const filesFake = createFakeFiles();
      const controller = createVoiceController({
        client,
        clock,
        recorder: recorderFake.recorder,
        speaker: speakerFake.speaker,
        files: filesFake.files,
        random: makeRandom(),
        speakReplies: true,
        log: () => {},
      });
      const h2 = {
        controller,
        transport,
        clock,
        client,
        voiceLogs: [] as string[],
        recorderFake,
        speakerFake,
        filesFake,
      };
      connectAndOpen(h2.client, h2.transport);
      await flush();

      await recordAndStop(h2, 2_000);

      expect(h2.controller.get().phase).toBe("notSent");
      expect(h2.controller.get().notice).toEqual({ code: "notSentBusy" });
      expect(h2.controller.get().canRetry).toBe(true);

      void h2.controller.retry();
      await flush();
      h2.clock.advance(0);
      await flush();
      answerBlob(latestSocket(h2.transport), {
        kind: "heard",
        route: "brain",
        transcript: "hi",
        language: "en",
      });
      await flush();
      expect(h2.controller.get().phase).toBe("waitingReply");
    },
  );
});

describe("voice-controller: subscription lifetime", () => {
  it("blur holds the subscription until the awaited reply resolves, then drops it", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    const release = h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    const turnId = (async () => {
      await recordAndStop(h, 2_000);
      const id = blobMeta(socket).turnId as string;
      answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "en" });
      return id;
    })();
    const id = await turnId;
    await flush();
    expect(h.controller.get().phase).toBe("waitingReply");

    release();
    await flush();

    expect(sentFrames(socket).some((m) => m.t === "sub" && (m as { drop?: string[] }).drop)).toBe(
      false,
    );

    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "hi", language: "en", at: 1, replyTo: id },
      }),
    });
    await flush();

    const dropFrames = sentFrames(socket).filter(
      (m) => m.t === "sub" && (m as { drop?: string[] }).drop?.includes("turn:new"),
    );
    expect(dropFrames).toHaveLength(1);
  });

  it("a second external holder of turn:new prevents any drop frame", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.client.subscribe("turn:new"); // external second holder
    const release = h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    release();
    await flush();

    const dropFrames = sentFrames(socket).filter(
      (m) => m.t === "sub" && (m as { drop?: string[] }).drop?.includes("turn:new"),
    );
    expect(dropFrames).toHaveLength(0);
  });
});

describe("voice-controller: dispose", () => {
  it("stops a live recording, removes its file, and releases handlers", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    const release = h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await h.controller.toggle();
    await flush();
    expect(h.controller.get().phase).toBe("recording");

    h.controller.dispose();
    await flush();

    expect(h.recorderFake.calls).toContain("stop");
    expect(h.filesFake.removed).toContain("file:///rec-1.m4a");

    const dropFrames = sentFrames(socket).filter(
      (m) => m.t === "sub" && (m as { drop?: string[] }).drop?.includes("turn:new"),
    );
    expect(dropFrames).toHaveLength(1);
    release();
  });

  it("isDisposed() is false until dispose(), then true", () => {
    const h = createHarness();
    expect(h.controller.isDisposed()).toBe(false);
    h.controller.dispose();
    expect(h.controller.isDisposed()).toBe(true);
  });

  it(
    "dispose() during readBase64() does not throw and never produces an " +
      "unhandled rejection " +
      "[bite-proof: dereference `pending` unconditionally after readBase64 " +
      "instead of checking disposed/pending; the unhandledRejection spy fires]",
    async () => {
      let resolveRead: (value: string) => void = () => {};
      const readGate = new Promise<string>((resolve) => {
        resolveRead = resolve;
      });
      const h = createHarness({
        files: {
          readBase64: () => readGate,
          size: () => 2_048,
          remove: () => {},
        },
      });
      const socket = connectAndOpen(h.client, h.transport);
      await flush();
      const release = h.controller.focus({ kind: "brain" });
      await flush();
      answerLatest(socket, "turns:list", []);
      await flush();

      await h.controller.toggle(); // start()
      await flush();
      h.clock.advance(2_000);
      const stopPromise = h.controller.toggle(); // stop() -> send() -> parks on readBase64()
      await flush();

      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on("unhandledRejection", onUnhandledRejection);
      try {
        h.controller.dispose(); // clears `pending` unconditionally, mid-readBase64
        resolveRead("QQ==");
        await stopPromise;
        await flush();
        // Give a genuinely unhandled rejection a turn of the microtask
        // queue to surface before asserting none did.
        await new Promise<void>((resolve) => setImmediate(() => resolve()));
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }

      expect(unhandled).toEqual([]);
      release();
    },
  );
});

describe("voice-controller: rule 11 — speakableNow() requires !recorderInFlight", () => {
  it(
    "a reply arriving while start() awaits the mic permission is not spoken, even " +
      "though phase is still idle at that moment " +
      "[bite-proof: drop the !recorderInFlight check from speakableNow(); the reply " +
      "is spoken immediately, into an about-to-open mic]",
    async () => {
      const clock = createFakeClock();
      let recording = false;
      let startedAt = 0;
      let nextUri = 0;
      let permissionGate: Promise<MicPermission> | undefined;
      const recorder: VoiceRecorder = {
        async permission() {
          return (await permissionGate) ?? "granted";
        },
        async requestPermission() {
          return "granted";
        },
        async start() {
          startedAt = clock.now();
          recording = true;
        },
        async stop() {
          if (!recording) return undefined;
          recording = false;
          const durationMs = clock.now() - startedAt;
          nextUri += 1;
          return { uri: `file:///gate-rec-${nextUri}.m4a`, durationMs };
        },
        elapsedMs() {
          return recording ? clock.now() - startedAt : 0;
        },
      };

      const h = createHarness({ clock, recorder });
      const socket = connectAndOpen(h.client, h.transport);
      await flush();
      const release = h.controller.focus({ kind: "brain" });
      await flush();
      answerLatest(socket, "turns:list", []);
      await flush();

      // First turn: a normal record/upload/heard cycle, so `awaiting` has
      // a real entry for the reply below to match against.
      await h.controller.toggle();
      await flush();
      clock.advance(2_000);
      void h.controller.toggle();
      await flush();
      clock.advance(0);
      await flush();
      const turnId = blobMeta(socket).turnId as string;
      answerBlob(socket, { kind: "heard", route: "brain", transcript: "hi", language: "en" });
      await flush();
      expect(h.controller.get().phase).toBe("waitingReply");

      // Rule 3: toggle() may start a second recording while waitingReply.
      // Gate permission() so start() parks mid-await, recorderInFlight
      // still true, phase still "waitingReply"/"idle" (speakableNow()'s
      // phase check alone would say yes).
      let resolvePermission: (value: MicPermission) => void = () => {};
      permissionGate = new Promise((resolve) => {
        resolvePermission = resolve;
      });
      const startPromise = h.controller.toggle();
      await flush();

      // The first turn's reply arrives now, while start() is still
      // awaiting permission() — must not be spoken.
      socket.emit({
        kind: "message",
        text: encodeMessage({
          t: "psh",
          ch: "turn:new",
          seq: 1,
          p: { role: "assistant", text: "hi", language: "en", at: 1, replyTo: turnId },
        }),
      });
      await flush();
      expect(h.speakerFake.speakCalls).toEqual([]);

      resolvePermission("granted");
      await startPromise;
      await flush();
      expect(h.controller.get().phase).toBe("recording");
      // Never spoken, even once the recorder has settled — handleReply
      // already consumed and marked it `spoken` above (the same "consume
      // only" path an overlapping recording always takes).
      expect(h.speakerFake.speakCalls).toEqual([]);

      release();
    },
  );
});

describe("voice-controller: no sensitive data ever logged", () => {
  it("never logs the transcript, the reply text, base64, or a uri", async () => {
    const h = createHarness();
    const socket = connectAndOpen(h.client, h.transport);
    await flush();
    h.controller.focus({ kind: "brain" });
    await flush();
    answerLatest(socket, "turns:list", []);
    await flush();

    await recordAndStop(h, 2_000);
    answerBlob(socket, { kind: "heard", route: "brain", transcript: "مرحبا", language: "ar" });
    await flush();
    const turnId = blobMeta(socket).turnId as string;
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: "turn:new",
        seq: 1,
        p: { role: "assistant", text: "أهلًا", language: "ar", at: 1, replyTo: turnId },
      }),
    });
    await flush();

    const joined = h.voiceLogs.join("\n");
    expect(joined).not.toContain("مرحبا");
    expect(joined).not.toContain("أهلًا");
    expect(joined).not.toContain("QQ==");
    expect(joined).not.toContain("file:///");
  });
});

describe("voice-controller: source scan", () => {
  it("calls .upload( exactly once", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "voice-controller.ts"), "utf8");
    const matches = source.match(/\.upload\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });
});
