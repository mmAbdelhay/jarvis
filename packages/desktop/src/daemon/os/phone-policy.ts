// What a paired phone may do with Rafiq (M3 contracts §2): exactly the
// allowlist — agent:prompt/stop/confirm/undo, audit:list, memory:list, the
// voice:utterance blob — and the agent:events and sys:snapshot pushes.
// Everything else is refused before it reaches the router (which refuses it
// again: os-binding.ts PHONE_REQUESTS). Password-tier approvals are refused
// by the risk gate (confirmFrom → allowPassword: false); phone approvals are
// audited "phone:<deviceName>" from the bridge's authenticated device only.
//
// No electron here (core/no-electron.test.ts).
import type {
  AuditPolicy,
  ChannelPolicies,
  ChannelPolicy,
  ErrorText,
  RequestHandler,
} from "@jarvis/remote";
import {
  MAX_VOICE_BYTES,
  OS_CONTROL_BLOBS,
  OS_CONTROL_PUSHES,
  OS_CONTROL_REQUESTS,
  type RemoteErrorCode,
} from "@jarvis/wire";
import { ControlRequestError } from "../control/messages.js";
import { type OsRouter, PHONE_REQUESTS } from "./os-binding.js";

export const PHONE_BLOBS: ReadonlyMap<string, number> = new Map([
  [OS_CONTROL_BLOBS.voiceUtterance, MAX_VOICE_BYTES],
]);

export const PHONE_PUSHES: ChannelPolicies = new Map<string, ChannelPolicy>([
  [OS_CONTROL_PUSHES.agentEvents, { kind: "reliable" }],
  [OS_CONTROL_PUSHES.sysSnapshot, { kind: "latest" }],
]);

const KNOWN_OS_CHANNELS: ReadonlySet<string> = new Set<string>([
  ...Object.values(OS_CONTROL_REQUESTS),
  ...Object.values(OS_CONTROL_BLOBS),
  ...Object.values(OS_CONTROL_PUSHES),
  // Named refusals of the contract, whether or not this build serves them.
  "memory:setEnabled",
  "registry:install",
  "registry:remove",
]);

const READS: ReadonlySet<string> = new Set([
  OS_CONTROL_REQUESTS.auditList,
  OS_CONTROL_REQUESTS.memoryList,
]);

export function phoneAuditPolicy(channel: string): AuditPolicy {
  return READS.has(channel) ? "never" : "always";
}

const ERROR_TEXT: Readonly<Record<RemoteErrorCode, string>> = {
  "bad-request": "Jarvis could not read that request.",
  "unknown-channel": "This computer does not offer that.",
  forbidden: "That can only be done on the computer.",
  internal: "Something went wrong on the computer.",
  "rate-limited": "Too many requests. Wait a moment.",
  unsupported: "This computer does not support that.",
  locked: "The computer's screen is locked.",
};

/** An owner-login refusal (auth:* channels) reads as a wrong password, not "computer only". */
export const phoneErrorText: ErrorText = (code, authChannel) => ({
  text:
    authChannel !== undefined && code === "forbidden"
      ? "Wrong password or passkey."
      : ERROR_TEXT[code],
  language: "en",
});

type Refusable = "bad-request" | "forbidden" | "locked" | "unsupported" | "rate-limited";
const REFUSABLE: ReadonlySet<string> = new Set<Refusable>([
  "bad-request",
  "forbidden",
  "locked",
  "unsupported",
  "rate-limited",
]);

// A record with own keys only: "__proto__" or "constructor" never read a prototype value.
const KNOWN_RECORD: Readonly<Record<string, true>> = Object.fromEntries(
  [...KNOWN_OS_CHANNELS].map((channel) => [channel, true] as const),
);

function refusedOrUnknown(channel: string): { kind: "forbidden" } | { kind: "unknown-channel" } {
  return Object.hasOwn(KNOWN_RECORD, channel) ? { kind: "forbidden" } : { kind: "unknown-channel" };
}

export function createPhoneRequestHandler(
  router: () => OsRouter,
  log: (line: string) => void,
): RequestHandler {
  return async (channel, args, device, blob) => {
    // The device comes only from the bridge's authentication, never from args.
    const origin = { kind: "phone" as const, device: { id: device.id, name: device.name } };
    let run: () => Promise<unknown>;
    if (blob !== undefined) {
      const limit = PHONE_BLOBS.get(channel);
      if (limit === undefined || blob.byteLength > limit) return refusedOrUnknown(channel);
      run = () => router().upload(channel, args, blob, origin);
    } else {
      if (PHONE_BLOBS.has(channel) || !PHONE_REQUESTS.has(channel))
        return refusedOrUnknown(channel);
      run = () => router().invoke(channel, args, origin);
    }
    try {
      return { kind: "value", value: await run() };
    } catch (error) {
      if (error instanceof ControlRequestError && REFUSABLE.has(error.code)) {
        return { kind: "refused", code: error.code as Refusable, text: error.message };
      }
      if (error instanceof ControlRequestError && error.code === "unknown-channel") {
        return { kind: "unknown-channel" };
      }
      // Never the message: it may hold a path or a tool's stderr.
      log(`[phone] ${channel} failed`);
      throw new Error("internal");
    }
  };
}
