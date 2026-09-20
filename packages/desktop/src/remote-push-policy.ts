// Every push channel a paired phone may subscribe to, and how it must be
// delivered.
//
// REMOTE_PUSH_POLICY is typed as a total map over every PushChannels key —
// { readonly [C in keyof PushChannels]: ChannelPolicy | "desktop-only" } —
// so a new push channel that lands in channels.ts without a line here is a
// tsc error, never a channel a phone silently never receives (or, worse,
// silently does). "desktop-only" channels are this window's own chrome or
// name a local child process a phone never started (setup:output,
// voice:hotkeys, the two DevTools notices, remote:update); every other
// channel gets a real ChannelPolicy.
//
// The three stream channels (terminal:data, session:output, docker:log)
// carry a key in their payload — paneKey, sessionId, tabId — so their
// codecs read that field defensively: `keyOf` never coerces a non-string
// field into a key, `chunkOf` never throws on a malformed payload, and
// `withChunk` always builds a fresh object with exactly that channel's own
// fields rather than spreading whatever the input happened to carry (a
// spread would let an extra field the sender attached ride along to every
// subscriber, keyed subscription or not).
import type {
  AuthenticatedDevice,
  AuthorizeKey,
  ChannelPolicies,
  ChannelPolicy,
  StreamPolicy,
} from "@jarvis/remote";
import { STREAM_MAX_BYTES } from "@jarvis/remote";
import type { PushChannels } from "./channels.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(payload: unknown, field: string): string | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[field];
  return typeof value === "string" ? value : undefined;
}

function numberField(payload: unknown, field: string): number | undefined {
  if (!isRecord(payload)) return undefined;
  const value = payload[field];
  return typeof value === "number" ? value : undefined;
}

/** Keyed by `paneKey`, offset by `offset` — a Terminal pane's live output. */
const terminalDataPolicy: StreamPolicy = {
  kind: "stream",
  maxBytes: STREAM_MAX_BYTES,
  keyOf: (payload) => stringField(payload, "paneKey"),
  chunkOf: (payload) => stringField(payload, "chunk") ?? "",
  offsetOf: (payload) => numberField(payload, "offset"),
  withChunk: (payload, chunk, offset) => ({
    paneKey: stringField(payload, "paneKey") ?? "",
    chunk,
    offset,
  }),
};

/** Keyed by `sessionId`, offset by `offset` — a session's live transcript. */
const sessionOutputPolicy: StreamPolicy = {
  kind: "stream",
  maxBytes: STREAM_MAX_BYTES,
  keyOf: (payload) => stringField(payload, "sessionId"),
  chunkOf: (payload) => stringField(payload, "chunk") ?? "",
  offsetOf: (payload) => numberField(payload, "offset"),
  withChunk: (payload, chunk, offset) => ({
    sessionId: stringField(payload, "sessionId") ?? "",
    chunk,
    offset,
  }),
};

/** Keyed by `tabId`, no offset — a Docker follower carries no cursor
 *  (PushChannels["docker:log"] is `{ tabId, chunk }`, unchanged by M5). */
const dockerLogPolicy: StreamPolicy = {
  kind: "stream",
  maxBytes: STREAM_MAX_BYTES,
  keyOf: (payload) => stringField(payload, "tabId"),
  chunkOf: (payload) => stringField(payload, "chunk") ?? "",
  offsetOf: () => undefined,
  withChunk: (payload, chunk) => ({
    tabId: stringField(payload, "tabId") ?? "",
    chunk,
  }),
};

export const REMOTE_PUSH_POLICY: {
  readonly [C in keyof PushChannels]: ChannelPolicy | "desktop-only";
} = {
  // This window's own chrome — a phone has no DevTools dock to be told about.
  "workspace:devtoolsDockChosen": "desktop-only",
  "workspace:devtoolsClosed": "desktop-only",
  // Each names a local child process a phone never started.
  "setup:output": "desktop-only",
  "voice:hotkeys": "desktop-only",
  // Local to this window only (remote-access.ts's onStatus, ruling 36) — the
  // wire protocol has no message that carries a RemoteStatus at all.
  "remote:update": "desktop-only",

  "metrics:update": { kind: "latest" },
  "sessions:update": { kind: "latest" },
  "providers:update": { kind: "latest" },
  "git:counts": { kind: "latest" },

  "turn:new": { kind: "reliable" },
  "voice:listening": { kind: "reliable" },
  "voice:speaking": { kind: "reliable" },
  "voice:notice": { kind: "reliable" },
  "workspace:update": { kind: "reliable" },
  // Keyed, unlike the five reliable channels above: a phone that only cares
  // about one pane subscribes to that pane's exit, not every pane's.
  "terminal:exit": { kind: "reliable", keyOf: (payload) => stringField(payload, "paneKey") },

  "terminal:data": terminalDataPolicy,
  "session:output": sessionOutputPolicy,
  "docker:log": dockerLogPolicy,
};

const DESKTOP_ONLY_PUSH: ReadonlySet<string> = new Set(
  Object.entries(REMOTE_PUSH_POLICY)
    .filter(([, policy]) => policy === "desktop-only")
    .map(([channel]) => channel),
);

/** Every REMOTE_PUSH_POLICY entry that is not "desktop-only", as the
 *  ChannelPolicies map @jarvis/remote's bridge wants. */
export function remotePushPolicies(): ChannelPolicies {
  const map = new Map<string, ChannelPolicy>();
  for (const [channel, policy] of Object.entries(REMOTE_PUSH_POLICY)) {
    if (!DESKTOP_ONLY_PUSH.has(channel)) map.set(channel, policy as ChannelPolicy);
  }
  return map;
}

/** What remoteKeyAuthorizer asks to decide whether a device may subscribe to
 *  one keyed `(channel, key)` pair — real ShellManager/SessionManager/
 *  DockerFollowers methods in main.ts, a fake in tests. `followerOwner`
 *  returns the device id that owns a Docker follower for `tabId`, or
 *  undefined if nobody (or the desktop window itself) does. */
export type StreamOwners = {
  hasPane(paneKey: string): boolean;
  hasSession(sessionId: string): boolean;
  followerOwner(tabId: string): string | undefined;
};

/**
 * Whether `device` may open a keyed subscription to `(channel, key)`
 * (spec, "Capability policy" — a bare channel name never grants a keyed
 * one; this is the other half). `terminal:data`/`terminal:exit` require the
 * pane to still exist; `session:output` requires the session to still
 * exist; `docker:log` requires `key` (a tab id) to be a follower this exact
 * device opened — never another device's, and never the desktop window's
 * own (`followerOwner` returning `"desktop"` compares unequal to any real
 * device id already, so no separate check is needed for it). Every other
 * channel refuses — including the nine unkeyed latest/reliable channels
 * above (the four "latest" ones, plus the five unkeyed "reliable" ones;
 * terminal:exit, the sixth "reliable" channel, is keyed and handled by the
 * case above instead), none of which is keyed at all.
 */
export function remoteKeyAuthorizer(owners: StreamOwners): AuthorizeKey {
  return (channel, key, device: AuthenticatedDevice) => {
    switch (channel) {
      case "terminal:data":
      case "terminal:exit":
        return owners.hasPane(key);
      case "session:output":
        return owners.hasSession(key);
      case "docker:log":
        return owners.followerOwner(key) === device.id;
      default:
        return false;
    }
  };
}
