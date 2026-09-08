import { describe, expect, it } from "vitest";
import type { Session } from "@jarvis/core";
import { NO_PROJECT, agentsIn, filterSessions, sortSessions } from "./session-filter.js";

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1",
    project: "acme",
    projectPath: "/home/u/projects/acme",
    agentId: "claude-acme",
    model: "claude-opus-5",
    state: "done",
    summary: "fetch all my bugs",
    startedAt: 1,
    lastActivityAt: 100,
    branch: "master",
    insertions: 0,
    deletions: 0,
    changedFiles: 0,
    ...over,
  };
}

describe("NO_PROJECT", () => {
  // The first version of this sentinel was a NUL byte, invisible in the
  // source and in every diff. It round-tripped through the select as an
  // empty value, so "No project" quietly showed all 96 rows while every
  // unit test passed.
  it("is printable, so it survives a select and can be read in the source", () => {
    expect(NO_PROJECT).toMatch(/^[\x20-\x7e]+$/);
  });

  it("cannot be mistaken for a yaml project key", () => {
    expect(NO_PROJECT).not.toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("filterSessions", () => {
  const all = [
    session({ id: "a", summary: "fetch all my bugs" }),
    session({
      id: "b",
      project: null,
      projectPath: "/home/u/projects/jarvis",
      summary: "add a cluster tab",
      agentId: "claude-main",
      branch: "feat/x",
    }),
    session({ id: "c", project: "orbit", summary: "deploy the thing", state: "dead" }),
  ];

  it("returns everything when nothing is asked for", () => {
    expect(filterSessions(all, { query: "", project: "", agent: "" })).toHaveLength(3);
  });

  it("matches the summary, case-insensitively", () => {
    expect(filterSessions(all, { query: "CLUSTER", project: "", agent: "" }).map((s) => s.id)).toEqual(
      ["b"],
    );
  });

  // A session with no configured project is found by the directory it ran
  // in, because for 66 of the 95 sessions here that is the only name it has.
  it("matches the directory of a session with no project", () => {
    expect(filterSessions(all, { query: "jarvis", project: "", agent: "" }).map((s) => s.id)).toEqual(
      ["b"],
    );
  });

  it("matches the agent and the branch too", () => {
    expect(filterSessions(all, { query: "claude-main", project: "", agent: "" })).toHaveLength(1);
    expect(filterSessions(all, { query: "feat/x", project: "", agent: "" })).toHaveLength(1);
  });

  it("filters by project", () => {
    expect(filterSessions(all, { query: "", project: "orbit", agent: "" }).map((s) => s.id)).toEqual([
      "c",
    ]);
  });

  // The largest group in the table, and the one a project dropdown cannot
  // name any other way.
  it("filters to the sessions that belong to no project", () => {
    expect(
      filterSessions(all, { query: "", project: NO_PROJECT, agent: "" }).map((s) => s.id),
    ).toEqual(["b"]);
  });

  it("filters by agent", () => {
    expect(
      filterSessions(all, { query: "", project: "", agent: "claude-main" }).map((s) => s.id),
    ).toEqual(["b"]);
  });

  it("combines every criterion", () => {
    expect(
      filterSessions(all, { query: "deploy", project: "orbit", agent: "claude-acme" }),
    ).toHaveLength(1);
    expect(filterSessions(all, { query: "deploy", project: "acme", agent: "" })).toHaveLength(0);
  });

  it("ignores surrounding whitespace in the query", () => {
    expect(filterSessions(all, { query: "  cluster  ", project: "", agent: "" })).toHaveLength(1);
  });
});

describe("sortSessions", () => {
  const all = [
    session({ id: "a", project: "beta", lastActivityAt: 200, state: "done" }),
    session({ id: "b", project: "alpha", lastActivityAt: 300, state: "dead" }),
    session({
      id: "c",
      project: null,
      projectPath: "/home/u/zulu",
      lastActivityAt: 100,
      state: "done",
    }),
  ];

  it("sorts by last activity, newest first", () => {
    expect(sortSessions(all, "lastActivityAt", "desc").map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("reverses on the other direction", () => {
    expect(sortSessions(all, "lastActivityAt", "asc").map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  // A project-less session sorts under the name the table shows for it,
  // which is its directory. Sorting on the raw null would clump every one of
  // them at one end regardless of what the reader sees.
  it("sorts by the label the table actually shows", () => {
    expect(sortSessions(all, "project", "asc").map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("sorts by state", () => {
    expect(sortSessions(all, "state", "asc").map((s) => s.id)).toEqual(["b", "a", "c"]);
  });

  it("does not mutate the array it was given", () => {
    const order = all.map((s) => s.id);
    sortSessions(all, "project", "desc");
    expect(all.map((s) => s.id)).toEqual(order);
  });
});

describe("agentsIn", () => {
  it("lists each agent once, in order", () => {
    expect(
      agentsIn([session({ agentId: "b" }), session({ agentId: "a" }), session({ agentId: "b" })]),
    ).toEqual(["a", "b"]);
  });
});
