import { describe, expect, it } from "vitest";
import {
  EXPO_PUSH_TOKEN_PATTERN,
  isExpoPushToken,
  isPushKind,
  MAX_PUSH_PROJECT_CHARS,
  parsePushData,
  parsePushRegisterResult,
  parsePushRegistration,
  PUSH_KINDS,
  PUSH_REGISTER_CHANNEL,
  PUSH_UNREGISTER_CHANNEL,
} from "./push.js";

describe("channel names", () => {
  it("PUSH_REGISTER_CHANNEL is remote:registerPush", () => {
    expect(PUSH_REGISTER_CHANNEL).toBe("remote:registerPush");
  });

  it("PUSH_UNREGISTER_CHANNEL is remote:unregisterPush", () => {
    expect(PUSH_UNREGISTER_CHANNEL).toBe("remote:unregisterPush");
  });
});

describe("isPushKind", () => {
  it("accepts every PUSH_KINDS entry", () => {
    for (const kind of PUSH_KINDS) {
      expect(isPushKind(kind)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isPushKind("nope")).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isPushKind(7)).toBe(false);
  });
});

describe("isExpoPushToken / EXPO_PUSH_TOKEN_PATTERN", () => {
  it("accepts an ExponentPushToken with a 22-char inner id", () => {
    const token = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";
    expect(EXPO_PUSH_TOKEN_PATTERN.test(token)).toBe(true);
    expect(isExpoPushToken(token)).toBe(true);
  });

  it("accepts an ExpoPushToken with an 8-char inner id", () => {
    expect(isExpoPushToken("ExpoPushToken[abc12345]")).toBe(true);
  });

  it("rejects an empty inner id", () => {
    expect(isExpoPushToken("ExponentPushToken[]")).toBe(false);
  });

  it("rejects an inner id containing a space", () => {
    expect(isExpoPushToken("ExponentPushToken[a b]")).toBe(false);
  });

  it("rejects a 200-character inner id (over the 128 cap)", () => {
    const token = `ExponentPushToken[${"x".repeat(200)}]`;
    expect(isExpoPushToken(token)).toBe(false);
  });

  it("rejects a trailing newline", () => {
    expect(isExpoPushToken(`ExponentPushToken[${"x".repeat(8)}]\n`)).toBe(false);
  });

  it("rejects a non-string", () => {
    expect(isExpoPushToken(12345)).toBe(false);
  });

  // Documents the mutation, not a test of push.ts: the first assertion is a
  // literal loosened regex (the bite-proof's "before" state, run for real
  // in the report), the second is push.ts's real behaviour today.
  // bite-proof: loosen the inner class to `.+`; this space case passes.
  it("bite-proof: a space in the inner id is rejected by the [A-Za-z0-9_-] class", () => {
    expect(/^Expo(nent)?PushToken\[.+\]$/.test("ExponentPushToken[a b]")).toBe(true);
    expect(isExpoPushToken("ExponentPushToken[a b]")).toBe(false);
  });
});

describe("parsePushData", () => {
  it("round-trips kind + sessionId", () => {
    const value = { kind: "session-done", sessionId: "s1" };
    expect(parsePushData(value)).toEqual(value);
  });

  it("round-trips a kind-only reply", () => {
    expect(parsePushData({ kind: "reply" })).toEqual({ kind: "reply" });
  });

  it("drops an extra key", () => {
    const result = parsePushData({ kind: "reply", url: "http://evil" });
    expect(result).toEqual({ kind: "reply" });
    expect(result).not.toHaveProperty("url");
  });

  // Documents the mutation, not a test of push.ts: the first assertion is
  // what a naive `{ ...raw }` return would carry (the bite-proof's "before"
  // state, run for real in the report), the second is parsePushData's real
  // behaviour today.
  // bite-proof: spread the input in parsePushData's return; `url` survives.
  it("bite-proof: spreading the input would carry the extra key through", () => {
    const raw = { kind: "reply", url: "http://evil" };
    expect({ ...raw }).toHaveProperty("url");
    expect(parsePushData(raw)).not.toHaveProperty("url");
  });

  it("rejects an unknown kind", () => {
    expect(parsePushData({ kind: "nope" })).toBeUndefined();
  });

  it("rejects a sessionId that fails isSubscriptionKey", () => {
    expect(parsePushData({ kind: "session-done", sessionId: "../x" })).toBeUndefined();
  });

  it(`rejects a project of ${MAX_PUSH_PROJECT_CHARS + 1} characters`, () => {
    const project = "p".repeat(MAX_PUSH_PROJECT_CHARS + 1);
    expect(parsePushData({ kind: "reply", project })).toBeUndefined();
  });

  it("accepts a project of exactly MAX_PUSH_PROJECT_CHARS characters", () => {
    const project = "p".repeat(MAX_PUSH_PROJECT_CHARS);
    expect(parsePushData({ kind: "reply", project })).toEqual({ kind: "reply", project });
  });

  it("rejects a project containing a control character", () => {
    expect(parsePushData({ kind: "reply", project: "a\u0000b" })).toBeUndefined();
  });

  it("rejects an empty project", () => {
    expect(parsePushData({ kind: "reply", project: "" })).toBeUndefined();
  });

  it("rejects null", () => {
    expect(parsePushData(null)).toBeUndefined();
  });

  it("rejects an array", () => {
    expect(parsePushData([])).toBeUndefined();
  });

  it("rejects a string", () => {
    expect(parsePushData("x")).toBeUndefined();
  });
});

const VALID_TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

function validRegistration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    token: VALID_TOKEN,
    platform: "ios",
    language: "en",
    ...overrides,
  };
}

describe("parsePushRegistration", () => {
  it("round-trips a valid registration", () => {
    expect(parsePushRegistration(validRegistration())).toEqual({
      token: VALID_TOKEN,
      platform: "ios",
      language: "en",
    });
  });

  it("accepts platform: android", () => {
    expect(parsePushRegistration(validRegistration({ platform: "android" }))?.platform).toBe(
      "android",
    );
  });

  it("accepts language: ar", () => {
    expect(parsePushRegistration(validRegistration({ language: "ar" }))?.language).toBe("ar");
  });

  it("rejects an invalid token", () => {
    expect(parsePushRegistration(validRegistration({ token: "not-a-token" }))).toBeUndefined();
  });

  it("rejects an unknown platform", () => {
    expect(parsePushRegistration(validRegistration({ platform: "web" }))).toBeUndefined();
  });

  it("rejects an unknown language", () => {
    expect(parsePushRegistration(validRegistration({ language: "fr" }))).toBeUndefined();
  });

  it("drops an extra key", () => {
    const result = parsePushRegistration(validRegistration({ extra: "nope" }));
    expect(result).toEqual({ token: VALID_TOKEN, platform: "ios", language: "en" });
    expect(result).not.toHaveProperty("extra");
  });

  it("rejects null", () => {
    expect(parsePushRegistration(null)).toBeUndefined();
  });

  it("rejects an array", () => {
    expect(parsePushRegistration([validRegistration()])).toBeUndefined();
  });
});

describe("parsePushRegisterResult", () => {
  it("round-trips registered: true", () => {
    const value = { registered: true, laptopEnabled: true };
    expect(parsePushRegisterResult(value)).toEqual(value);
  });

  it("round-trips registered: true with laptopEnabled: false", () => {
    const value = { registered: true, laptopEnabled: false };
    expect(parsePushRegisterResult(value)).toEqual(value);
  });

  it("round-trips registered: false", () => {
    const value = { registered: false, text: "notifications are off", language: "en" };
    expect(parsePushRegisterResult(value)).toEqual(value);
  });

  it("rejects registered: true with a non-boolean laptopEnabled", () => {
    expect(parsePushRegisterResult({ registered: true, laptopEnabled: "yes" })).toBeUndefined();
  });

  it("rejects registered: false with an unknown language", () => {
    expect(
      parsePushRegisterResult({ registered: false, text: "x", language: "fr" }),
    ).toBeUndefined();
  });

  it("rejects a text of 513 characters", () => {
    const text = "a".repeat(513);
    expect(parsePushRegisterResult({ registered: false, text, language: "en" })).toBeUndefined();
  });

  it("accepts a text of exactly 512 characters", () => {
    const text = "a".repeat(512);
    expect(parsePushRegisterResult({ registered: false, text, language: "en" })).toEqual({
      registered: false,
      text,
      language: "en",
    });
  });

  it("rejects a non-boolean registered", () => {
    expect(parsePushRegisterResult({ registered: "true" })).toBeUndefined();
  });

  it("rejects null", () => {
    expect(parsePushRegisterResult(null)).toBeUndefined();
  });
});
