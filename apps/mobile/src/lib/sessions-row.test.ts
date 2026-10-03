import { describe, expect, it } from "vitest";
import type { MergedRow } from "./sessions-merge";
import { resumable, rowCounts, rowSubtitle, rowTimeLabel, rowVariant } from "./sessions-row";

const NOW = new Date(2026, 8, 19, 12, 0, 0).getTime();

function row(over: Partial<MergedRow> = {}): MergedRow {
  return {
    id: "s",
    label: "api",
    summary: "task",
    state: "running",
    agentId: "claude-main",
    project: "api",
    projectPath: "/code/api",
    startedAt: NOW - 14 * 60_000,
    lastActivityAt: NOW,
    source: "live",
    imported: false,
    ...over,
  };
}

describe("rowTimeLabel", () => {
  it("shows the running elapsed for an active row", () => {
    expect(rowTimeLabel(row(), NOW)).toBe("14m");
  });

  it("shows the duration for a row that ended today", () => {
    const start = NOW - 3_600_000;
    expect(rowTimeLabel(row({ state: "done", startedAt: start, endedAt: NOW - 60_000 }), NOW)).toBe(
      "59m",
    );
  });

  it("shows the clock time for an older row", () => {
    const ended = new Date(2026, 8, 18, 22, 10).getTime();
    expect(rowTimeLabel(row({ state: "done", endedAt: ended }), NOW)).toBe("22:10");
  });
});

describe("rowSubtitle", () => {
  it("has no status for a plain live row", () => {
    expect(rowSubtitle("en", row())).toBe("api · claude-main");
  });

  it("says done, imported and outside Jarvis", () => {
    expect(rowSubtitle("en", row({ state: "done" }))).toBe("api · claude-main · done");
    expect(rowSubtitle("en", row({ state: "done", imported: true }))).toBe(
      "api · claude-main · imported",
    );
    expect(rowSubtitle("en", row({ origin: "external" }))).toContain("outside Jarvis");
  });
});

describe("rowVariant", () => {
  it("separates waiting, active and done", () => {
    expect(rowVariant(row({ state: "waiting" }))).toBe("waiting");
    expect(rowVariant(row())).toBe("active");
    expect(rowVariant(row({ source: "history", state: "dead" }))).toBe("done");
  });
});

describe("rowCounts", () => {
  it("prefers the live push over the saved totals", () => {
    const live = { s: { files: 1, insertions: 9, deletions: 3 } };
    expect(rowCounts(row({ insertions: 1 }), live)).toEqual({ insertions: 9, deletions: 3 });
  });

  it("falls back to the saved totals and hides zeros", () => {
    expect(rowCounts(row({ insertions: 4 }), {})).toEqual({ insertions: 4, deletions: 0 });
    expect(rowCounts(row({ insertions: 0, deletions: 0 }), {})).toBeUndefined();
    expect(rowCounts(row(), {})).toBeUndefined();
  });
});

describe("resumable", () => {
  it("needs a finished session and a project", () => {
    expect(resumable(row({ state: "done" }))).toBe(true);
    expect(resumable(row({ state: "done", project: null }))).toBe(false);
    expect(resumable(row())).toBe(false);
  });
});
