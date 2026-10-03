import { describe, expect, it } from "vitest";
import type { SessionSummary } from "./dashboard-store";
import {
  type ActiveRow,
  activeRows,
  activeSubtitle,
  activeTitle,
  workingCount,
} from "./home-active";

function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: "s",
    project: "api",
    agentId: "claude-main",
    state: "running",
    summary: "Add orders migration",
    startedAt: 0,
    ...overrides,
  };
}

function only(summary: SessionSummary): ActiveRow {
  const [row] = activeRows([summary], {});
  if (row === undefined) throw new Error("expected a live row");
  return row;
}

describe("activeRows", () => {
  it("lists live sessions only, waiting first, then newest first", () => {
    const rows = activeRows(
      [
        session({ id: "old", startedAt: 1 }),
        session({ id: "new", startedAt: 5 }),
        session({ id: "wait", state: "waiting", startedAt: 0 }),
        session({ id: "done", state: "done", startedAt: 9 }),
        session({ id: "start", state: "starting", startedAt: 3 }),
      ],
      {},
    );
    expect(rows.map((row) => row.id)).toEqual(["wait", "new", "start", "old"]);
  });

  it("attaches counts only when the store has the session", () => {
    const rows = activeRows([session({ id: "a" }), session({ id: "b" })], {
      a: { files: 1, insertions: 84, deletions: 12 },
    });
    expect(rows[0]?.counts ?? rows[1]?.counts).toEqual({
      files: 1,
      insertions: 84,
      deletions: 12,
    });
    expect(rows.filter((row) => row.counts === undefined)).toHaveLength(1);
  });

  it("marks process-scan rows external", () => {
    expect(activeRows([session({ origin: "external" })], {})[0]?.external).toBe(true);
  });
});

describe("activeSubtitle", () => {
  const now = 14 * 60_000;
  it("composes project, agent and status", () => {
    expect(activeSubtitle("en", only(session({})), now)).toBe("api · claude-main · running 14m");
    expect(activeSubtitle("en", only(session({ state: "waiting" })), now)).toBe(
      "api · claude-main · waiting",
    );
  });

  it("skips a null project and says outside Jarvis for external rows", () => {
    const row = only(session({ project: null, origin: "external" }));
    expect(activeSubtitle("en", row, now)).toBe("claude-main · outside Jarvis");
  });

  it("leaves the project out of an external row's sub line: it is the title", () => {
    const row = only(session({ project: "video-streaming", agentId: "codex", origin: "external" }));
    expect(activeSubtitle("en", row, now)).toBe("codex · outside Jarvis");
  });
});

describe("activeTitle", () => {
  it("keeps a Jarvis session's summary", () => {
    expect(activeTitle(only(session({})))).toBe("Add orders migration");
  });

  it("titles an external row by its project, else its agent", () => {
    const summary = "Running outside Jarvis";
    expect(
      activeTitle(only(session({ project: "video-streaming", summary, origin: "external" }))),
    ).toBe("video-streaming");
    expect(
      activeTitle(only(session({ project: null, agentId: "codex", summary, origin: "external" }))),
    ).toBe("codex");
  });
});

describe("workingCount", () => {
  it("counts running and waiting sessions, external ones included", () => {
    expect(
      workingCount([
        session({ id: "a", origin: "external" }),
        session({ id: "b", origin: "external", state: "waiting" }),
        session({ id: "c" }),
        session({ id: "d", state: "done" }),
        session({ id: "e", state: "starting" }),
      ]),
    ).toBe(3);
  });
});
