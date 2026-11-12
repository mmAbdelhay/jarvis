// A Terminal tab follows the name of the Claude Code session running in it
// (Task 16): Claude's own topic name, or one given with `/rename`. The name
// comes from Claude Code's `<configDir>/sessions/<pid>.json` (session-
// import.ts reads it), the pane from the same process scan the Reviews
// service uses. Applied only when the session name changes, so a name the
// user typed into the tab stands until the session's own name moves on.

import { firstPrRef, type AgentConfig, type PrRef, type WorkspaceState } from "@jarvis/core";
import {
  lastCustomTitle,
  lastAiTitle,
  parseTranscript,
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
  /** The PR named in the user's latest prompt that names one, on every
   *  check (pr-tab-namer.ts fromPrompt, which handles each once). When set,
   *  the transcript is read even if the pid file names the session. */
  onPromptPr?(paneKey: string, ref: PrRef): void;
};

/** The PR of the last user prompt in a stretch of transcript that names
 *  one — its first PR URL. Only what the user typed counts: tool results,
 *  assistant text and the CLI's own injections are not prompts. */
export function lastPromptPr(text: string): PrRef | undefined {
  const turns = parseTranscript(text);
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn?.role !== "user") continue;
    const ref = firstPrRef(turn.text);
    if (ref !== undefined) return ref;
  }
  return undefined;
}

type TranscriptRead = { name: string | undefined; prompt: PrRef | undefined; readAt: number };

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
  /** Session id → its transcript path, once found (a title fallback, and
   *  the user's prompts when onPromptPr is set). */
  const transcriptPaths = createTranscriptPaths(deps.listTranscripts);
  const titles = new Map<string, TranscriptRead>();
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

  /** What the session's transcript says: its title and the PR of the
   *  user's latest prompt naming one (only read when onPromptPr is set). */
  async function readTranscript(
    paths: { transcriptsDir: string },
    sessionId: string,
  ): Promise<TranscriptRead | undefined> {
    const path = await transcriptPaths.find(paths.transcriptsDir, sessionId);
    if (path === undefined) return undefined;
    const cached = titles.get(sessionId);
    const now = deps.now();
    if (cached !== undefined && now - cached.readAt < SESSION_TAB_RECHECK_MS) return cached;
    // The user's /rename (custom-title) beats Claude's ai-title wherever
    // it is: a session renamed long ago and then resumed has the rename in
    // the head and newer ai-titles in the tail. Newest custom-title first
    // (the tail is newer than the head), then the newest ai-title. A
    // prompt's PR likewise: the tail's latest, else the head's.
    const wantPrompt = deps.onPromptPr !== undefined;
    const tail = await deps.readTail(path);
    let name = lastCustomTitle(tail);
    let prompt = wantPrompt ? lastPromptPr(tail) : undefined;
    if (name === undefined || (wantPrompt && prompt === undefined)) {
      const head = await deps.readHead(path);
      name ??= lastCustomTitle(head) ?? lastAiTitle(tail) ?? lastAiTitle(head);
      if (wantPrompt) prompt ??= lastPromptPr(head);
    }
    const read = { name, prompt, readAt: now };
    titles.set(sessionId, read);
    return read;
  }

  async function applyTo(process: ExternalAgentProcess, paneKey: string): Promise<void> {
    const paths = claudePathsFor(deps.agents(), deps.home, process);
    if (paths === null) return;
    ensureWatch(paths.sessionsDir);

    const record = await readClaudePidRecord(deps.readFile, paths.sessionsDir, process.pid);
    if (record === null) return;
    seenSessions.add(record.sessionId);
    const transcript =
      record.name === undefined || deps.onPromptPr !== undefined
        ? await readTranscript(paths, record.sessionId)
        : undefined;
    if (stopped) return;
    if (transcript?.prompt !== undefined) deps.onPromptPr?.(paneKey, transcript.prompt);
    const name = record.name ?? transcript?.name;
    if (name === undefined) return;

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
