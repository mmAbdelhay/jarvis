import type { Session, WorkspaceState, WorkspaceTab } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import type { OfficeActivity } from "../src/office-activity.js";
import {
  buildOffice,
  ENDED_VISIBLE_MS,
  type OfficeInput,
  roomGeometry,
  seatPoint,
  STARTING_MS,
  worldLayout,
} from "./office-model.js";

const NOW = 1_000_000_000;

function tab(id: string, project: string, overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id,
    project,
    url: "https://example.com",
    kind: "web",
    title: `tab ${id}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    hasPlayingVideo: false,
    pageFullscreen: false,
    suspended: false,
    ...overrides,
  };
}

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project: "alpha",
    projectPath: "/p",
    agentId: "claude",
    state: "running",
    summary: `summary ${id}`,
    startedAt: NOW - 60_000,
    lastActivityAt: NOW - 1000,
    ...overrides,
  };
}

function input(overrides: Partial<OfficeInput> = {}): OfficeInput {
  const workspace: WorkspaceState = overrides.workspace ?? { tabs: [], activeTabId: undefined };
  return {
    projects: ["alpha", "beta", "gamma"],
    workspace,
    sessions: [],
    activity: { panes: {}, sessions: {} },
    runningTabs: new Set<string>(),
    now: NOW,
    ...overrides,
  };
}

const ws = (...tabs: WorkspaceTab[]): WorkspaceState => ({ tabs, activeTabId: undefined });
const act = (activity: Partial<OfficeActivity>): OfficeActivity => ({
  panes: {},
  sessions: {},
  ...activity,
});
const employeesOf = (out: ReturnType<typeof buildOffice>) =>
  out.rooms.flatMap((room) => room.employees);

describe("buildOffice", () => {
  it("makes one employee per tab and merges a pane's session row into its tab", () => {
    const out = buildOffice(
      input({
        workspace: ws(tab("t1", "alpha", { kind: "terminal" })),
        sessions: [
          session("s1", { origin: "external", pid: 5, terminalPaneKey: "t1:p2", branch: "main" }),
        ],
      }),
    );
    const all = employeesOf(out);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ key: "tab:t1", branch: "main" });
  });

  it("gives a split terminal tab one employee and raises its hand for a question in any pane", () => {
    const out = buildOffice(
      input({
        workspace: ws(tab("t1", "alpha", { kind: "terminal" })),
        activity: act({
          panes: {
            t1: { agent: "Claude Code", state: "busy" },
            "t1:p2": { agent: "Codex", state: "question", question: "Run it?" },
          },
        }),
      }),
    );
    const [only, ...rest] = employeesOf(out);
    expect(rest).toHaveLength(0);
    expect(only).toMatchObject({
      pose: "hand",
      question: "Run it?",
      target: { type: "pane", tabId: "t1", paneKey: "t1:p2" },
    });
    expect(out.rooms[0]?.hands).toBe(1);
    expect(out.totals.hands).toBe(1);
  });

  it("treats an unreadable approval menu as a hand with no question text", () => {
    const out = buildOffice(
      input({
        workspace: ws(tab("t1", "alpha", { kind: "terminal" })),
        activity: act({ panes: { t1: { agent: "Codex", state: "question" } } }),
      }),
    );
    expect(employeesOf(out)[0]).toMatchObject({ pose: "hand" });
    expect(employeesOf(out)[0]).not.toHaveProperty("question");
  });

  it("gives a live agent with no tab its own employee, and a stale ended one none", () => {
    const out = buildOffice(
      input({
        sessions: [
          session("live", { origin: "external", pid: 9 }),
          session("fresh-done", {
            state: "done",
            endedAt: NOW - ENDED_VISIBLE_MS + 1000,
          }),
          session("old-done", { state: "done", endedAt: NOW - ENDED_VISIBLE_MS - 1 }),
          session("gone-pane", { origin: "external", pid: 3, terminalPaneKey: "zz:p" }),
        ],
      }),
    );
    const keys = employeesOf(out).map((e) => e.key);
    expect(keys).toContain("session:live");
    expect(keys).toContain("session:fresh-done");
    expect(keys).toContain("session:gone-pane");
    expect(keys).not.toContain("session:old-done");
    expect(employeesOf(out).find((e) => e.key === "session:fresh-done")?.pose).toBe("done");
  });

  it("never shows imported or historical rows", () => {
    const out = buildOffice(
      input({
        sessions: [
          session("imported", { transcriptPath: "/t.jsonl", state: "running" }),
          session("imported-done", {
            transcriptPath: "/t.jsonl",
            state: "done",
            endedAt: NOW - 1000,
          }),
        ],
      }),
    );
    expect(employeesOf(out)).toHaveLength(0);
  });

  it("orders poses: question, error or dead, starting, busy or loading, suspended, done, idle", () => {
    const poseOf = (overrides: Partial<WorkspaceTab>, entry?: OfficeActivity["panes"][string]) =>
      employeesOf(
        buildOffice(
          input({
            workspace: ws(tab("t1", "alpha", overrides)),
            activity: act({ panes: entry === undefined ? {} : { t1: entry } }),
          }),
        ),
      )[0]?.pose;
    expect(poseOf({ kind: "terminal", error: "x" }, { agent: "Codex", state: "question" })).toBe(
      "hand",
    );
    expect(poseOf({ error: "x", loading: true })).toBe("dead");
    expect(poseOf({ loading: true, suspended: true })).toBe("typing");
    expect(poseOf({ suspended: true })).toBe("asleep");
    expect(poseOf({})).toBe("idle");
    expect(poseOf({ kind: "editor" })).toBe("idle");
    expect(poseOf({ kind: "terminal" }, { agent: "Claude Code", state: "busy" })).toBe("typing");
    expect(poseOf({ kind: "terminal" }, { agent: "Claude Code", state: "idle" })).toBe("idle");
  });

  it("walks a session during its first seconds, then types", () => {
    const poseAt = (age: number) =>
      employeesOf(
        buildOffice(
          input({
            sessions: [session("s", { state: "starting", startedAt: NOW - age })],
          }),
        ),
      )[0]?.pose;
    expect(poseAt(STARTING_MS - 1)).toBe("walking");
    expect(poseAt(STARTING_MS + 1)).toBe("typing");
  });

  it("types in a pane without an agent only when the renderer already knows a command runs", () => {
    const base = { workspace: ws(tab("t1", "alpha", { kind: "terminal" })) };
    expect(employeesOf(buildOffice(input(base)))[0]?.pose).toBe("idle");
    expect(
      employeesOf(buildOffice(input({ ...base, runningTabs: new Set(["t1"]) })))[0]?.pose,
    ).toBe("typing");
  });

  it("puts tabs and agents with no project in the Lounge, last", () => {
    const out = buildOffice(
      input({
        workspace: ws(tab("t1", ""), tab("t2", "alpha")),
        sessions: [session("s1", { project: null, origin: "external", pid: 1 })],
      }),
    );
    expect(out.rooms.map((room) => room.name)).toEqual(["alpha", "Lounge"]);
    expect(out.rooms[1]?.lounge).toBe(true);
    expect(out.rooms[1]?.employees).toHaveLength(2);
  });

  it("lists projects with nothing open as closed and keeps config order", () => {
    const out = buildOffice(
      input({
        workspace: ws(tab("t1", "gamma"), tab("t2", "alpha")),
        projects: ["alpha", "beta", "gamma"],
      }),
    );
    expect(out.rooms.map((room) => room.name)).toEqual(["alpha", "gamma"]);
    expect(out.closed).toEqual(["beta"]);
    expect(out.totals).toMatchObject({ employees: 2, open: 2, closed: 1 });
  });

  it("keeps a stable order when a tab appears or changes state", () => {
    const first = buildOffice(input({ workspace: ws(tab("t1", "alpha"), tab("t2", "alpha")) }));
    const second = buildOffice(
      input({
        workspace: ws(
          tab("t1", "alpha", { loading: true }),
          tab("t2", "alpha"),
          tab("t3", "alpha"),
        ),
      }),
    );
    expect(employeesOf(first).map((e) => e.key)).toEqual(["tab:t1", "tab:t2"]);
    expect(employeesOf(second).map((e) => e.key)).toEqual(["tab:t1", "tab:t2", "tab:t3"]);
  });

  it("handles 40 employees in one room", () => {
    const tabs = Array.from({ length: 40 }, (_, i) => tab(`t${i}`, "alpha"));
    const out = buildOffice(input({ workspace: ws(...tabs) }));
    const room = out.rooms[0];
    expect(room?.employees).toHaveLength(40);
    expect(room && room.geometry.cols * room.geometry.rows).toBeGreaterThanOrEqual(40);
  });

  it("carries a hostile label as plain text", () => {
    const out = buildOffice(
      input({ workspace: ws(tab("t1", "alpha", { title: "<img src=x onerror=1>" })) }),
    );
    expect(employeesOf(out)[0]?.label).toBe("<img src=x onerror=1>");
  });
});

describe("roomGeometry and worldLayout", () => {
  it("grows 2x1, 2x2, 3x2, 3x3, 4x3 with the count", () => {
    const dims = (n: number) => {
      const { cols, rows } = roomGeometry(n);
      return `${cols}x${rows}`;
    };
    expect([1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13].map(dims)).toEqual([
      "2x1",
      "2x1",
      "2x2",
      "2x2",
      "3x2",
      "3x2",
      "3x3",
      "3x3",
      "4x3",
      "4x3",
      "4x4",
    ]);
  });

  it("never has fewer seats than employees, and seats stay inside the room box", () => {
    for (const n of [0, 1, 5, 17, 40, 120]) {
      const geometry = roomGeometry(n);
      expect(geometry.cols * geometry.rows).toBeGreaterThanOrEqual(n);
      for (let i = 0; i < n; i += 1) {
        const seat = seatPoint(geometry, i);
        expect(seat.x).toBeGreaterThan(0);
        expect(seat.x).toBeLessThan(geometry.width);
        expect(seat.y).toBeGreaterThan(0);
        expect(seat.y).toBeLessThan(geometry.height);
      }
    }
  });

  it("places 30 rooms of mixed size without any two boxes overlapping", () => {
    const sizes = Array.from({ length: 30 }, (_, i) => (i * 7) % 26);
    const placed = worldLayout(sizes.map((n) => roomGeometry(n)));
    for (let a = 0; a < placed.rooms.length; a += 1) {
      for (let b = a + 1; b < placed.rooms.length; b += 1) {
        const p = placed.rooms[a];
        const q = placed.rooms[b];
        if (p === undefined || q === undefined) continue;
        const apart =
          p.x + p.width <= q.x ||
          q.x + q.width <= p.x ||
          p.y + p.height <= q.y ||
          q.y + q.height <= p.y;
        expect(apart).toBe(true);
      }
    }
    for (const room of placed.rooms) {
      expect(room.x + room.width).toBeLessThanOrEqual(placed.width);
      expect(room.y + room.height).toBeLessThanOrEqual(placed.height);
    }
  });

  it("is deterministic for the same input", () => {
    const a = worldLayout([roomGeometry(3), roomGeometry(9)]);
    const b = worldLayout([roomGeometry(3), roomGeometry(9)]);
    expect(a).toEqual(b);
  });
});
