// Which coding-agent session runs in a Terminal pane, for the desktop's
// Chat view: Claude Code through its pid file (pane-claude-session.ts, left
// as it is), Copilot through the `inuse.<pid>.lock` its session directory
// holds, Codex through the rollout file it has open. Every doubt gives
// undefined — two candidates are never guessed between — and nothing here
// throws. All file and process access is injected.

import { join } from "node:path";
import type { AgentConfig } from "@jarvis/core";
import { transcriptDirs, type ExternalAgentProcess } from "@jarvis/platform";
import {
  createPaneClaudeLookup,
  type PaneClaudeLookup,
  type PaneClaudeLookupDeps,
} from "./pane-claude-session.js";

export type AgentVendor = "anthropic" | "github" | "openai";

export type PaneAgentSession = {
  paneKey: string;
  pid: number;
  vendor: AgentVendor;
  sessionId: string;
  /** The agent's own name for the session, when it has one. */
  name?: string;
  /** Absent until the agent has written the transcript. */
  transcriptPath?: string;
  cwd: string | null;
};

export type PaneAgentLookupDeps = PaneClaudeLookupDeps & {
  platform: NodeJS.Platform;
  /** CODEX_HOME and the like; only read for an agent with no configDir. */
  env?: NodeJS.ProcessEnv;
  /** Entry names in a directory; rejects when it is missing. */
  listDir(path: string): Promise<string[]>;
  /** Direct child pids of a process. */
  childPids(pid: number): Promise<number[]>;
  /** Paths of the files these processes hold open (lsof); posix only. */
  openFiles(pids: number[]): Promise<string[]>;
  /** Every rollout file under a Codex sessions directory, with its mtime. */
  listRollouts(dir: string): Promise<{ path: string; mtimeMs: number }[]>;
  /** The start of a file, as text. */
  readHead(path: string): Promise<string>;
};

export type PaneAgentLookup = {
  forProcess(process: ExternalAgentProcess): Promise<PaneAgentSession | undefined>;
  retain: PaneClaudeLookup["retain"];
  forget: PaneClaudeLookup["forget"];
};

/** The direct children of `pid` in `ps -axo pid=,ppid=` output. */
export function parseChildPids(text: string, pid: number): number[] {
  const children: number[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (match !== null && Number(match[2]) === pid) children.push(Number(match[1]));
  }
  return children;
}

/** Every `n` (name) line of `lsof -Fn` output. */
export function parseLsofFileNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("n") && line.length > 1) names.push(line.slice(1).trimEnd());
  }
  return names;
}

const ROLLOUT_NAME = /(?:^|[\\/])rollout-[^\\/]*\.jsonl$/;

function agentSessionsDir(agent: AgentConfig, deps: PaneAgentLookupDeps): string {
  const codexHome = deps.env?.["CODEX_HOME"];
  const base =
    agent.configDir ??
    (codexHome !== undefined && codexHome !== "" ? codexHome : join(deps.home, ".codex"));
  return join(base, "sessions");
}

/** A rollout's session id and cwd, from the `session_meta` record on its first line. */
async function rolloutMeta(
  path: string,
  readHead: PaneAgentLookupDeps["readHead"],
): Promise<{ id: string; cwd: string | undefined } | undefined> {
  try {
    const first = (await readHead(path)).split("\n")[0] ?? "";
    const record = JSON.parse(first) as { type?: unknown; payload?: Record<string, unknown> };
    const payload = record.payload;
    if (record.type !== "session_meta" || payload === undefined || payload === null) {
      return undefined;
    }
    const fromName = /([0-9a-f-]{8,})\.jsonl$/i.exec(path)?.[1];
    const id = typeof payload["id"] === "string" && payload["id"] !== "" ? payload["id"] : fromName;
    if (id === undefined) return undefined;
    const cwd = payload["cwd"];
    return { id, cwd: typeof cwd === "string" ? cwd : undefined };
  } catch {
    return undefined;
  }
}

export function createPaneAgentLookup(deps: PaneAgentLookupDeps): PaneAgentLookup {
  const claude = createPaneClaudeLookup(deps);

  async function pidsOf(process: ExternalAgentProcess): Promise<number[]> {
    let children: number[] = [];
    try {
      children = await deps.childPids(process.pid);
    } catch {
      // The pid alone.
    }
    return [process.pid, ...children.filter((pid) => pid !== process.pid)];
  }

  async function copilot(
    process: ExternalAgentProcess,
    paneKey: string,
    agent: AgentConfig,
  ): Promise<PaneAgentSession | undefined> {
    const dir = transcriptDirs([agent], deps.home).find((entry) => entry.format === "copilot")?.dir;
    if (dir === undefined) return undefined;
    const locks = new Set((await pidsOf(process)).map((pid) => `inuse.${pid}.lock`));
    const matches: string[] = [];
    for (const session of await deps.listDir(dir)) {
      let entries: string[];
      try {
        entries = await deps.listDir(join(dir, session));
      } catch {
        continue; // A stray file, or a session directory that just went.
      }
      if (entries.some((entry) => locks.has(entry))) matches.push(session);
    }
    const [sessionId] = matches;
    if (matches.length !== 1 || sessionId === undefined) return undefined;
    return {
      paneKey,
      pid: process.pid,
      vendor: "github",
      sessionId,
      transcriptPath: join(dir, sessionId, "events.jsonl"),
      cwd: process.cwd,
    };
  }

  async function codex(
    process: ExternalAgentProcess,
    paneKey: string,
    agent: AgentConfig,
  ): Promise<PaneAgentSession | undefined> {
    const sessionsDir = agentSessionsDir(agent, deps);
    const session = (id: string, transcriptPath: string): PaneAgentSession => ({
      paneKey,
      pid: process.pid,
      vendor: "openai",
      sessionId: id,
      transcriptPath,
      cwd: process.cwd,
    });
    const under = (path: string): boolean => path.startsWith(sessionsDir);

    if (deps.platform !== "win32") {
      let open: string[] | undefined;
      try {
        open = await deps.openFiles(await pidsOf(process));
      } catch {
        open = undefined;
      }
      const rollouts = [
        ...new Set((open ?? []).filter((path) => ROLLOUT_NAME.test(path) && under(path))),
      ];
      if (rollouts.length > 1) return undefined;
      const [path] = rollouts;
      if (path !== undefined) {
        const meta = await rolloutMeta(path, deps.readHead);
        return meta === undefined ? undefined : session(meta.id, path);
      }
    }

    // No open file to go by: the one rollout begun in this process's cwd
    // since it started.
    if (process.cwd === null) return undefined;
    const candidates = (await deps.listRollouts(sessionsDir)).filter(
      (file) => file.mtimeMs >= process.startedAt,
    );
    const found: { id: string; path: string }[] = [];
    for (const file of candidates) {
      const meta = await rolloutMeta(file.path, deps.readHead);
      if (meta?.cwd === process.cwd) found.push({ id: meta.id, path: file.path });
    }
    const [only] = found;
    return found.length === 1 && only !== undefined ? session(only.id, only.path) : undefined;
  }

  return {
    async forProcess(process) {
      const paneKey = process.terminalPaneKey;
      if (paneKey === undefined) return undefined;
      const agent = deps.agents().find((candidate) => candidate.id === process.agentId);
      try {
        switch (agent?.vendor) {
          case "anthropic": {
            const found = await claude.forProcess(process);
            if (found === undefined) return undefined;
            const { transcriptsDir: _dir, ...rest } = found;
            return { ...rest, vendor: "anthropic" };
          }
          case "github":
            return await copilot(process, paneKey, agent);
          case "openai":
            return await codex(process, paneKey, agent);
          default:
            return undefined;
        }
      } catch {
        return undefined;
      }
    },
    retain: (ids) => claude.retain(ids),
    forget: (ids) => claude.forget(ids),
  };
}
