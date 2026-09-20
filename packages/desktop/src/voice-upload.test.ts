import { Buffer } from "node:buffer";
import { join } from "node:path";
import type { VoiceUploadResult } from "@jarvis/wire";
import { describe, expect, it, vi } from "vitest";
import { MESSAGES } from "./messages.js";
import type { RemoteOrigin } from "./remote-blob.js";
import type { HandledUtterance, UtteranceRequest } from "./voice-turn.js";
import {
  createVoiceUploadHandler,
  RECENT_TURN_TTL_MS,
  RECENT_TURNS_PER_DEVICE,
  type VoiceUploadDeps,
} from "./voice-upload.js";

// createVoiceUploadHandler returns a BlobHandler (Promise<unknown> — the
// desktop-wide handler shape, remote-blob.ts), but every result here is
// actually a VoiceUploadResult; this narrows it once so tests can read
// `.kind` directly instead of casting at each call site.
function typedHandler(
  deps: VoiceUploadDeps,
): (
  args: readonly unknown[],
  bytes: Uint8Array,
  origin: RemoteOrigin,
) => Promise<VoiceUploadResult> {
  const handler = createVoiceUploadHandler(deps);
  return (args, bytes, origin) => handler(args, bytes, origin) as Promise<VoiceUploadResult>;
}

const DEVICE_1: RemoteOrigin = { kind: "remote", deviceId: "d1", deviceName: "Phone" };
const DEVICE_2: RemoteOrigin = { kind: "remote", deviceId: "d2", deviceName: "Tablet" };

function turnId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

// A real 12-byte ftyp/M4A header followed by filler — isMp4Audio only ever
// reads bytes 4-11, so the rest can be anything.
function m4aBytes(length = 64): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(Buffer.from("ftyp", "latin1"), 4);
  bytes.set(Buffer.from("M4A ", "latin1"), 8);
  return bytes;
}

function riffBytes(length = 32): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set(Buffer.from("RIFF", "latin1"), 0);
  bytes.set(Buffer.from("WAVE", "latin1"), 8);
  return bytes;
}

function meta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turnId: turnId(1),
    format: "m4a",
    durationMs: 1000,
    ...overrides,
  };
}

const BRAIN_OUTCOME: HandledUtterance = {
  outcome: { kind: "brain", transcript: "hello", language: "en" },
  answered: Promise.resolve(),
};

/** Drains queued microtasks until `check()` is true or `ticks` run out — used
 *  to let a handler's own chain of `await`s (makeTempDir, writeFileExclusive,
 *  transcode) reach the point that assigns a deferred resolver, without
 *  guessing an exact tick count. */
// voice-upload.ts builds both with `join(dir, …)` — platform-correct
// (backslash-joined on win32) — from the raw `makeTempDir()` result below
// ("/tmp/voice-N"); a literal "/tmp/voice-N/audio.m4a" only ever matches on
// POSIX, so expectations that check the joined path build it the same way.
function voiceFile(n: number, name: string): string {
  return join(`/tmp/voice-${n}`, name);
}

async function flushUntil(check: () => boolean, ticks = 50): Promise<void> {
  for (let i = 0; i < ticks && !check(); i += 1) {
    await Promise.resolve();
  }
}

function harness(overrides: Partial<VoiceUploadDeps> = {}) {
  let clock = 0;
  let dirCounter = 0;
  let makeTempDirCalls = 0;
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const transcodes: { input: string; output: string }[] = [];
  const utteranceCalls: UtteranceRequest[] = [];
  const removeDirs: string[] = [];
  const logs: string[] = [];
  const scripted: (HandledUtterance | Error)[] = [];

  const deps: VoiceUploadDeps = {
    now: () => clock,
    makeTempDir: vi.fn(async () => {
      makeTempDirCalls += 1;
      return `/tmp/voice-${dirCounter++}`;
    }),
    writeFileExclusive: vi.fn(async (path: string, bytes: Uint8Array) => {
      writes.push({ path, bytes });
    }),
    removeDir: vi.fn(async (path: string) => {
      removeDirs.push(path);
    }),
    transcode: vi.fn(async (input: string, output: string) => {
      transcodes.push({ input, output });
      return { ok: true as const };
    }),
    utterance: vi.fn(async (request: UtteranceRequest) => {
      utteranceCalls.push(request);
      const next = scripted.shift();
      if (next instanceof Error) throw next;
      return next ?? BRAIN_OUTCOME;
    }),
    language: "en",
    log: vi.fn((line: string) => logs.push(line)),
    ...overrides,
  };

  return {
    deps,
    writes,
    transcodes,
    utteranceCalls,
    removeDirs,
    logs,
    makeTempDirCalls: () => makeTempDirCalls,
    setNow: (n: number) => {
      clock = n;
    },
    scriptUtterance: (result: HandledUtterance | Error) => {
      scripted.push(result);
    },
  };
}

describe("createVoiceUploadHandler", () => {
  describe("brain happy path", () => {
    it("returns heard/brain, writes the exact bytes, transcodes, and calls utterance with the target and replyTo", async () => {
      const h = harness();
      const handler = typedHandler(h.deps);
      const bytes = m4aBytes();

      const result = await handler(
        [meta({ turnId: turnId(1), targetSessionId: "s1" })],
        bytes,
        DEVICE_1,
      );

      expect(result).toEqual({
        kind: "heard",
        route: "brain",
        transcript: "hello",
        language: "en",
      });
      expect(h.writes).toHaveLength(1);
      expect(h.writes[0]?.path).toBe(voiceFile(0, "audio.m4a"));
      expect(h.writes[0]?.bytes).toBe(bytes);
      expect(h.transcodes).toEqual([
        { input: voiceFile(0, "audio.m4a"), output: voiceFile(0, "audio.wav") },
      ]);
      expect(h.utteranceCalls).toEqual([
        {
          wavPath: voiceFile(0, "audio.wav"),
          targetSessionId: "s1",
          origin: { kind: "remote", replyTo: turnId(1) },
        },
      ]);
    });

    it("calls removeDir(dir) only after utterance has resolved", async () => {
      const h = harness();
      const order: string[] = [];
      let resolveUtterance: ((value: HandledUtterance) => void) | undefined;
      const deps: VoiceUploadDeps = {
        ...h.deps,
        utterance: vi.fn(
          () =>
            new Promise<HandledUtterance>((resolve) => {
              resolveUtterance = (value) => {
                order.push("utterance-resolved");
                resolve(value);
              };
            }),
        ),
        removeDir: vi.fn(async (path: string) => {
          order.push(`removeDir:${path}`);
        }),
      };
      const handler = typedHandler(deps);

      const pending = handler([meta()], m4aBytes(), DEVICE_1);
      await flushUntil(() => resolveUtterance !== undefined);
      expect(order).toEqual([]);

      resolveUtterance?.(BRAIN_OUTCOME);
      await pending;

      expect(order).toEqual(["utterance-resolved", "removeDir:/tmp/voice-0"]);
    });
  });

  it("session path returns heard/session with the sessionId", async () => {
    const h = harness();
    h.scriptUtterance({
      outcome: { kind: "session", sessionId: "s1", transcript: "hi there", language: "en" },
      answered: Promise.resolve(),
    });
    const handler = typedHandler(h.deps);

    const result = await handler([meta({ targetSessionId: "s1" })], m4aBytes(), DEVICE_1);

    expect(result).toEqual({
      kind: "heard",
      route: "session",
      sessionId: "s1",
      transcript: "hi there",
      language: "en",
    });
  });

  describe("invalid inputs never touch makeTempDir or transcode", () => {
    it("empty args", async () => {
      const h = harness();
      const handler = typedHandler(h.deps);
      const result = await handler([], m4aBytes(), DEVICE_1);
      expect(result).toEqual({
        kind: "invalid",
        text: MESSAGES.voiceUploadInvalid("en"),
        language: "en",
      });
      expect(h.makeTempDirCalls()).toBe(0);
      expect(h.transcodes).toHaveLength(0);
    });

    it("an extra positional argument", async () => {
      const h = harness();
      const handler = typedHandler(h.deps);
      const result = await handler([meta(), "extra"], m4aBytes(), DEVICE_1);
      expect(result.kind).toBe("invalid");
      expect(h.makeTempDirCalls()).toBe(0);
      expect(h.transcodes).toHaveLength(0);
    });

    it('format:"wav"', async () => {
      const h = harness();
      const handler = typedHandler(h.deps);
      const result = await handler([meta({ format: "wav" })], m4aBytes(), DEVICE_1);
      expect(result.kind).toBe("invalid");
      expect(h.makeTempDirCalls()).toBe(0);
      expect(h.transcodes).toHaveLength(0);
    });

    // [bite-proof: bypassing parseVoiceUploadMeta for targetSessionId (using
    // args[0].targetSessionId directly instead of meta.targetSessionId) would
    // let "../x" reach utterance instead of being refused here.]
    it('targetSessionId:"../x"', async () => {
      const h = harness();
      const handler = typedHandler(h.deps);
      const result = await handler([meta({ targetSessionId: "../x" })], m4aBytes(), DEVICE_1);
      expect(result.kind).toBe("invalid");
      expect(h.makeTempDirCalls()).toBe(0);
      expect(h.transcodes).toHaveLength(0);
      expect(h.utteranceCalls).toHaveLength(0);
    });

    // [bite-proof: skipping isMp4Audio would let this reach transcode.]
    it("a RIFF header", async () => {
      const h = harness();
      const handler = typedHandler(h.deps);
      const result = await handler([meta()], riffBytes(), DEVICE_1);
      expect(result.kind).toBe("invalid");
      expect(h.makeTempDirCalls()).toBe(0);
      expect(h.transcodes).toHaveLength(0);
    });

    it("0 bytes", async () => {
      const h = harness();
      const handler = typedHandler(h.deps);
      const result = await handler([meta()], new Uint8Array(0), DEVICE_1);
      expect(result.kind).toBe("invalid");
      expect(h.makeTempDirCalls()).toBe(0);
    });

    it("4194305 bytes (one over MAX_VOICE_BYTES)", async () => {
      const h = harness();
      const handler = typedHandler(h.deps);
      const result = await handler([meta()], new Uint8Array(4_194_305), DEVICE_1);
      expect(result.kind).toBe("invalid");
      expect(h.makeTempDirCalls()).toBe(0);
    });
  });

  // [bite-proof: with no replay memory, the same turnId would call utterance twice.]
  it("replay: the same turnId twice sequentially calls utterance once and deep-equals the stored result", async () => {
    const h = harness();
    const handler = typedHandler(h.deps);
    const args = [meta({ turnId: turnId(2) })];
    const bytes = m4aBytes();

    const first = await handler(args, bytes, DEVICE_1);
    const second = await handler(args, bytes, DEVICE_1);

    expect(h.utteranceCalls).toHaveLength(1);
    expect(second).toEqual(first);
  });

  describe("pending concurrency", () => {
    it("the same turnId while the first is still pending returns busy", async () => {
      const h = harness();
      let release: ((value: HandledUtterance) => void) | undefined;
      const deps: VoiceUploadDeps = {
        ...h.deps,
        utterance: vi.fn(
          () =>
            new Promise<HandledUtterance>((resolve) => {
              release = resolve;
            }),
        ),
      };
      const handler = typedHandler(deps);
      const args = [meta({ turnId: turnId(3) })];
      const bytes = m4aBytes();

      const first = handler(args, bytes, DEVICE_1);
      const second = await handler(args, bytes, DEVICE_1);

      expect(second).toEqual({
        kind: "busy",
        text: MESSAGES.voiceUploadBusy("en"),
        language: "en",
      });

      await flushUntil(() => release !== undefined);
      release?.(BRAIN_OUTCOME);
      await first;
    });

    it("a different turnId from the same device while pending also returns busy", async () => {
      const h = harness();
      let release: ((value: HandledUtterance) => void) | undefined;
      const deps: VoiceUploadDeps = {
        ...h.deps,
        utterance: vi.fn(
          () =>
            new Promise<HandledUtterance>((resolve) => {
              release = resolve;
            }),
        ),
      };
      const handler = typedHandler(deps);
      const bytes = m4aBytes();

      const first = handler([meta({ turnId: turnId(4) })], bytes, DEVICE_1);
      const second = await handler([meta({ turnId: turnId(5) })], bytes, DEVICE_1);

      expect(second.kind).toBe("busy");

      await flushUntil(() => release !== undefined);
      release?.(BRAIN_OUTCOME);
      await first;
    });

    it("a turn from a different device is processed concurrently", async () => {
      const h = harness();
      let releaseD1: ((value: HandledUtterance) => void) | undefined;
      let callCount = 0;
      const deps: VoiceUploadDeps = {
        ...h.deps,
        utterance: vi.fn(() => {
          callCount += 1;
          if (callCount === 1) {
            return new Promise<HandledUtterance>((resolve) => {
              releaseD1 = resolve;
            });
          }
          return Promise.resolve(BRAIN_OUTCOME);
        }),
      };
      const handler = typedHandler(deps);
      const bytes = m4aBytes();

      const first = handler([meta({ turnId: turnId(6) })], bytes, DEVICE_1);
      const second = await handler([meta({ turnId: turnId(7) })], bytes, DEVICE_2);

      expect(second).toMatchObject({ kind: "heard", route: "brain" });
      expect(h.makeTempDirCalls()).toBe(2);

      await flushUntil(() => releaseD1 !== undefined);
      releaseD1?.(BRAIN_OUTCOME);
      await first;
    });
  });

  // [bite-proof: returning transcoded.detail as the phone-facing text would
  // put "/secret/path boom" in the result JSON.]
  it("a transcode failure never leaks its detail; a retry reprocesses", async () => {
    const failingTranscode = vi.fn(async () => ({
      ok: false as const,
      detail: "/secret/path boom",
    }));
    const h = harness({ transcode: failingTranscode });
    const handler = typedHandler(h.deps);
    const args = [meta({ turnId: turnId(8) })];
    const bytes = m4aBytes();

    const result = await handler(args, bytes, DEVICE_1);

    expect(result).toEqual({
      kind: "failed",
      text: MESSAGES.voiceTurnFailed("en"),
      language: "en",
    });
    const json = JSON.stringify(result);
    expect(json).not.toContain("/secret");
    expect(json).not.toContain("boom");
    // Review I1: the console line still names the failing step, but never
    // the detail that produced it.
    const joinedLogs = h.logs.join("\n");
    expect(joinedLogs).toContain("failed:transcode");
    expect(joinedLogs).not.toContain("/secret");
    expect(joinedLogs).not.toContain("boom");

    const retry = await handler(args, bytes, DEVICE_1);
    expect(retry.kind).toBe("failed");
    expect(failingTranscode).toHaveBeenCalledTimes(2);
  });

  it("writeFileExclusive rejecting returns failed and still calls removeDir", async () => {
    const h = harness({
      writeFileExclusive: vi.fn(async () => {
        throw new Error("disk full at /secret/audio.m4a");
      }),
    });
    const handler = typedHandler(h.deps);

    const result = await handler([meta()], m4aBytes(), DEVICE_1);

    expect(result).toEqual({
      kind: "failed",
      text: MESSAGES.voiceTurnFailed("en"),
      language: "en",
    });
    expect(h.removeDirs).toEqual(["/tmp/voice-0"]);

    const joinedLogs = h.logs.join("\n");
    expect(joinedLogs).toContain("failed:write");
    expect(joinedLogs).not.toContain("disk full");
    expect(joinedLogs).not.toContain("/secret");
  });

  it("utterance throwing returns failed, calls removeDir, and deletes the entry", async () => {
    const h = harness();
    h.scriptUtterance(new Error("brain exploded: /secret/session"));
    const handler = typedHandler(h.deps);
    const args = [meta({ turnId: turnId(9) })];
    const bytes = m4aBytes();

    const result = await handler(args, bytes, DEVICE_1);

    expect(result).toEqual({
      kind: "failed",
      text: MESSAGES.voiceTurnFailed("en"),
      language: "en",
    });
    expect(h.removeDirs).toEqual(["/tmp/voice-0"]);

    const joinedLogs = h.logs.join("\n");
    expect(joinedLogs).toContain("failed:utterance");
    expect(joinedLogs).not.toContain("brain exploded");
    expect(joinedLogs).not.toContain("/secret");

    // Deleted, not remembered as done: a retry reprocesses from scratch
    // (the scripted throw only fires once, so this retry hits the default
    // BRAIN_OUTCOME).
    const retry = await handler(args, bytes, DEVICE_1);
    expect(h.utteranceCalls).toHaveLength(2);
    expect(retry).toMatchObject({ kind: "heard", route: "brain" });
  });

  it("a transcode throw (not just ok:false) is also logged as failed:transcode", async () => {
    const h = harness({
      transcode: vi.fn(async () => {
        throw new Error("ffmpeg spawn failed: /secret/ffmpeg-binary");
      }),
    });
    const handler = typedHandler(h.deps);

    const result = await handler([meta()], m4aBytes(), DEVICE_1);

    expect(result).toEqual({
      kind: "failed",
      text: MESSAGES.voiceTurnFailed("en"),
      language: "en",
    });
    const joinedLogs = h.logs.join("\n");
    expect(joinedLogs).toContain("failed:transcode");
    expect(joinedLogs).not.toContain("ffmpeg spawn failed");
    expect(joinedLogs).not.toContain("/secret");
  });

  // Review I1 / M6: makeTempDir has its own site (outside the inner
  // try/finally entirely, since there is no directory yet to clean up).
  it("makeTempDir rejecting returns failed:tmpdir, never calls removeDir, and a retry reprocesses", async () => {
    const failingMakeTempDir = vi.fn(async () => {
      throw new Error("ENOSPC: /secret/tmp is full");
    });
    const h = harness({ makeTempDir: failingMakeTempDir });
    const handler = typedHandler(h.deps);
    const args = [meta({ turnId: turnId(12) })];
    const bytes = m4aBytes();

    const result = await handler(args, bytes, DEVICE_1);

    expect(result).toEqual({
      kind: "failed",
      text: MESSAGES.voiceTurnFailed("en"),
      language: "en",
    });
    expect(h.removeDirs).toEqual([]);
    const joinedLogs = h.logs.join("\n");
    expect(joinedLogs).toContain("failed:tmpdir");
    expect(joinedLogs).not.toContain("ENOSPC");
    expect(joinedLogs).not.toContain("/secret");

    // Deleted, not remembered: a retry reprocesses from scratch.
    const retry = await handler(args, bytes, DEVICE_1);
    expect(failingMakeTempDir).toHaveBeenCalledTimes(2);
    expect(retry.kind).toBe("failed");
  });

  // Review walk item 4 / M1: memory is keyed per device, so a second
  // device presenting the *same* turnId string as a device that has
  // already finished is processed fresh — it can never read back the
  // first device's stored result (which may hold its transcript).
  it("a different device presenting the same turnId as a finished device is processed fresh, not replayed", async () => {
    const h = harness();
    h.scriptUtterance({
      outcome: { kind: "brain", transcript: "d1's secret transcript", language: "en" },
      answered: Promise.resolve(),
    });
    h.scriptUtterance({
      outcome: { kind: "brain", transcript: "d2's own transcript", language: "en" },
      answered: Promise.resolve(),
    });
    const handler = typedHandler(h.deps);
    const sharedTurnId = turnId(13);
    const bytes = m4aBytes();

    const fromD1 = await handler([meta({ turnId: sharedTurnId })], bytes, DEVICE_1);
    const fromD2 = await handler([meta({ turnId: sharedTurnId })], bytes, DEVICE_2);

    expect(h.utteranceCalls).toHaveLength(2);
    expect(fromD1).toMatchObject({ transcript: "d1's secret transcript" });
    expect(fromD2).toMatchObject({ transcript: "d2's own transcript" });
    expect(fromD2).not.toEqual(fromD1);
  });

  it("TTL: after now advances past RECENT_TURN_TTL_MS, the same turnId is processed again", async () => {
    const h = harness();
    const handler = typedHandler(h.deps);
    const args = [meta({ turnId: turnId(10) })];
    const bytes = m4aBytes();

    await handler(args, bytes, DEVICE_1);
    expect(h.transcodes).toHaveLength(1);

    h.setNow(RECENT_TURN_TTL_MS + 1);
    await handler(args, bytes, DEVICE_1);
    expect(h.transcodes).toHaveLength(2);
  });

  it(`cap: ${RECENT_TURNS_PER_DEVICE + 1} finished turns forgets the first (it reprocesses) while the last still replays`, async () => {
    const h = harness();
    const handler = typedHandler(h.deps);
    const bytes = m4aBytes();
    const total = RECENT_TURNS_PER_DEVICE + 1;

    for (let i = 1; i <= total; i += 1) {
      h.setNow(i);
      const result = await handler([meta({ turnId: turnId(i) })], bytes, DEVICE_1);
      expect(result.kind).toBe("heard");
    }
    expect(h.transcodes).toHaveLength(total);

    // The oldest (turn 1) was evicted for being past the cap — replaying it reprocesses.
    await handler([meta({ turnId: turnId(1) })], bytes, DEVICE_1);
    expect(h.transcodes).toHaveLength(total + 1);

    // The most recent turn is still remembered — replaying it does not reprocess.
    await handler([meta({ turnId: turnId(total) })], bytes, DEVICE_1);
    expect(h.transcodes).toHaveLength(total + 1);
  });

  // M12 Task 7 (M8 T4-a review carry, M9 T3 ledger): pruneStale must never
  // evict a `pending` entry, however old its reservation looks — only a
  // committed `done` entry past the TTL is ever pruned.
  it("a pending entry older than the TTL survives pruneStale; a finished one is evicted", async () => {
    const h = harness();
    let calls = 0;
    let release: ((value: HandledUtterance) => void) | undefined;
    const deps: VoiceUploadDeps = {
      ...h.deps,
      utterance: vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          return new Promise<HandledUtterance>((resolve) => {
            release = resolve;
          });
        }
        return Promise.resolve(BRAIN_OUTCOME);
      }),
    };
    const handler = typedHandler(deps);
    const bytes = m4aBytes();
    const pendingId = turnId(20);

    h.setNow(0);
    const first = handler([meta({ turnId: pendingId })], bytes, DEVICE_1);
    await flushUntil(() => release !== undefined);

    // Past the TTL now, while turn(pendingId) is still pending.
    h.setNow(RECENT_TURN_TTL_MS + 1);

    // [bite-proof: drop the `entry.status === "done"` guard in pruneStale;
    // this stale-looking pending entry is wrongly evicted, so the second
    // call reprocesses (calls makeTempDir again) instead of returning busy]
    const second = await handler([meta({ turnId: pendingId })], bytes, DEVICE_1);
    expect(second).toEqual({ kind: "busy", text: MESSAGES.voiceUploadBusy("en"), language: "en" });
    expect(h.makeTempDirCalls()).toBe(1);

    release?.(BRAIN_OUTCOME);
    await first;

    // A finished entry, once past the TTL, really is evicted (reprocesses).
    const doneId = turnId(21);
    h.setNow(RECENT_TURN_TTL_MS + 2);
    await handler([meta({ turnId: doneId })], bytes, DEVICE_1);
    const afterFirstDone = h.transcodes.length;

    h.setNow(RECENT_TURN_TTL_MS + 2 + RECENT_TURN_TTL_MS + 1);
    await handler([meta({ turnId: doneId })], bytes, DEVICE_1);
    expect(h.transcodes).toHaveLength(afterFirstDone + 1);
  });

  it("no log line contains the transcript or any meta value other than turnId", async () => {
    const h = harness();
    h.scriptUtterance({
      outcome: {
        kind: "session",
        sessionId: "super-secret-session",
        transcript: "hello",
        language: "en",
      },
      answered: Promise.resolve(),
    });
    const handler = typedHandler(h.deps);
    const tid = turnId(11);

    await handler(
      [meta({ turnId: tid, targetSessionId: "super-secret-session" })],
      m4aBytes(),
      DEVICE_1,
    );
    await handler(
      [meta({ turnId: tid, targetSessionId: "super-secret-session" })],
      m4aBytes(),
      DEVICE_1,
    );

    const joined = h.logs.join("\n");
    expect(joined).not.toContain("hello");
    expect(joined).not.toContain("super-secret-session");
    expect(joined).toContain(tid);
  });
});
