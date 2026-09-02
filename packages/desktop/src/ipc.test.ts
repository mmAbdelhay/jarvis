import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWiring,
  createBookmarksHandlers,
  createDatabaseHandlers,
  createEditorHandlers,
  createApiHandlers,
  createTerminalHandlers,
  type ApiHandlerDeps,
  createGitHandlers,
  createSettingsHandlers,
  type WiringDeps,
} from "./ipc.js";
import type {
  Bookmark,
  BookmarkStore,
  CodeServerManager,
  DbGateManager,
  ShellManager,
} from "@jarvis/platform";
import type { AgentHealth, WorkspaceState } from "@jarvis/core";
import { ProviderMonitor, ProviderStatusStore, type GitProvider, type ProviderStatus } from "@jarvis/core";
import type { JarvisConfig } from "./config.js";

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
    onSessionOutput: () => () => {},
    refreshChanges: async () => {},
    changesIntervalMs: 100_000,
    onProvidersChange: () => () => {},
    onWorkspaceChange: () => () => {},
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

describe("buildWiring session output", () => {
  it("forwards each output chunk to the renderer's session:output channel", () => {
    const sent: { channel: string; payload: unknown }[] = [];
    let emit: ((output: { sessionId: string; chunk: string }) => void) | undefined;
    const wiring = buildWiring({
      ...baseDeps(sent),
      onSessionOutput: (cb) => {
        emit = cb;
        return () => {};
      },
    });
    wiring.start();

    emit?.({ sessionId: "s1", chunk: "hello\n" });
    wiring.stop();

    expect(sent).toContainEqual({
      channel: "session:output",
      payload: { sessionId: "s1", chunk: "hello\n" },
    });
  });

  it("unsubscribes from session output on stop", () => {
    const sent: { channel: string; payload: unknown }[] = [];
    const unsubscribe = vi.fn();
    const wiring = buildWiring({ ...baseDeps(sent), onSessionOutput: () => unsubscribe });

    wiring.start();
    wiring.stop();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("buildWiring workspace", () => {
  it("pushes workspace state to the renderer", () => {
    const sent: { channel: string; payload: unknown }[] = [];
    let emit: ((state: WorkspaceState) => void) | undefined;
    const wiring = buildWiring({
      ...baseDeps(sent),
      onWorkspaceChange: (cb) => {
        emit = cb;
        return () => {};
      },
    });
    wiring.start();

    emit?.({ tabs: [], activeTabId: undefined });

    expect(sent).toContainEqual({
      channel: "workspace:update",
      payload: { tabs: [], activeTabId: undefined },
    });
    wiring.stop();
  });
});

describe("editor handlers", () => {
  function codeServer(overrides: Partial<CodeServerManager> = {}): CodeServerManager {
    return {
      open: () => Promise.resolve({ ok: true, url: "http://127.0.0.1:9001/?folder=%2Fp" }),
      stopAll: () => {},
      ...overrides,
    };
  }

  it("opens the project's editor and returns its URL", async () => {
    const handlers = createEditorHandlers({
      codeServer: codeServer({
        open: (path) => Promise.resolve({ ok: true, url: `http://127.0.0.1:9001/?folder=${path}` }),
      }),
      projects: { acme: "/p/acme" },
      editors: {},
      language: "en",
    });

    expect(await handlers.open("acme")).toEqual({
      ok: true,
      value: "http://127.0.0.1:9001/?folder=/p/acme",
    });
  });

  it("passes the configured root, not anything the caller supplied", async () => {
    const opened: string[] = [];
    const handlers = createEditorHandlers({
      codeServer: codeServer({
        open: (path) => {
          opened.push(path);
          return Promise.resolve({ ok: true, url: "http://127.0.0.1:9001" });
        },
      }),
      projects: { acme: "/p/acme" },
      editors: {},
      language: "en",
    });

    await handlers.open("acme");

    expect(opened).toEqual(["/p/acme"]);
  });

  it("refuses an unknown project without starting a code-server instance", async () => {
    let called = false;
    const handlers = createEditorHandlers({
      codeServer: codeServer({
        open: () => {
          called = true;
          return Promise.resolve({ ok: true, url: "http://127.0.0.1:9001" });
        },
      }),
      projects: { acme: "/p/acme" },
      editors: {},
      language: "en",
    });

    const result = await handlers.open("/etc");

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("refuses a non-string project", async () => {
    const handlers = createEditorHandlers({
      codeServer: codeServer(),
      projects: { acme: "/p/acme" },
      editors: {},
      language: "en",
    });

    const result = await handlers.open(undefined as unknown as string);

    expect(result.ok).toBe(false);
  });

  it("reports a code-server failure as localised text", async () => {
    const handlers = createEditorHandlers({
      codeServer: codeServer({
        open: () => Promise.resolve({ ok: false, detail: "did not become ready in time" }),
      }),
      projects: { acme: "/p/acme" },
      editors: {},
      language: "en",
    });

    const result = await handlers.open("acme");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.text.length).toBeGreaterThan(0);
  });

  it("survives a code-server manager that throws", async () => {
    const handlers = createEditorHandlers({
      codeServer: codeServer({ open: () => Promise.reject(new Error("boom")) }),
      projects: { acme: "/p/acme" },
      editors: {},
      language: "en",
    });

    const result = await handlers.open("acme");

    expect(result.ok).toBe(false);
  });

  // A project with configured roots: the Editor button asks for one by
  // name, and main is the only side that ever sees a path.
  describe("editor roots", () => {
    const editors = {
      acme: [
        { name: "portal-vue", path: "portal-vue" },
        { name: "api", path: "services/api" },
      ],
    };

    function withRoots(opened: { project: string; folder: string | undefined }[]) {
      return createEditorHandlers({
        codeServer: codeServer({
          open: (project, folder) => {
            opened.push({ project, folder });
            return Promise.resolve({ ok: true, url: "http://127.0.0.1:9001" });
          },
        }),
        projects: { acme: "/p/acme" },
        editors,
        language: "en",
      });
    }

    it("lists a project's root names", async () => {
      const handlers = withRoots([]);

      expect(await handlers.roots("acme")).toEqual(["portal-vue", "api"]);
    });

    it("lists nothing for a project with no configured root", async () => {
      const handlers = withRoots([]);

      expect(await handlers.roots("storefront")).toEqual([]);
    });

    it("resolves a named root against the project directory", async () => {
      const opened: { project: string; folder: string | undefined }[] = [];

      await withRoots(opened).open("acme", "api");

      expect(opened).toEqual([{ project: "/p/acme", folder: "/p/acme/services/api" }]);
    });

    it("opens the project itself when no root is named", async () => {
      const opened: { project: string; folder: string | undefined }[] = [];

      await withRoots(opened).open("acme");

      expect(opened).toEqual([{ project: "/p/acme", folder: "/p/acme" }]);
    });

    // The renderer names a root; a name that is not in this project's
    // config resolves to nothing, and nothing is what gets opened.
    it("refuses a root the project does not declare, without opening anything", async () => {
      const opened: { project: string; folder: string | undefined }[] = [];

      const result = await withRoots(opened).open("acme", "../../etc");

      expect(result.ok).toBe(false);
      expect(opened).toEqual([]);
    });

    it("refuses a non-string root", async () => {
      const opened: { project: string; folder: string | undefined }[] = [];

      const result = await withRoots(opened).open("acme", 7 as unknown as string);

      expect(result.ok).toBe(false);
      expect(opened).toEqual([]);
    });
  });
});

describe("bookmarks handlers", () => {
  function store(overrides: Partial<BookmarkStore> = {}): BookmarkStore {
    return {
      list: () => Promise.resolve({ ok: true, value: [] }),
      add: (_project, bookmark) => Promise.resolve({ ok: true, value: [bookmark] }),
      remove: () => Promise.resolve({ ok: true, value: [] }),
      ...overrides,
    };
  }

  it("lists a project's bookmarks", async () => {
    const handlers = createBookmarksHandlers({
      store: store({
        list: (project) =>
          Promise.resolve({
            ok: true,
            value: project === "acme" ? [{ url: "https://github.com", title: "GitHub" }] : [],
          }),
      }),
      language: "en",
    });

    expect(await handlers.list("acme")).toEqual({
      ok: true,
      value: [{ url: "https://github.com", title: "GitHub" }],
    });
  });

  it("adds a bookmark and returns the updated list", async () => {
    const handlers = createBookmarksHandlers({ store: store(), language: "en" });

    const result = await handlers.add("acme", { url: "https://github.com", title: "GitHub" });

    expect(result).toEqual({ ok: true, value: [{ url: "https://github.com", title: "GitHub" }] });
  });

  it("removes a bookmark", async () => {
    const removed: { project: string; url: string }[] = [];
    const handlers = createBookmarksHandlers({
      store: store({
        remove: (project, url) => {
          removed.push({ project, url });
          return Promise.resolve({ ok: true, value: [] });
        },
      }),
      language: "en",
    });

    await handlers.remove("acme", "https://github.com");

    expect(removed).toEqual([{ project: "acme", url: "https://github.com" }]);
  });

  it("refuses a non-string project", async () => {
    const handlers = createBookmarksHandlers({ store: store(), language: "en" });

    const result = await handlers.list(undefined as unknown as string);

    expect(result.ok).toBe(false);
  });

  it("refuses a malformed bookmark", async () => {
    const handlers = createBookmarksHandlers({ store: store(), language: "en" });

    const result = await handlers.add("acme", { url: "https://github.com" } as unknown as Bookmark);

    expect(result.ok).toBe(false);
  });

  it("reports a store failure as localised text", async () => {
    const handlers = createBookmarksHandlers({
      store: store({ add: () => Promise.resolve({ ok: false, detail: "disk full" }) }),
      language: "en",
    });

    const result = await handlers.add("acme", { url: "https://github.com", title: "GitHub" });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.text.length).toBeGreaterThan(0);
  });
});

const sampleConfig: JarvisConfig = {
  registry: { agents: { "claude-mm": { command: "claude-mm" } }, routing: [] },
  projects: { acme: "/p/acme" },
  databases: {},
  editors: {},
  clusters: {},
  headlamp: { binary: "/some/path" },
  voice: {
    engine: "say" as const,
    piperBinary: "/opt/piper",
    piperModel: "/voices/alan.onnx",
    englishVoice: "Daniel",
    arabicVoice: "Majed",
    greeting: { en: "Good {timeOfDay} sir, how can I help you today?", ar: "{timeOfDay} يا سيدي" },
  },
  brain: { systemPrompt: "You are Jarvis.", cwd: "/tmp/brain" },
  whisper: { binaryPath: "/opt/whisper", modelPath: "/opt/model.bin" },
  sessionsDbPath: "/tmp/sessions.db",
};

function settingsDeps(overrides: Partial<{
  readConfig: () => Promise<JarvisConfig>;
  writeConfig: (draft: JarvisConfig) => Promise<{ ok: true } | { ok: false; detail: string }>;
  run: (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  restart: () => void;
}> = {}) {
  return {
    readConfig: overrides.readConfig ?? (() => Promise.resolve(sampleConfig)),
    writeConfig: overrides.writeConfig ?? (() => Promise.resolve({ ok: true } as const)),
    run: overrides.run ?? (() => Promise.resolve({ code: 0, stdout: "1.0.0", stderr: "" })),
    restart: overrides.restart ?? (() => {}),
    language: "en" as const,
  };
}

describe("createSettingsHandlers", () => {
  it("reads the current config through readConfig", async () => {
    const handlers = createSettingsHandlers(settingsDeps());

    expect(await handlers.read()).toEqual(sampleConfig);
  });

  it("saves a draft through writeConfig and reports success", async () => {
    const written: JarvisConfig[] = [];
    const handlers = createSettingsHandlers(
      settingsDeps({
        writeConfig: (draft) => {
          written.push(draft);
          return Promise.resolve({ ok: true });
        },
      }),
    );

    const result = await handlers.save(sampleConfig);

    expect(result).toEqual({ ok: true });
    expect(written).toEqual([sampleConfig]);
  });

  it("wraps a write failure in the bilingual headline plus the raw detail", async () => {
    const handlers = createSettingsHandlers(
      settingsDeps({
        writeConfig: () =>
          Promise.resolve({ ok: false, detail: "Config `agents.x.command` must be a string" }),
      }),
    );

    const result = await handlers.save(sampleConfig);

    expect(result).toEqual({
      ok: false,
      text: "Couldn't save settings — see below.",
      detail: "Config `agents.x.command` must be a string",
      language: "en",
    });
  });

  it("localises the headline into Arabic when that is the configured language", async () => {
    const handlers = createSettingsHandlers({
      ...settingsDeps({ writeConfig: () => Promise.resolve({ ok: false, detail: "x" }) }),
      language: "ar",
    });

    const result = await handlers.save(sampleConfig);

    expect(!result.ok && result.text).toBe("تعذّر حفظ الإعدادات — التفاصيل أدناه.");
  });

  it("runs the health probe against the draft agent via run", async () => {
    const calls: [string, string[]][] = [];
    const handlers = createSettingsHandlers(
      settingsDeps({
        run: (command, args) => {
          calls.push([command, args]);
          return Promise.resolve({ code: 0, stdout: "1.2.3", stderr: "" });
        },
      }),
    );

    const health: AgentHealth = await handlers.testAgent({ id: "claude-mm", command: "claude-mm" });

    expect(health).toEqual({ id: "claude-mm", ok: true, detail: "1.2.3" });
    expect(calls).toEqual([["claude-mm", ["--version"]]]);
  });

  it("reports a broken agent as unhealthy rather than throwing", async () => {
    const handlers = createSettingsHandlers(
      settingsDeps({
        run: () => Promise.resolve({ code: 0, stdout: "Error: command not found", stderr: "" }),
      }),
    );

    const health = await handlers.testAgent({ id: "claude-mm", command: "claude-mm" });

    expect(health.ok).toBe(false);
  });

  it("calls the injected restart function", () => {
    let called = false;
    const handlers = createSettingsHandlers(settingsDeps({ restart: () => { called = true; } }));

    handlers.restart();

    expect(called).toBe(true);
  });
});

describe("database handlers", () => {
  function dbgate(overrides: Partial<DbGateManager> = {}): DbGateManager {
    return {
      open: () =>
        Promise.resolve({ ok: true, url: "http://127.0.0.1:51234/", login: "jarvis", password: "pw" }),
      stopAll: () => {},
      ...overrides,
    };
  }

  it("opens the project's database browser and returns its URL and credential", async () => {
    const handlers = createDatabaseHandlers({
      dbgate: dbgate(),
      projects: { acme: "/p/acme" },
      language: "en",
    });

    expect(await handlers.open("acme")).toEqual({
      ok: true,
      value: { url: "http://127.0.0.1:51234/", login: "jarvis", password: "pw" },
    });
  });

  // Unlike the editor, the manager is keyed by project *name*: it owns the
  // workspace directory and the connection set, and never needs a path.
  it("passes the project name through to the manager", async () => {
    const opened: string[] = [];
    const handlers = createDatabaseHandlers({
      dbgate: dbgate({
        open: (project) => {
          opened.push(project);
          return Promise.resolve({
            ok: true,
            url: "http://127.0.0.1:51234/",
            login: "jarvis",
            password: "pw",
          });
        },
      }),
      projects: { acme: "/p/acme" },
      language: "en",
    });

    await handlers.open("acme");

    expect(opened).toEqual(["acme"]);
  });

  it("refuses an unknown project without starting an instance", async () => {
    let called = false;
    const handlers = createDatabaseHandlers({
      dbgate: dbgate({
        open: () => {
          called = true;
          return Promise.resolve({
            ok: true,
            url: "http://127.0.0.1:51234/",
            login: "jarvis",
            password: "pw",
          });
        },
      }),
      projects: { acme: "/p/acme" },
      language: "en",
    });

    const result = await handlers.open("nope");

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("refuses a non-string project", async () => {
    const handlers = createDatabaseHandlers({
      dbgate: dbgate(),
      projects: { acme: "/p/acme" },
      language: "en",
    });

    expect((await handlers.open(undefined as unknown as string)).ok).toBe(false);
  });

  it("wraps a manager failure behind one localised headline", async () => {
    const handlers = createDatabaseHandlers({
      dbgate: dbgate({
        open: () => Promise.resolve({ ok: false, detail: "did not report a port in time" }),
      }),
      projects: { acme: "/p/acme" },
      language: "en",
    });

    const result = await handlers.open("acme");

    expect(result).toEqual({
      ok: false,
      text: "Could not open the database browser.",
      language: "en",
    });
  });

  it("catches a manager that throws", async () => {
    const handlers = createDatabaseHandlers({
      dbgate: dbgate({ open: () => Promise.reject(new Error("boom")) }),
      projects: { acme: "/p/acme" },
      language: "en",
    });

    expect((await handlers.open("acme")).ok).toBe(false);
  });
});

describe("terminal handlers", () => {
  function shells(): {
    manager: ShellManager;
    started: { tabId: string; cwd: string }[];
    written: { tabId: string; data: string }[];
    killed: string[];
  } {
    const started: { tabId: string; cwd: string }[] = [];
    const written: { tabId: string; data: string }[] = [];
    const killed: string[] = [];
    return {
      started,
      written,
      killed,
      manager: {
        start: (tabId, cwd) => started.push({ tabId, cwd }),
        attach: () => "",
        write: (tabId, data) => written.push({ tabId, data }),
        resize: () => {},
        kill: (tabId) => killed.push(tabId),
        stopAll: () => {},
      },
    };
  }

  it("opens a terminal tab and starts a shell in the project's directory", () => {
    const { manager, started } = shells();
    const opened: string[] = [];
    const handlers = createTerminalHandlers({
      shells: manager,
      openTerminalTab: (project) => {
        opened.push(project);
        return "tab-7";
      },
      projects: { acme: "/p/acme" },
      language: "en",
    });

    const result = handlers.open("acme");

    expect(result.ok).toBe(true);
    expect(opened).toEqual(["acme"]);
    expect(started).toEqual([{ tabId: "tab-7", cwd: "/p/acme" }]);
  });

  it("refuses an unknown project without opening a tab or a shell", () => {
    const { manager, started } = shells();
    let openedTab = false;
    const handlers = createTerminalHandlers({
      shells: manager,
      openTerminalTab: () => {
        openedTab = true;
        return "tab-7";
      },
      projects: { acme: "/p/acme" },
      language: "en",
    });

    const result = handlers.open("nope");

    expect(result.ok).toBe(false);
    expect(openedTab).toBe(false);
    expect(started).toEqual([]);
  });

  it("refuses a non-string project", () => {
    const { manager } = shells();
    const handlers = createTerminalHandlers({
      shells: manager,
      openTerminalTab: () => "tab-7",
      projects: { acme: "/p/acme" },
      language: "en",
    });

    expect(handlers.open(undefined as unknown as string).ok).toBe(false);
  });

  it("forwards input for a tab to that tab's shell", () => {
    const { manager, written } = shells();
    const handlers = createTerminalHandlers({
      shells: manager,
      openTerminalTab: () => "tab-7",
      projects: {},
      language: "en",
    });

    handlers.input("tab-7", "ls\r");

    expect(written).toEqual([{ tabId: "tab-7", data: "ls\r" }]);
  });

  // Every argument here crosses an untyped IPC boundary.
  it("ignores input whose tab id or data is not a string", () => {
    const { manager, written } = shells();
    const handlers = createTerminalHandlers({
      shells: manager,
      openTerminalTab: () => "tab-7",
      projects: {},
      language: "en",
    });

    handlers.input(undefined as unknown as string, "ls");
    handlers.input("tab-7", undefined as unknown as string);

    expect(written).toEqual([]);
  });

  it("ignores a resize with non-numeric dimensions", () => {
    const resized: [string, number, number][] = [];
    const { manager } = shells();
    const handlers = createTerminalHandlers({
      shells: { ...manager, resize: (tabId, cols, rows) => resized.push([tabId, cols, rows]) },
      openTerminalTab: () => "tab-7",
      projects: {},
      language: "en",
    });

    handlers.resize("tab-7", "80" as unknown as number, 24);
    handlers.resize("tab-7", 80, 24);

    expect(resized).toEqual([["tab-7", 80, 24]]);
  });

  it("kills a tab's shell when the tab is closed", () => {
    const { manager, killed } = shells();
    const handlers = createTerminalHandlers({
      shells: manager,
      openTerminalTab: () => "tab-7",
      projects: {},
      language: "en",
    });

    handlers.close("tab-7");

    expect(killed).toEqual(["tab-7"]);
  });
});

describe("api handlers", () => {
  function handlers(overrides: Partial<ApiHandlerDeps> = {}) {
    const saved: { path: string; json: unknown }[] = [];
    const deps: ApiHandlerDeps = {
      listCollections: () => Promise.resolve([{ name: "api", path: "/p/acme/api" }]),
      readCollection: (path) =>
        Promise.resolve({
          collection: { name: "api", path },
          root: { name: "api", path, requests: [], folders: [] },
          environments: [],
        }),
      readRequest: () => Promise.resolve({ meta: { name: "R" } }),
      writeRequest: (path, json) => {
        saved.push({ path, json });
        return Promise.resolve();
      },
      createRequest: (folder, name) => Promise.resolve(`${folder}/${name}.bru`),
      createFolder: (parent, name) => Promise.resolve(`${parent}/${name}`),
      renameRequest: (path, name) => Promise.resolve(`${path}:${name}`),
      renameFolder: (path, name) => Promise.resolve(`${path}:${name}`),
      deleteEntry: () => Promise.resolve(),
      createCollection: (root, name) => Promise.resolve(`${root}/${name}`),
      writeEnvironment: (path, name) => Promise.resolve(`${path}/environments/${name}.bru`),
      postmanToRequests: () => ({ name: "Imported", requests: [] }),
      writeImported: (root, name) => Promise.resolve(`${root}/${name}`),
      truncateBody: (body: string) => body,
      store: {
        read: () =>
          Promise.resolve({
            history: [],
            cookies: [],
            settings: { proxyUrl: "", verifyCertificate: true, timeoutMs: 30_000 },
          }),
        addHistory: (_project, entry) => Promise.resolve([entry]),
        clearHistory: () => Promise.resolve(),
        saveCookies: () => Promise.resolve(),
        saveSettings: (_project, settings) => Promise.resolve(settings),
      },
      evaluateAssertions: (assertions) =>
        assertions.map((assertion) => ({
          target: assertion.name ?? "",
          expression: assertion.value ?? "",
          passed: true,
          actual: "200",
        })),
      toCurl: () => "curl 'http://h'",
      sendRequest: () =>
        Promise.resolve({
          response: {
            status: 200,
            statusText: "OK",
            headers: {},
            body: "{}",
            timeMs: 5,
            bytes: 2,
            unresolved: [],
          },
          cookies: [],
        }),
      projects: { acme: "/p/acme" },
      language: "en",
      ...overrides,
    };
    return { api: createApiHandlers(deps), saved };
  }

  it("lists a project's collections", async () => {
    const { api } = handlers();

    expect(await api.collections("acme")).toEqual({
      ok: true,
      value: [{ name: "api", path: "/p/acme/api" }],
    });
  });

  it("refuses an unknown project", async () => {
    const { api } = handlers();

    expect((await api.collections("nope")).ok).toBe(false);
  });

  // The renderer names, main resolves: a path the renderer supplies is only
  // ever accepted if it is inside the project it claims to belong to.
  it("refuses a path outside the project", async () => {
    const { api } = handlers();

    expect((await api.request("acme", "/etc/passwd")).ok).toBe(false);
    expect((await api.request("acme", "/p/acme/../secrets/x.bru")).ok).toBe(false);
  });

  it("accepts a path inside the project", async () => {
    const { api } = handlers();

    expect((await api.request("acme", "/p/acme/api/list.bru")).ok).toBe(true);
  });

  it("refuses to save outside the project, without touching the store", async () => {
    const { api, saved } = handlers();

    const result = await api.save("acme", "/tmp/evil.bru", { meta: {} });

    expect(result.ok).toBe(false);
    expect(saved).toEqual([]);
  });

  it("saves a request inside the project", async () => {
    const { api, saved } = handlers();

    await api.save("acme", "/p/acme/api/list.bru", { meta: { name: "R" } });

    expect(saved).toEqual([{ path: "/p/acme/api/list.bru", json: { meta: { name: "R" } } }]);
  });

  it("sends a request and returns the response", async () => {
    const { api } = handlers();

    const result = await api.send("acme", { meta: {} }, {});

    expect(result.ok && result.value.response).toMatchObject({ status: 200, timeMs: 5 });
  });

  it("wraps a runner that throws behind one localised headline", async () => {
    const { api } = handlers({ sendRequest: () => Promise.reject(new Error("boom")) });

    const result = await api.send("acme", { meta: {} }, {});

    expect(result).toEqual({ ok: false, text: "Could not run the request.", language: "en" });
  });

  it("wraps a collection read that throws", async () => {
    const { api } = handlers({ readCollection: () => Promise.reject(new Error("nope")) });

    expect((await api.tree("acme", "/p/acme/api")).ok).toBe(false);
  });
});

describe("api editing handlers", () => {
  function handlers(overrides: Partial<ApiHandlerDeps> = {}) {
    const deleted: string[] = [];
    const deps: ApiHandlerDeps = {
      listCollections: () => Promise.resolve([]),
      readCollection: () => Promise.reject(new Error("unused")),
      readRequest: () => Promise.reject(new Error("unused")),
      writeRequest: () => Promise.resolve(),
      sendRequest: () => Promise.reject(new Error("unused")),
      truncateBody: (body: string) => body,
      store: {
        read: () =>
          Promise.resolve({
            history: [],
            cookies: [],
            settings: { proxyUrl: "", verifyCertificate: true, timeoutMs: 30_000 },
          }),
        addHistory: (_project, entry) => Promise.resolve([entry]),
        clearHistory: () => Promise.resolve(),
        saveCookies: () => Promise.resolve(),
        saveSettings: (_project, settings) => Promise.resolve(settings),
      },

      createRequest: (folder, name) => Promise.resolve(`${folder}/${name}.bru`),
      createFolder: (parent, name) => Promise.resolve(`${parent}/${name}`),
      renameRequest: (path, name) => Promise.resolve(`renamed:${path}:${name}`),
      renameFolder: (path, name) => Promise.resolve(`folder:${path}:${name}`),
      deleteEntry: (path) => {
        deleted.push(path);
        return Promise.resolve();
      },
      createCollection: (root, name) => Promise.resolve(`${root}/${name}`),
      writeEnvironment: (path, name) => Promise.resolve(`${path}/environments/${name}.bru`),
      postmanToRequests: () => ({ name: "Imported", requests: [] }),
      evaluateAssertions: () => [],
      toCurl: () => "curl 'http://h'",
      writeImported: (root, name) => Promise.resolve(`${root}/${name}`),
      projects: { acme: "/p/acme" },
      language: "en",
      ...overrides,
    };
    return { api: createApiHandlers(deps), deleted };
  }

  it("creates a request inside the project", async () => {
    const { api } = handlers();

    expect(await api.createRequest("acme", "/p/acme/api", "New", 1)).toEqual({
      ok: true,
      value: "/p/acme/api/New.bru",
    });
  });

  it("refuses to create outside the project", async () => {
    const { api } = handlers();

    expect((await api.createRequest("acme", "/tmp", "New", 1)).ok).toBe(false);
  });

  it("refuses a blank name", async () => {
    const { api } = handlers();

    expect((await api.createRequest("acme", "/p/acme/api", "   ", 1)).ok).toBe(false);
  });

  it("renames a request or a folder depending on which it is", async () => {
    const { api } = handlers();

    expect(await api.renameEntry("acme", "/p/acme/api/a.bru", "B", false)).toEqual({
      ok: true,
      value: "renamed:/p/acme/api/a.bru:B",
    });
    expect(await api.renameEntry("acme", "/p/acme/api/f", "G", true)).toEqual({
      ok: true,
      value: "folder:/p/acme/api/f:G",
    });
  });

  it("deletes inside the project", async () => {
    const { api, deleted } = handlers();

    await api.deleteEntry("acme", "/p/acme/api/a.bru");

    expect(deleted).toEqual(["/p/acme/api/a.bru"]);
  });

  // A mis-click in a tree view must not be able to remove the project root.
  it("refuses to delete the project root itself", async () => {
    const { api, deleted } = handlers();

    expect((await api.deleteEntry("acme", "/p/acme")).ok).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("refuses to delete outside the project", async () => {
    const { api, deleted } = handlers();

    expect((await api.deleteEntry("acme", "/etc/hosts")).ok).toBe(false);
    expect(deleted).toEqual([]);
  });

  it("creates a collection at the project root", async () => {
    const { api } = handlers();

    expect(await api.createCollection("acme", "orders")).toEqual({
      ok: true,
      value: "/p/acme/orders",
    });
  });

  it("saves an environment inside the collection", async () => {
    const { api } = handlers();

    expect(
      await api.saveEnvironment("acme", "/p/acme/api", "local", [
        { name: "base", value: "http://h", enabled: true, secret: false },
      ]),
    ).toEqual({ ok: true, value: "/p/acme/api/environments/local.bru" });
  });

  it("imports a Postman collection", async () => {
    const { api } = handlers();

    expect(await api.importPostman("acme", "", {})).toEqual({
      ok: true,
      value: "/p/acme/Imported",
    });
  });

  // An import fails for reasons about the file the user chose, and they are
  // the one who can fix it — so that message survives rather than being
  // replaced by a generic headline.
  it("passes the importer's own message through on a bad file", async () => {
    const { api } = handlers({
      postmanToRequests: () => {
        throw new Error("Only Postman Collection v2.0 and v2.1 are supported");
      },
    });

    expect(await api.importPostman("acme", "", {})).toEqual({
      ok: false,
      text: "Only Postman Collection v2.0 and v2.1 are supported",
      language: "en",
    });
  });
});
