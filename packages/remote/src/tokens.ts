// Device credential primitives: minting a secret/token, hashing a token for
// storage, and comparing candidates in constant time. Nothing here touches
// disk — devices.ts calls `mintCredential` and stores only `salt`/`hash`,
// never the token itself (spec, "Device tokens... stored hashed").

import { createHash, timingSafeEqual } from "node:crypto";
import type { RandomBytes } from "./io.js";

export const SECRET_BYTES = 32;
export const SALT_BYTES = 16;
export const DEVICE_ID_BYTES = 16;

// Exported so devices.ts's own on-disk validation (a `salt`/`hash` pair
// read back from devices.json) checks against the exact same shape a
// credential is minted with, rather than a second hand-maintained copy.
export const SALT_HEX_PATTERN = /^[0-9a-f]{32}$/;
export const HASH_HEX_PATTERN = /^[0-9a-f]{128}$/;

/** 32 random bytes, base64url-encoded — a 43-character secret/token (protocol.ts's SECRET_PATTERN). */
export function mintSecret(random: RandomBytes): string {
  return random(SECRET_BYTES).toString("base64url");
}

/** Hex SHA-512 over `salt ‖ utf8(token)` — never the token alone, so a stolen hash table is useless without the per-device salt. */
export function hashToken(token: string, salt: Buffer): string {
  return createHash("sha512")
    .update(Buffer.concat([salt, Buffer.from(token, "utf8")]))
    .digest("hex");
}

export type DeviceCredential = { deviceId: string; token: string; salt: string; hash: string };

/**
 * Mints a fresh device credential. Draws from `random` in a fixed order —
 * token (32 bytes), salt (16), deviceId (16) — so callers that inject a
 * counting double can assert on that order. Only `salt` and `hash` are meant
 * to reach disk; `token` is returned once, for the caller to hand to the
 * device and then discard.
 */
export function mintCredential(random: RandomBytes): DeviceCredential {
  const token = mintSecret(random);
  const saltBytes = random(SALT_BYTES);
  const salt = saltBytes.toString("hex");
  const deviceId = random(DEVICE_ID_BYTES).toString("hex");
  const hash = hashToken(token, saltBytes);
  return { deviceId, token, salt, hash };
}

/**
 * True iff `token` hashes (with `stored.salt`) to `stored.hash`. Rejects a
 * malformed `salt`/`hash` by returning false outright — never throwing, and
 * never reaching `timingSafeEqual` with mismatched buffer lengths, which
 * would throw. The digests being compared are always the same length here
 * (both parsed from a 128-hex-char string), so the comparison itself never
 * leaks length information; it only ever guards against a non-constant-time
 * short-circuit on the byte contents.
 */
export function tokenMatches(token: string, stored: { salt: string; hash: string }): boolean {
  if (!SALT_HEX_PATTERN.test(stored.salt) || !HASH_HEX_PATTERN.test(stored.hash)) return false;
  const candidate = Buffer.from(hashToken(token, Buffer.from(stored.salt, "hex")), "hex");
  const expected = Buffer.from(stored.hash, "hex");
  return timingSafeEqual(candidate, expected);
}

/**
 * True iff `candidate` and `secret` are equal, compared without leaking
 * either string's length: both sides are first SHA-256'd to a fixed 32
 * bytes, so `timingSafeEqual` always receives equal-length buffers and never
 * throws regardless of how `candidate` and `secret` differ in length.
 */
export function secretMatches(candidate: string, secret: string): boolean {
  const candidateDigest = createHash("sha256").update(candidate, "utf8").digest();
  const secretDigest = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(candidateDigest, secretDigest);
}
