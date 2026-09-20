// M8 Task 9's phone-side end-to-end scenario, in the style of
// e2e-session.test.ts: the real `createRpcClient` and `createVoiceController`
// over a `FakeTransport`/fake clock, with only the native-adjacent edges
// (recorder, speaker, recording files) faked. One flowing scenario —
// record, upload, hear a reply, drop mid-upload, reconnect without replay,
// retry, and release — rather than one `it` per rule.
import { PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./lib/clock";
import type { FakeSocket } from "./lib/fake-transport";
import { createFakeTransport } from "./lib/fake-transport";
import type { Language } from "./lib/i18n";
import type { RecordingFiles } from "./lib/recording-files";
import type { Credential, Endpoint } from "./lib/rpc-client";
import { createRpcClient } from "./lib/rpc-client";
import type { SpeakOutcome, Speaker } from "./lib/speaker";
import { createVoiceController } from "./lib/voice-controller";
import type { MicPermission, Recording, VoiceRecorder } from "./lib/voice-recorder";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const CLIENT_STRING = "jarvis-mobile/1.0.0/ios";
const CAPS = ["turn:new", "turns:list", "remote:uploadAudio"];
// The fake recording file's fixed content — its decoded length (1 byte) is
// what the blob header's own `bytes`/`chunks` are checked against below.
const FILE_BASE64 = "QQ==";

type Frame = {
  t: string;
  id?: number;
  ch?: string;
  a?: unknown[];
  add?: unknown[];
  drop?: unknown[];
  bytes?: number;
  chunks?: number;
};

function frames(socket: FakeSocket): Frame[] {
  return socket.sent.map((text) => JSON.parse(text) as Frame);
}

/** The index, *within `socket.frames`* (text and binary interleaved — see
 *  fake-transport.ts), of the last text frame whose parsed JSON is a `blob`
 *  header. Indexing into `socket.frames` with an index computed over
 *  `frames(socket)` (= `socket.sent`, text only) is only safe when no
 *  binary frame precedes the header on that socket — true by accident for
 *  the first recording below, but not guaranteed in general (review Minor
 *  6). This walks `socket.frames` directly instead. */
function lastBlobFrameIndex(socket: FakeSocket): number {
  return socket.frames.findLastIndex(
    (f) => f.kind === "text" && (JSON.parse(f.text) as Frame).t === "blob",
  );
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function lastMatching(socket: FakeSocket, predicate: (f: Frame) => boolean): Frame {
  const found = frames(socket).filter(predicate).at(-1);
  if (found === undefined) throw new Error("no matching frame found");
  return found;
}

function answer(socket: FakeSocket, ch: string, value: unknown): void {
  const req = lastMatching(socket, (f) => f.t === "req" && f.ch === ch);
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "res", id: req.id as number, v: value }),
  });
}

function latestBlob(socket: FakeSocket): { id: number; ch: string; a: unknown[] } {
  const blob = lastMatching(socket, (f) => f.t === "blob");
  return blob as { id: number; ch: string; a: unknown[] };
}

function answerBlob(socket: FakeSocket, value: unknown): void {
  const blob = latestBlob(socket);
  socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: blob.id, v: value }) });
}

function push(socket: FakeSocket, seq: number, payload: unknown): void {
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "psh", ch: "turn:new", seq, p: payload }),
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

/** A deterministic LCG, not a constant — newTurnId() draws 32 values per
 *  call, so a fixed `() => 0.5` would mint the same turnId for every
 *  recording in this scenario. */
function makeRandom(seedStart = 1): () => number {
  let seed = seedStart;
  return () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
}

// --- fakes: recorder, speaker, files ------------------------------------

function createFakeRecorder(clock: ReturnType<typeof createFakeClock>): VoiceRecorder {
  let recording = false;
  let startedAt = 0;
  let nextUri = 0;
  return {
    async permission() {
      return "granted" as MicPermission;
    },
    async requestPermission() {
      return "granted" as MicPermission;
    },
    async start() {
      startedAt = clock.now();
      recording = true;
    },
    async stop(): Promise<Recording | undefined> {
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
}

function createFakeSpeaker(): {
  speaker: Speaker;
  speakCalls: { text: string; language: Language }[];
} {
  const speakCalls: { text: string; language: Language }[] = [];
  const speaker: Speaker = {
    speak(text: string, language: Language) {
      speakCalls.push({ text, language });
      return Promise.resolve<SpeakOutcome>("done");
    },
    stop() {},
    async hasVoice() {
      return true;
    },
  };
  return { speaker, speakCalls };
}

function createFakeFiles(): { files: RecordingFiles; removed: string[] } {
  const removed: string[] = [];
  const files: RecordingFiles = {
    async readBase64() {
      return FILE_BASE64;
    },
    size() {
      return 2_048;
    },
    remove(uri: string) {
      removed.push(uri);
    },
  };
  return { files, removed };
}

describe("voice scenario over the real client and controller", () => {
  it(
    "records, uploads, hears a spoken reply, survives a mid-upload drop without " +
      "replay, retries onto the same turn, and releases cleanly",
    async () => {
      const transport = createFakeTransport();
      const clock = createFakeClock();
      const logs: string[] = [];
      const speakerFake = createFakeSpeaker();
      const filesFake = createFakeFiles();

      const client = createRpcClient({
        transport,
        clock,
        random: () => 0.5,
        client: CLIENT_STRING,
        log: (line) => logs.push(line),
      });
      const controller = createVoiceController({
        client,
        clock,
        recorder: createFakeRecorder(clock),
        speaker: speakerFake.speaker,
        files: filesFake.files,
        random: makeRandom(),
        speakReplies: true,
        log: (line) => logs.push(line),
      });

      // 1. connect -> hello. welcome -> open.
      client.connect(ENDPOINT, CREDENTIAL);
      let socket = latestSocket(transport);
      socket.emit({ kind: "open" });
      expect(frames(socket)[0]).toMatchObject({
        t: "hello",
        v: PROTOCOL_VERSION,
        deviceId: CREDENTIAL.deviceId,
        token: CREDENTIAL.token,
      });
      socket.emit({
        kind: "message",
        text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
      });
      expect(client.state()).toBe("open");

      // 2. focus(brain) -> sub add [turn:new] and req turns:list (answered []).
      const release = controller.focus({ kind: "brain" });
      await flush();
      expect(frames(socket).find((f) => f.t === "sub")?.add).toEqual(["turn:new"]);
      const firstTurnsList = lastMatching(socket, (f) => f.t === "req" && f.ch === "turns:list");
      expect(firstTurnsList).toBeDefined();
      answer(socket, "turns:list", []);
      await flush();

      // 3. toggle, advance 3000ms, toggle -> a blob header followed by one
      // binary frame whose base64 equals the fake file's.
      await controller.toggle();
      await flush();
      clock.advance(3_000);
      void controller.toggle();
      await flush();
      // Task 5: RpcClient.upload() now paces each chunk to its own
      // scheduled turn rather than sending it synchronously — this single
      // recording is one chunk, so one more clock turn delivers it.
      clock.advance(0);
      await flush();

      const blobIndex = lastBlobFrameIndex(socket);
      expect(blobIndex).toBeGreaterThanOrEqual(0);
      const blobFrame = socket.frames[blobIndex] as { kind: "text"; text: string };
      const blobHeader = JSON.parse(blobFrame.text) as Frame & {
        bytes: number;
        chunks: number;
        a: [Record<string, unknown>];
      };
      expect(blobHeader.ch).toBe("remote:uploadAudio");
      expect(blobHeader.bytes).toBe(1); // "QQ==" decodes to exactly one byte
      expect(blobHeader.chunks).toBe(1);
      expect(socket.frames[blobIndex + 1]).toEqual({ kind: "binary", base64: FILE_BASE64 });
      expect(socket.frames.slice(blobIndex + 2).some((f) => f.kind === "binary")).toBe(false);
      const turnIdFirst = blobHeader.a[0].turnId as string;
      expect(typeof turnIdFirst).toBe("string");

      // 4. res heard/brain -> waitingReply.
      answerBlob(socket, {
        kind: "heard",
        route: "brain",
        transcript: "open acme",
        language: "en",
      });
      await flush();
      expect(controller.get().phase).toBe("waitingReply");

      // 5. a user turn with the same replyTo is merged but never spoken; the
      // matching assistant reply is spoken once and returns the controller
      // to idle.
      push(socket, 1, {
        role: "user",
        text: "open acme",
        language: "en",
        at: 1,
        replyTo: turnIdFirst,
      });
      await flush();
      expect(speakerFake.speakCalls).toEqual([]);
      // Exactly one — not `.some(...)` (review Important 1): a duplicate
      // merge (the push applied twice, or merged alongside a second local
      // copy) would show two user bubbles and still pass an existence
      // check. `.filter(...).toHaveLength(1)` is what "merged" actually
      // pins. [bite-proof: verified by hand — pushing this same frame a
      // second time with a different `at` (mergeTurns dedupes on
      // `(role, at, text, replyTo)`, so an identical `at` would collapse
      // back to one entry and prove nothing) makes this assertion fail
      // with "expected 2 to be 1"; reverted before committing.]
      expect(
        controller.get().turns.filter((t) => t.role === "user" && t.replyTo === turnIdFirst),
      ).toHaveLength(1);

      push(socket, 2, {
        role: "assistant",
        text: "Opening acme.",
        language: "en",
        at: 2,
        replyTo: turnIdFirst,
      });
      await flush();
      expect(speakerFake.speakCalls).toEqual([{ text: "Opening acme.", language: "en" }]);
      expect(controller.get().phase).toBe("idle");

      // 6. a second recording: the socket drops between the header and the
      // res -> uncertain. After the reconnect, the first client frame is a
      // sub for turn:new, then req turns:list — and no blob/binary frame
      // appears until retry().
      await controller.toggle();
      await flush();
      clock.advance(3_000);
      void controller.toggle();
      await flush();

      const secondBlobIndex = lastBlobFrameIndex(socket);
      expect(secondBlobIndex).toBeGreaterThan(blobIndex);
      const secondBlobFrame = socket.frames[secondBlobIndex] as { kind: "text"; text: string };
      const secondBlobHeader = JSON.parse(secondBlobFrame.text) as Frame & {
        a: [Record<string, unknown>];
      };
      const turnIdSecond = secondBlobHeader.a[0].turnId as string;
      expect(turnIdSecond).not.toBe(turnIdFirst);

      socket.emit({ kind: "close", code: 1006, reason: "" });
      await flush();
      expect(controller.get().phase).toBe("uncertain");

      clock.advance(1_000);
      // A real new socket, not the closed one `latestSocket` would silently
      // keep returning if no reconnect happened (review Minor 4).
      expect(transport.sockets).toHaveLength(2);
      socket = latestSocket(transport);
      socket.emit({ kind: "open" });
      expect(frames(socket)[0]?.t).toBe("hello");
      socket.emit({
        kind: "message",
        text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: CAPS }),
      });
      await flush();
      const framesAfterHello = frames(socket);
      expect(framesAfterHello[1]).toMatchObject({ t: "sub", add: ["turn:new"] });
      expect(framesAfterHello[2]).toMatchObject({ t: "req", ch: "turns:list" });
      expect(frames(socket).some((f) => f.t === "blob")).toBe(false);
      expect(socket.frames.some((f) => f.kind === "binary")).toBe(false);
      expect(controller.get().phase).toBe("uncertain");

      // 7. retry() -> a blob header whose a[0].turnId equals the first
      // attempt's (this recording's own, minted at stop() time). Answering
      // it re-requests turns:list (attempt > 1); the reply it contains is
      // spoken once, and a later push of the same turn is not spoken again.
      void controller.retry();
      await flush();
      const retryBlob = latestBlob(socket);
      expect((retryBlob.a[0] as Record<string, unknown>).turnId).toBe(turnIdSecond);

      answerBlob(socket, {
        kind: "heard",
        route: "brain",
        transcript: "open acme",
        language: "en",
      });
      await flush();
      const turnsListAfterRetry = frames(socket).filter(
        (f) => f.t === "req" && f.ch === "turns:list",
      );
      expect(turnsListAfterRetry.length).toBeGreaterThan(1);

      answer(socket, "turns:list", [
        { role: "assistant", text: "Opening acme.", language: "en", at: 3, replyTo: turnIdSecond },
      ]);
      await flush();
      expect(speakerFake.speakCalls).toHaveLength(2);

      push(socket, 3, {
        role: "assistant",
        text: "Opening acme.",
        language: "en",
        at: 3,
        replyTo: turnIdSecond,
      });
      await flush();
      expect(speakerFake.speakCalls).toHaveLength(2); // not spoken again

      // 8. focus released, no reply awaited -> sub drop [turn:new].
      release();
      await flush();
      const dropFrames = frames(socket).filter(
        (f) => f.t === "sub" && f.drop?.includes("turn:new"),
      );
      expect(dropFrames).toHaveLength(1);

      // 9. across the whole scenario, the log never carries the token, the
      // spoken reply text, or the uploaded base64.
      const joined = logs.join("\n");
      for (const secret of [CREDENTIAL.token, "Opening acme.", FILE_BASE64]) {
        expect(joined).not.toContain(secret);
      }
    },
  );
});
