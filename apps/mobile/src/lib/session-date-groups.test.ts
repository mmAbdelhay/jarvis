import { describe, expect, it } from "vitest";
import { groupEndedByDate, sessionDateLabel } from "./session-date-groups";
import type { SessionRowView } from "./sessions-store";

function row(overrides: Partial<SessionRowView> = {}): SessionRowView {
  return {
    id: "s1",
    label: "acme",
    summary: "fixing tests",
    state: "done",
    agentId: "claude-main",
    startedAt: 0,
    lastActivityAt: 0,
    ...overrides,
  };
}

// A fixed local-time anchor: 2026-09-19 12:00 local.
const NOW = new Date(2026, 8, 19, 12, 0, 0).getTime();
const YESTERDAY = new Date(2026, 8, 18, 9, 30, 0).getTime();
const TWO_DAYS_AGO = new Date(2026, 8, 17, 9, 30, 0).getTime();

describe("sessionDateLabel", () => {
  it("labels the same calendar day as today", () => {
    expect(sessionDateLabel(new Date(2026, 8, 19, 0, 1).getTime(), NOW)).toEqual({
      kind: "today",
    });
  });

  it("labels the previous calendar day as yesterday", () => {
    expect(sessionDateLabel(YESTERDAY, NOW)).toEqual({ kind: "yesterday" });
  });

  it("labels anything earlier with its own day's start-of-day ms", () => {
    expect(sessionDateLabel(TWO_DAYS_AGO, NOW)).toEqual({
      kind: "date",
      ms: new Date(2026, 8, 17, 0, 0, 0, 0).getTime(),
    });
  });
});

describe("groupEndedByDate", () => {
  it("groups contiguous same-day rows into one bucket, in order", () => {
    const rows = [
      row({ id: "a", endedAt: new Date(2026, 8, 19, 10, 0).getTime() }),
      row({ id: "b", endedAt: new Date(2026, 8, 19, 9, 0).getTime() }),
      row({ id: "c", endedAt: YESTERDAY }),
    ];
    const groups = groupEndedByDate(rows, NOW);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.label).toEqual({ kind: "today" });
    expect(groups[0]?.rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(groups[1]?.label).toEqual({ kind: "yesterday" });
    expect(groups[1]?.rows.map((r) => r.id)).toEqual(["c"]);
  });

  it("falls back to lastActivityAt when endedAt is absent", () => {
    const rows = [row({ id: "a", lastActivityAt: YESTERDAY })];
    const groups = groupEndedByDate(rows, NOW);
    expect(groups).toEqual([{ label: { kind: "yesterday" }, rows: [rows[0]] }]);
  });

  it("returns [] for an empty list", () => {
    expect(groupEndedByDate([], NOW)).toEqual([]);
  });
});
