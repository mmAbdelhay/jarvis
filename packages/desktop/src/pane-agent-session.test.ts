import { join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "@jarvis/core";
import type { ExternalAgentProcess } from "@jarvis/platform";
import {
  createPaneAgentLookup,
  listCodexRollouts,
  parseChildPids,
  parseLsofFileNames,
  type PaneAgentLookupDeps,
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
    });
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
      await expect(createPaneAgentLookup(deps).forProcess(processOf("codex"))).resolves.toEqual({
        paneKey: "t1",
        pid: 500,
        vendor: "openai",
        sessionId: "aaaa",
        transcriptPath: ROLLOUT,
        cwd: "/w",
      });
      expect(openFiles).toHaveBeenCalledWith([500, 501]);
    });

    it("ignores a rollout outside the agent's own sessions directory", async () => {
      const { deps } = world({ openFiles: async () => ["/elsewhere/rollout-x.jsonl"] });
      await expect(
        createPaneAgentLookup(deps).forProcess(processOf("codex")),
      ).resolves.toBeUndefined();
    });

    it("does not take a rollout under a sibling directory that shares the prefix", async () => {
      const sibling = join("/h", ".codex", "sessions-old", "2026", "rollout-x-cccc.jsonl");
      const { deps } = world({
        openFiles: async () => [sibling],
        readHead: async () => meta("cccc", "/w"),
      });
      await expect(
        createPaneAgentLookup(deps).forProcess(processOf("codex")),
      ).resolves.toBeUndefined();
    });

    it("is undefined when lsof shows two open rollouts", async () => {
      const { deps } = world({ openFiles: async () => [ROLLOUT, OTHER] });
      await expect(
        createPaneAgentLookup(deps).forProcess(processOf("codex")),
      ).resolves.toBeUndefined();
    });

    it("falls back to the one rollout with the process's cwd, started after it", async () => {
      const { deps } = world({
        listRollouts: async () => [
          { path: ROLLOUT, mtimeMs: 2000 },
          { path: OTHER, mtimeMs: 500 }, // older than the process
        ],
      });
      await expect(
        createPaneAgentLookup(deps).forProcess(processOf("codex")),
      ).resolves.toMatchObject({
        sessionId: "aaaa",
        transcriptPath: ROLLOUT,
      });
    });

    it("gives none when the fallback has two candidates", async () => {
      const { deps } = world({
        listRollouts: async () => [
          { path: ROLLOUT, mtimeMs: 2000 },
          { path: OTHER, mtimeMs: 3000 },
        ],
      });
      await expect(
        createPaneAgentLookup(deps).forProcess(processOf("codex")),
      ).resolves.toBeUndefined();
    });

    it("gives none when the cwd differs or is unknown", async () => {
      const { deps } = world({ listRollouts: async () => [{ path: ROLLOUT, mtimeMs: 2000 }] });
      const lookup = createPaneAgentLookup(deps);
      await expect(
        lookup.forProcess(processOf("codex", { cwd: "/else" })),
      ).resolves.toBeUndefined();
      await expect(lookup.forProcess(processOf("codex", { cwd: null }))).resolves.toBeUndefined();
    });

    it("uses the account's own config directory", async () => {
      const listRollouts = vi.fn(async () => []);
      const { deps } = world({ listRollouts });
      await createPaneAgentLookup(deps).forProcess(processOf("codex-work"));
      expect(listRollouts).toHaveBeenCalledWith(join("/h/.codex-work", "sessions"));
    });

    it("on Windows never runs lsof and resolves by the fallback only", async () => {
      const openFiles = vi.fn(async () => [ROLLOUT]);
      const { deps } = world({
        platform: "win32",
        openFiles,
        listRollouts: async () => [{ path: OTHER, mtimeMs: 2000 }],
      });
      const out = await createPaneAgentLookup(deps).forProcess(processOf("codex"));
      expect(openFiles).not.toHaveBeenCalled();
      expect(out?.sessionId).toBe("bbbb");
    });

    it("never throws when a dependency does", async () => {
      const { deps } = world({
        openFiles: async () => Promise.reject(new Error("lsof")),
        childPids: async () => Promise.reject(new Error("ps")),
        listRollouts: async () => Promise.reject(new Error("fs")),
      });
      await expect(
        createPaneAgentLookup(deps).forProcess(processOf("codex")),
      ).resolves.toBeUndefined();
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
