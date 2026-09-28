import { describe, expect, it } from "vitest";
import {
  AUTH_CHANNELS,
  AUTH_TOKEN_PATTERN,
  CLOSE,
  DEVICE_ID_PATTERN,
  encodeMessage,
  FINGERPRINT_PATTERN,
  isSubscriptionKey,
  isValidBlobShape,
  LOCKED_ALLOWED,
  PROTOCOL_VERSION,
  REMOTE_ERROR_CODES,
  SECRET_PATTERN,
  SUBSCRIPTION_KEY_PATTERN,
} from "./protocol.js";

describe("encodeMessage", () => {
  it("is JSON.stringify", () => {
    const message = { t: "bye" as const };
    expect(encodeMessage(message)).toBe(JSON.stringify(message));
  });
});

describe("CLOSE", () => {
  it("has unauthorized at 4401, congested at 4413, and every application code at or above 4000 and unique", () => {
    expect(CLOSE.unauthorized).toBe(4401);
    expect(CLOSE.congested).toBe(4413);
    const applicationCodes = [
      CLOSE.badFrame,
      CLOSE.unauthorized,
      CLOSE.pairingDenied,
      CLOSE.handshakeTimeout,
      CLOSE.revoked,
      CLOSE.congested,
      CLOSE.versionMismatch,
      CLOSE.tooManyRequests,
      CLOSE.overCapacity,
    ];
    for (const code of applicationCodes) {
      expect(code).toBeGreaterThanOrEqual(4000);
    }
    expect(new Set(applicationCodes).size).toBe(applicationCodes.length);
  });
});

describe("REMOTE_ERROR_CODES", () => {
  it("has seven distinct codes including forbidden and locked", () => {
    expect(REMOTE_ERROR_CODES).toHaveLength(7);
    expect(new Set(REMOTE_ERROR_CODES).size).toBe(REMOTE_ERROR_CODES.length);
    expect(REMOTE_ERROR_CODES).toContain("forbidden");
    expect(REMOTE_ERROR_CODES).toContain("locked");
  });
});

describe("PROTOCOL_VERSION", () => {
  it("is 2 (owner login: an old app must get a version mismatch, not a silently locked connection)", () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

describe("AUTH_CHANNELS / LOCKED_ALLOWED", () => {
  it("lists the nine auth channels", () => {
    expect([...AUTH_CHANNELS]).toEqual([
      "auth:status",
      "auth:login",
      "auth:passkeyBegin",
      "auth:passkeyFinish",
      "auth:passkeyRegisterBegin",
      "auth:passkeyRegisterFinish",
      "auth:refresh",
      "auth:resume",
      "auth:logout",
    ]);
  });

  it("allows every auth channel while locked except the passkey-register pair", () => {
    expect([...LOCKED_ALLOWED].sort()).toEqual(
      AUTH_CHANNELS.filter(
        (ch) => ch !== "auth:passkeyRegisterBegin" && ch !== "auth:passkeyRegisterFinish",
      ).sort(),
    );
  });
});

describe("AUTH_TOKEN_PATTERN", () => {
  it.each<[string, boolean]>([
    ["0123456789abcdef".repeat(4), true],
    ["0123456789ABCDEF".repeat(4), false],
    ["a".repeat(63), false],
    ["a".repeat(65), false],
    ["g".repeat(64), false],
  ])("AUTH_TOKEN_PATTERN.test(%j) is %s", (value, expected) => {
    expect(AUTH_TOKEN_PATTERN.test(value)).toBe(expected);
  });
});

describe("isSubscriptionKey", () => {
  it.each<[unknown, boolean]>([
    ["tab-1", true],
    ["a.b_c:d-9", true],
    ["", false],
    ["a".repeat(129), false],
    ["a b", false],
    [7, false],
    [undefined, false],
  ])("isSubscriptionKey(%j) is %s", (value, expected) => {
    expect(isSubscriptionKey(value)).toBe(expected);
  });
});

describe("isValidBlobShape", () => {
  it.each<[number, number, boolean]>([
    [1, 1, true],
    [262_144, 1, true],
    [262_145, 1, false],
    [262_145, 2, true],
    [0, 1, false],
    [1, 0, false],
    [5, 6, false],
    [26_214_401, 101, false],
    [10, 129, false],
    [1.5, 1, false],
    [Number.NaN, 1, false],
  ])("isValidBlobShape(%j, %j) is %s", (bytes, chunks, expected) => {
    expect(isValidBlobShape(bytes, chunks)).toBe(expected);
  });
});

describe("patterns", () => {
  it("DEVICE_ID_PATTERN matches a 32-char lowercase hex string only", () => {
    expect(DEVICE_ID_PATTERN.test("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(DEVICE_ID_PATTERN.test("0123456789ABCDEF0123456789abcdef")).toBe(false);
  });

  it("SECRET_PATTERN matches a 43-char token only", () => {
    expect(SECRET_PATTERN.test("A".repeat(43))).toBe(true);
    expect(SECRET_PATTERN.test("short")).toBe(false);
  });

  it("FINGERPRINT_PATTERN matches a 64-char lowercase hex string only", () => {
    expect(FINGERPRINT_PATTERN.test("0123456789abcdef".repeat(4))).toBe(true);
    expect(FINGERPRINT_PATTERN.test("A".repeat(64))).toBe(false);
  });

  it("SUBSCRIPTION_KEY_PATTERN agrees with isSubscriptionKey", () => {
    expect(SUBSCRIPTION_KEY_PATTERN.test("tab-1")).toBe(true);
  });
});
