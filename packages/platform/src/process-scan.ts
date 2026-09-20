import type { AgentConfig } from "@jarvis/core";

/**
 * Finds coding-agent processes running on this machine that Jarvis did not
 * start — the same idea as session-import.ts, but for the live process
 * table instead of the transcript directory. Someone who typed `claude` into
 * an ordinary terminal is running a real agent Jarvis has no record of; this
 * is how a Refresh finds it.
 *
 * Shaped like session-import.ts: pure parsing helpers, each pinned by its
 * own test against fixture `ps`/`lsof` output, and one impure orchestrator
 * whose every syscall arrives through an injected `exec` — so the tests run
 * against fixture text, never a real process table.
 *
 * `command` on the returned rows is deliberately just the resolved agent's
 * name — never the full command line. A paired phone can ask for this list
 * (SECURITY.md), and the arguments an agent was started with can carry a
 * prompt, a file path, a secret typed at a shell — exactly the kind of thing
 * that must never leave this machine over the remote bridge.
 */
export type ExternalAgentProcess = {
  pid: number;
  agentId: string;
  /** The registered agent's own command name — never the argv this process
   *  was actually started with. */
  command: string;
  /** Resolved via `lsof`, or null when it could not be determined (no lsof
   *  on this machine, or the process exited before it could be read). */
  cwd: string | null;
  startedAt: number;
};

/** One row of `ps -axo pid=,ppid=,etime=,command=`. */
export type PsRow = { pid: number; ppid: number; etime: string; command: string };

/**
 * Parses `ps -axo pid=,ppid=,etime=,command=` output.
 *
 * The `=` suffix on each column asks `ps` for no header, which is what lets
 * this parse by position rather than by name. `command` is always the last
 * field and is taken greedily to the end of the line — it is the only field
 * that can itself contain whitespace (an agent's own arguments).
 */
export function parsePsOutput(text: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, etime, command] = match;
    rows.push({ pid: Number(pid), ppid: Number(ppid), etime: etime ?? "", command: command ?? "" });
  }
  return rows;
}

/**
 * The executable name a command line was run with — never the arguments.
 * Takes the first whitespace-separated token and strips any directory
 * component, so `/opt/homebrew/bin/claude --resume abc` and `claude` both
 * read as `claude`.
 */
export function commandBasename(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? "";
  const segments = first.split("/");
  return segments.at(-1) ?? "";
}

/**
 * `ps`'s elapsed-time column as a `startedAt` timestamp (`now` minus the
 * elapsed duration).
 *
 * Three forms cover both darwin and linux: `mm:ss` for a process under an
 * hour old, `hh:mm:ss` for one under a day, and `d-hh:mm:ss` for one that
 * has run multiple days. Returns null for anything else — a malformed
 * reading must cost one row, never the whole scan.
 */
export function parseEtime(etime: string, now: number): number | null {
  const match = /^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?$/.exec(etime.trim());
  if (match === null) return null;
  const [, daysStr, a, b, c] = match;
  const days = daysStr === undefined ? 0 : Number(daysStr);
  let hours: number;
  let minutes: number;
  let seconds: number;
  if (c !== undefined) {
    // d-hh:mm:ss or hh:mm:ss
    hours = Number(a);
    minutes = Number(b);
    seconds = Number(c);
  } else {
    // mm:ss
    hours = 0;
    minutes = Number(a);
    seconds = Number(b);
  }
  const elapsedMs = (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
  return now - elapsedMs;
}

/**
 * `lsof -a -p <pids> -d cwd -Fn` output: pid → cwd.
 *
 * `-F n` is lsof's machine-readable form — one field per line, each
 * prefixed with the letter naming it. A process block starts with a `p`
 * line (the pid); this reads every `n` line that follows as that pid's cwd,
 * until the next `p` line starts a new block. Only the cwd fd was asked
 * for, so there is at most one `n` line per block, but the parser does not
 * depend on that — it just takes the last one seen before the next `p`.
 */
export function parseLsofCwd(text: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let currentPid: number | null = null;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "") continue;
    const kind = line[0];
    const value = line.slice(1);
    if (kind === "p") {
      const pid = Number(value);
      currentPid = Number.isFinite(pid) ? pid : null;
    } else if (kind === "n" && currentPid !== null) {
      cwds.set(currentPid, value);
    }
  }
  return cwds;
}

/** Every `ps` row that is `jarvisPid` itself or a descendant of it, walked
 *  from the parent/child edges `ps` reports — Jarvis's shell-spawned
 *  children (a Terminal tab's shell, a `docker logs -f` follower, and every
 *  agent already tracked by pid via `ownedPids`) all live under this tree,
 *  but so does anything else this same process happened to spawn, and none
 *  of it is a session the user started outside Jarvis. */
function ownProcessTree(rows: readonly PsRow[], jarvisPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const tree = new Set<number>([jarvisPid]);
  const queue = [jarvisPid];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined) continue;
    for (const child of children.get(pid) ?? []) {
      if (tree.has(child)) continue;
      tree.add(child);
      queue.push(child);
    }
  }
  return tree;
}

export type ProcessScanDeps = {
  /** Runs one command and resolves with its stdout — never rejects on a
   *  non-zero exit, so a scan can tell "ps failed" from "ps ran and found
   *  nothing" without a try/catch at every call site. Injected so the tests
   *  run against fixture text instead of a real process table. */
  exec: (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  platform: NodeJS.Platform;
  agents: readonly AgentConfig[];
  /** pids SessionManager is currently running agents under — its pty
   *  children must never be reported as "outside Jarvis" twice. */
  ownedPids: () => ReadonlySet<number>;
  /** This process's own pid, so its whole tree (this window's own shells,
   *  followers, and every pty child) can be excluded even where
   *  `ownedPids` alone would miss one — see ownProcessTree. */
  jarvisPid: number;
  now: () => number;
};

/**
 * Every running process whose command matches a registered agent's, minus
 * Jarvis's own. One bounded `ps` call, one batched `lsof` call for whatever
 * is left — never one `lsof` per process, which would mean a syscall per
 * row on a machine with a dozen agents running.
 *
 * Windows has no `ps`/`lsof` equivalent used here and returns `[]` rather
 * than guessing at a WMI query nobody has verified.
 */
export async function listAgentProcesses(deps: ProcessScanDeps): Promise<ExternalAgentProcess[]> {
  if (deps.platform !== "darwin" && deps.platform !== "linux") return [];

  let psResult: { code: number; stdout: string };
  try {
    psResult = await deps.exec("ps", ["-axo", "pid=,ppid=,etime=,command="]);
  } catch {
    return [];
  }
  if (psResult.code !== 0) return [];

  const rows = parsePsOutput(psResult.stdout);
  const ownTree = ownProcessTree(rows, deps.jarvisPid);
  const owned = deps.ownedPids();

  // Bare command name (never a full path) for each registered agent, so a
  // `claude` on PATH and `/opt/homebrew/bin/claude` in the config both
  // match a `claude` row.
  const agentByCommand = new Map<string, string>();
  for (const agent of deps.agents) {
    agentByCommand.set(commandBasename(agent.command), agent.id);
  }

  const now = deps.now();
  const candidates: { row: PsRow; agentId: string; startedAt: number }[] = [];
  for (const row of rows) {
    if (ownTree.has(row.pid) || owned.has(row.pid)) continue;
    const agentId = agentByCommand.get(commandBasename(row.command));
    if (agentId === undefined) continue;
    const startedAt = parseEtime(row.etime, now);
    if (startedAt === null) continue;
    candidates.push({ row, agentId, startedAt });
  }

  if (candidates.length === 0) return [];

  let cwds = new Map<number, string>();
  try {
    const lsofResult = await deps.exec("lsof", [
      "-a",
      "-p",
      candidates.map((c) => c.row.pid).join(","),
      "-d",
      "cwd",
      "-Fn",
    ]);
    if (lsofResult.code === 0) cwds = parseLsofCwd(lsofResult.stdout);
  } catch {
    // No lsof on this machine, or it failed outright — every row's cwd is
    // reported unknown rather than the scan losing its rows entirely.
  }

  return candidates.map(({ row, agentId, startedAt }) => ({
    pid: row.pid,
    agentId,
    command: commandBasename(row.command),
    cwd: cwds.get(row.pid) ?? null,
    startedAt,
  }));
}
