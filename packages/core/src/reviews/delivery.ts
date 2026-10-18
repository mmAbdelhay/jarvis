import type { AgentInputState } from "../session/agent-input-state.js";
import type { LinkResult } from "./link.js";
import type { QueuedComment } from "./types.js";

/** Pane output must be quiet this long before a paste. */
export const DELIVERY_QUIET_MS = 2_000;
/** No user keystroke to the pane for this long before a paste. */
export const DELIVERY_TYPING_MS = 10_000;

// Mirrors Task 3's resolveLink result; the controller unifies the two once both land.
export type PaneState = {
  hasAgent: boolean;
  input: AgentInputState;
  draft: boolean;
  quietMs: number;
  sinceKeystrokeMs: number;
  paused: boolean;
};

export type DeliveryWait =
  | "no-link"
  | "ambiguous"
  | "no-agent"
  | "approval-prompt"
  | "busy"
  | "typing"
  | "batching"
  | "paused"
  | "nothing";

export type DeliveryPlan = { send: QueuedComment[] } | { wait: DeliveryWait };

/**
 * Decides whether the queued comments for one PR may be pasted into its pane now.
 * `force` ("Deliver now") skips the busy, quiet, typing and batching checks, but never
 * the link, pause, agent or approval-prompt checks.
 */
export function planDelivery(args: {
  now: number;
  queued: QueuedComment[];
  link: LinkResult;
  pane?: PaneState;
  batchMs: number;
  force: boolean;
}): DeliveryPlan {
  const { now, link, pane, batchMs, force } = args;
  const pending = args.queued
    .filter((q) => q.state === "queued")
    .sort((a, b) => a.comment.createdAt - b.comment.createdAt);

  if (pending.length === 0) return { wait: "nothing" };
  if (link.kind === "none") return { wait: "no-link" };
  if (link.kind === "ambiguous") return { wait: "ambiguous" };
  if (pane?.paused) return { wait: "paused" };
  if (!pane?.hasAgent) return { wait: "no-agent" };
  if (pane.input === "approval-prompt") return { wait: "approval-prompt" };

  if (!force) {
    if (pane.input !== "idle-input") return { wait: "busy" };
    if (pane.quietMs < DELIVERY_QUIET_MS) return { wait: "busy" };
    if (pane.sinceKeystrokeMs < DELIVERY_TYPING_MS || pane.draft) return { wait: "typing" };
    const newest = Math.max(...pending.map((q) => q.comment.createdAt));
    if (now - newest < batchMs) return { wait: "batching" };
  }

  return { send: pending };
}
