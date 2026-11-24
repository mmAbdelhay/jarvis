// Which coding-agent session runs in a Terminal pane, for the desktop's
// Chat view: Claude Code through its pid file (pane-claude-session.ts, left
// as it is), Copilot through the `inuse.<pid>.lock` its session directory
// holds, Codex through the rollout file it has open. Every doubt gives
// undefined — two candidates are never guessed between — and nothing here
// throws. All file and process access is injected.

import { dirname, join, sep } from "node:path";
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
  /** The process start (ms) this session is bound to; with the pid it says
   *  whether two reads of a pane are about the same process. */
  startedAt?: number;
  /** True for a session id invented before the agent has written its
   *  transcript; it gives way to the real id for the same pid and start. */
  pending?: true;
  /** The config directory of the agent account that matched this process
   *  (Claude's config dir, CODEX_HOME, Copilot's home): known before any
   *  transcript exists, never guessed between accounts. */
  configDir?: string;
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
  /** A path with symlinks resolved (fs.realpath); rejects when it is missing.
   *  Without it paths are compared as they are. */
  realPath?(path: string): Promise<string>;
};

export type PaneAgentLookup = {
  /** `peers` is the machine-wide agent scan the process came from; Codex
   *  needs it to know whether another process shares a working directory. */
  forProcess(
    process: ExternalAgentProcess,
    peers?: readonly ExternalAgentProcess[],
  ): Promise<PaneAgentSession | undefined>;
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

/** The clock slack between `ps` (1 s resolution) and a rollout's own timestamp. */
const CLOCK_ALLOWANCE_MS = 2000;
/** A rollout touched this long after start-up was written by the session, not flushed at launch. */
const RESUME_SLACK_MS = 5000;

type RolloutMeta = {
  id: string;
  cwd: string | undefined;
  /** When the session began: the record's timestamp, else the file name's. */
  startedMs: number | undefined;
  /** A sub-agent or `codex exec` thread, not a TUI's main thread. */
  sub: boolean;
};

function nameTimestamp(path: string): number | undefined {
  const m = /rollout-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(path);
  if (m === null) return undefined;
  const [y, mo, d, h, mi, sec] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const ms = new Date(y, mo - 1, d, h, mi, sec).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/** A rollout's session id, cwd and kind, from the `session_meta` record on its first line. */
async function rolloutMeta(
  path: string,
  readHead: PaneAgentLookupDeps["readHead"],
): Promise<RolloutMeta | undefined> {
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
    const stamp = payload["timestamp"];
    const parsed = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
    const kinds = JSON.stringify([
      payload["source"],
      payload["thread_source"],
      payload["originator"],
    ]).toLowerCase();
    return {
      id,
      cwd: typeof cwd === "string" ? cwd : undefined,
      startedMs: Number.isNaN(parsed) ? nameTimestamp(path) : parsed,
      sub: kinds.includes("subagent") || kinds.includes("exec"),
    };
  } catch {
    return undefined;
  }
}

/** Whether two reads of a pane are the same agent: one id, or a pending id
 *  and the real one for the same pid and process start. */
export function sameAgentSession(a: PaneAgentSession, b: PaneAgentSession): boolean {
  if (a.sessionId === b.sessionId) return true;
  return (
    (a.pending === true || b.pending === true) &&
    a.pid === b.pid &&
    a.startedAt !== undefined &&
    a.startedAt === b.startedAt
  );
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
      configDir: dirname(dir),
    };
  }

  /** The process → the rollout it was last bound to, so an ambiguous later
   *  read keeps the session it had instead of flipping or vanishing. */
  const bound = new Map<string, string>();

  async function real(path: string): Promise<string> {
    if (deps.realPath === undefined) return path;
    try {
      return await deps.realPath(path);
    } catch {
      return path;
    }
  }

  async function codex(
    process: ExternalAgentProcess,
    paneKey: string,
    agent: AgentConfig,
    peers: readonly ExternalAgentProcess[] | undefined,
  ): Promise<PaneAgentSession | undefined> {
    const sessionsDir = agentSessionsDir(agent, deps);
    const realSessionsDir = await real(sessionsDir);
    const bindKey = `${process.pid}:${process.startedAt}`;
    const session = (id: string, transcriptPath?: string): PaneAgentSession => {
      if (transcriptPath !== undefined) {
        bound.set(bindKey, id);
        if (bound.size > 200) {
          const oldest = bound.keys().next().value;
          if (oldest !== undefined) bound.delete(oldest);
        }
      }
      return {
        paneKey,
        pid: process.pid,
        vendor: "openai",
        sessionId: id,
        ...(transcriptPath === undefined ? { pending: true as const } : { transcriptPath }),
        startedAt: process.startedAt,
        cwd: process.cwd,
        configDir: dirname(sessionsDir),
      };
    };
    // A path separator closes the prefix: "sessions-old" is not under "sessions".
    // lsof reports real paths, the configured directory may be a symlink.
    const under = (path: string): boolean =>
      path.startsWith(sessionsDir + sep) || path.startsWith(realSessionsDir + sep);

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

    // No open file to go by (a shared background app-server holds the
    // rollout): the rollout begun in this process's cwd since it started, or
    // (a resumed session) the one older rollout it has been writing to.
    if (process.cwd === null) return undefined;
    const cwd = await real(process.cwd);
    const since = process.startedAt - CLOCK_ALLOWANCE_MS;
    type Found = { meta: RolloutMeta; path: string; mtimeMs: number };
    const fresh: Found[] = [];
    const older: Found[] = [];
    for (const file of await deps.listRollouts(sessionsDir)) {
      if (file.mtimeMs < since) continue; // cheap prefilter
      const meta = await rolloutMeta(file.path, deps.readHead);
      if (meta === undefined || meta.cwd === undefined) continue;
      if ((await real(meta.cwd)) !== cwd) continue;
      const entry = { meta, path: file.path, mtimeMs: file.mtimeMs };
      // An older session of the same cwd that something touched later is not
      // this process's, unless it is the one it resumed (below).
      if (meta.startedMs !== undefined && meta.startedMs >= since) fresh.push(entry);
      else if (meta.startedMs !== undefined) older.push(entry);
    }

    // The other live Codex processes, and the rollouts a live one is bound to.
    const codexIds = new Set(
      deps
        .agents()
        .filter((candidate) => candidate.vendor === "openai")
        .map((candidate) => candidate.id),
    );
    const others =
      peers === undefined
        ? undefined
        : peers.filter((peer) => peer.pid !== process.pid && codexIds.has(peer.agentId));
    const inCwd: ExternalAgentProcess[] = [];
    for (const peer of others ?? []) {
      if (peer.cwd === null || (await real(peer.cwd)) === cwd) inCwd.push(peer);
    }
    const takenByOthers = new Set<string>();
    for (const peer of others ?? []) {
      const id = bound.get(`${peer.pid}:${peer.startedAt}`);
      if (id !== undefined) takenByOthers.add(id);
    }
    const boundId = bound.get(bindKey);
    const pending = (): PaneAgentSession => session(`pending-${process.pid}-${process.startedAt}`);
    const keep = (pool: Found[]): PaneAgentSession | undefined => {
      const kept = pool.find((entry) => entry.meta.id === boundId);
      return kept === undefined ? undefined : session(kept.meta.id, kept.path);
    };
    // Sub-agent and exec threads never win over a main thread.
    const mains = (pool: Found[]): Found[] => {
      const main = pool.filter((entry) => !entry.meta.sub);
      return main.length > 0 ? main : pool;
    };

    const pool = mains(fresh).filter((entry) => !takenByOthers.has(entry.meta.id));
    if (pool.length > 0) {
      // A candidate is this process's only if no other live Codex process in
      // the cwd could own it: one that started after the rollout began could
      // not have.
      const contested =
        others === undefined ||
        pool.some((entry) =>
          inCwd.some(
            (peer) =>
              entry.meta.startedMs === undefined ||
              peer.startedAt <= entry.meta.startedMs + CLOCK_ALLOWANCE_MS,
          ),
        );
      if (contested) return keep(pool) ?? pending();
      const newest = [...pool].sort(
        (a, b) => (b.meta.startedMs ?? 0) - (a.meta.startedMs ?? 0) || b.mtimeMs - a.mtimeMs,
      )[0];
      return newest === undefined ? pending() : session(newest.meta.id, newest.path);
    }

    // Resumed: the one older, main-thread rollout written to since start-up
    // (a daemon's flush at start does not count), with no other Codex here.
    const written = mains(older).filter(
      (entry) =>
        entry.mtimeMs > process.startedAt + RESUME_SLACK_MS &&
        !entry.meta.sub &&
        !takenByOthers.has(entry.meta.id),
    );
    const [only] = written;
    if (written.length === 1 && only !== undefined && others !== undefined && inCwd.length === 0) {
      return session(only.meta.id, only.path);
    }
    return keep(older) ?? pending();
  }

  return {
    async forProcess(process, peers) {
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
            return await codex(process, paneKey, agent, peers);
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

/** The most rollout files one fallback listing looks at. */
export const MAX_ROLLOUTS = 200;

/**
 * The rollout files under a Codex sessions directory (`YYYY/MM/DD/rollout-*.jsonl`),
 * newest day first, each with its mtime. A missing directory is an empty list.
 */
export async function listCodexRollouts(
  dir: string,
  fs: { readDir(path: string): Promise<string[]>; mtimeMs(path: string): Promise<number> },
  limit = MAX_ROLLOUTS,
): Promise<{ path: string; mtimeMs: number }[]> {
  const found: { path: string; mtimeMs: number }[] = [];
  async function walk(path: string, depth: number): Promise<void> {
    if (found.length >= limit) return;
    let entries: string[];
    try {
      entries = (await fs.readDir(path)).sort().reverse();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const child = join(path, entry);
      if (depth < 3) {
        if (/^\d+$/.test(entry)) await walk(child, depth + 1);
      } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        try {
          found.push({ path: child, mtimeMs: await fs.mtimeMs(child) });
        } catch {
          // Gone between the listing and the stat.
        }
      }
    }
  }
  await walk(dir, 0);
  return found;
}
