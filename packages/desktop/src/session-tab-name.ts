// A Terminal tab follows the name of the Claude Code session running in it
// (Task 16): Claude's own topic name, or one given with `/rename`. The name
// comes from Claude Code's `<configDir>/sessions/<pid>.json` (session-
// import.ts reads it), the pane from the same process scan the Reviews
// service uses. Applied only when the session name changes, so a name the
// user typed into the tab stands until the session's own name moves on.

import { basename, join } from "node:path";
import type { AgentConfig, WorkspaceState } from "@jarvis/core";
import {
  claudeSessionPaths,
  lastCustomTitle,
  parseClaudePidRecord,
  type ExternalAgentProcess,
  type ShellManager,
  type TranscriptFile,
} from "@jarvis/platform";

/** Quiet time after a sessions-directory event before the re-check. */
export const SESSION_TAB_DEBOUNCE_MS = 500;
/** Fallback re-check interval, for whatever a watch misses. */
export const SESSION_TAB_RECHECK_MS = 10_000;

export type SessionTabNameDeps = {
  shells: Pick<ShellManager, "panes" | "onOutput" | "onShellExit">;
  tabs: { state(): WorkspaceState; rename(id: string, title: string): void };
  /** A fresh process scan (process-scan.ts listAgentProcesses). */
  scanAgents(): Promise<readonly ExternalAgentProcess[]>;
  /** The configured agents, read live. */
  agents(): readonly AgentConfig[];
  home: string;
  /** A pid file's text; rejects when it is missing. */
  readFile(path: string): Promise<string>;
  /** Every transcript under one Claude transcripts directory. */
  listTranscripts(dir: string): Promise<TranscriptFile[]>;
  /** The end of a transcript, where a `/rename` record is appended. */
  readTail(path: string): Promise<string>;
  /** Calls back on any change in `dir`. May throw (no such directory). */
  watch(dir: string, onChange: () => void): { close(): void };
  /** One-shot timer; returns its cancel. */
  schedule(fn: () => void, ms: number): () => void;
  /** Epoch ms; read once, when the namer is created. */
  now(): number;
  /** Repeating timer; returns its cancel. */
  interval(fn: () => void, ms: number): () => void;
};

export type SessionTabNamer = {
  /** Subscribes, starts the fallback timer and runs a first check. */
  start(): void;
  /** One coalesced check of every pane. Never rejects. */
  check(): Promise<void>;
  /** Resolves once no check is running or queued. */
  whenIdle(): Promise<void>;
  /** Closes every watcher, timer and subscription. */
  stop(): void;
};

/** The workspace tab a pane belongs to: its own id, or `<tabId>:<n>` for a
 *  split — the same rule as the `terminal:panes` handler (dispatch.ts). */
function tabOf(state: WorkspaceState, paneKey: string): string | undefined {
  return state.tabs.find(
    (tab) => tab.kind === "terminal" && (tab.id === paneKey || paneKey.startsWith(`${tab.id}:`)),
  )?.id;
}

export function createSessionTabNamer(deps: SessionTabNameDeps): SessionTabNamer {
  /** Per pane: the session and name last applied to its tab. */
  const applied = new Map<string, { sessionId: string; name: string }>();
  /** A process started before this is a session that was already running
   *  when Jarvis (re)started: a name the user gave its tab is kept. */
  const createdAt = deps.now();
  /** Sessions read during the current check, for pruning transcriptPaths. */
  const seenSessions = new Set<string>();
  /** Session id → its transcript path, once found (fallback only). */
  const transcriptPaths = new Map<string, string>();
  const watchers = new Map<string, { close(): void }>();
  /** Panes whose output has been seen — a new one means a shell started. */
  const seenPanes = new Set<string>();
  const unsubscribers: (() => void)[] = [];
  let cancelDebounce: (() => void) | undefined;
  let cancelEvery: (() => void) | undefined;
  let stopped = false;
  let running: Promise<void> | undefined;
  let queued: Promise<void> | undefined;

  function requestSoon(): void {
    if (stopped || cancelDebounce !== undefined) return;
    cancelDebounce = deps.schedule(() => {
      cancelDebounce = undefined;
      void check();
    }, SESSION_TAB_DEBOUNCE_MS);
  }

  function ensureWatch(dir: string): void {
    if (stopped || watchers.has(dir)) return;
    try {
      watchers.set(dir, deps.watch(dir, requestSoon));
    } catch {
      // No sessions directory yet; the next check tries again.
    }
  }

  async function nameFor(
    paths: { transcriptsDir: string },
    record: { sessionId: string; name?: string },
  ): Promise<string | undefined> {
    if (record.name !== undefined) return record.name;
    let path = transcriptPaths.get(record.sessionId);
    if (path === undefined) {
      const files = await deps.listTranscripts(paths.transcriptsDir);
      path = files.find((file) => basename(file.path) === `${record.sessionId}.jsonl`)?.path;
      if (path === undefined) return undefined;
      transcriptPaths.set(record.sessionId, path);
    }
    return lastCustomTitle(await deps.readTail(path));
  }

  async function applyTo(process: ExternalAgentProcess, paneKey: string): Promise<void> {
    const agents = deps.agents();
    const agent = agents.find((candidate) => candidate.id === process.agentId);
    if (agent?.vendor !== "anthropic") return;
    const paths = claudeSessionPaths(agents, deps.home, process.agentId);
    if (paths === null) return;
    ensureWatch(paths.sessionsDir);

    const record = parseClaudePidRecord(
      await deps.readFile(join(paths.sessionsDir, `${process.pid}.json`)),
      process.pid,
    );
    if (record === null) return;
    seenSessions.add(record.sessionId);
    const name = await nameFor(paths, record);
    if (name === undefined || stopped) return;

    const last = applied.get(paneKey);
    if (last?.sessionId === record.sessionId && last.name === name) return;
    const state = deps.tabs.state();
    const tabId = tabOf(state, paneKey);
    if (tabId === undefined) return;
    applied.set(paneKey, { sessionId: record.sessionId, name });
    const customTitle = state.tabs.find((tab) => tab.id === tabId)?.customTitle;
    // First sighting of a session that predates this run, in a tab the user
    // named: recorded as applied without renaming, so the hand-set name
    // survives a restart. Its next name change still applies.
    if (last === undefined && process.startedAt < createdAt && customTitle !== undefined) return;
    if (customTitle !== name) deps.tabs.rename(tabId, name);
  }

  async function run(): Promise<void> {
    if (stopped) return;
    const live = new Set(
      deps.shells
        .panes()
        .filter((pane) => !pane.exited)
        .map((pane) => pane.paneKey),
    );
    // Forget panes the shell manager no longer knows, so the map cannot grow.
    for (const paneKey of applied.keys()) if (!live.has(paneKey)) applied.delete(paneKey);
    if (live.size === 0) {
      transcriptPaths.clear();
      return;
    }

    let processes: readonly ExternalAgentProcess[];
    try {
      processes = await deps.scanAgents();
    } catch {
      return;
    }
    seenSessions.clear();
    for (const process of processes) {
      if (stopped) return;
      const paneKey = process.terminalPaneKey;
      if (paneKey === undefined || process.foreground !== true || !live.has(paneKey)) continue;
      try {
        await applyTo(process, paneKey);
      } catch {
        // A pid file mid-write, a transcript gone: this pane waits for the next check.
      }
    }
    // Pruned with `applied`: a session in no live pane needs no cached path.
    for (const sessionId of transcriptPaths.keys()) {
      if (!seenSessions.has(sessionId)) transcriptPaths.delete(sessionId);
    }
  }

  /** At most one check queued behind the running one. */
  function check(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (queued !== undefined) return queued;
    const previous = running ?? Promise.resolve();
    const next = previous.then(async () => {
      queued = undefined;
      running = next;
      try {
        await run();
      } finally {
        if (running === next) running = undefined;
      }
    });
    queued = next;
    return next;
  }

  return {
    start() {
      if (stopped) return;
      unsubscribers.push(
        deps.shells.onShellExit(({ paneKey }) => {
          seenPanes.delete(paneKey);
          applied.delete(paneKey);
          requestSoon();
        }),
        deps.shells.onOutput(({ paneKey }) => {
          if (seenPanes.has(paneKey)) return;
          seenPanes.add(paneKey);
          requestSoon();
        }),
      );
      cancelEvery = deps.interval(() => void check(), SESSION_TAB_RECHECK_MS);
      void check();
    },
    check,
    async whenIdle() {
      while (queued !== undefined || running !== undefined) await (queued ?? running);
    },
    stop() {
      stopped = true;
      cancelDebounce?.();
      cancelDebounce = undefined;
      cancelEvery?.();
      cancelEvery = undefined;
      for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
      }
      watchers.clear();
      applied.clear();
      transcriptPaths.clear();
      seenPanes.clear();
    },
  };
}
