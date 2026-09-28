// The control transport's message shapes, parsed field by field (conventions:
// "Parse wire values field by field"). After the handshake, frames are the
// @jarvis/wire req/blob/res/err/psh/welcome shapes; the handshake frames
// (hello, challenge, auth — see handshake.ts), restart-required and the
// daemon's own start-up probe are the control socket's own.
//
// Frozen contract: hello (with its optional intent), challenge, auth,
// restart-required and stopping must keep these shapes across every
// CONTROL_PROTOCOL_VERSION. A version mismatch is itself reported through
// them — an app meeting a daemon of another version has to be able to
// authenticate and read restart-required to recover, and to stop that
// daemon (intent "stop") where no service manager can (review C1).
import { REMOTE_ERROR_CODES, type RemoteErrorCode, type ServerMessage } from "@jarvis/wire";
import { HEX32_PATTERN } from "./handshake.js";

/** `intent: "stop"` asks the daemon to stop once the client has proven
 *  itself, whatever build or protocol version either side runs; the daemon
 *  answers `stopping` and serves nothing else on that connection. */
export type ControlHello = {
  t: "hello";
  v: number;
  build: string;
  nonceC: string;
  intent?: "stop";
};
export type ControlChallenge = { t: "challenge"; nonceS: string; proof: string };
export type ControlAuth = { t: "auth"; proof: string };
/** Sent by a starting daemon to itself, to confirm the endpoint reaches it. */
export type ControlProbe = { t: "probe"; token: string };

export type ControlClientMessage =
  | { t: "req"; id: number; ch: string; a: unknown[] }
  | { t: "blob"; id: number; ch: string; a: unknown[]; bytes: number; chunks: number };

export type ControlServerMessage =
  | Exclude<ServerMessage, { t: "ping" }>
  | ControlChallenge
  | { t: "restart-required"; build: string }
  | { t: "stopping" };

/** A handler's typed refusal; anything else a handler throws is sent as "internal". */
export class ControlRequestError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const MAX_CHANNEL_LENGTH = 128;
const MAX_BUILD_LENGTH = 256;

type Fields = Record<string, unknown>;

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isChannel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CHANNEL_LENGTH;
}

function isBuild(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_BUILD_LENGTH;
}

function isHex32(value: unknown): value is string {
  return typeof value === "string" && HEX32_PATTERN.test(value);
}

/** The first frame on a connection: a client's hello, or the daemon's own probe. */
export function parseOpening(value: unknown): ControlHello | ControlProbe | undefined {
  if (!isFields(value)) return undefined;
  if (value.t === "probe")
    return isHex32(value.token) ? { t: "probe", token: value.token } : undefined;
  if (value.t !== "hello") return undefined;
  const { v, build, nonceC, intent } = value;
  if (!isId(v) || !isBuild(build) || !isHex32(nonceC)) return undefined;
  if (intent === undefined) return { t: "hello", v, build, nonceC };
  return intent === "stop" ? { t: "hello", v, build, nonceC, intent } : undefined;
}

export function parseAuth(value: unknown): ControlAuth | undefined {
  if (!isFields(value) || value.t !== "auth" || !isHex32(value.proof)) return undefined;
  return { t: "auth", proof: value.proof };
}

export function parseClientMessage(value: unknown): ControlClientMessage | undefined {
  if (!isFields(value)) return undefined;
  const { t, id, ch, a } = value;
  if (!isId(id) || !isChannel(ch) || !Array.isArray(a)) return undefined;
  if (t === "req") return { t, id, ch, a };
  if (t !== "blob") return undefined;
  const { bytes, chunks } = value;
  if (typeof bytes !== "number" || typeof chunks !== "number") return undefined;
  return { t, id, ch, a, bytes, chunks };
}

function isErrorCode(value: unknown): value is RemoteErrorCode {
  return typeof value === "string" && (REMOTE_ERROR_CODES as readonly string[]).includes(value);
}

export function parseServerMessage(value: unknown): ControlServerMessage | undefined {
  if (!isFields(value)) return undefined;
  switch (value.t) {
    case "welcome": {
      const { v, capabilities } = value;
      if (!isId(v) || !Array.isArray(capabilities)) return undefined;
      if (!capabilities.every((c) => typeof c === "string")) return undefined;
      return { t: "welcome", v, capabilities };
    }
    case "challenge": {
      const { nonceS, proof } = value;
      return isHex32(nonceS) && isHex32(proof) ? { t: "challenge", nonceS, proof } : undefined;
    }
    case "restart-required":
      return isBuild(value.build) ? { t: "restart-required", build: value.build } : undefined;
    case "stopping":
      return { t: "stopping" };
    case "res":
      return isId(value.id) ? { t: "res", id: value.id, v: value.v } : undefined;
    case "err": {
      const { id, code, text } = value;
      if (!isId(id) || !isErrorCode(code) || typeof text !== "string") return undefined;
      return { t: "err", id, code, text, language: "en" };
    }
    case "psh": {
      const { ch, seq } = value;
      if (!isChannel(ch) || !isId(seq)) return undefined;
      return { t: "psh", ch, p: value.p, seq };
    }
    default:
      return undefined;
  }
}
