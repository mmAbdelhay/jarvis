// Channel push policy and subscription-key rules (M5 plan, "streams").
// Pure: no third-party imports, no desktop channel names — a channel's
// *name* is decided in @jarvis/desktop's REMOTE_PUSH_POLICY map, which
// imports these types; this file only knows the shapes a policy can take
// and the bounds a subscription key must respect. Reachable from
// index.ts (like outbox.ts) with nothing here ever touching a socket.
//
// `SUBSCRIPTION_KEY_PATTERN` and `isSubscriptionKey` are re-exported from
// @jarvis/wire (M6 ruling 4) — the phone app validates the same key shape
// client-side, so there is exactly one definition.
export { isSubscriptionKey, SUBSCRIPTION_KEY_PATTERN } from "@jarvis/wire";

/** Per-`(channel, key)` cap on buffered stream bytes (spec, "Bounds"). */
export const STREAM_MAX_BYTES = 262_144;

/** Per-connection cap on distinct keyed subscriptions (spec, "Bounds"). */
export const MAX_KEYED_SUBSCRIPTIONS = 16;

export type ReliablePolicy = {
  kind: "reliable";
  keyOf?: (payload: unknown) => string | undefined;
};

export type LatestPolicy = { kind: "latest" };

export type StreamPolicy = {
  kind: "stream";
  maxBytes: number;
  keyOf(payload: unknown): string | undefined;
  chunkOf(payload: unknown): string;
  offsetOf(payload: unknown): number | undefined;
  withChunk(payload: unknown, chunk: string, offset: number | undefined): unknown;
};

export type ChannelPolicy = ReliablePolicy | LatestPolicy | StreamPolicy;

export type ChannelPolicies = ReadonlyMap<string, ChannelPolicy>;

/** True for `stream`, and for `reliable` with a `keyOf`; false otherwise. */
export function isKeyedPolicy(policy: ChannelPolicy): boolean {
  if (policy.kind === "stream") return true;
  if (policy.kind === "reliable") return policy.keyOf !== undefined;
  return false;
}

/** The UTF-8 byte length Buffer.byteLength counts, including 3 bytes per lone surrogate. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Removes at least `minBytes` UTF-8 bytes from the head of `text`, never
 * splitting a code point. Walks `text` by Unicode code point (the string
 * iterator itself pairs a valid surrogate pair into one step, so a lone
 * surrogate is the only code point ever counted as 3 bytes on its own),
 * summing each one's UTF-8 length until the running total is at least
 * `minBytes`. `minBytes <= 0` removes nothing; `minBytes >= utf8Bytes(text)`
 * removes everything. `minBytes` that is `NaN` or otherwise non-finite
 * (`Infinity`, `-Infinity`) also removes nothing — a comparison against a
 * non-finite bound is never a meaningful "drop everything" signal, so a
 * bad one is treated as a no-op rather than silently emptying the text.
 */
export function dropHead(
  text: string,
  minBytes: number,
): { rest: string; droppedBytes: number; droppedUnits: number } {
  if (!Number.isFinite(minBytes) || minBytes <= 0) {
    return { rest: text, droppedBytes: 0, droppedUnits: 0 };
  }
  let droppedBytes = 0;
  let droppedUnits = 0;
  for (const codePoint of text) {
    if (droppedBytes >= minBytes) break;
    droppedBytes += utf8Bytes(codePoint);
    droppedUnits += codePoint.length;
  }
  return { rest: text.slice(droppedUnits), droppedBytes, droppedUnits };
}
