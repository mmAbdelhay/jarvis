// The phone's chat view of a Terminal pane running Claude Code
// (terminal:claudeView), its verified prompt answers (terminal:answer), and
// the "look again" push (terminal:claudeViewChanged).
//
// The view joins two sources: the session's transcript tail for the turns
// and model, and the pane's headless screen for what Claude shows right now
// (a prompt, the mode, the spinner). Nothing here logs a path, a session
// name, or any transcript or screen text — only category tokens.

import { basename, dirname } from "node:path";
import { readClaudeScreen } from "@jarvis/core";
import { type ExternalAgentProcess, parseChatTranscript } from "@jarvis/platform";
import type { ClaudeAnswerResult, ClaudeView, TerminalPaneInfo } from "@jarvis/wire";
import type { PaneClaudeLookup, PaneClaudeSession } from "./pane-claude-session.js";
import { createChatCache, createPaneSessionCache } from "./pane-session-cache.js";

/** Transcript-change pushes for one pane are at most this often apart. */
export const CLAUDE_VIEW_DEBOUNCE_MS = 300;
/** Output-only pushes (the pane printed) are at most this often apart:
 *  Claude's spinner redraws continuously while it works. */
export const CLAUDE_VIEW_OUTPUT_THROTTLE_MS = 1000;
/** How long a pane's process scan + pid record lookup is reused. */
export const PANE_SESSION_TTL_MS = 5000;
/** How long a pane with no Claude is taken to have none: under one output
 *  throttle, so the next push after Claude starts scans again. Held for the
 *  full session TTL, a none read just before `claude` drew its screen
 *  outlived the last push, and a phone stayed on Term once Claude was idle. */
export const PANE_NONE_TTL_MS = CLAUDE_VIEW_OUTPUT_THROTTLE_MS - 100;

/** Where a pane's transcript appears: its directory and its file name, so a
 *  directory watch also sees a transcript Claude has not written yet. */
export type TranscriptLocation = { dir: string; file: string };

export type ClaudeViewDeps = {
  panes(): readonly TerminalPaneInfo[];
  /** A fresh process scan. */
  scanAgents(): Promise<readonly ExternalAgentProcess[]>;
  lookup: Pick<PaneClaudeLookup, "forProcess" | "retain">;
  /** The transcript's tail, already bounded (CHAT_TAIL_BYTES). */
  readTail(path: string): Promise<string>;
  /** Size and mtime, so an unchanged transcript is not read again. */
  statFile(path: string): Promise<{ size: number; mtimeMs: number }>;
  now(): number;
  screenText(paneKey: string): string | undefined;
  write(paneKey: string, data: string): void;
  log(token: string): void;
  /** Tells the notifier a remote is looking at this pane. */
  notice(paneKey: string): void;
  /** Tells the notifier which transcript to watch for this pane. */
  follow(paneKey: string, transcript: TranscriptLocation): void;
  /** Undoes a follow, for a pane that exited while it was being set up. */
  forget(paneKey: string): void;
};

const NONE: ClaudeView = { kind: "none" };

type Chat = ReturnType<typeof parseChatTranscript>;

export function createClaudeViewHandlers(deps: ClaudeViewDeps): {
  view(paneKey: unknown): Promise<ClaudeView>;
  answer(paneKey: unknown, index: unknown, label: unknown): ClaudeAnswerResult;
  /** Drops a pane's cached session (its shell exited). */
  forgetPane(paneKey: string): void;
  /** The transcript of the Claude session in this pane: its path; null for
   *  a Claude with no transcript yet; else the last one this pane had, or
   *  undefined when it never had one. Never throws. */
  transcriptOf(paneKey: string): Promise<string | null | undefined>;
} {
  const cache = createPaneSessionCache<PaneClaudeSession>({
    panes: () => deps.panes(),
    scanAgents: () => deps.scanAgents(),
    lookup: deps.lookup,
    now: () => deps.now(),
    ttlMs: PANE_SESSION_TTL_MS,
    noneTtlMs: PANE_NONE_TTL_MS,
  });
  const chats = createChatCache<Chat>(deps);
  const live = cache.live;

  function none(token: string): ClaudeView {
    try {
      deps.log(`claude-view: ${token}`);
    } catch {
      // A failing logger cannot turn a none into a throw.
    }
    return NONE;
  }

  // Pane → the last transcript its Claude had, so a pane whose Claude has
  // exited keeps showing that session's plan rather than another tab's.
  const lastTranscript = new Map<string, string>();

  /** Keeps the caches to live panes and their sessions. */
  function prune(livePanes: ReadonlySet<string>): void {
    for (const paneKey of lastTranscript.keys())
      if (!livePanes.has(paneKey)) lastTranscript.delete(paneKey);
    chats.retain(cache.prune(livePanes));
  }

  const sessionFor = cache.sessionFor;

  function chatOf(session: PaneClaudeSession, path: string): Promise<Chat> {
    return chats.get(session.sessionId, path, (text) => parseChatTranscript(text));
  }

  return {
    forgetPane(paneKey) {
      cache.forget(paneKey);
      lastTranscript.delete(paneKey);
    },

    async transcriptOf(paneKey) {
      try {
        const session = await sessionFor(paneKey);
        if (session !== undefined) {
          if (session.transcriptPath === undefined) return null;
          lastTranscript.set(paneKey, session.transcriptPath);
          return session.transcriptPath;
        }
      } catch {
        // A failed scan or lookup falls back to what the pane last had.
      }
      return lastTranscript.get(paneKey);
    },

    async view(paneKey) {
      try {
        if (typeof paneKey !== "string") return NONE;
        const panes = deps.panes();
        prune(new Set(panes.filter((pane) => !pane.exited).map((pane) => pane.paneKey)));
        if (!panes.some((pane) => pane.paneKey === paneKey && !pane.exited)) return NONE;
      } catch {
        return none("panes");
      }
      try {
        deps.notice(paneKey);
      } catch {
        none("notice"); // Costs output pushes for a non-Claude pane only.
      }
      let session: PaneClaudeSession | undefined;
      try {
        session = await sessionFor(paneKey);
      } catch (error) {
        return none(error instanceof Error && error.message === "scan" ? "scan" : "lookup");
      }
      if (session === undefined) return NONE;
      const transcriptPath = session.transcriptPath;
      if (transcriptPath !== undefined) {
        // The transcript's own folder (projects/<slug>/), not the projects
        // root: a directory watch sees only its direct children.
        try {
          deps.follow(paneKey, { dir: dirname(transcriptPath), file: basename(transcriptPath) });
        } catch {
          none("follow"); // Costs live pushes for the transcript, not the view.
        }
      }
      // The shell can exit while the scan or lookup awaits. Its exit has
      // already forgotten the pane, so this follow re-added a dead one —
      // and with it a watch nothing would ever close.
      try {
        if (!live(paneKey)) {
          deps.forget(paneKey);
          cache.forget(paneKey);
          return NONE;
        }
      } catch {
        return none("panes");
      }

      let chat: Chat = { turns: [] };
      if (transcriptPath !== undefined) {
        try {
          chat = await chatOf(session, transcriptPath);
        } catch {
          return none("transcript");
        }
      }
      let screen: ReturnType<typeof readClaudeScreen>;
      try {
        screen = readClaudeScreen(deps.screenText(paneKey) ?? "");
      } catch {
        return none("screen");
      }
      return {
        kind: "claude",
        sessionId: session.sessionId,
        ...(session.name === undefined ? {} : { title: session.name }),
        ...(chat.model === undefined ? {} : { model: chat.model }),
        mode: screen.mode,
        turns: chat.turns,
        ...(screen.prompt === undefined
          ? {}
          : {
              prompt: {
                question: screen.prompt.question,
                options: screen.prompt.options.map(({ label, keys }) => ({ label, keys })),
              },
            }),
        ...(screen.working === undefined ? {} : { working: screen.working }),
      };
    },

    // Read again at the moment of answering, never trusted from the call —
    // the same rule as session:answer. The phone names the option by index
    // and label; both must match the screen now, and the keys typed are the
    // ones read now, never any the phone holds.
    answer(paneKey, index, label) {
      try {
        if (!live(paneKey)) return { ok: false, reason: "gone" };
        const prompt = readClaudeScreen(deps.screenText(paneKey) ?? "").prompt;
        if (prompt === undefined) return { ok: false, reason: "gone" };
        const option = Number.isInteger(index) ? prompt.options[index as number] : undefined;
        if (option === undefined || option.label !== label) {
          return { ok: false, reason: "changed" };
        }
        deps.write(paneKey, option.keys);
        return { ok: true };
      } catch {
        // A pane that died under the write (or a screen that could not be
        // read) is gone to the phone; the error's text stays here.
        none("answer");
        return { ok: false, reason: "gone" };
      }
    },
  };
}

export type ClaudeViewNotifierDeps = {
  /** Subscribes to every pane's output; returns the unsubscribe. */
  onOutput(cb: (paneKey: string) => void): () => void;
  /** Subscribes to every pane's shell exit; returns the unsubscribe. */
  onExit(cb: (paneKey: string) => void): () => void;
  /** Watches a directory; `file` is the changed entry's name, or null when
   *  the platform does not say. May throw (directory missing). `onError`
   *  runs when the watch dies later (directory removed). */
  watch(dir: string, cb: (file: string | null) => void, onError: () => void): { close(): void };
  schedule(fn: () => void, ms: number): () => void;
  emit(paneKey: string): void;
  log(token: string): void;
};

/**
 * Says "look again" for a pane when its transcript changes (at most once per
 * CLAUDE_VIEW_DEBOUNCE_MS) or when it prints (at most once per
 * CLAUDE_VIEW_OUTPUT_THROTTLE_MS). Output counts only for panes a remote has
 * looked at (`notice`) or that run a followed Claude session — a printing
 * `npm run dev` nobody watches pushes nothing. A throttle, not a trailing
 * debounce — Claude's spinner redraws continuously, and a debounce that
 * waited for quiet would never fire while it works. A transcript change
 * arriving while a slower output push waits pulls that push forward.
 *
 * Transcript watches are per directory, shared by every pane whose session
 * lives there, and only for panes the view handler has followed; a pane's
 * entries go when its shell exits, or on `forget`. A watch that errors is
 * dropped, so the next follow watches that directory again.
 */
export function createClaudeViewNotifier(deps: ClaudeViewNotifierDeps): {
  notice(paneKey: string): void;
  follow(paneKey: string, transcript: TranscriptLocation): void;
  forget(paneKey: string): void;
  stop(): void;
} {
  const pending = new Map<string, { cancel: () => void; ms: number }>();
  const followed = new Map<string, TranscriptLocation>();
  const noticed = new Set<string>();
  const watchers = new Map<string, { close(): void }>();
  let stopped = false;

  function log(token: string): void {
    try {
      deps.log(`claude-view: ${token}`);
    } catch {
      // Diagnostics cannot break the notifier.
    }
  }

  function bump(paneKey: string, ms: number): void {
    if (stopped) return;
    const waiting = pending.get(paneKey);
    if (waiting !== undefined) {
      if (waiting.ms <= ms) return;
      waiting.cancel();
    }
    pending.set(paneKey, {
      ms,
      cancel: deps.schedule(() => {
        pending.delete(paneKey);
        if (stopped) return;
        try {
          deps.emit(paneKey);
        } catch {
          log("emit");
        }
      }, ms),
    });
  }

  function onOutput(paneKey: string): void {
    if (noticed.has(paneKey) || followed.has(paneKey)) {
      bump(paneKey, CLAUDE_VIEW_OUTPUT_THROTTLE_MS);
    }
  }

  function closeUnused(dir: string): void {
    for (const location of followed.values()) if (location.dir === dir) return;
    watchers.get(dir)?.close();
    watchers.delete(dir);
  }

  function forget(paneKey: string): void {
    const location = followed.get(paneKey);
    followed.delete(paneKey);
    noticed.delete(paneKey);
    pending.get(paneKey)?.cancel();
    pending.delete(paneKey);
    if (location !== undefined) closeUnused(location.dir);
  }

  const stopOutput = deps.onOutput(onOutput);
  const stopExit = deps.onExit(forget);

  return {
    notice(paneKey) {
      if (!stopped) noticed.add(paneKey);
    },
    follow(paneKey, transcript) {
      if (stopped) return;
      const previous = followed.get(paneKey);
      followed.set(paneKey, transcript);
      if (previous !== undefined && previous.dir !== transcript.dir) closeUnused(previous.dir);
      if (watchers.has(transcript.dir)) return;
      try {
        const dir = transcript.dir;
        let watcher: { close(): void } | undefined;
        let failed = false;
        watcher = deps.watch(
          dir,
          (file) => {
            for (const [key, location] of followed) {
              if (location.dir === dir && (file === null || file === location.file)) {
                bump(key, CLAUDE_VIEW_DEBOUNCE_MS);
              }
            }
          },
          () => {
            // Only this watch's own entry: a late error from one already
            // replaced must not drop its successor.
            failed = true;
            if (watcher !== undefined && watchers.get(dir) === watcher) watchers.delete(dir);
            watcher?.close();
            log("watch-error");
          },
        );
        if (!failed) watchers.set(dir, watcher);
      } catch {
        // Not there yet (Claude creates it on its first write); the next
        // view call follows again. Output pushes still flow meanwhile.
        log("watch");
      }
    },
    forget,
    stop() {
      stopped = true;
      stopOutput();
      stopExit();
      for (const { cancel } of pending.values()) cancel();
      pending.clear();
      noticed.clear();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      followed.clear();
    },
  };
}
