import type { Session } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import {
  findRow,
  firstOpenableRow,
  historyRow,
  selectedRow,
  isActiveRow,
  mergeSessions,
} from "./sessions-merge";
import type { SessionRowView } from "./sessions-store";

function live(overrides: Partial<SessionRowView> = {}): SessionRowView {
  return {
    id: "a",
    label: "api",
    summary: "live one",
    state: "running",
    agentId: "claude-main",
    project: "api",
    projectPath: "/code/api",
    startedAt: 1000,
    lastActivityAt: 2000,
    ...overrides,
  };
}

function saved(overrides: Partial<Session> = {}): Session {
  return {
    id: "h",
    project: "web",
    projectPath: "/code/web",
    agentId: "copilot",
    state: "done",
    summary: "saved one",
    startedAt: 100,
    lastActivityAt: 500,
    ...overrides,
  };
}

describe("mergeSessions", () => {
  it("keeps the live row when an id is in both lists", () => {
    const rows = mergeSessions([live({ id: "x", summary: "from live" })], [saved({ id: "x" })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ summary: "from live", source: "live" });
  });

  it("flags history-only rows", () => {
    const rows = mergeSessions([live()], [saved()]);
    expect(rows.find((row) => row.id === "h")?.source).toBe("history");
    expect(rows.find((row) => row.id === "a")?.source).toBe("live");
  });

  it("marks a row imported when it has a transcript path", () => {
    const rows = mergeSessions([], [saved({ transcriptPath: "/t.jsonl" }), saved({ id: "i" })]);
    expect(rows.find((row) => row.id === "h")?.imported).toBe(true);
    expect(rows.find((row) => row.id === "i")?.imported).toBe(false);
  });

  it("puts waiting first, then running, then ended newest first", () => {
    const rows = mergeSessions(
      [
        live({ id: "run", lastActivityAt: 9000 }),
        live({ id: "wait", state: "waiting", lastActivityAt: 100 }),
        live({ id: "old", state: "done", endedAt: 300 }),
      ],
      [saved({ id: "new", endedAt: 800 })],
    );
    expect(rows.map((row) => row.id)).toEqual(["wait", "run", "new", "old"]);
  });

  it("shows a saved row that claims to be running as ended", () => {
    const rows = mergeSessions([], [saved({ state: "running" })]);
    expect(rows[0]?.state).toBe("dead");
    expect(rows[0] && isActiveRow(rows[0])).toBe(false);
  });
});

describe("historyRow", () => {
  it("falls back to the project path for the label and keeps git totals", () => {
    const row = historyRow(saved({ project: null, insertions: 4, deletions: 1, changedFiles: 2 }));
    expect(row).toMatchObject({ label: "web", insertions: 4, deletions: 1, changedFiles: 2 });
  });
});

describe("findRow", () => {
  it("finds history-only rows, so a selection counts as present", () => {
    const rows = mergeSessions([live()], [saved()]);
    expect(findRow(rows, "h")?.source).toBe("history");
    expect(findRow(rows, "nope")).toBeUndefined();
    expect(findRow(rows, undefined)).toBeUndefined();
  });
});

describe("selectedRow", () => {
  it("keeps a remembered row of the same id once the rows no longer hold it", () => {
    const remembered = findRow(mergeSessions([live()], [saved()]), "h");
    const rows = mergeSessions([live()], []);
    expect(selectedRow(rows, "h", remembered)).toBe(remembered);
    expect(selectedRow(rows, "other", remembered)).toBeUndefined();
    expect(selectedRow(rows, undefined, remembered)).toBeUndefined();
    expect(selectedRow(mergeSessions([live()], [saved()]), "h", undefined)?.id).toBe("h");
  });
});

describe("firstOpenableRow", () => {
  it("picks the first row, skipping one outside Jarvis", () => {
    const rows = mergeSessions([live({ id: "ext", origin: "external" }), live({ id: "own" })], []);
    expect(firstOpenableRow(rows)?.id).toBe("own");
  });

  it("is undefined for an empty list", () => {
    expect(firstOpenableRow([])).toBeUndefined();
  });
});
