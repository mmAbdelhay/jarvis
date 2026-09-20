import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RandomBytes } from "./io.js";
import {
  DEVICE_ID_BYTES,
  hashToken,
  mintCredential,
  mintSecret,
  SALT_BYTES,
  secretMatches,
  SECRET_BYTES,
  tokenMatches,
} from "./tokens.js";

// `timingSafeEqual` is mocked to a spy that calls through to the real
// implementation, so behaviour is unchanged but the bite-proof test below
// can assert it was actually invoked rather than `===`/`Buffer.equals`
// sneaking in unnoticed.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const { timingSafeEqual } = await import("node:crypto");

/** A RandomBytes double that fills each call's buffer with an incrementing byte, so callers can assert call order by size and fill value. */
function countingRandom(): RandomBytes {
  let call = 0;
  return (size: number) => Buffer.alloc(size, ++call);
}

const REAL_TOKEN = "A".repeat(43);
const SALT = "a".repeat(32);
const HASH = hashToken(REAL_TOKEN, Buffer.from(SALT, "hex"));

describe("mintSecret", () => {
  it("calls random(32) and returns that buffer's base64url", () => {
    const random = vi.fn((size: number) => Buffer.alloc(size, 7));
    const secret = mintSecret(random);
    expect(random).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalledWith(SECRET_BYTES);
    expect(secret).toBe(Buffer.alloc(32, 7).toString("base64url"));
  });
});

describe("hashToken", () => {
  it("equals sha512(concat(salt, token)), and a different salt gives a different hash", () => {
    // Hex text held in a variable before it reaches Buffer.from: written as
    // a literal directly inside the call, `Buffer.from("aa"..., "hex")`
    // matches import-direction.test.ts's "from(<quote>" detector, which
    // exists to catch `from "electron"`-shaped module specifiers, not this.
    const saltHex = "aa".repeat(16);
    const otherSaltHex = "bb".repeat(16);
    const plainToken = "a-token";
    const salt = Buffer.from(saltHex, "hex");
    const otherSalt = Buffer.from(otherSaltHex, "hex");
    const tokenBytes = Buffer.from(plainToken, "utf8");
    const expected = createHash("sha512")
      .update(Buffer.concat([salt, tokenBytes]))
      .digest("hex");

    expect(hashToken(plainToken, salt)).toBe(expected);
    expect(hashToken(plainToken, otherSalt)).not.toBe(hashToken(plainToken, salt));
  });
});

describe("mintCredential", () => {
  it("draws random() in order token(32), salt(16), deviceId(16), and never leaks the token", () => {
    const credential = mintCredential(countingRandom());

    const expectedTokenBytes = Buffer.alloc(SECRET_BYTES, 1);
    const expectedSaltBytes = Buffer.alloc(SALT_BYTES, 2);
    const expectedDeviceIdBytes = Buffer.alloc(DEVICE_ID_BYTES, 3);
    const expectedToken = expectedTokenBytes.toString("base64url");
    const expectedSalt = expectedSaltBytes.toString("hex");
    const expectedDeviceId = expectedDeviceIdBytes.toString("hex");
    const expectedHash = hashToken(expectedToken, expectedSaltBytes);

    expect(credential).toEqual({
      deviceId: expectedDeviceId,
      token: expectedToken,
      salt: expectedSalt,
      hash: expectedHash,
    });
    expect(credential.hash).not.toContain(expectedToken);
    expect(credential.salt).not.toContain(expectedToken);
  });
});

describe("tokenMatches", () => {
  it("is true for the right token", () => {
    expect(tokenMatches(REAL_TOKEN, { salt: SALT, hash: HASH })).toBe(true);
  });

  it.each<[string, string]>([
    ["another token", "B".repeat(43)],
    ["the last character changed", `${REAL_TOKEN.slice(0, -1)}B`],
    ["a trailing space", `${REAL_TOKEN} `],
    ["an empty string", ""],
    ["a 1 MiB string", "x".repeat(1024 * 1024)],
  ])("is false for %s", (_label, candidate) => {
    expect(tokenMatches(candidate, { salt: SALT, hash: HASH })).toBe(false);
  });

  it.each<[string, { salt: string; hash: string }]>([
    ["a short hash", { salt: SALT, hash: HASH.slice(0, 10) }],
    ['a "zz" salt', { salt: "zz".repeat(16), hash: HASH }],
    ["an upper-case hash", { salt: SALT, hash: HASH.toUpperCase() }],
  ])("is false, without throwing, for %s", (_label, stored) => {
    expect(() => tokenMatches(REAL_TOKEN, stored)).not.toThrow();
    expect(tokenMatches(REAL_TOKEN, stored)).toBe(false);
  });

  it("[bite-proof] calls timingSafeEqual exactly once per call", () => {
    vi.mocked(timingSafeEqual).mockClear();
    tokenMatches(REAL_TOKEN, { salt: SALT, hash: HASH });
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});

describe("secretMatches", () => {
  const SECRET = "C".repeat(43);

  it("is true for equal secrets", () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
  });

  it.each<[string, string]>([
    ["a trailing extra character", `${SECRET}x`],
    ["an empty string", ""],
    ["one character short", SECRET.slice(0, -1)],
  ])("is false, without throwing, for %s", (_label, candidate) => {
    expect(() => secretMatches(candidate, SECRET)).not.toThrow();
    expect(secretMatches(candidate, SECRET)).toBe(false);
  });

  it("calls timingSafeEqual", () => {
    vi.mocked(timingSafeEqual).mockClear();
    secretMatches(SECRET, SECRET);
    expect(timingSafeEqual).toHaveBeenCalled();
  });
});
