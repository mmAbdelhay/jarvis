// The wire protocol's constants, types and patterns (spec, "The
// protocol"): the pieces shared verbatim by the laptop bridge
// (@jarvis/remote) and the phone client (apps/mobile, React Native — no
// Buffer, no node:*). Frame parsing that needs Buffer.byteLength stays in
// @jarvis/remote's own protocol.ts, which imports these and re-exports
// them so every name it exported before this package existed is still
// importable from there.

// 2 (owner login, Phase 0): a v2 connection is device-authenticated but
// locked until the owner logs in over the auth:* channels below. A v1 app
// gets the version-mismatch close instead of a silently locked connection.
export const PROTOCOL_VERSION = 2;

export const MAX_TEXT_FRAME_BYTES = 1_048_576;
export const MAX_PAIR_FRAME_BYTES = 4_096;
export const HANDSHAKE_TIMEOUT_MS = 5_000;
export const PING_INTERVAL_MS = 15_000;
export const MAX_MISSED_PONGS = 2;

// The blob upload lane (M8 ruling 1): a `blob` header frame declares its
// total byte count and how many binary frames will follow it, each no
// larger than MAX_BLOB_CHUNK_BYTES. MAX_BLOB_CHUNKS bounds how many binary
// frames a single blob may cost the event loop, independent of its byte
// total. BLOB_IDLE_TIMEOUT_MS abandons a blob that stalls mid-transfer.
export const MAX_BLOB_BYTES = 26_214_400;
export const MAX_BLOB_CHUNK_BYTES = 262_144;
export const MAX_BLOB_CHUNKS = 128;
export const BLOB_IDLE_TIMEOUT_MS = 30_000;

export const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const DEVICE_ID_PATTERN = /^[0-9a-f]{32}$/;
export const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
export const SUBSCRIPTION_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

// A DNS hostname (M11, "system-trust mode"): lowercase labels of 1-63
// `[a-z0-9]` characters with inner `-` only, at least two labels, 1-253
// characters overall, no trailing dot. The leading `(?=.{1,253}$)` bounds
// the total length and the leading `(?!.*\.[0-9]+$)` rejects a last label
// of only digits — the one shape that would otherwise let an IPv4 literal
// (whose every label is digits) slip through the label grammar below, since
// digits are themselves valid label characters. An IPv6 literal never
// reaches that check at all: `:` isn't in the label character class, so it
// fails the very first label.
export const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?!.*\.[0-9]+$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;

/** A string matching HOSTNAME_PATTERN — never coerced from any other type. */
export function isHostname(value: unknown): value is string {
  return typeof value === "string" && HOSTNAME_PATTERN.test(value);
}

/** A string matching SUBSCRIPTION_KEY_PATTERN — never coerced from any other type. */
export function isSubscriptionKey(value: unknown): value is string {
  return typeof value === "string" && SUBSCRIPTION_KEY_PATTERN.test(value);
}

/**
 * True iff a `blob` header's declared `{bytes, chunks}` is internally
 * consistent — checked before a single byte is ever kept (M8 Task 1
 * security review): both are safe integers, `bytes` is 1..MAX_BLOB_BYTES,
 * `chunks` is 1..MAX_BLOB_CHUNKS, `chunks` is at least enough to carry
 * `bytes` at MAX_BLOB_CHUNK_BYTES per frame, and never more than one frame
 * per byte (a chunk can never be empty).
 */
export function isValidBlobShape(bytes: number, chunks: number): boolean {
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(chunks)) return false;
  if (bytes < 1 || bytes > MAX_BLOB_BYTES) return false;
  if (chunks < 1 || chunks > MAX_BLOB_CHUNKS) return false;
  if (chunks < Math.ceil(bytes / MAX_BLOB_CHUNK_BYTES)) return false;
  if (chunks > bytes) return false;
  return true;
}

export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  unsupportedData: 1003,
  internalError: 1011,
  badFrame: 4400,
  unauthorized: 4401,
  pairingDenied: 4403,
  handshakeTimeout: 4408,
  revoked: 4410,
  congested: 4413,
  versionMismatch: 4426,
  tooManyRequests: 4429,
  overCapacity: 4503,
} as const;

export const REMOTE_ERROR_CODES = [
  "bad-request",
  "unknown-channel",
  "forbidden",
  "internal",
  "rate-limited",
  "unsupported",
  "locked",
] as const;
export type RemoteErrorCode = (typeof REMOTE_ERROR_CODES)[number];

// Owner login (Phase 0). camelCase verbs because the frame parser's channel
// pattern rejects hyphens. The bridge handles these itself, per connection,
// before the channel-policy router.
export const AUTH_CHANNELS = [
  "auth:status",
  "auth:login",
  "auth:passkeyBegin",
  "auth:passkeyFinish",
  "auth:passkeyRegisterBegin",
  "auth:passkeyRegisterFinish",
  "auth:refresh",
  "auth:resume",
  "auth:logout",
] as const;
export type AuthChannel = (typeof AUTH_CHANNELS)[number];

/** The only channels a locked connection accepts: registering a passkey needs an unlocked one. */
export const LOCKED_ALLOWED: readonly AuthChannel[] = [
  "auth:status",
  "auth:login",
  "auth:passkeyBegin",
  "auth:passkeyFinish",
  "auth:refresh",
  "auth:resume",
  "auth:logout",
];

/**
 * The one push a connection receives without subscribing: sent the moment
 * an unlocked connection locks (access expiry, logout, a revoked token
 * family, or an owner-credential invalidation), as
 * `{t:"psh", ch:"auth:state", p:{locked:true, reason}, seq}`. Its `seq`
 * is the connection's ordinary push sequence. The /rpc socket stays open;
 * the client shows its unlock screen and logs in again on the same socket.
 * A `sub` frame refused while locked (it carries no id) is answered with
 * `err` id 0 code "locked" — clients number their requests from 1.
 */
export const AUTH_STATE_CHANNEL = "auth:state";
/** `signed-out`: the owner password changed, a passkey was deleted, the
 *  owner signed out everywhere, or this login's token family was revoked. */
export type AuthLockReason = "expired" | "logout" | "signed-out";
export type AuthStatePush = { locked: true; reason: AuthLockReason };

/** Access and refresh tokens: 32 random bytes as lowercase hex. */
export const AUTH_TOKEN_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_PASSWORD_LENGTH = 1_024;
/** Every base64url WebAuthn field except the attestation object. */
export const MAX_PASSKEY_FIELD_LENGTH = 16_384;
export const MAX_ATTESTATION_OBJECT_LENGTH = 65_536;
export const MAX_PASSKEY_LABEL_LENGTH = 64;

/** Each auth channel's single argument object (sent as `a: [args]`; the empty ones may send `a: []`). */
export type AuthArgs = {
  "auth:status": Record<string, never>;
  "auth:login": { password: string };
  "auth:passkeyBegin": Record<string, never>;
  "auth:passkeyFinish": {
    credentialId: string;
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  "auth:passkeyRegisterBegin": { password: string };
  "auth:passkeyRegisterFinish": {
    credentialId: string;
    clientDataJSON: string;
    attestationObject: string;
    label: string;
  };
  "auth:refresh": { refreshToken: string };
  "auth:resume": { accessToken: string };
  "auth:logout": Record<string, never>;
};

/** Issued by login, passkeyFinish and refresh. `accessExpiresAt` is epoch milliseconds. */
export type AuthTokens = { accessToken: string; refreshToken: string; accessExpiresAt: number };
export type AuthStatus = { locked: boolean; hasPasskeys: boolean; accessExpiresAt?: number };
/** WebAuthn get() options; every binary value is base64url. `timeout` is milliseconds. */
export type PasskeyLoginOptions = {
  challenge: string;
  rpId: string;
  allowCredentials?: string[];
  userVerification?: "required";
  timeout?: number;
};
/** WebAuthn create() options; every binary value is base64url. `timeout` is milliseconds. */
export type PasskeyRegisterOptions = {
  challenge: string;
  rpId: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: string[];
  /** ES256 (-7) then RS256 (-257). */
  pubKeyCredParams?: Array<{ type: "public-key"; alg: -7 | -257 }>;
  authenticatorSelection?: { userVerification: "required"; residentKey: "preferred" };
  attestation?: "none";
  timeout?: number;
};

export type AuthResults = {
  "auth:status": AuthStatus;
  "auth:login": AuthTokens;
  "auth:passkeyBegin": PasskeyLoginOptions;
  "auth:passkeyFinish": AuthTokens;
  "auth:passkeyRegisterBegin": PasskeyRegisterOptions;
  "auth:passkeyRegisterFinish": null;
  "auth:refresh": AuthTokens;
  "auth:resume": AuthStatus;
  "auth:logout": null;
};

export type SubTarget = string | { ch: string; key: string };

export type ClientMessage =
  | { t: "hello"; v: number; deviceId: string; token: string; client: string }
  | { t: "req"; id: number; ch: string; a: unknown[] }
  | { t: "sub"; add?: SubTarget[]; drop?: SubTarget[] }
  | { t: "blob"; id: number; ch: string; a: unknown[]; bytes: number; chunks: number }
  | { t: "pong"; seq: number }
  | { t: "bye" };

export type ServerMessage =
  | { t: "welcome"; v: number; capabilities: string[] }
  | { t: "res"; id: number; v: unknown }
  | { t: "err"; id: number; code: RemoteErrorCode; text: string; language: "ar" | "en" }
  | { t: "psh"; ch: string; p: unknown; seq: number; dropped?: number }
  | { t: "ping"; seq: number };

export type PairClientMessage = {
  t: "pair";
  v: number;
  secret: string;
  deviceName: string;
  client: string;
};
export type PairServerMessage = { t: "paired"; v: number; deviceId: string; token: string };

// `name` (M11, ruling 1) is set only when the laptop serves a configured
// certificate carrying a DNS SAN: its presence is what tells the phone to
// dial that name with the OS trust store instead of pinning the leaf.
export type PairingLink = {
  host: string;
  port: number;
  secret: string;
  fingerprint: string;
  name?: string;
};

export function encodeMessage(
  message: ClientMessage | ServerMessage | PairClientMessage | PairServerMessage,
): string {
  return JSON.stringify(message);
}
