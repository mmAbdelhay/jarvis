import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@jarvis/core";
import type { ExternalAgentProcess } from "@jarvis/platform";
import {
  createPaneAgentLookup,
  listCodexRollouts,
  parseChildPids,
  parseLsofFileNames,
  sameAgentSession,
  type PaneAgentLookupDeps,
  type PaneAgentSession,
} from "./pane-agent-session.js";

const AGENTS: AgentConfig[] = [
  { id: "claude", command: "claude", vendor: "anthropic", configDir: "/h/.claude-main" },
  { id: "copilot", command: "copilot", vendor: "github" },
  { id: "codex", command: "codex", vendor: "openai" },
  { id: "codex-work", command: "codex-work", vendor: "openai", configDir: "/h/.codex-work" },
];
const COPILOT_STATE = join("/h", ".copilot", "session-state");
const CODEX_SESSIONS = join("/h", ".codex", "sessions");
const ROLLOUT = join(CODEX_SESSIONS, "2026", "11", "23", "rollout-2026-11-23T10-00-00-aaaa.jsonl");
const OTHER = join(CODEX_SESSIONS, "2026", "11", "23", "rollout-2026-11-23T10-05-00-bbbb.jsonl");

function processOf(agentId: string, overrides: Partial<ExternalAgentProcess> = {}) {
  return {
    pid: 500,
    agentId,
    command: agentId,
    cwd: "/w",
    startedAt: 1000,
    terminalPaneKey: "t1",
    foreground: true,
    ...overrides,
  } satisfies ExternalAgentProcess;
}

const meta = (id: string, cwd: string): string =>
  `${JSON.stringify({ type: "session_meta", payload: { id, cwd } })}\n{"type":"turn_context"`;

function world(overrides: Partial<PaneAgentLookupDeps> = {}) {
  const dirs = new Map<string, string[]>([
    [COPILOT_STATE, ["s-one", "s-two"]],
    [join(COPILOT_STATE, "s-one"), ["workspace.yaml", "events.jsonl"]],
    [join(COPILOT_STATE, "s-two"), ["workspace.yaml", "events.jsonl", "inuse.501.lock"]],
  ]);
  const deps: PaneAgentLookupDeps = {
    agents: () => AGENTS,
    home: "/h",
    platform: "darwin",
    readFile: async () => {
      throw new Error("ENOENT");
    },
    listTranscripts: async () => [],
    listDir: vi.fn(async (path: string) => {
      const entries = dirs.get(path);
      if (entries === undefined) throw new Error("ENOENT");
      return entries;
    }),
    childPids: vi.fn(async () => [] as number[]),
    openFiles: vi.fn(async () => [] as string[]),
    listRollouts: vi.fn(async () => [] as { path: string; mtimeMs: number }[]),
    readHead: vi.fn(async (path: string) => {
      if (path === ROLLOUT) return meta("aaaa", "/w");
      if (path === OTHER) return meta("bbbb", "/w");
      throw new Error("ENOENT");
    }),
    ...overrides,
  };
  return { deps, dirs };
}

const MINE = processOf("codex");

describe("parsers", () => {
  it("reads direct children from ps output", () => {
    const ps = ["  1     0", "500   400", "501   500", "502   500", "503   501"].join("\n");
    expect(parseChildPids(ps, 500)).toEqual([501, 502]);
  });

  it("reads file names from lsof -Fn output", () => {
    expect(parseLsofFileNames("p500\nfcwd\nn/w\nf7\nn/a/rollout-x.jsonl\np501\nn/b c")).toEqual([
      "/w",
      "/a/rollout-x.jsonl",
      "/b c",
    ]);
  });
});

describe("createPaneAgentLookup", () => {
  it("is undefined for a process outside a pane or of an unknown agent", async () => {
    const lookup = createPaneAgentLookup(world().deps);
    await expect(
      lookup.forProcess(processOf("codex", { terminalPaneKey: undefined })),
    ).resolves.toBeUndefined();
    await expect(lookup.forProcess(processOf("nobody"))).resolves.toBeUndefined();
  });

  it("delegates anthropic to the Claude lookup and tags the vendor", async () => {
    const files = new Map([
      [
        join("/h/.claude-main", "sessions", "500.json"),
        JSON.stringify({ pid: 500, sessionId: "c1", name: "n" }),
      ],
    ]);
    const { deps } = world({
      readFile: async (path) => {
        const text = files.get(path);
        if (text === undefined) throw new Error("ENOENT");
        return text;
      },
      listTranscripts: async () => [
        { path: join("/h/.claude-main", "projects", "-w", "c1.jsonl"), mtime: 1 },
      ],
    });
    await expect(createPaneAgentLookup(deps).forProcess(processOf("claude"))).resolves.toEqual({
      paneKey: "t1",
      pid: 500,
      vendor: "anthropic",
      sessionId: "c1",
      name: "n",
      transcriptPath: join("/h/.claude-main", "projects", "-w", "c1.jsonl"),
      cwd: "/w",
      configDir: "/h/.claude-main",
    });
  });

  it("names the account's config directory even before a transcript exists", async () => {
    const { deps } = world({
      readFile: async (path) => {
        if (path === join("/h/.claude-main", "sessions", "500.json"))
          return JSON.stringify({ pid: 500, sessionId: "c1" });
        throw new Error("ENOENT");
      },
    });
    const found = await createPaneAgentLookup(deps).forProcess(processOf("claude"));
    expect(found?.transcriptPath).toBeUndefined();
    expect(found?.configDir).toBe("/h/.claude-main");
  });

  describe("github", () => {
    it("matches the session directory holding inuse.<pid>.lock, via a child pid", async () => {
      const { deps } = world({ childPids: vi.fn(async () => [501]) });
      await expect(createPaneAgentLookup(deps).forProcess(processOf("copilot"))).resolves.toEqual({
        paneKey: "t1",
        pid: 500,
        vendor: "github",
        sessionId: "s-two",
        transcriptPath: join(COPILOT_STATE, "s-two", "events.jsonl"),
        cwd: "/w",
        configDir: join("/h", ".copilot"),
      });
    });

    it("is undefined with no matching lock", async () => {
      const lookup = createPaneAgentLookup(world().deps);
      await expect(lookup.forProcess(processOf("copilot"))).resolves.toBeUndefined();
    });

    it("is undefined when two sessions hold a lock for the process", async () => {
      const { deps, dirs } = world({ childPids: vi.fn(async () => [501]) });
      dirs.set(join(COPILOT_STATE, "s-one"), ["inuse.500.lock"]);
      await expect(
        createPaneAgentLookup(deps).forProcess(processOf("copilot")),
      ).resolves.toBeUndefined();
    });

    it("is undefined, never throwing, when the directory cannot be read", async () => {
      const { deps } = world({ listDir: async () => Promise.reject(new Error("x")) });
      await expect(
        createPaneAgentLookup(deps).forProcess(processOf("copilot")),
      ).resolves.toBeUndefined();
    });
  });

  describe("openai", () => {
    it("takes the single open rollout, asking lsof about the pid and its children", async () => {
      const openFiles = vi.fn(async () => [ROLLOUT, "/w/file.ts"]);
      const { deps } = world({ openFiles, childPids: vi.fn(async () => [501]) });
      await expect(createPaneAgentLookup(deps).forProcess(MINE, [MINE])).resolves.toEqual({
        paneKey: "t1",
        pid: 500,
        vendor: "openai",
        sessionId: "aaaa",
        transcriptPath: ROLLOUT,
        startedAt: 1000,
        cwd: "/w",
        configDir: join("/h", ".codex"),
      });
      expect(openFiles).toHaveBeenCalledWith([500, 501]);
    });

    it("ignores a rollout outside the agent's own sessions directory", async () => {
      const { deps } = world({ openFiles: async () => ["/elsewhere/rollout-x.jsonl"] });
      await expect(createPaneAgentLookup(deps).forProcess(MINE, [MINE])).resolves.toMatchObject({
        pending: true,
      });
    });

    it("does not take a rollout under a sibling directory that shares the prefix", async () => {
      const sibling = join("/h", ".codex", "sessions-old", "2026", "rollout-x-cccc.jsonl");
      const { deps } = world({
        openFiles: async () => [sibling],
        readHead: async () => meta("cccc", "/w"),
      });
      await expect(createPaneAgentLookup(deps).forProcess(MINE, [MINE])).resolves.toMatchObject({
        pending: true,
      });
    });

    it("is undefined when lsof shows two open rollouts", async () => {
      const { deps } = world({ openFiles: async () => [ROLLOUT, OTHER] });
      await expect(createPaneAgentLookup(deps).forProcess(MINE, [MINE])).resolves.toBeUndefined();
    });

    it("falls back to the one rollout with the process's cwd, started after it", async () => {
      const { deps } = world({
        listRollouts: async () => [
          { path: ROLLOUT, mtimeMs: 2000 },
          { path: OTHER, mtimeMs: -5000 }, // older than the process
        ],
      });
      await expect(createPaneAgentLookup(deps).forProcess(MINE, [MINE])).resolves.toMatchObject({
        sessionId: "aaaa",
        transcriptPath: ROLLOUT,
      });
    });

    it("gives a pending session, not a guess, when two rollouts are candidates and another codex is in the cwd", async () => {
      const { deps } = world({
        listRollouts: async () => [
          { path: ROLLOUT, mtimeMs: 2000 },
          { path: OTHER, mtimeMs: 3000 },
        ],
      });
      const peer = processOf("codex", { pid: 600, startedAt: 900 });
      await expect(
        createPaneAgentLookup(deps).forProcess(MINE, [MINE, peer]),
      ).resolves.toMatchObject({ pending: true });
    });

    it("gives none when the cwd is unknown, and a pending session when no rollout is in the cwd", async () => {
      const { deps } = world({ listRollouts: async () => [{ path: ROLLOUT, mtimeMs: 2000 }] });
      const lookup = createPaneAgentLookup(deps);
      await expect(
        lookup.forProcess(processOf("codex", { cwd: null }), []),
      ).resolves.toBeUndefined();
      await expect(
        lookup.forProcess(processOf("codex", { cwd: "/else" }), [
          processOf("codex", { cwd: "/else" }),
        ]),
      ).resolves.toMatchObject({
        pending: true,
        sessionId: "pending-500-1000",
        startedAt: 1000,
      });
    });

    it("is pending before any rollout exists, and the real session after", async () => {
      let rollouts: { path: string; mtimeMs: number }[] = [];
      const { deps } = world({ listRollouts: async () => rollouts });
      const lookup = createPaneAgentLookup(deps);
      const before = await lookup.forProcess(MINE, [MINE]);
      expect(before).toMatchObject({ pending: true });
      expect(before?.transcriptPath).toBeUndefined();
      rollouts = [{ path: ROLLOUT, mtimeMs: 2000 }];
      const after = await lookup.forProcess(MINE, [MINE]);
      expect(after).toMatchObject({ sessionId: "aaaa", transcriptPath: ROLLOUT });
      expect(after?.pending).toBeUndefined();
      expect(sameAgentSession(before as PaneAgentSession, after as PaneAgentSession)).toBe(true);
      expect(
        sameAgentSession(before as PaneAgentSession, {
          ...(after as PaneAgentSession),
          pid: 501,
        }),
      ).toBe(false);
    });

    it("skips an older session of the same cwd that something touched later", async () => {
      const old = `${JSON.stringify({ type: "session_meta", payload: { id: "bbbb", cwd: "/w", timestamp: new Date(1000 - 60_000).toISOString() } })}\n`;
      const fresh = `${JSON.stringify({ type: "session_meta", payload: { id: "aaaa", cwd: "/w", timestamp: new Date(1500).toISOString() } })}\n`;
      const { deps } = world({
        listRollouts: async () => [
          { path: ROLLOUT, mtimeMs: 2000 },
          { path: OTHER, mtimeMs: 9000 },
        ],
        readHead: async (path) => (path === ROLLOUT ? fresh : old),
      });
      await expect(createPaneAgentLookup(deps).forProcess(MINE, [MINE])).resolves.toMatchObject({
        sessionId: "aaaa",
      });
    });

    it("takes the newest of several rollouts only when no other codex shares the cwd", async () => {
      const stamp = (id: string, at: number): string =>
        `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/w", timestamp: new Date(at).toISOString() } })}\n`;
      const { deps } = world({
        listRollouts: async () => [
          { path: ROLLOUT, mtimeMs: 2000 },
          { path: OTHER, mtimeMs: 3000 },
        ],
        readHead: async (path) => (path === ROLLOUT ? stamp("aaaa", 1500) : stamp("bbbb", 2500)),
      });
      const lookup = createPaneAgentLookup(deps);
      const mine = processOf("codex");
      await expect(lookup.forProcess(mine, [mine])).resolves.toMatchObject({ sessionId: "bbbb" });
      const second = processOf("codex", { pid: 501 });
      const other = processOf("codex", { pid: 600, terminalPaneKey: "t2" });
      await expect(lookup.forProcess(second, [second, other])).resolves.toMatchObject({
        pending: true,
      });
      const elsewhere = processOf("codex", { pid: 600, cwd: "/x" });
      await expect(lookup.forProcess(second, [second, elsewhere])).resolves.toMatchObject({
        sessionId: "bbbb",
      });
      // Not told about peers: never a guess.
      await expect(lookup.forProcess(processOf("codex", { pid: 502 }))).resolves.toMatchObject({
        pending: true,
      });
      // A process that was bound keeps its session when it later turns ambiguous.
      await expect(lookup.forProcess(mine, [mine, other])).resolves.toMatchObject({
        sessionId: "bbbb",
      });
    });

    describe("several codex processes in one cwd, and resume", () => {
      const stamp = (id: string, at: number, extra: object = {}): string =>
        `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/w", timestamp: new Date(at).toISOString(), ...extra } })}\n`;
      const one = (at: number, mtimeMs: number, extra: object = {}) =>
        world({
          listRollouts: async () => [{ path: ROLLOUT, mtimeMs }],
          readHead: async () => stamp("aaaa", at, extra),
        }).deps;

      it("lets two TUIs in one cwd both stay pending when one rollout could be either's", async () => {
        const deps = one(1500, 2000);
        const lookup = createPaneAgentLookup(deps);
        const a = processOf("codex", { pid: 500, startedAt: 1000 });
        const b = processOf("codex", { pid: 501, startedAt: 1100 });
        await expect(lookup.forProcess(a, [a, b])).resolves.toMatchObject({ pending: true });
        await expect(lookup.forProcess(b, [a, b])).resolves.toMatchObject({ pending: true });
      });

      it("does not count a peer that started after the rollout began", async () => {
        const lookup = createPaneAgentLookup(one(1500, 2000));
        const a = processOf("codex", { pid: 500, startedAt: 1000 });
        const late = processOf("codex", { pid: 501, startedAt: 9000 });
        await expect(lookup.forProcess(a, [a, late])).resolves.toMatchObject({ sessionId: "aaaa" });
      });

      it("keeps a rollout bound to one live process away from another, but not a dead one's", async () => {
        const lookup = createPaneAgentLookup(one(1500, 2000));
        const x = processOf("codex", { pid: 500, startedAt: 1000 });
        const y = processOf("codex", { pid: 501, startedAt: 1100, cwd: "/elsewhere" });
        await expect(lookup.forProcess(x, [x, y])).resolves.toMatchObject({ sessionId: "aaaa" });
        // X moved on to another directory, so it no longer contests the rollout,
        // but the rollout stays bound to it while it lives.
        const xMoved = processOf("codex", { pid: 500, startedAt: 1000, cwd: "/elsewhere" });
        const y2 = processOf("codex", { pid: 501, startedAt: 1100 });
        await expect(lookup.forProcess(y2, [xMoved, y2])).resolves.toMatchObject({
          pending: true,
        });
        // X is gone: nothing binds the rollout away from Y any more.
        const peerGone = createPaneAgentLookup(one(1500, 2000));
        await peerGone.forProcess(x, [x]);
        await expect(peerGone.forProcess(y2, [y2])).resolves.toMatchObject({ sessionId: "aaaa" });
      });

      it("is pending for an older rollout of the cwd that was only touched at start-up", async () => {
        await expect(
          createPaneAgentLookup(one(1000 - 60_000, 3000)).forProcess(MINE, [MINE]),
        ).resolves.toMatchObject({ pending: true });
      });

      it("finds a resumed rollout that began before the process, when it is the one written since start-up", async () => {
        const old = 1000 - 3_600_000;
        await expect(
          createPaneAgentLookup(one(old, 20_000)).forProcess(MINE, [MINE]),
        ).resolves.toMatchObject({ sessionId: "aaaa", transcriptPath: ROLLOUT });
        // A flush at start-up is not a write by the session.
        await expect(
          createPaneAgentLookup(one(old, 3000)).forProcess(MINE, [MINE]),
        ).resolves.toMatchObject({ pending: true });
        // Nor is a sub-agent's, or one with another codex in the cwd.
        await expect(
          createPaneAgentLookup(one(old, 20_000, { source: { subagent: {} } })).forProcess(MINE, [
            MINE,
          ]),
        ).resolves.toMatchObject({ pending: true });
        const peer = processOf("codex", { pid: 600 });
        await expect(
          createPaneAgentLookup(one(old, 20_000)).forProcess(MINE, [MINE, peer]),
        ).resolves.toMatchObject({ pending: true });
      });

      it("stays pending when two older rollouts were both written since start-up", async () => {
        const old = 1000 - 3_600_000;
        const { deps } = world({
          listRollouts: async () => [
            { path: ROLLOUT, mtimeMs: 20_000 },
            { path: OTHER, mtimeMs: 30_000 },
          ],
          readHead: async (path) => stamp(path === ROLLOUT ? "aaaa" : "bbbb", old),
        });
        await expect(createPaneAgentLookup(deps).forProcess(MINE, [MINE])).resolves.toMatchObject({
          pending: true,
        });
      });
    });

    it("prefers the main thread over a sub-agent rollout", async () => {
      const line = (id: string, extra: object): string =>
        `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/w", timestamp: new Date(1500).toISOString(), ...extra } })}\n`;
      const { deps } = world({
        listRollouts: async () => [
          { path: ROLLOUT, mtimeMs: 2000 },
          { path: OTHER, mtimeMs: 3000 },
        ],
        readHead: async (path) =>
          path === ROLLOUT
            ? line("aaaa", { source: "cli" })
            : line("bbbb", { source: { subagent: { thread_spawn: {} } } }),
      });
      await expect(createPaneAgentLookup(deps).forProcess(MINE, [MINE])).resolves.toMatchObject({
        sessionId: "aaaa",
      });
    });

    it("compares real paths for a symlinked sessions dir and cwd", async () => {
      const real = join("/real", "codex", "sessions", "2026", "11", "23", "rollout-x-aaaa.jsonl");
      const { deps } = world({
        openFiles: async () => [real],
        realPath: async (path) =>
          path === join("/h", ".codex", "sessions")
            ? join("/real", "codex", "sessions")
            : path.startsWith("/tmp")
              ? `/private${path}`
              : path,
        readHead: async () => meta("aaaa", "/private/tmp/w"),
      });
      await expect(
        createPaneAgentLookup(deps).forProcess(processOf("codex", { cwd: "/tmp/w" }), [
          processOf("codex", { cwd: "/tmp/w" }),
        ]),
      ).resolves.toMatchObject({ sessionId: "aaaa", transcriptPath: real });
      const viaCwd = world({
        listRollouts: async () => [{ path: ROLLOUT, mtimeMs: 2000 }],
        realPath: async (path) => (path.startsWith("/tmp") ? `/private${path}` : path),
        readHead: async () => meta("aaaa", "/private/tmp/w"),
      });
      await expect(
        createPaneAgentLookup(viaCwd.deps).forProcess(processOf("codex", { cwd: "/tmp/w" }), [
          processOf("codex", { cwd: "/tmp/w" }),
        ]),
      ).resolves.toMatchObject({ sessionId: "aaaa" });
    });

    it("uses the account's own config directory", async () => {
      const listRollouts = vi.fn(async () => []);
      const { deps } = world({ listRollouts });
      await createPaneAgentLookup(deps).forProcess(processOf("codex-work"), [
        processOf("codex-work"),
      ]);
      expect(listRollouts).toHaveBeenCalledWith(join("/h/.codex-work", "sessions"));
    });

    it("names the account's own directory for a codex account with a config directory", async () => {
      const { deps } = world({
        listRollouts: async () => [
          {
            path: join("/h/.codex-work", "sessions", "2026", "11", "23", "rollout-x-cccc.jsonl"),
            mtimeMs: 2000,
          },
        ],
        readHead: async () => meta("cccc", "/w"),
      });
      const found = await createPaneAgentLookup(deps).forProcess(processOf("codex-work"), [
        processOf("codex-work"),
      ]);
      expect(found?.configDir).toBe("/h/.codex-work");
    });

    it("on Windows never runs lsof and resolves by the fallback only", async () => {
      const openFiles = vi.fn(async () => [ROLLOUT]);
      const { deps } = world({
        platform: "win32",
        openFiles,
        listRollouts: async () => [{ path: OTHER, mtimeMs: 2000 }],
      });
      const out = await createPaneAgentLookup(deps).forProcess(MINE, [MINE]);
      expect(openFiles).not.toHaveBeenCalled();
      expect(out?.sessionId).toBe("bbbb");
    });

    it("never throws when a dependency does", async () => {
      const { deps } = world({
        openFiles: async () => Promise.reject(new Error("lsof")),
        childPids: async () => Promise.reject(new Error("ps")),
        listRollouts: async () => Promise.reject(new Error("fs")),
      });
      await expect(createPaneAgentLookup(deps).forProcess(MINE, [MINE])).resolves.toBeUndefined();
    });
  });
});

describe("listCodexRollouts", () => {
  it("walks year/month/day newest first, keeps rollouts only, stops at the cap", async () => {
    const tree = new Map<string, string[]>([
      ["/s", ["2026", "2025", "note.txt"]],
      ["/s/2026", ["11"]],
      ["/s/2026/11", ["22", "23"]],
      ["/s/2026/11/23", ["rollout-b.jsonl", "rollout-a.jsonl", "other.txt"]],
      ["/s/2026/11/22", ["rollout-c.jsonl"]],
      ["/s/2025", ["01"]],
      ["/s/2025/01", ["01"]],
      ["/s/2025/01/01", ["rollout-old.jsonl"]],
    ]);
    const fs = {
      readDir: async (path: string) => {
        const entries = tree.get(path.split("\\").join("/"));
        if (entries === undefined) throw new Error("ENOENT");
        return entries;
      },
      mtimeMs: async () => 7,
    };
    const all = await listCodexRollouts("/s", fs);
    expect(all.map((file) => file.path.split(sep).slice(-1)[0])).toEqual([
      "rollout-b.jsonl",
      "rollout-a.jsonl",
      "rollout-c.jsonl",
      "rollout-old.jsonl",
    ]);
    expect(all[0]?.mtimeMs).toBe(7);
    expect(await listCodexRollouts("/s", fs, 2)).toHaveLength(2);
    expect(await listCodexRollouts("/missing", fs)).toEqual([]);
  });
});
