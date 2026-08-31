import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildWiring, createGitHandlers, type WiringDeps } from "./ipc.js";
import { ProviderMonitor, ProviderStatusStore, type GitProvider, type ProviderStatus } from "@jarvis/core";

// Shared fixture for buildWiring's provider-facing tests: everything a
// WiringDeps needs, wired to a `sent` capture array instead of a bare
// vi.fn(), plus no-op defaults for every subscription/timer so a test only
// has to override what it actually exercises.
function baseDeps(sent: { channel: string; payload: unknown }[]): WiringDeps {
  return {
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    readMetrics: async () => ({
      cpuPercent: 10,
      memoryUsedBytes: 1,
      memoryTotalBytes: 2,
      diskUsedBytes: 1,
      diskTotalBytes: 2,
      networkDownMbps: 0,
      networkUpMbps: 0,
      uptimeSeconds: 1,
    }),
    intervalMs: 100_000,
    onSessionsChange: () => () => {},
    onTurn: () => () => {},
    onChangeCounts: () => () => {},
    refreshChanges: async () => {},
    changesIntervalMs: 100_000,
    onProvidersChange: () => () => {},
    refreshHealth: async () => {},
    healthIntervalMs: 100_000,
  };
}

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
      ...baseDeps([]),
      send,
      readMetrics: metrics,
      intervalMs: 10,
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
      ...baseDeps([]),
      send,
      readMetrics: async () => { throw new Error("unused"); },
      onSessionsChange: (cb) => { emit = cb as (s: unknown[]) => void; return () => {}; },
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
      ...baseDeps([]),
      send,
      readMetrics: async () => { throw new Error("unused"); },
      onTurn: (cb) => { emit = cb as (t: unknown) => void; return () => {}; },
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
      ...baseDeps([]),
      send: vi.fn(),
      readMetrics: async () => { throw new Error("unused"); },
      onSessionsChange: () => unsubSessions,
      onTurn: () => unsubTurns,
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
      ...baseDeps([]),
      send,
      readMetrics: metrics,
      intervalMs: 10,
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
      ...baseDeps([]),
      send,
      readMetrics: async () => { throw new Error("sensor gone"); },
      intervalMs: 10,
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

  // Ruling P15: a buggy Task 12-15 caller can pass a value of the wrong
  // type over IPC — TypeScript's compile-time signature is no guard at
  // runtime. Each of these previously reached deps.git.* directly and, for
  // the real provider, threw a raw TypeError that crossed IPC as an
  // unhandled rejection (leaking internals, no localised text). Now they
  // must resolve to a normal GitViewResult failure without ever touching
  // git.
  describe("argument validation (P15)", () => {
    it("rejects a non-string path to fileDiff without calling git", async () => {
      const calls: unknown[] = [];
      const { handlers } = handlerFakes({
        diff: async (_repoPath, path) => {
          calls.push(path);
          return { ok: true, value: { path, binary: false, hunks: [] } };
        },
      });
      const badFileDiff = handlers.fileDiff as unknown as (
        sessionId: string,
        path: unknown,
      ) => ReturnType<typeof handlers.fileDiff>;
      const result = await badFileDiff("s1", {});
      expect(result.ok).toBe(false);
      expect(calls).toEqual([]);
    });

    it("rejects a null commit message without calling git", async () => {
      const calls: unknown[] = [];
      const { handlers } = handlerFakes({
        commit: async (_repoPath, message) => {
          calls.push(message);
          return { ok: true, value: { sha: "x", filesChanged: 0 } };
        },
      });
      const badCommit = handlers.commit as unknown as (
        sessionId: string,
        message: unknown,
      ) => ReturnType<typeof handlers.commit>;
      const result = await badCommit("s1", null);
      expect(result.ok).toBe(false);
      expect(calls).toEqual([]);
    });

    it("rejects a non-boolean `staged` rather than coercing it", async () => {
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
      const badSetStaged = handlers.setStaged as unknown as (
        sessionId: string,
        path: string,
        staged: unknown,
      ) => ReturnType<typeof handlers.setStaged>;

      // "false" and 0 are both truthy-adjacent footguns for `staged ? … :
      // …` — the coercion the ruling calls out — and both must be refused,
      // not silently treated as unstage.
      const resultString = await badSetStaged("s1", "a.php", "false");
      const resultNumber = await badSetStaged("s1", "a.php", 0);
      expect(resultString.ok).toBe(false);
      expect(resultNumber.ok).toBe(false);
      expect(staged).toEqual([]);
      expect(unstaged).toEqual([]);
    });

    it("returns a renderable failure, never a rejection, when the provider throws unexpectedly", async () => {
      const { handlers } = handlerFakes({
        diff: async () => {
          throw new TypeError('The "path" argument must be of type string. Received an instance of Object');
        },
      });
      await expect(handlers.fileDiff("s1", "a.php")).resolves.toEqual(
        expect.objectContaining({ ok: false, language: "ar" }),
      );
    });
  });

  // Ruling P26: the renderer's own guard against a double Commit click is
  // one window's JavaScript, not real serialization. The main process must
  // itself refuse to let setStaged and commit for the *same* repository
  // interleave, or a commit can capture a staging set that was mid-change.
  describe("per-repo serialization (P26)", () => {
    it("runs a slow setStaged and a commit for the SAME repo strictly in order", async () => {
      const order: string[] = [];
      let releaseStage: (() => void) | undefined;
      const stageGate = new Promise<void>((resolve) => {
        releaseStage = resolve;
      });

      const { handlers } = handlerFakes({
        stage: async () => {
          order.push("stage:start");
          await stageGate;
          order.push("stage:end");
          return { ok: true, value: null };
        },
        commit: async () => {
          order.push("commit:start");
          order.push("commit:end");
          return { ok: true, value: { sha: "a1b2c3d", filesChanged: 1 } };
        },
      });

      const setStagedPromise = handlers.setStaged("s1", "a.php", true);
      // Fired before setStaged's git call has resolved — proving the
      // ordering below comes from real serialization, not from these two
      // calls merely being awaited one after another by the test.
      const commitPromise = handlers.commit("s1", "fix payment");

      // Give both microtask queues a turn so, absent serialization, the
      // commit's `stage` — sorry, `commit` — call would already have
      // started interleaved with the still-pending stage.
      await Promise.resolve();
      await Promise.resolve();
      expect(order).toEqual(["stage:start"]);

      releaseStage?.();
      await Promise.all([setStagedPromise, commitPromise]);

      expect(order).toEqual(["stage:start", "stage:end", "commit:start", "commit:end"]);
    });

    it("still runs two DIFFERENT repos concurrently — no global lock", async () => {
      const session1 = {
        id: "s1",
        project: "acme",
        projectPath: "/projects/acme",
        agentId: "claude-acme",
        state: "running" as const,
        summary: "",
        startedAt: 0,
        lastActivityAt: 0,
      };
      const session2 = {
        id: "s2",
        project: "other",
        projectPath: "/projects/other",
        agentId: "claude-other",
        state: "running" as const,
        summary: "",
        startedAt: 0,
        lastActivityAt: 0,
      };

      const order: string[] = [];
      let releaseRepo1: (() => void) | undefined;
      const repo1Gate = new Promise<void>((resolve) => {
        releaseRepo1 = resolve;
      });

      const git: GitProvider = {
        changes: async (repoPath) => ({
          ok: true,
          value: { repoPath, branch: "main", detached: false, files: [], insertions: 0, deletions: 0 },
        }),
        diff: async (_repoPath, path) => ({ ok: true, value: { path, binary: false, hunks: [] } }),
        stage: async () => ({ ok: true, value: null }),
        unstage: async () => ({ ok: true, value: null }),
        commit: async (repoPath) => {
          if (repoPath === "/projects/acme") {
            order.push("repo1:start");
            await repo1Gate;
            order.push("repo1:end");
          } else {
            order.push("repo2:start");
            order.push("repo2:end");
          }
          return { ok: true, value: { sha: "a1b2c3d", filesChanged: 1 } };
        },
      };

      const handlers = createGitHandlers({
        git,
        sessions: { get: (id) => (id === "s1" ? session1 : id === "s2" ? session2 : undefined) },
        language: "en",
        refresh: async () => {},
      });

      const repo1Promise = handlers.commit("s1", "repo1 message");
      const repo2Promise = handlers.commit("s2", "repo2 message");

      // repo2's commit is not blocked behind repo1's still-open gate.
      await repo2Promise;
      expect(order).toEqual(["repo1:start", "repo2:start", "repo2:end"]);

      releaseRepo1?.();
      await repo1Promise;
      expect(order).toEqual(["repo1:start", "repo2:start", "repo2:end", "repo1:end"]);
    });
  });
});

describe("provider wiring", () => {
  it("pushes a provider snapshot on every store change", () => {
    const sent: { channel: string; payload: unknown }[] = [];
    let emit: ((statuses: ProviderStatus[]) => void) | undefined;
    const wiring = buildWiring({
      ...baseDeps(sent),
      onProvidersChange: (cb) => {
        emit = cb;
        return () => {};
      },
      refreshHealth: async () => {},
      healthIntervalMs: 300_000,
    });
    wiring.start();

    const statuses: ProviderStatus[] = [
      {
        id: "claude-mm",
        vendor: "anthropic",
        capacity: { state: "unknown", reason: "never-read" },
        health: { state: "ok", detail: "ok", readAt: 1 },
      },
    ];
    emit?.(statuses);

    expect(sent).toContainEqual({ channel: "providers:update", payload: statuses });
    wiring.stop();
  });

  it("polls the free health endpoints on its own interval, and stops on teardown", async () => {
    vi.useFakeTimers();
    try {
      const refreshHealth = vi.fn(async () => {});
      const wiring = buildWiring({
        ...baseDeps([]),
        onProvidersChange: () => () => {},
        refreshHealth,
        healthIntervalMs: 1_000,
      });
      wiring.start();

      await vi.advanceTimersByTimeAsync(2_000);
      expect(refreshHealth).toHaveBeenCalledTimes(2);

      wiring.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(refreshHealth).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never puts capacity on a timer — no wiring dep asks for a paid read", () => {
    // Pinned deliberately: a capacity interval is the one design mistake
    // this feature exists to avoid (~$2/day, and it consumes what it reports).
    const source = readFileSync(fileURLToPath(new URL("./ipc.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/refreshCapacity/);
  });
});

// Acceptance test for "the renderer must not be able to spend without
// limit". `refreshProviders()` reaches main.ts's `providers:refresh`
// ipcMain.handle (wired in Task 11's composition, outside ipc.ts's scope —
// see the pinned "never puts capacity on a timer" test above, which keeps
// ipc.ts itself from ever calling ProviderMonitor#refreshCapacity
// directly). That handler's only correct shape is a direct forward to
// `monitor.refreshCapacity({ force: true })` — never a bypass of the
// monitor, never its own throttle reimplemented alongside it. This test
// proves what bounds a renderer loop once that forward exists: a REAL
// ProviderMonitor (not a fake standing in for its own logic), hit with a
// tight synchronous loop of forced calls — the shape a buggy or
// compromised renderer's spam would take — spends exactly one billed read
// per due account, because the monitor coalesces concurrent forced passes
// (`#refreshing`/`#refreshingForce`) instead of starting one per call. The
// bound is the monitor's own, not anything this IPC layer adds on top.
describe("renderer-triggered capacity spend is bounded by ProviderMonitor, not by renderer restraint", () => {
  it("a tight loop of forced refresh calls buys one billed read per account, not one per call", async () => {
    const agents = [
      { id: "claude-mm", command: "claude", configDir: "/config/mm", vendor: "anthropic" as const },
      { id: "claude-personal", command: "claude", configDir: "/config/247", vendor: "anthropic" as const },
    ];
    const store = new ProviderStatusStore(agents);
    const readCapacity = vi.fn(
      () =>
        new Promise<{
          ok: true;
          fiveHour: { usedPercent: number; resetsAt: string };
          sevenDay: undefined;
        }>((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                fiveHour: { usedPercent: 10, resetsAt: "2026-01-01T00:00:00Z" },
                sevenDay: undefined,
              }),
            10,
          );
        }),
    );
    const monitor = new ProviderMonitor({
      agents,
      store,
      readCapacity,
      readHealth: async () => ({ state: "unknown", detail: "" }),
    });

    // A tight synchronous loop — nothing here awaits between calls, exactly
    // as a `providers:refresh` handler forwarding to
    // `monitor.refreshCapacity({ force: true })` would see from a
    // misbehaving renderer calling refreshProviders() in a loop.
    const calls = Array.from({ length: 20 }, () => monitor.refreshCapacity({ force: true }));
    await Promise.all(calls);

    // One billed read per readable account, not one per call — 20 forced
    // calls did not buy 20x (or even 2x) the reads.
    expect(readCapacity).toHaveBeenCalledTimes(agents.length);
  });
});
