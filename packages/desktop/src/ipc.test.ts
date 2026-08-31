import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWiring,
  createDocsHandlers,
  createEditorHandlers,
  createGitHandlers,
  type WiringDeps,
} from "./ipc.js";
import type { CodeServerManager, DocOutcome, DocReader } from "@jarvis/platform";
import type { DocEntry, WorkspaceState } from "@jarvis/core";
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

function reader(overrides: Partial<DocReader> = {}): DocReader {
  return {
    list: () => Promise.resolve({ ok: true, value: [] } as DocOutcome<DocEntry[]>),
    read: () => Promise.resolve({ ok: true, value: "" } as DocOutcome<string>),
    write: () => Promise.resolve({ ok: true, value: null } as DocOutcome<null>),
    ...overrides,
  };
}

const projects = { acme: "/p/acme" };

describe("docs handlers", () => {
  it("lists a known project's docs", async () => {
    const handlers = createDocsHandlers({
      reader: reader({
        list: () => Promise.resolve({ ok: true, value: [{ path: "a.md", name: "a.md" }] }),
      }),
      projects,
      language: "en",
    });

    expect(await handlers.list("acme")).toEqual({
      ok: true,
      value: [{ path: "a.md", name: "a.md" }],
    });
  });

  // The renderer names a project; main owns the path. A compromised
  // renderer must not be able to point the reader anywhere it likes.
  it("passes the configured root, not anything the caller supplied", async () => {
    const roots: string[] = [];
    const handlers = createDocsHandlers({
      reader: reader({
        list: (root) => {
          roots.push(root);
          return Promise.resolve({ ok: true, value: [] });
        },
      }),
      projects,
      language: "en",
    });

    await handlers.list("acme");

    expect(roots).toEqual(["/p/acme"]);
  });

  it("refuses an unknown project without touching the reader", async () => {
    let called = false;
    const handlers = createDocsHandlers({
      reader: reader({
        list: () => {
          called = true;
          return Promise.resolve({ ok: true, value: [] });
        },
      }),
      projects,
      language: "en",
    });

    const result = await handlers.list("/etc");

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("refuses a non-string project id", async () => {
    const handlers = createDocsHandlers({ reader: reader(), projects, language: "en" });

    // The IPC boundary is untyped at runtime; a buggy or hostile caller can
    // send anything.
    const result = await handlers.list(undefined as unknown as string);

    expect(result.ok).toBe(false);
  });

  it("returns a parsed document model, not markdown source", async () => {
    const handlers = createDocsHandlers({
      reader: reader({ read: () => Promise.resolve({ ok: true, value: "# Title" }) }),
      projects,
      language: "en",
    });

    expect(await handlers.read("acme", "a.md")).toEqual({
      ok: true,
      value: [{ kind: "heading", level: 1, children: [{ kind: "text", text: "Title" }] }],
    });
  });

  it("reports a read failure as localised text, never as a rejection", async () => {
    const handlers = createDocsHandlers({
      reader: reader({
        read: () => Promise.resolve({ ok: false, error: { code: "outside-root", detail: "x" } }),
      }),
      projects,
      language: "en",
    });

    const result = await handlers.read("acme", "x");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.text.length).toBeGreaterThan(0);
    expect(!result.ok && result.language).toBe("en");
  });

  it("localises a failure into Arabic when that is the configured language", async () => {
    const handlers = createDocsHandlers({
      reader: reader({
        read: () => Promise.resolve({ ok: false, error: { code: "too-large", detail: "x" } }),
      }),
      projects,
      language: "ar",
    });

    const result = await handlers.read("acme", "x");

    expect(!result.ok && result.language).toBe("ar");
    expect(!result.ok && /[؀-ۿ]/.test(result.text)).toBe(true);
  });

  it("survives a reader that throws instead of returning a failure", async () => {
    const handlers = createDocsHandlers({
      reader: reader({ read: () => Promise.reject(new Error("boom")) }),
      projects,
      language: "en",
    });

    const result = await handlers.read("acme", "a.md");

    expect(result.ok).toBe(false);
  });

  it("writes content through to the configured project's root", async () => {
    const calls: [string, string, string][] = [];
    const handlers = createDocsHandlers({
      reader: reader({
        write: (root, path, content) => {
          calls.push([root, path, content]);
          return Promise.resolve({ ok: true, value: null });
        },
      }),
      projects,
      language: "en",
    });

    const result = await handlers.write("acme", "a.md", "new content");

    expect(result).toEqual({ ok: true, value: null });
    expect(calls).toEqual([["/p/acme", "a.md", "new content"]]);
  });

  it("refuses to write to an unknown project without touching the reader", async () => {
    let called = false;
    const handlers = createDocsHandlers({
      reader: reader({
        write: () => {
          called = true;
          return Promise.resolve({ ok: true, value: null });
        },
      }),
      projects,
      language: "en",
    });

    const result = await handlers.write("/etc", "a.md", "pwned");

    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("refuses a non-string path or content on write", async () => {
    const handlers = createDocsHandlers({ reader: reader(), projects, language: "en" });

    const byPath = await handlers.write("acme", undefined as unknown as string, "x");
    const byContent = await handlers.write("acme", "a.md", undefined as unknown as string);

    expect(byPath.ok).toBe(false);
    expect(byContent.ok).toBe(false);
  });

  it("reports a write failure as localised text", async () => {
    const handlers = createDocsHandlers({
      reader: reader({
        write: () => Promise.resolve({ ok: false, error: { code: "not-found", detail: "x" } }),
      }),
      projects,
      language: "en",
    });

    const result = await handlers.write("acme", "a.md", "x");

    expect(result.ok).toBe(false);
    expect(!result.ok && result.text.length).toBeGreaterThan(0);
  });

  it("survives a reader whose write throws instead of returning a failure", async () => {
    const handlers = createDocsHandlers({
      reader: reader({ write: () => Promise.reject(new Error("boom")) }),
      projects,
      language: "en",
    });

    const result = await handlers.write("acme", "a.md", "x");

    expect(result.ok).toBe(false);
  });

  // parse is pure — no project, no filesystem, no failure mode. It exists
  // so the renderer can preview unsaved edits (Dev-mode text that has not
  // been written to disk yet) through the same parser read() already uses,
  // without ever writing that draft to disk just to look at it.
  it("parses arbitrary text with no filesystem access at all", () => {
    const handlers = createDocsHandlers({ reader: reader(), projects, language: "en" });

    expect(handlers.parse("# Title")).toEqual([
      { kind: "heading", level: 1, children: [{ kind: "text", text: "Title" }] },
    ]);
  });

  it("returns raw markdown source, not the parsed model", async () => {
    const handlers = createDocsHandlers({
      reader: reader({ read: () => Promise.resolve({ ok: true, value: "# Title\n" }) }),
      projects,
      language: "en",
    });

    expect(await handlers.readRaw("acme", "a.md")).toEqual({ ok: true, value: "# Title\n" });
  });

  it("reports a readRaw failure the same way read does", async () => {
    const handlers = createDocsHandlers({
      reader: reader({
        read: () => Promise.resolve({ ok: false, error: { code: "not-found", detail: "x" } }),
      }),
      projects,
      language: "en",
    });

    const result = await handlers.readRaw("acme", "x");

    expect(result.ok).toBe(false);
  });

  it("finds task-marker offsets with no filesystem access at all", () => {
    const handlers = createDocsHandlers({ reader: reader(), projects, language: "en" });

    expect(handlers.taskOffsets("- [x] a\n- [ ] b")).toHaveLength(2);
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
      language: "en",
    });

    const result = await handlers.open("acme");

    expect(result.ok).toBe(false);
  });
});
