import { describe, expect, it } from "vitest";
import {
  MAX_VOICE_DURATION_MS,
  MIN_VOICE_DURATION_MS,
  parseVoiceUploadMeta,
  parseVoiceUploadResult,
  VOICE_UPLOAD_CHANNEL,
} from "./voice.js";

const TURN_ID_32 = "0123456789abcdef0123456789abcde0".slice(0, 32);

function validMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    turnId: TURN_ID_32,
    format: "m4a",
    durationMs: 1000,
    ...overrides,
  };
}

describe("parseVoiceUploadMeta", () => {
  it("VOICE_UPLOAD_CHANNEL is remote:uploadAudio", () => {
    expect(VOICE_UPLOAD_CHANNEL).toBe("remote:uploadAudio");
  });

  it("accepts a valid meta with no target", () => {
    expect(parseVoiceUploadMeta(validMeta())).toEqual({
      turnId: TURN_ID_32,
      format: "m4a",
      durationMs: 1000,
    });
  });

  it("accepts a valid meta with a target", () => {
    expect(parseVoiceUploadMeta(validMeta({ targetSessionId: "session-1" }))).toEqual({
      turnId: TURN_ID_32,
      format: "m4a",
      durationMs: 1000,
      targetSessionId: "session-1",
    });
  });

  it("rejects an array", () => {
    expect(parseVoiceUploadMeta([validMeta()])).toBeUndefined();
  });

  it("rejects a turnId of 31 chars", () => {
    expect(parseVoiceUploadMeta(validMeta({ turnId: TURN_ID_32.slice(0, 31) }))).toBeUndefined();
  });

  it("rejects a turnId of 33 chars", () => {
    expect(parseVoiceUploadMeta(validMeta({ turnId: `${TURN_ID_32}0` }))).toBeUndefined();
  });

  it("rejects an uppercase turnId", () => {
    expect(parseVoiceUploadMeta(validMeta({ turnId: TURN_ID_32.toUpperCase() }))).toBeUndefined();
  });

  it('rejects format:"wav"', () => {
    expect(parseVoiceUploadMeta(validMeta({ format: "wav" }))).toBeUndefined();
  });

  it("rejects durationMs 499 (below the minimum)", () => {
    expect(
      parseVoiceUploadMeta(validMeta({ durationMs: MIN_VOICE_DURATION_MS - 1 })),
    ).toBeUndefined();
  });

  it("rejects durationMs 120001 (above the maximum)", () => {
    expect(
      parseVoiceUploadMeta(validMeta({ durationMs: MAX_VOICE_DURATION_MS + 1 })),
    ).toBeUndefined();
  });

  it("rejects a fractional durationMs", () => {
    expect(parseVoiceUploadMeta(validMeta({ durationMs: 1.5 }))).toBeUndefined();
  });

  it('rejects targetSessionId "../x"', () => {
    expect(parseVoiceUploadMeta(validMeta({ targetSessionId: "../x" }))).toBeUndefined();
  });

  it('rejects targetSessionId "a b"', () => {
    expect(parseVoiceUploadMeta(validMeta({ targetSessionId: "a b" }))).toBeUndefined();
  });

  it("rejects a numeric targetSessionId", () => {
    expect(parseVoiceUploadMeta(validMeta({ targetSessionId: 7 }))).toBeUndefined();
  });

  it("does not copy extra keys", () => {
    const result = parseVoiceUploadMeta(validMeta({ extra: "nope" }));
    expect(result).toEqual({ turnId: TURN_ID_32, format: "m4a", durationMs: 1000 });
    expect(result).not.toHaveProperty("extra");
  });
});

describe("parseVoiceUploadResult", () => {
  it("round-trips heard/brain", () => {
    const value = { kind: "heard", route: "brain", transcript: "hello", language: "en" };
    expect(parseVoiceUploadResult(value)).toEqual(value);
  });

  it("round-trips heard/session", () => {
    const value = {
      kind: "heard",
      route: "session",
      sessionId: "s1",
      transcript: "hello",
      language: "ar",
    };
    expect(parseVoiceUploadResult(value)).toEqual(value);
  });

  it("round-trips silence", () => {
    const value = { kind: "silence", text: "nothing heard", language: "en" };
    expect(parseVoiceUploadResult(value)).toEqual(value);
  });

  it("round-trips busy", () => {
    const value = { kind: "busy", text: "busy", language: "en" };
    expect(parseVoiceUploadResult(value)).toEqual(value);
  });

  it("round-trips invalid", () => {
    const value = { kind: "invalid", text: "invalid", language: "ar" };
    expect(parseVoiceUploadResult(value)).toEqual(value);
  });

  it("round-trips failed", () => {
    const value = { kind: "failed", text: "failed", language: "en" };
    expect(parseVoiceUploadResult(value)).toEqual(value);
  });

  it("rejects an unknown kind", () => {
    expect(parseVoiceUploadResult({ kind: "nope", text: "x", language: "en" })).toBeUndefined();
  });

  it("rejects an unknown route under heard", () => {
    expect(
      parseVoiceUploadResult({ kind: "heard", route: "nope", transcript: "x", language: "en" }),
    ).toBeUndefined();
  });

  it('rejects language:"fr"', () => {
    expect(parseVoiceUploadResult({ kind: "silence", text: "x", language: "fr" })).toBeUndefined();
  });

  it("rejects an over-long text", () => {
    const text = "a".repeat(16_385);
    expect(parseVoiceUploadResult({ kind: "silence", text, language: "en" })).toBeUndefined();
  });

  it("rejects an over-long transcript", () => {
    const transcript = "a".repeat(16_385);
    expect(
      parseVoiceUploadResult({ kind: "heard", route: "brain", transcript, language: "en" }),
    ).toBeUndefined();
  });

  it('rejects a sessionId "a b"', () => {
    expect(
      parseVoiceUploadResult({
        kind: "heard",
        route: "session",
        sessionId: "a b",
        transcript: "x",
        language: "en",
      }),
    ).toBeUndefined();
  });
});
