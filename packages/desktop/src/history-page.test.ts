import type { Session } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { HISTORY_PAGE_MAX, historyPage, parseHistoryPageRequest } from "./history-page.js";

function session(id: string, lastActivityAt: number, over: Partial<Session> = {}): Session {
  return {
    id,
    project: "api",
    projectPath: "/code/api",
    agentId: "claude-main",
    state: "done",
    summary: `task ${id}`,
    startedAt: 0,
    lastActivityAt,
    ...over,
  } as Session;
}

describe("parseHistoryPageRequest", () => {
  it("reads a limit, a cursor and a query, capping the limit", () => {
    expect(
      parseHistoryPageRequest({
        limit: 1000,
        before: { lastActivityAt: 5, id: "x" },
        query: " orders ",
      }),
    ).toEqual({
      limit: HISTORY_PAGE_MAX,
      before: { lastActivityAt: 5, id: "x" },
      query: " orders ",
    });
  });

  it("refuses anything that is not a page request", () => {
    expect(parseHistoryPageRequest(undefined)).toBeUndefined();
    expect(parseHistoryPageRequest({ limit: 0 })).toBeUndefined();
    expect(parseHistoryPageRequest({ limit: 1.5 })).toBeUndefined();
    expect(parseHistoryPageRequest({ limit: 5, before: { id: "x" } })).toBeUndefined();
    expect(parseHistoryPageRequest({ limit: 5, query: 4 })).toBeUndefined();
  });

  it("drops a blank query", () => {
    expect(parseHistoryPageRequest({ limit: 5, query: "   " })).toEqual({ limit: 5 });
  });
});

describe("historyPage", () => {
  const all = [session("a", 30), session("c", 20), session("b", 20), session("d", 10)];

  it("pages newest first, breaking a tie by id, never skipping or repeating", () => {
    const first = historyPage(all, { limit: 2 });
    expect(first.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect(first.more).toBe(true);
    const last = first.sessions.at(-1) as Session;
    const second = historyPage(all, {
      limit: 2,
      before: { lastActivityAt: last.lastActivityAt, id: last.id },
    });
    expect(second.sessions.map((s) => s.id)).toEqual(["c", "d"]);
    expect(second.more).toBe(false);
  });

  it("searches the summary, project and agent with every word", () => {
    const rows = [
      session("x", 3, { summary: "Add orders migration" }),
      session("y", 2, { summary: "Fix login", agentId: "copilot", project: "web" }),
    ];
    expect(historyPage(rows, { limit: 10, query: "orders API" }).sessions.map((s) => s.id)).toEqual(
      ["x"],
    );
    expect(historyPage(rows, { limit: 10, query: "copilot" }).sessions.map((s) => s.id)).toEqual([
      "y",
    ]);
  });

  it("finds one session by its id, wherever it is in the list", () => {
    expect(historyPage(all, { limit: 1, id: "d" })).toEqual({ sessions: [all[3]], more: false });
    expect(historyPage(all, { limit: 1, id: "nope" })).toEqual({ sessions: [], more: false });
    expect(parseHistoryPageRequest({ limit: 1, id: 4 })).toBeUndefined();
  });
});
