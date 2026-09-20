// M8 Task 9's laptop-side end-to-end scenario: a real `createConnection`
// (@jarvis/remote) over an injected `SocketLike` double, wired to a real
// `createDispatchTable` and a real `createBlobTable({ uploadAudio:
// createVoiceUploadHandler(...) })`, whose `utterance` dep is the real
// `handleUtterance` (voice-turn.ts). Only four things are fake: the socket
// itself, the transcoder (a plain file copy — the ffmpeg.skipIf block below
// swaps in the real one), whisper (a fixed transcribe result) and the
// brain (a recording orchestrator). Everything else — argument validation,
// the blob framing, the replay memory, the mkdtemp/write/remove lifecycle,
// per-turn muting, the desktop-only policy gate — is production code.
//
// `createConnection` is not exported from `@jarvis/remote`'s package root by
// default (every other top-level factory there is); this file's own
// existence is why it now is — see index.ts's comment on that export.
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CLOSE,
  createConnection,
  PROTOCOL_VERSION,
  type AuthenticatedDevice,
  type SocketLike,
} from "@jarvis/remote";
import { runCommandWithLimits, transcodeToWhisperWavCommand } from "@jarvis/platform";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDispatchTable, type DispatchTable } from "./dispatch.js";
import { fakeDeps } from "./dispatch.test.js";
import { remoteRequestHandler } from "./remote-access.js";
import { blobLimitOf, createBlobTable, type BlobTable } from "./remote-blob.js";
import {
  remoteKeyAuthorizer,
  remotePushPolicies,
  type StreamOwners,
} from "./remote-push-policy.js";
import { MESSAGES } from "./messages.js";
import { TRANSCODE_TIMEOUT_MS, TRANSCRIBE_TIMEOUT_MS } from "./voice-upload.js";
import { createVoiceUploadHandler, type VoiceUploadDeps } from "./voice-upload.js";
import type { UtteranceDeps } from "./voice-turn.js";
import { handleUtterance } from "./voice-turn.js";

const DEVICE: AuthenticatedDevice = { id: "d".repeat(32), name: "Phone" };
const TOKEN = "t".repeat(43);
const SOURCE = "10.0.0.5:1";

/** Mirrors packages/remote/src/socket-double.ts (not exported from
 *  @jarvis/remote's package root) — the same pattern remote-flood.test.ts
 *  already uses for a piece of the bridge internals a desktop test needs. */
class FakeSocket implements SocketLike {
  sent: Record<string, unknown>[] = [];
  closed: { code: number; reason: string } | undefined;
  terminated = false;
  bufferedAmount = 0;
  send(text: string): void {
    this.sent.push(JSON.parse(text) as Record<string, unknown>);
  }
  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
}

function helloFrame(deviceId: string, token: string): string {
  return JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, deviceId, token, client: "test/1.0" });
}
function reqFrame(id: number, ch: string, a: unknown[] = []): string {
  return JSON.stringify({ t: "req", id, ch, a });
}
function blobFrame(id: number, ch: string, bytes: number, chunks: number, a: unknown[]): string {
  return JSON.stringify({ t: "blob", id, ch, a, bytes, chunks });
}

/** A real 12-byte ftyp/M4A header (isMp4Audio only ever reads bytes 4-11)
 *  followed by filler bytes — the exact shape voice-upload.test.ts's own
 *  m4aBytes() uses. */
function m4aBytes(length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(Buffer.from("ftyp", "latin1"), 4);
  bytes.set(Buffer.from("M4A ", "latin1"), 8);
  return bytes;
}

/** Waits for a condition backed by real I/O (real mkdtemp/writeFile/rm, real
 *  ffmpeg in the skipIf block) rather than a fake clock — this file's own
 *  "everything real except the socket, the transcoder, whisper and the
 *  brain" scope means there is no fake timer to advance through the async
 *  chain a completed blob triggers. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function resFor(socket: FakeSocket, id: number): Record<string, unknown> | undefined {
  return socket.sent.find((m) => m.t === "res" && m.id === id);
}
function errFor(socket: FakeSocket, id: number): Record<string, unknown> | undefined {
  return socket.sent.find((m) => m.t === "err" && m.id === id);
}

type OrchestratorCall = { text: string; language: string; options: unknown };
type BroadcastCall = { channel: string; payload: unknown };
type SessionWrite = { id: string; data: string };

/** Assembles one full, real connection -> dispatch -> blob-table stack, its
 *  only fake being `transcode` — the harness's caller supplies either a
 *  bytes-copying fake or the real ffmpeg-backed one. */
function buildHarness(transcode: VoiceUploadDeps["transcode"], tempRoot: string) {
  const orchestratorCalls: OrchestratorCall[] = [];
  const broadcastCalls: BroadcastCall[] = [];
  const sessionWrites: SessionWrite[] = [];
  const uploadLogLines: string[] = [];
  const connectionLogLines: string[] = [];
  let failNextWrite = false;

  const orchestrator = {
    handle: vi.fn(async (text: string, language: "ar" | "en", options?: unknown) => {
      orchestratorCalls.push({ text, language, options });
      return undefined;
    }),
    transcript: vi.fn(() => []),
  };

  // Backs both DispatchDeps.sessions (log/write/resize/snapshot/list) and
  // UtteranceDeps.sessions (get/write) — one object, so a session-targeted
  // upload's `sessions.write` and the dispatch table's own `session:input`
  // would land on the same recorder.
  const sessions = {
    log: vi.fn(() => ""),
    write: vi.fn((id: string, data: string) => {
      sessionWrites.push({ id, data });
    }),
    resize: vi.fn(),
    snapshot: vi.fn(() => ({ text: "", end: 0 })),
    list: vi.fn(() => []),
    get: (id: string) => (id === "s1" ? { id: "s1" } : undefined),
  };

  const broadcast = {
    send: vi.fn((channel: string, payload: unknown) => {
      broadcastCalls.push({ channel, payload });
    }),
  };

  const utteranceDeps: UtteranceDeps = {
    transcribe: async () => ({ text: "open acme", language: "en" }),
    sessions,
    orchestrator,
    broadcast,
    primaryLanguage: "en",
    log: () => {},
  };

  const voiceUploadDeps: VoiceUploadDeps = {
    now: Date.now,
    makeTempDir: () => mkdtemp(join(tempRoot, "jarvis-voice-")),
    writeFileExclusive: async (path, bytes) => {
      if (failNextWrite) {
        failNextWrite = false;
        // A planted path a real EACCES/ENOENT message would carry — the
        // "never a path/stderr/message" rule (Task 4) means this string
        // must reach neither voiceUploadDeps.log nor any phone-bound frame.
        throw new Error("EACCES: permission denied, open '/secret/keys/audio.m4a'");
      }
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    },
    removeDir: (dir) => rm(dir, { recursive: true, force: true }),
    transcode,
    utterance: (request) => handleUtterance(request, utteranceDeps),
    language: "en",
    log: (line) => uploadLogLines.push(line),
  };

  const blobTable: BlobTable = createBlobTable({
    uploadAudio: createVoiceUploadHandler(voiceUploadDeps),
    // M9 Task 3: createBlobTable now also requires a remote:uploadFile
    // handler. This scenario is voice-only — the handler is never called —
    // so a fixed refusal stands in rather than the real file-upload.ts one.
    uploadFile: async () => ({ ok: false, text: "not exercised in this test", language: "en" }),
  });

  const dispatchTable: DispatchTable = createDispatchTable(
    fakeDeps({ orchestrator, sessions, language: "en" }),
  );

  const table = () => dispatchTable;
  const blobs = () => blobTable;
  const handle = remoteRequestHandler(table, blobs);

  const streams: StreamOwners = {
    hasPane: () => false,
    hasSession: (id) => id === "s1",
    followerOwner: () => undefined,
  };

  const socket = new FakeSocket();
  const log = (line: string) => connectionLogLines.push(line);
  const connection = createConnection(socket, {
    source: SOURCE,
    now: () => Date.now(),
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    authenticate: (deviceId, token) =>
      deviceId === DEVICE.id && token === TOKEN ? DEVICE : undefined,
    handle,
    policies: remotePushPolicies(),
    authorizeKey: remoteKeyAuthorizer(streams),
    blobLimit: (channel) => blobLimitOf(blobTable, channel),
    errorText: (code) => ({ text: MESSAGES.remoteErrorText(code, "en"), language: "en" as const }),
    log,
    audit: { record: () => {} },
    auditPolicy: () => "never",
    onOpen: () => {},
    onAuthFailed: () => {},
    onClosed: () => {},
  });

  let nextId = 1;
  function sendReq(ch: string, a: unknown[] = []): number {
    const id = nextId++;
    connection.onText(reqFrame(id, ch, a));
    return id;
  }
  function sendBlob(ch: string, a: unknown[], bytes: Uint8Array, chunkCount: number): number {
    const id = nextId++;
    const chunkSize = Math.ceil(bytes.length / chunkCount);
    connection.onText(blobFrame(id, ch, bytes.length, chunkCount, a));
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      connection.onBinary(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return id;
  }

  return {
    socket,
    connection,
    orchestratorCalls,
    broadcastCalls,
    sessionWrites,
    uploadLogLines,
    connectionLogLines,
    sendReq,
    sendBlob,
    setFailNextWrite: (value: boolean) => {
      failNextWrite = value;
    },
  };
}

describe("remote-voice.integration: laptop, everything real but the socket, the transcoder, whisper and the brain", () => {
  let tempRoot: string;

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "jarvis-remote-voice-test-"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("authenticates, uploads, replays, targets a session, and gates every other channel", async () => {
    const fakeTranscode: VoiceUploadDeps["transcode"] = async (input, output) => {
      await copyFile(input, output);
      return { ok: true };
    };
    const h = buildHarness(fakeTranscode, tempRoot);

    // 1. Authenticated as device d1 by a real hello/welcome handshake.
    h.connection.onText(helloFrame(DEVICE.id, TOKEN));
    expect(h.connection.device).toEqual(DEVICE);
    expect(h.socket.sent[0]).toMatchObject({ t: "welcome", v: PROTOCOL_VERSION });
    h.socket.sent = [];

    // 2. A valid upload, no target: brain route, silent, cleaned up.
    const turnA = "a".repeat(32);
    const bytes = m4aBytes(64);
    const idA = h.sendBlob(
      "remote:uploadAudio",
      [{ turnId: turnA, format: "m4a", durationMs: 1000 }],
      bytes,
      2,
    );
    await waitFor(() => resFor(h.socket, idA) !== undefined);
    expect(resFor(h.socket, idA)).toEqual({
      t: "res",
      id: idA,
      v: { kind: "heard", route: "brain", transcript: "open acme", language: "en" },
    });
    expect(h.orchestratorCalls).toEqual([
      { text: "open acme", language: "en", options: { speakAloud: false, replyTo: turnA } },
    ]);
    expect(
      h.broadcastCalls.some((c) =>
        ["voice:notice", "voice:speaking", "turn:new"].includes(c.channel),
      ),
    ).toBe(false);
    // The `res` above only arrives after voice-upload.ts's own `finally`
    // has already removed the temp dir (review Minor 2) — a direct readdir
    // right here is both stronger than a `waitFor` (it pins "deleted
    // before the request answers", not just "eventually") and simpler.
    expect(await readdir(tempRoot)).toEqual([]);

    // 3. The same blob again: replayed, not reprocessed.
    const idA2 = h.sendBlob(
      "remote:uploadAudio",
      [{ turnId: turnA, format: "m4a", durationMs: 1000 }],
      bytes,
      2,
    );
    await waitFor(() => resFor(h.socket, idA2) !== undefined);
    expect(resFor(h.socket, idA2)).toEqual({
      t: "res",
      id: idA2,
      v: { kind: "heard", route: "brain", transcript: "open acme", language: "en" },
    });
    expect(h.orchestratorCalls).toHaveLength(1);

    // 4. A new turnId targeting session s1: routed there instead, still silent.
    const turnB = "b".repeat(32);
    const idB = h.sendBlob(
      "remote:uploadAudio",
      [{ turnId: turnB, format: "m4a", durationMs: 1000, targetSessionId: "s1" }],
      bytes,
      2,
    );
    await waitFor(() => resFor(h.socket, idB) !== undefined);
    expect(resFor(h.socket, idB)).toEqual({
      t: "res",
      id: idB,
      v: {
        kind: "heard",
        route: "session",
        sessionId: "s1",
        transcript: "open acme",
        language: "en",
      },
    });
    expect(h.sessionWrites).toContainEqual({ id: "s1", data: "open acme\r" });
    expect(
      h.broadcastCalls.some((c) =>
        ["voice:notice", "voice:speaking", "turn:new"].includes(c.channel),
      ),
    ).toBe(false);

    // 5. remote:uploadAudio is a blob-only channel — a req is forbidden; a
    // blob for a channel the blob table does not know is refused before any
    // binary frame arrives, and the socket stays open either way.
    const idForbidden = h.sendReq("remote:uploadAudio", []);
    await waitFor(() => errFor(h.socket, idForbidden) !== undefined);
    expect(errFor(h.socket, idForbidden)?.code).toBe("forbidden");

    const idUnknown = 900;
    h.connection.onText(blobFrame(idUnknown, "session:input", 10, 1, ["s1", "yes\r"]));
    // The refusal is synchronous, inside connection.ts's own blob-header
    // handling — answered before a single binary frame has been sent.
    expect(errFor(h.socket, idUnknown)?.code).toBe("unknown-channel");
    h.connection.onBinary(new Uint8Array(10)); // the declared chunk, discarded
    expect(h.socket.closed).toBeUndefined();
    expect(h.socket.terminated).toBe(false);

    // 6. input:send stays quiet on the laptop for a remote origin.
    const idInput = h.sendReq("input:send", ["hi", "en"]);
    await waitFor(() => resFor(h.socket, idInput) !== undefined);
    expect(h.orchestratorCalls.at(-1)).toEqual({
      text: "hi",
      language: "en",
      options: { speakAloud: false },
    });

    // 7. voice:target stays desktop-only.
    const idTarget = h.sendReq("voice:target", ["s1"]);
    await waitFor(() => errFor(h.socket, idTarget) !== undefined);
    expect(errFor(h.socket, idTarget)?.code).toBe("forbidden");

    // 8. Never-logged sweep (decision beyond the brief's own list): a
    // planted /secret path (Task 4's writeFileExclusive failure site) and
    // the transcript a successful turn already carries must never reach
    // voice-upload's own log line, and the planted path must never reach
    // the wire either — a failure answers only the generic voiceTurnFailed
    // text (ruling 17), never the real error's own message.
    h.setFailNextWrite(true);
    const turnFail = "d".repeat(32);
    const idFail = h.sendBlob(
      "remote:uploadAudio",
      [{ turnId: turnFail, format: "m4a", durationMs: 1000 }],
      bytes,
      2,
    );
    await waitFor(() => resFor(h.socket, idFail) !== undefined);
    expect(resFor(h.socket, idFail)).toEqual({
      t: "res",
      id: idFail,
      v: { kind: "failed", text: MESSAGES.voiceTurnFailed("en"), language: "en" },
    });
    expect(h.uploadLogLines.some((line) => line.includes("failed:write"))).toBe(true);

    const uploadLog = h.uploadLogLines.join("\n");
    const connectionLog = h.connectionLogLines.join("\n");
    const wireText = JSON.stringify(h.socket.sent);
    for (const secret of ["/secret", "permission denied", "EACCES"]) {
      expect(uploadLog).not.toContain(secret);
      expect(connectionLog).not.toContain(secret);
      expect(wireText).not.toContain(secret);
    }
    // The transcript a *successful* turn legitimately returns to the phone
    // (res.v.transcript, asserted above) is not a leak — but it must never
    // appear in either side's own console log line.
    expect(uploadLog).not.toContain("open acme");
    expect(connectionLog).not.toContain("open acme");

    // Real setTimeout/clearTimeout back this connection's heartbeat/blob
    // idle timers (review Minor 9) — close it so none are left armed for
    // vitest's own worker teardown to race.
    h.connection.close(CLOSE.normal, "test cleanup");
  });
});

const ffmpegOnPath = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!ffmpegOnPath)(
  "remote-voice.integration: real ffmpeg transcodes a generated 1s m4a",
  () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), "jarvis-remote-voice-ffmpeg-"));
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it("uploads a real m4a, transcodes it with the pinned ffmpeg command, and still answers heard/brain", async () => {
      const fixture = join(dir, "one-second.m4a");
      const gen = spawnSync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:a",
        "aac",
        "-b:a",
        "32k",
        "-ar",
        "16000",
        "-ac",
        "1",
        fixture,
      ]);
      expect(gen.status).toBe(0);
      const bytes = new Uint8Array(await readFile(fixture));

      const realTranscode: VoiceUploadDeps["transcode"] = async (input, output) => {
        const { command, args } = transcodeToWhisperWavCommand(input, output);
        const result = await runCommandWithLimits(command, args, {
          timeoutMs: TRANSCODE_TIMEOUT_MS,
          maxOutputBytes: 65_536,
        });
        return result.code === 0 ? { ok: true } : { ok: false, detail: result.stderr };
      };
      const h = buildHarness(realTranscode, dir);
      h.connection.onText(helloFrame(DEVICE.id, TOKEN));
      h.socket.sent = [];

      const turnId = "c".repeat(32);
      const id = h.sendBlob(
        "remote:uploadAudio",
        [{ turnId, format: "m4a", durationMs: 1000 }],
        bytes,
        1,
      );
      await waitFor(() => resFor(h.socket, id) !== undefined, TRANSCRIBE_TIMEOUT_MS);
      expect(resFor(h.socket, id)).toEqual({
        t: "res",
        id,
        v: { kind: "heard", route: "brain", transcript: "open acme", language: "en" },
      });
      h.connection.close(CLOSE.normal, "test cleanup"); // Minor 9, same as above
    }, 30_000);
  },
);
