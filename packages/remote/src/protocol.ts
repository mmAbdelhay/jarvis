// The wire format for the `/rpc` socket (spec, "The protocol") and for the
// pairing exchange that precedes it. Every parse function here rebuilds its
// result field-by-field from validated values — it never returns (or
// spreads) the object `JSON.parse` handed it. That is not stylistic: an
// attacker's frame is free to carry an own `__proto__` key, and the only way
// to guarantee that key goes nowhere is to never copy the parsed object's
// keys wholesale.
//
// The constants, types, patterns, `encodeMessage` and the pairing-URI
// functions moved to @jarvis/wire (M6 ruling 4) so the phone app can share
// them without pulling in `Buffer`/`node:*`. This file keeps every parse
// function (they need `Buffer.byteLength` for the frame-size checks) and
// re-exports everything it exported before so no other file in this
// package needs to change its imports.

import { isSubscriptionKey } from "./policy.js";
export {
  AUTH_CHANNELS,
  AUTH_STATE_CHANNEL,
  BLOB_IDLE_TIMEOUT_MS,
  CLOSE,
  DEVICE_ID_PATTERN,
  encodeMessage,
  formatPairingUri,
  HANDSHAKE_TIMEOUT_MS,
  isValidBlobShape,
  LOCKED_ALLOWED,
  MAX_BLOB_BYTES,
  MAX_BLOB_CHUNK_BYTES,
  MAX_BLOB_CHUNKS,
  MAX_MISSED_PONGS,
  MAX_PAIR_FRAME_BYTES,
  MAX_TEXT_FRAME_BYTES,
  parsePairingUri,
  PING_INTERVAL_MS,
  PROTOCOL_VERSION,
  REMOTE_ERROR_CODES,
  SECRET_PATTERN,
} from "@jarvis/wire";
export type {
  AuthArgs,
  AuthChannel,
  AuthLockReason,
  AuthResults,
  AuthStatePush,
  AuthStatus,
  AuthTokens,
  ClientMessage,
  PairClientMessage,
  PairingLink,
  PairServerMessage,
  RemoteErrorCode,
  ServerMessage,
  SubTarget,
} from "@jarvis/wire";
import {
  AUTH_TOKEN_PATTERN,
  DEVICE_ID_PATTERN,
  MAX_ATTESTATION_OBJECT_LENGTH,
  MAX_PAIR_FRAME_BYTES,
  MAX_PASSKEY_FIELD_LENGTH,
  MAX_PASSKEY_LABEL_LENGTH,
  MAX_PASSWORD_LENGTH,
  MAX_TEXT_FRAME_BYTES,
  SECRET_PATTERN,
} from "@jarvis/wire";
import type {
  AuthArgs,
  AuthChannel,
  ClientMessage,
  PairClientMessage,
  SubTarget,
} from "@jarvis/wire";

export const REQUEST_WINDOW_MS = 10_000;
export const MAX_REQUESTS_PER_WINDOW = 200;

// A channel name: a lowercase-led namespace, a colon, then the verb —
// "remote:decidePair", never "__proto__" or anything without a colon.
const CHANNEL_PATTERN = /^[a-z][A-Za-z]*:[A-Za-z]+$/;
const MAX_CHANNEL_LENGTH = 64;
const MAX_SUB_TARGETS = 64;
const MAX_ARGS = 64;
const MAX_CLIENT_LENGTH = 128;

export type InvalidFrame = { t: "invalid"; id: number | undefined; malformedBlob?: true };

function isSafeNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isChannel(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= MAX_CHANNEL_LENGTH && CHANNEL_PATTERN.test(value)
  );
}

const INVALID = Symbol("invalid");

/**
 * A `sub`/`unsub` target: a channel string (the existing channel pattern),
 * or an object whose `ch` is a channel and `key` passes `isSubscriptionKey`.
 * An object target is always rebuilt field-by-field — `const { ch, key } =
 * value` is a property *get*, and `{ ch, key }` a fresh literal, so an own
 * `__proto__` key on the parsed object, or any other extra key, never
 * reaches the result.
 */
function parseSubTarget(value: unknown): SubTarget | typeof INVALID {
  if (typeof value === "string") return isChannel(value) ? value : INVALID;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return INVALID;
  const { ch, key } = value as Record<string, unknown>;
  if (!isChannel(ch) || !isSubscriptionKey(key)) return INVALID;
  return { ch, key };
}

/** Optional array of ≤64 sub/unsub targets. `undefined` (absent) is valid; anything else must fully validate. */
function optionalTargetArray(value: unknown): SubTarget[] | undefined | typeof INVALID {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_SUB_TARGETS) return INVALID;
  const targets: SubTarget[] = [];
  for (const item of value) {
    const target = parseSubTarget(item);
    if (target === INVALID) return INVALID;
    targets.push(target);
  }
  return targets;
}

/** Parses one `/rpc` text frame. Never throws; an unparseable or invalid frame is `{t:"invalid", ...}`. */
export function parseClientMessage(text: string): ClientMessage | InvalidFrame {
  // Checked before anything else touches the text: an over-size frame is
  // rejected outright, its `id` (if any) discarded along with the rest.
  if (Buffer.byteLength(text, "utf8") > MAX_TEXT_FRAME_BYTES)
    return { t: "invalid", id: undefined };

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { t: "invalid", id: undefined };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return { t: "invalid", id: undefined };
  const obj = raw as Record<string, unknown>;
  const id = isSafeNonNegativeInt(obj.id) ? obj.id : undefined;

  switch (obj.t) {
    case "hello": {
      const { deviceId, token, client, v } = obj;
      if (
        typeof deviceId === "string" &&
        DEVICE_ID_PATTERN.test(deviceId) &&
        typeof token === "string" &&
        SECRET_PATTERN.test(token) &&
        typeof client === "string" &&
        client.length <= MAX_CLIENT_LENGTH &&
        isSafeNonNegativeInt(v)
      ) {
        return { t: "hello", v, deviceId, token, client };
      }
      break;
    }
    case "req": {
      const { ch, a } = obj;
      if (id !== undefined && isChannel(ch) && Array.isArray(a) && a.length <= MAX_ARGS) {
        return { t: "req", id, ch, a: [...a] };
      }
      break;
    }
    case "sub": {
      const add = optionalTargetArray(obj.add);
      const drop = optionalTargetArray(obj.drop);
      if (add !== INVALID && drop !== INVALID) {
        const message: Extract<ClientMessage, { t: "sub" }> = { t: "sub" };
        if (add !== undefined) message.add = add;
        if (drop !== undefined) message.drop = drop;
        return message;
      }
      break;
    }
    case "blob": {
      const { ch, a, bytes, chunks } = obj;
      if (
        id !== undefined &&
        isChannel(ch) &&
        Array.isArray(a) &&
        a.length <= MAX_ARGS &&
        isSafeNonNegativeInt(bytes) &&
        isSafeNonNegativeInt(chunks)
      ) {
        return { t: "blob", id, ch, a: [...a], bytes, chunks };
      }
      break;
    }
    case "pong": {
      const { seq } = obj;
      if (isSafeNonNegativeInt(seq)) return { t: "pong", seq };
      break;
    }
    case "bye":
      return { t: "bye" };
  }
  // A blob header has a following binary phase. Once its discriminator is
  // known, malformed fields are a framing error rather than an ordinary bad
  // request: replying would leave a prior upload alive or desynchronise the
  // next binary frame from the text stream.
  return obj.t === "blob" ? { t: "invalid", id, malformedBlob: true } : { t: "invalid", id };
}

/** Parses a pre-auth pairing frame. Never throws; anything invalid is `undefined`. */
export function parsePairMessage(text: string): PairClientMessage | undefined {
  if (Buffer.byteLength(text, "utf8") > MAX_PAIR_FRAME_BYTES) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.t !== "pair") return undefined;

  const { v, secret, deviceName, client } = obj;
  if (
    isSafeNonNegativeInt(v) &&
    typeof secret === "string" &&
    SECRET_PATTERN.test(secret) &&
    typeof deviceName === "string" &&
    deviceName.length >= 1 &&
    deviceName.length <= 256 &&
    typeof client === "string" &&
    client.length <= MAX_CLIENT_LENGTH
  ) {
    return { t: "pair", v, secret, deviceName, client };
  }
  return undefined;
}

// Unpadded base64url, as WebAuthn's JSON encoding produces it.
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
// No control, format (bidi overrides, zero-widths), surrogate, private-use or
// unassigned code points, and no line/paragraph separators.
const UNPRINTABLE_PATTERN = /[\p{C}\p{Zl}\p{Zp}]/u;

function isPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= MAX_PASSWORD_LENGTH;
}

function isAuthToken(value: unknown): value is string {
  return typeof value === "string" && AUTH_TOKEN_PATTERN.test(value);
}

function isBase64Url(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength && BASE64URL_PATTERN.test(value);
}

function isPasskeyLabel(value: unknown): value is string {
  // Two UTF-16 units per code point at most: rejects a huge string before
  // the regex or the code-point spread ever walks it.
  if (typeof value !== "string" || value.length > MAX_PASSKEY_LABEL_LENGTH * 2) return false;
  if (UNPRINTABLE_PATTERN.test(value)) return false;
  const codePoints = [...value].length;
  return codePoints >= 1 && codePoints <= MAX_PASSKEY_LABEL_LENGTH;
}

/**
 * An auth request's `a` array: at most one plain-object argument (absent
 * means `{}`). Returns the object, or `undefined` when the shape is wrong.
 */
function singleArgObject(args: readonly unknown[]): Record<string, unknown> | undefined {
  if (args.length === 0) return {};
  if (args.length !== 1) return undefined;
  const [arg] = args;
  if (typeof arg !== "object" || arg === null || Array.isArray(arg)) return undefined;
  return arg as Record<string, unknown>;
}

/**
 * Validates an `auth:*` request's arguments. Pure and never throws; the
 * result is rebuilt field by field (see the header comment), so extra keys
 * and an own `__proto__` go nowhere. `undefined` means the request is a
 * `bad-request` — including a channel that isn't an auth channel.
 */
export function parseAuthArgs<C extends AuthChannel>(
  channel: C,
  args: readonly unknown[],
): AuthArgs[C] | undefined;
export function parseAuthArgs(
  channel: string,
  args: readonly unknown[],
): AuthArgs[AuthChannel] | undefined;
export function parseAuthArgs(
  channel: string,
  args: readonly unknown[],
): AuthArgs[AuthChannel] | undefined {
  const arg = singleArgObject(args);
  if (arg === undefined) return undefined;
  switch (channel) {
    case "auth:status":
    case "auth:passkeyBegin":
    case "auth:logout":
      return {};
    case "auth:login":
    case "auth:passkeyRegisterBegin": {
      const { password } = arg;
      return isPassword(password) ? { password } : undefined;
    }
    case "auth:refresh": {
      const { refreshToken } = arg;
      return isAuthToken(refreshToken) ? { refreshToken } : undefined;
    }
    case "auth:resume": {
      const { accessToken } = arg;
      return isAuthToken(accessToken) ? { accessToken } : undefined;
    }
    case "auth:passkeyFinish": {
      const { credentialId, clientDataJSON, authenticatorData, signature, userHandle } = arg;
      if (
        !isBase64Url(credentialId, MAX_PASSKEY_FIELD_LENGTH) ||
        !isBase64Url(clientDataJSON, MAX_PASSKEY_FIELD_LENGTH) ||
        !isBase64Url(authenticatorData, MAX_PASSKEY_FIELD_LENGTH) ||
        !isBase64Url(signature, MAX_PASSKEY_FIELD_LENGTH)
      ) {
        return undefined;
      }
      const result: AuthArgs["auth:passkeyFinish"] = {
        credentialId,
        clientDataJSON,
        authenticatorData,
        signature,
      };
      if (userHandle !== undefined) {
        if (!isBase64Url(userHandle, MAX_PASSKEY_FIELD_LENGTH)) return undefined;
        result.userHandle = userHandle;
      }
      return result;
    }
    case "auth:passkeyRegisterFinish": {
      const { credentialId, clientDataJSON, attestationObject, label } = arg;
      if (
        isBase64Url(credentialId, MAX_PASSKEY_FIELD_LENGTH) &&
        isBase64Url(clientDataJSON, MAX_PASSKEY_FIELD_LENGTH) &&
        isBase64Url(attestationObject, MAX_ATTESTATION_OBJECT_LENGTH) &&
        isPasskeyLabel(label)
      ) {
        return { credentialId, clientDataJSON, attestationObject, label };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}
