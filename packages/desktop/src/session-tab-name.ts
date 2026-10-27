// A Terminal tab follows the name of the Claude Code session running in it
// (Task 16): Claude's own topic name, or one given with `/rename`. The name
// comes from Claude Code's `<configDir>/sessions/<pid>.json` (session-
// import.ts reads it), the pane from the same process scan the Reviews
// service uses. Applied only when the session name changes, so a name the
// user typed into the tab stands until the session's own name moves on.

import type { AgentConfig, WorkspaceState } from "@jarvis/core";
import {
  lastCustomTitle,
  lastAiTitle,
  type ExternalAgentProcess,
  type ShellManager,
  type TranscriptFile,
} from "@jarvis/platform";
import {
  claudePathsFor,
  createTranscriptPaths,
  readClaudePidRecord,
} from "./pane-claude-session.js";

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
  /** The first 64 KB of a transcript, for titles outside the tail. */
  readHead(path: string): Promise<string>;
  /** Calls back on any change in `dir`. May throw (no such directory). */
  watch(dir: string, onChange: () => void): { close(): void };
  /** One-shot timer; returns its cancel. */
  schedule(fn: () => void, ms: number): () => void;
  /** Epoch ms, for startup protection and the transcript cache. */
  now(): number;
  /** Repeating timer; returns its cancel. */
  interval(fn: () => void, ms: number): () => void;
  /** A tab named after a PR one of its panes opened (pr-tab-namer.ts):
   *  that name outranks the session's own. */
  isPrNamedTab?(tabId: string): boolean;
};

export type SessionTabNamer = {
  /** Subscribes, starts the fallback timer and runs a first check. */
  start(): void;
  /** One coalesced check of every pane. Never rejects. */
  check(): Promise<void>;
  /** Resolves once no check is running or queued. */
  whenIdle(): Promise<void>;
  /** Closes every watcher, timer and subscription, then resolves once a
   *  check in flight has finished — nothing is opened after that. Final. */
  stop(): Promise<void>;
};

/** The workspace tab a pane belongs to: its own id, or `<tabId>:<n>` for a
 *  split — the same rule as the `terminal:panes` handler (dispatch.ts). */
export function tabOf(state: WorkspaceState, paneKey: string): string | undefined {
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
  const transcriptPaths = createTranscriptPaths(deps.listTranscripts);
  const titles = new Map<string, { name: string | undefined; readAt: number }>();
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
    const path = await transcriptPaths.find(paths.transcriptsDir, record.sessionId);
    if (path === undefined) return undefined;
    const cached = titles.get(record.sessionId);
    const now = deps.now();
    if (cached !== undefined && now - cached.readAt < SESSION_TAB_RECHECK_MS) return cached.name;
    // The user's /rename (custom-title) beats Claude's ai-title wherever
    // it is: a session renamed long ago and then resumed has the rename in
    // the head and newer ai-titles in the tail. Newest custom-title first
    // (the tail is newer than the head), then the newest ai-title.
    const tail = await deps.readTail(path);
    let name = lastCustomTitle(tail);
    if (name === undefined) {
      const head = await deps.readHead(path);
      name = lastCustomTitle(head) ?? lastAiTitle(tail) ?? lastAiTitle(head);
    }
    titles.set(record.sessionId, { name, readAt: now });
    return name;
  }

  async function applyTo(process: ExternalAgentProcess, paneKey: string): Promise<void> {
    const paths = claudePathsFor(deps.agents(), deps.home, process);
    if (paths === null) return;
    ensureWatch(paths.sessionsDir);

    const record = await readClaudePidRecord(deps.readFile, paths.sessionsDir, process.pid);
    if (record === null) return;
    seenSessions.add(record.sessionId);
    const name = await nameFor(paths, record);
    if (name === undefined || stopped) return;

    const last = applied.get(paneKey);
    if (last?.sessionId === record.sessionId && last.name === name) return;
    const state = deps.tabs.state();
    const tabId = tabOf(state, paneKey);
    if (tabId === undefined || deps.isPrNamedTab?.(tabId) === true) return;
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
      transcriptPaths.retain(new Set());
      titles.clear();
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
    transcriptPaths.retain(seenSessions);
    for (const id of titles.keys()) if (!seenSessions.has(id)) titles.delete(id);
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
    async stop() {
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
      titles.clear();
      transcriptPaths.retain(new Set());
      seenPanes.clear();
      // A check already running sees `stopped` before any watch/rename/timer.
      while (queued !== undefined || running !== undefined) {
        await (queued ?? running)?.catch(() => undefined);
      }
      // Belt and braces: anything a racing check slipped in is closed too.
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
      }
      watchers.clear();
    },
  };
}
