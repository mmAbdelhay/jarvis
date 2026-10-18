import { describe, expect, it } from "vitest";
import { planDelivery } from "./delivery.js";
import type { PaneState } from "./delivery.js";
import type { QueuedComment } from "./types.js";

const NOW = 1_000_000;
const BATCH_MS = 30_000;
const LINKED = { kind: "linked", paneKey: "pane-1", how: "manual" } as const;

function queued(
  id: string,
  createdAt: number,
  state: QueuedComment["state"] = "queued",
): QueuedComment {
  return {
    prKey: "o/r#1",
    state,
    comment: { id, kind: "issue", author: "reviewer", isBot: false, body: `c${id}`, createdAt },
  };
}

function pane(overrides: Partial<PaneState> = {}): PaneState {
  return {
    hasAgent: true,
    input: "idle-input",
    draft: false,
    quietMs: 5_000,
    sinceKeystrokeMs: 60_000,
    paused: false,
    ...overrides,
  };
}

type Args = Parameters<typeof planDelivery>[0];

function plan(overrides: Partial<Args> = {}) {
  return planDelivery({
    now: NOW,
    queued: [queued("a", NOW - 60_000)],
    link: LINKED,
    pane: pane(),
    batchMs: BATCH_MS,
    force: false,
    ...overrides,
  });
}

describe("planDelivery", () => {
  it("waits with nothing when no comment is queued", () => {
    expect(plan({ queued: [] })).toEqual({ wait: "nothing" });
  });

  it("waits with nothing when every comment is delivered, own or history", () => {
    const all = [
      queued("a", NOW - 60_000, "delivered"),
      queued("b", NOW - 60_000, "own"),
      queued("c", NOW - 60_000, "history"),
    ];
    expect(plan({ queued: all, force: true })).toEqual({ wait: "nothing" });
  });

  it("waits with no-link when the PR has no linked pane", () => {
    expect(plan({ link: { kind: "none" } })).toEqual({ wait: "no-link" });
  });

  it("waits with ambiguous when several panes match", () => {
    expect(plan({ link: { kind: "ambiguous", paneKeys: ["a", "b"] }, force: true })).toEqual({
      wait: "ambiguous",
    });
  });

  it("waits with paused when delivery to the pane is paused", () => {
    expect(plan({ pane: pane({ paused: true }), force: true })).toEqual({ wait: "paused" });
  });

  it("waits with no-agent when no agent runs, even when forced", () => {
    expect(plan({ pane: pane({ hasAgent: false }) })).toEqual({ wait: "no-agent" });
    expect(plan({ pane: pane({ hasAgent: false }), force: true })).toEqual({ wait: "no-agent" });
  });

  it("waits with no-agent when the pane state is missing", () => {
    expect(plan({ pane: undefined, force: true })).toEqual({ wait: "no-agent" });
  });

  it("waits with approval-prompt, even when forced", () => {
    expect(plan({ pane: pane({ input: "approval-prompt" }) })).toEqual({ wait: "approval-prompt" });
    expect(plan({ pane: pane({ input: "approval-prompt" }), force: true })).toEqual({
      wait: "approval-prompt",
    });
  });

  it("waits with busy when the agent is busy", () => {
    expect(plan({ pane: pane({ input: "busy" }) })).toEqual({ wait: "busy" });
  });

  it("treats an unknown input state as busy", () => {
    expect(plan({ pane: pane({ input: "unknown" }) })).toEqual({ wait: "busy" });
  });

  it("waits with busy while pane output was not quiet for 2 s", () => {
    expect(plan({ pane: pane({ quietMs: 1_999 }) })).toEqual({ wait: "busy" });
    expect(plan({ pane: pane({ quietMs: 2_000 }) })).toHaveProperty("send");
  });

  it("waits with typing after a recent keystroke", () => {
    expect(plan({ pane: pane({ sinceKeystrokeMs: 9_999 }) })).toEqual({ wait: "typing" });
    expect(plan({ pane: pane({ sinceKeystrokeMs: 10_000 }) })).toHaveProperty("send");
  });

  it("waits with typing while the input box holds a draft", () => {
    expect(plan({ pane: pane({ draft: true }) })).toEqual({ wait: "typing" });
  });

  it("waits with batching while the newest comment is within the batch window", () => {
    const list = [queued("a", NOW - 60_000), queued("b", NOW - BATCH_MS + 1)];
    expect(plan({ queued: list })).toEqual({ wait: "batching" });
    expect(plan({ queued: [queued("a", NOW - BATCH_MS)] })).toHaveProperty("send");
  });

  it("sends every queued comment oldest first when all conditions hold", () => {
    const list = [queued("c", NOW - 40_000), queued("a", NOW - 90_000), queued("b", NOW - 60_000)];
    const result = plan({ queued: list });
    expect(result).toEqual({ send: [list[1], list[2], list[0]] });
  });

  it("sends when forced even though the pane is busy, typing and batching", () => {
    const list = [queued("a", NOW - 1)];
    const busy = pane({ input: "busy", quietMs: 0, sinceKeystrokeMs: 0, draft: true });
    expect(plan({ queued: list, pane: busy, force: true })).toEqual({ send: list });
  });

  it("never sends delivered or own comments", () => {
    const list = [
      queued("a", NOW - 90_000),
      queued("b", NOW - 80_000, "delivered"),
      queued("c", NOW - 70_000, "own"),
      queued("d", NOW - 60_000),
    ];
    const result = plan({ queued: list });
    expect(result).toEqual({ send: [list[0], list[3]] });
  });
});
