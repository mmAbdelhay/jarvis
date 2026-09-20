import { describe, expect, it, vi } from "vitest";
import { MESSAGES } from "./messages.js";
import { handleUtterance, type UtteranceDeps, type UtteranceRequest } from "./voice-turn.js";

type Sent = { channel: string; payload: unknown };

function fakeDeps(overrides: Partial<UtteranceDeps> = {}): {
  deps: UtteranceDeps;
  sent: Sent[];
  logs: string[];
} {
  const sent: Sent[] = [];
  const logs: string[] = [];
  const deps: UtteranceDeps = {
    transcribe: vi.fn(async () => ({ text: "hello", language: "en" })),
    sessions: {
      get: vi.fn(() => undefined),
      write: vi.fn(),
    },
    orchestrator: { handle: vi.fn(async () => undefined) },
    broadcast: {
      send: vi.fn((channel: string, payload: unknown) => sent.push({ channel, payload })),
    },
    primaryLanguage: "en",
    log: vi.fn((line: string) => logs.push(line)),
    ...overrides,
  };
  return { deps, sent, logs };
}

function request(overrides: Partial<UtteranceRequest> = {}): UtteranceRequest {
  return {
    wavPath: "/tmp/x/audio.wav",
    targetSessionId: undefined,
    origin: { kind: "desktop" },
    ...overrides,
  };
}

describe("handleUtterance", () => {
  describe("transcription failure", () => {
    // [bite-proof: keep the detail in the broadcast text — reusing
    // transcriptionFailed(detail, language) instead of the no-detail form —
    // and this "not.toContain" assertion fails]
    it("desktop origin: broadcasts turn:new with the generic transcriptionFailed text, never the detail, and logs a fixed category", async () => {
      const detail = "/tmp/jarvis-voice-x/in.wav: whisper died";
      const { deps, sent, logs } = fakeDeps({
        transcribe: vi.fn(async () => {
          throw new Error(detail);
        }),
      });
      const { outcome, answered } = await handleUtterance(request(), deps);
      await answered;

      expect(outcome.kind).toBe("failed");
      expect(outcome).toMatchObject({ text: MESSAGES.transcriptionFailed("en") });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        channel: "turn:new",
        payload: {
          role: "assistant",
          text: MESSAGES.transcriptionFailed("en"),
          language: "en",
        },
      });
      if (outcome.kind === "failed") {
        expect(outcome.text).not.toContain("/tmp");
        expect(outcome.text).not.toContain("whisper");
      }
      const sentPayload = sent[0]?.payload;
      if (sentPayload === undefined) throw new Error("expected a broadcast payload");
      const sentText = (sentPayload as { text: string }).text;
      expect(sentText).not.toContain("/tmp");
      expect(sentText).not.toContain("whisper");

      // The log line carries the M8-style fixed site category only — never
      // the dependency's own message, path or stderr.
      expect(logs).toEqual(["voice-turn: transcription failed (desktop): transcribe"]);
      expect(logs.join("\n")).not.toContain("/tmp");
      expect(logs.join("\n")).not.toContain("whisper");
    });

    it("remote origin: no broadcast, generic voiceTurnFailed text, never the detail", async () => {
      const { deps, sent, logs } = fakeDeps({
        transcribe: vi.fn(async () => {
          throw new Error("boom");
        }),
      });
      const { outcome, answered } = await handleUtterance(
        request({ origin: { kind: "remote", replyTo: "turn-1" } }),
        deps,
      );
      await answered;

      expect(outcome.kind).toBe("failed");
      expect(outcome).toMatchObject({ text: MESSAGES.voiceTurnFailed("en") });
      if (outcome.kind === "failed") {
        expect(outcome.text).not.toContain("boom");
      }
      expect(sent).toHaveLength(0);
      expect(logs).toEqual(["voice-turn: transcription failed"]);
    });
  });

  describe("silence", () => {
    it("desktop origin: sends voice:notice with nothingHeard; outcome is silence", async () => {
      const { deps, sent } = fakeDeps({
        transcribe: vi.fn(async () => ({ text: "   ", language: "en" })),
      });
      const { outcome, answered } = await handleUtterance(request(), deps);
      await answered;

      expect(outcome).toMatchObject({ kind: "silence", text: MESSAGES.nothingHeard("en") });
      expect(sent).toEqual([
        { channel: "voice:notice", payload: { text: MESSAGES.nothingHeard("en"), language: "en" } },
      ]);
    });

    it("remote origin: no broadcast; outcome is silence", async () => {
      const { deps, sent } = fakeDeps({
        transcribe: vi.fn(async () => ({ text: "", language: "en" })),
      });
      const { outcome, answered } = await handleUtterance(
        request({ origin: { kind: "remote", replyTo: "turn-2" } }),
        deps,
      );
      await answered;

      expect(outcome.kind).toBe("silence");
      expect(sent).toHaveLength(0);
    });
  });

  describe("a live session target", () => {
    it("writes transcript + CR, desktop origin sends a notice, outcome is session", async () => {
      const { deps, sent } = fakeDeps({
        sessions: {
          get: vi.fn(() => ({ id: "s1", endedAt: undefined })),
          write: vi.fn(),
        },
      });
      const { outcome, answered } = await handleUtterance(request({ targetSessionId: "s1" }), deps);
      await answered;

      expect(deps.sessions.write).toHaveBeenCalledWith("s1", "hello\r");
      expect(outcome).toMatchObject({ kind: "session", sessionId: "s1", transcript: "hello" });
      expect(sent).toEqual([
        { channel: "voice:notice", payload: { text: "hello", language: "en" } },
      ]);
    });

    it("remote origin: writes, but sends no notice", async () => {
      const { deps, sent } = fakeDeps({
        sessions: {
          get: vi.fn(() => ({ id: "s1", endedAt: undefined })),
          write: vi.fn(),
        },
      });
      const { outcome, answered } = await handleUtterance(
        request({ targetSessionId: "s1", origin: { kind: "remote", replyTo: "turn-3" } }),
        deps,
      );
      await answered;

      expect(deps.sessions.write).toHaveBeenCalledWith("s1", "hello\r");
      expect(outcome.kind).toBe("session");
      expect(sent).toHaveLength(0);
    });
  });

  describe("falls back to the brain", () => {
    it("an ended target falls back to the brain", async () => {
      const { deps } = fakeDeps({
        sessions: {
          get: vi.fn(() => ({ id: "s1", endedAt: 1234 })),
          write: vi.fn(),
        },
      });
      const { outcome, answered } = await handleUtterance(request({ targetSessionId: "s1" }), deps);
      await answered;
      expect(outcome.kind).toBe("brain");
      expect(deps.sessions.write).not.toHaveBeenCalled();
    });

    it("a missing target falls back to the brain", async () => {
      const { deps } = fakeDeps({
        sessions: { get: vi.fn(() => undefined), write: vi.fn() },
      });
      const { outcome, answered } = await handleUtterance(request({ targetSessionId: "s1" }), deps);
      await answered;
      expect(outcome.kind).toBe("brain");
    });

    it("no target falls back to the brain", async () => {
      const { deps } = fakeDeps();
      const { outcome, answered } = await handleUtterance(
        request({ targetSessionId: undefined }),
        deps,
      );
      await answered;
      expect(outcome.kind).toBe("brain");
    });

    it("desktop origin calls handle(text, language, { speakAloud: true })", async () => {
      const { deps } = fakeDeps();
      const { answered } = await handleUtterance(request(), deps);
      await answered;
      expect(deps.orchestrator.handle).toHaveBeenCalledWith("hello", "en", { speakAloud: true });
    });

    // [bite-proof: pass speakAloud:true for remote]
    it("remote origin calls handle(text, language, { speakAloud: false, replyTo })", async () => {
      const { deps } = fakeDeps();
      const { answered } = await handleUtterance(
        request({ origin: { kind: "remote", replyTo: "turn-9" } }),
        deps,
      );
      await answered;
      expect(deps.orchestrator.handle).toHaveBeenCalledWith("hello", "en", {
        speakAloud: false,
        replyTo: "turn-9",
      });
    });

    it("resolves before a never-resolving orchestrator.handle settles", async () => {
      let resolveHandle: (() => void) | undefined;
      const { deps } = fakeDeps({
        orchestrator: {
          handle: vi.fn(
            () =>
              new Promise((resolve) => {
                resolveHandle = () => resolve(undefined);
              }),
          ),
        },
      });

      const { outcome, answered } = await handleUtterance(request(), deps);
      expect(outcome.kind).toBe("brain");

      let settled = false;
      answered.then(() => {
        settled = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);

      resolveHandle?.();
      await answered;
      expect(settled).toBe(true);
    });

    it("a rejecting orchestrator.handle: answered resolves; the log has only its failure category", async () => {
      const { deps, logs } = fakeDeps({
        orchestrator: {
          handle: vi.fn(async () => {
            throw new Error("brain down");
          }),
        },
      });
      const { answered } = await handleUtterance(request(), deps);
      await expect(answered).resolves.toBeUndefined();
      expect(logs).toEqual(["voice-turn: brain failed"]);
      expect(logs.some((line) => line.includes("hello"))).toBe(false);
    });

    it("a synchronous orchestrator.handle throw returns brain and answered resolves", async () => {
      const { deps, logs } = fakeDeps({
        orchestrator: {
          handle: vi.fn(() => {
            throw new Error("hello");
          }),
        },
      });

      const { outcome, answered } = await handleUtterance(request(), deps);

      expect(outcome).toMatchObject({ kind: "brain", transcript: "hello" });
      await expect(answered).resolves.toBeUndefined();
      expect(logs).toEqual(["voice-turn: brain failed"]);
    });
  });

  it("a synchronous session write failure returns failed and does not invoke the brain", async () => {
    const { deps, logs } = fakeDeps({
      sessions: {
        get: vi.fn(() => ({ id: "s1", endedAt: undefined })),
        write: vi.fn(() => {
          throw new Error("hello");
        }),
      },
    });

    const { outcome, answered } = await handleUtterance(request({ targetSessionId: "s1" }), deps);

    expect(outcome).toMatchObject({ kind: "failed", text: MESSAGES.voiceTurnFailed("en") });
    await expect(answered).resolves.toBeUndefined();
    expect(deps.orchestrator.handle).not.toHaveBeenCalled();
    expect(logs).toEqual(["voice-turn: session write failed"]);
  });

  it("a synchronous session lookup failure falls back to the brain without logging transcript detail", async () => {
    const { deps, logs } = fakeDeps({
      sessions: {
        get: vi.fn(() => {
          throw new Error("hello");
        }),
        write: vi.fn(),
      },
    });

    const { outcome, answered } = await handleUtterance(request({ targetSessionId: "s1" }), deps);

    expect(outcome.kind).toBe("brain");
    await expect(answered).resolves.toBeUndefined();
    expect(logs).toEqual(["voice-turn: session lookup failed"]);
  });

  it("broadcast and logger failures do not let the utterance reject", async () => {
    const { deps } = fakeDeps({
      transcribe: vi.fn(async () => {
        throw new Error("hello");
      }),
      broadcast: {
        send: vi.fn(() => {
          throw new Error("send failed");
        }),
      },
      log: vi.fn(() => {
        throw new Error("log failed");
      }),
    });

    await expect(handleUtterance(request(), deps)).resolves.toMatchObject({
      outcome: { kind: "failed", text: MESSAGES.transcriptionFailed("en") },
    });
  });

  it("treats a non-ar/en detected language as en", async () => {
    const { deps } = fakeDeps({
      transcribe: vi.fn(async () => ({ text: "bonjour", language: "fr" })),
    });
    const { outcome, answered } = await handleUtterance(request(), deps);
    await answered;
    expect(outcome).toMatchObject({ language: "en" });
  });

  it("never logs the transcript text, across every branch", async () => {
    const { deps: desktopDeps, logs: desktopLogs } = fakeDeps({
      sessions: {
        get: vi.fn(() => ({ id: "s1", endedAt: undefined })),
        write: vi.fn(),
      },
    });
    const { answered: a1 } = await handleUtterance(request({ targetSessionId: "s1" }), desktopDeps);
    await a1;
    expect(desktopLogs.some((line) => line.includes("hello"))).toBe(false);

    const { deps: brainDeps, logs: brainLogs } = fakeDeps();
    const { answered: a2 } = await handleUtterance(request(), brainDeps);
    await a2;
    expect(brainLogs.some((line) => line.includes("hello"))).toBe(false);
  });
});
