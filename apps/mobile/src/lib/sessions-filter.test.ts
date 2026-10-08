import { describe, expect, it } from "vitest";
import { filterRows, matchesQuery, projectsOf, statusCounts } from "./sessions-filter";
import type { SessionRowView } from "./sessions-store";

function row(over: Partial<SessionRowView>): SessionRowView {
  return {
    id: "s",
    label: "api · claude-main",
    summary: "Add orders migration",
    state: "running",
    agentId: "claude-main",
    project: null,
    projectPath: "/code/api",
    startedAt: 0,
    lastActivityAt: 0,
    ...over,
  };
}

const ROWS = [
  row({ id: "a", state: "running" }),
  row({
    id: "b",
    state: "waiting",
    summary: "Fix flaky login test",
    label: "web · copilot",
    agentId: "copilot",
  }),
  row({ id: "c", state: "done", summary: "Bump Electron" }),
  row({
    id: "d",
    state: "dead",
    summary: "Docker compose",
    label: "api · codex",
    agentId: "codex",
  }),
  row({
    id: "e",
    state: "starting",
    summary: "Release notes",
    label: "jarvis · codex",
    agentId: "codex",
  }),
];

describe("matchesQuery", () => {
  it("needs every word, in any field, ignoring case", () => {
    expect(matchesQuery(ROWS[0] as SessionRowView, "API claude")).toBe(true);
    expect(matchesQuery(ROWS[0] as SessionRowView, "api copilot")).toBe(false);
    expect(matchesQuery(ROWS[1] as SessionRowView, "  flaky  ")).toBe(true);
    expect(matchesQuery(ROWS[1] as SessionRowView, "")).toBe(true);
  });
});

describe("filterRows", () => {
  it("keeps the rows a status chip names", () => {
    const ids = (status: Parameters<typeof filterRows>[2]) =>
      filterRows(ROWS, "", status).map((entry) => entry.id);
    expect(ids("all")).toEqual(["a", "b", "c", "d", "e"]);
    expect(ids("waiting")).toEqual(["b"]);
    expect(ids("running")).toEqual(["a", "e"]);
    expect(ids("done")).toEqual(["c", "d"]);
  });

  it("applies the query and the chip together", () => {
    expect(filterRows(ROWS, "codex", "done").map((entry) => entry.id)).toEqual(["d"]);
  });
});

describe("statusCounts", () => {
  it("counts each chip under the current query", () => {
    expect(statusCounts(ROWS, "")).toEqual({ all: 5, waiting: 1, running: 2, done: 2 });
    expect(statusCounts(ROWS, "codex")).toEqual({ all: 2, waiting: 0, running: 1, done: 1 });
  });
});

describe("project filter", () => {
  const rows = [
    row({ id: "p1", project: "api", state: "running", summary: "migration" }),
    row({ id: "p2", project: "web", state: "done", summary: "migration" }),
    row({ id: "p3", project: "api", state: "dead", summary: "docker" }),
    row({ id: "p4", project: null, state: "done" }),
  ];

  it("composes with the query and the status", () => {
    expect(filterRows(rows, "migration", "all", "api").map((r) => r.id)).toEqual(["p1"]);
    expect(filterRows(rows, "", "done", "api").map((r) => r.id)).toEqual(["p3"]);
    expect(filterRows(rows, "", "all").length).toBe(4);
  });

  it("scopes the chip counts to the project", () => {
    expect(statusCounts(rows, "", "api")).toEqual({ all: 2, waiting: 0, running: 1, done: 1 });
  });

  it("lists the distinct named projects, sorted", () => {
    expect(projectsOf(rows)).toEqual(["api", "web"]);
  });
});
