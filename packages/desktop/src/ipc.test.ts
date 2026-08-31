import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWiring, createGitHandlers } from "./ipc.js";
import type { GitProvider } from "@jarvis/core";

describe("buildWiring", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes metrics on the interval", async () => {
    const send = vi.fn();
    const metrics = vi.fn(async () => ({
      cpuPercent: 10, memoryUsedBytes: 1, memoryTotalBytes: 2,
      diskUsedBytes: 1, diskTotalBytes: 2, networkDownMbps: 0,
      networkUpMbps: 0, uptimeSeconds: 1,
    }));

    const wiring = buildWiring({
      send,
      readMetrics: metrics,
      intervalMs: 10,
      onSessionsChange: () => () => {},
      onTurn: () => () => {},
      onChangeCounts: () => () => {},
      refreshChanges: async () => {},
      changesIntervalMs: 100_000,
    });

    wiring.start();
    await vi.advanceTimersByTimeAsync(40);
    wiring.stop();

    expect(metrics.mock.calls.length).toBeGreaterThan(1);
    expect(send).toHaveBeenCalledWith("metrics:update", expect.objectContaining({ cpuPercent: 10 }));
  });

  it("forwards session changes", () => {
    const send = vi.fn();
    let emit: ((sessions: unknown[]) => void) | undefined;

    const wiring = buildWiring({
      send,
      readMetrics: async () => { throw new Error("unused"); },
      intervalMs: 100_000,
      onSessionsChange: (cb) => { emit = cb as (s: unknown[]) => void; return () => {}; },
      onTurn: () => () => {},
      onChangeCounts: () => () => {},
      refreshChanges: async () => {},
      changesIntervalMs: 100_000,
    });

    wiring.start();
    emit?.([{ id: "a" }]);
    expect(send).toHaveBeenCalledWith("sessions:update", [{ id: "a" }]);
    wiring.stop();
  });

  it("forwards turns", () => {
    const send = vi.fn();
    let emit: ((turn: unknown) => void) | undefined;

    const wiring = buildWiring({
      send,
      readMetrics: async () => { throw new Error("unused"); },
      intervalMs: 100_000,
      onSessionsChange: () => () => {},
      onTurn: (cb) => { emit = cb as (t: unknown) => void; return () => {}; },
      onChangeCounts: () => () => {},
      refreshChanges: async () => {},
      changesIntervalMs: 100_000,
    });

    wiring.start();
    emit?.({ role: "user", text: "hi" });
    expect(send).toHaveBeenCalledWith("turn:new", { role: "user", text: "hi" });
    wiring.stop();
  });

  it("unsubscribes everything on stop", () => {
    const unsubSessions = vi.fn();
    const unsubTurns = vi.fn();

    const wiring = buildWiring({
      send: vi.fn(),
      readMetrics: async () => { throw new Error("unused"); },
      intervalMs: 100_000,
      onSessionsChange: () => unsubSessions,
      onTurn: () => unsubTurns,
      onChangeCounts: () => () => {},
      refreshChanges: async () => {},
      changesIntervalMs: 100_000,
    });

    wiring.start();
    wiring.stop();

    expect(unsubSessions).toHaveBeenCalled();
    expect(unsubTurns).toHaveBeenCalled();
  });

  it("stops the metrics interval on stop, so no further reads happen", async () => {
    const send = vi.fn();
    const metrics = vi.fn(async () => ({
      cpuPercent: 10, memoryUsedBytes: 1, memoryTotalBytes: 2,
      diskUsedBytes: 1, diskTotalBytes: 2, networkDownMbps: 0,
      networkUpMbps: 0, uptimeSeconds: 1,
    }));

    const wiring = buildWiring({
      send,
      readMetrics: metrics,
      intervalMs: 10,
      onSessionsChange: () => () => {},
      onTurn: () => () => {},
      onChangeCounts: () => () => {},
      refreshChanges: async () => {},
      changesIntervalMs: 100_000,
    });

    wiring.start();
    await vi.advanceTimersByTimeAsync(15);
    wiring.stop();
    const callsAtStop = metrics.mock.calls.length;

    await vi.advanceTimersByTimeAsync(100);
    expect(metrics.mock.calls.length).toBe(callsAtStop);
  });

  it("survives a metrics read that rejects", async () => {
    const send = vi.fn();
    const wiring = buildWiring({
      send,
      readMetrics: async () => { throw new Error("sensor gone"); },
      intervalMs: 10,
      onSessionsChange: () => () => {},
      onTurn: () => () => {},
      onChangeCounts: () => () => {},
      refreshChanges: async () => {},
      changesIntervalMs: 100_000,
    });

    wiring.start();
    await vi.advanceTimersByTimeAsync(30);
    wiring.stop();

    expect(send).not.toHaveBeenCalledWith("metrics:update", expect.anything());
  });
});

function handlerFakes(overrides: Partial<GitProvider> = {}) {
  const session = {
    id: "s1",
    project: "acme",
    projectPath: "/projects/acme",
    agentId: "claude-acme",
    state: "running" as const,
    summary: "",
    startedAt: 0,
    lastActivityAt: 1_700_000_000_000,
  };
  const git: GitProvider = {
    changes: async (repoPath) => ({
      ok: true,
      value: {
        repoPath,
        branch: "feat/checkout-retry",
        detached: false,
        files: [{ path: "a.php", status: "M", insertions: 3, deletions: 1, staged: false }],
        insertions: 3,
        deletions: 1,
      },
    }),
    diff: async (_repoPath, path) => ({ ok: true, value: { path, binary: false, hunks: [] } }),
    stage: async () => ({ ok: true, value: null }),
    unstage: async () => ({ ok: true, value: null }),
    commit: async () => ({ ok: true, value: { sha: "a1b2c3d", filesChanged: 1 } }),
    ...overrides,
  };
  const refreshes: number[] = [];
  const handlers = createGitHandlers({
    git,
    sessions: { get: (id) => (id === "s1" ? session : undefined) },
    language: "ar",
    refresh: async () => {
      refreshes.push(Date.now());
    },
  });
  return { handlers, refreshes };
}

describe("createGitHandlers", () => {
  it("returns the changes plus the session that produced them", async () => {
    const { handlers } = handlerFakes();
    const result = await handlers.changes("s1");
    if (!result.ok) throw new Error("expected ok");

    expect(result.value.session).toMatchObject({
      id: "s1",
      project: "acme",
      agentId: "claude-acme",
    });
    expect(result.value.changes.branch).toBe("feat/checkout-retry");
  });

  it("localises a git failure into text the renderer can show directly", async () => {
    const { handlers } = handlerFakes({
      changes: async () => ({ ok: false, error: { code: "not-a-repo", detail: "/p" } }),
    });
    const result = await handlers.changes("s1");
    expect(result).toEqual({
      ok: false,
      text: "هذا المجلد ليس مستودع git.",
      language: "ar",
    });
  });

  it("reports an unknown session id without touching git", async () => {
    const calls: string[] = [];
    const { handlers } = handlerFakes({
      changes: async (repoPath) => {
        calls.push(repoPath);
        return { ok: false, error: { code: "failed", detail: "should not run" } };
      },
    });
    const result = await handlers.changes("ghost");
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("stages and unstages through the same handler", async () => {
    const staged: string[][] = [];
    const unstaged: string[][] = [];
    const { handlers } = handlerFakes({
      stage: async (_repoPath, paths) => {
        staged.push(paths);
        return { ok: true, value: null };
      },
      unstage: async (_repoPath, paths) => {
        unstaged.push(paths);
        return { ok: true, value: null };
      },
    });

    expect(await handlers.setStaged("s1", "a.php", true)).toEqual({ ok: true, value: null });
    expect(await handlers.setStaged("s1", "a.php", false)).toEqual({ ok: true, value: null });
    expect(staged).toEqual([["a.php"]]);
    expect(unstaged).toEqual([["a.php"]]);
  });

  it("refreshes the tracker after a commit so the dashboard counts drop", async () => {
    const { handlers, refreshes } = handlerFakes();
    const result = await handlers.commit("s1", "إصلاح الدفع");
    expect(result.ok).toBe(true);
    expect(refreshes).toHaveLength(1);
  });

  it("does not refresh after a read", async () => {
    const { handlers, refreshes } = handlerFakes();
    await handlers.changes("s1");
    await handlers.fileDiff("s1", "a.php");
    expect(refreshes).toEqual([]);
  });
});
