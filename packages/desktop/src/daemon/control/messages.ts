// The control transport's message shapes, parsed field by field (conventions:
// "Parse wire values field by field"). After the hello, frames are the
// @jarvis/wire req/blob/res/err/psh/welcome shapes; only the hello (a local
// secret plus a build id instead of a device token) and restart-required are
// the control socket's own.
import { REMOTE_ERROR_CODES, type RemoteErrorCode, type ServerMessage } from "@jarvis/wire";

export type ControlHello = { t: "hello"; v: number; secret: string; build: string };

export type ControlClientMessage =
  | { t: "req"; id: number; ch: string; a: unknown[] }
  | { t: "blob"; id: number; ch: string; a: unknown[]; bytes: number; chunks: number };

export type ControlServerMessage =
  | Exclude<ServerMessage, { t: "ping" }>
  | { t: "restart-required"; build: string };

/** A handler's typed refusal; anything else a handler throws is sent as "internal". */
export class ControlRequestError extends Error {
  constructor(
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 32 random bytes as lowercase hex, exactly as the daemon writes it. */
export const CONTROL_SECRET_PATTERN = /^[0-9a-f]{64}$/;
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

export function parseHello(value: unknown): ControlHello | undefined {
  if (!isFields(value) || value.t !== "hello") return undefined;
  const { v, secret, build } = value;
  if (!isId(v) || typeof secret !== "string" || !isBuild(build)) return undefined;
  return { t: "hello", v, secret, build };
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
    case "restart-required":
      return isBuild(value.build) ? { t: "restart-required", build: value.build } : undefined;
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
