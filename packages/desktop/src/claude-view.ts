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

/** Transcript-change pushes for one pane are at most this often apart. */
export const CLAUDE_VIEW_DEBOUNCE_MS = 300;
/** Output-only pushes (the pane printed) are at most this often apart:
 *  Claude's spinner redraws continuously while it works. */
export const CLAUDE_VIEW_OUTPUT_THROTTLE_MS = 1000;
/** How long a pane's process scan + pid record lookup is reused. */
export const PANE_SESSION_TTL_MS = 5000;

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
} {
  // Pane → its session (or none), reused for PANE_SESSION_TTL_MS so a push
  // storm does not run ps + lsof per call.
  const sessions = new Map<string, { session: PaneClaudeSession | undefined; at: number }>();
  // Session → the last parse of its transcript, keyed by size and mtime.
  const parsed = new Map<string, { path: string; size: number; mtimeMs: number; chat: Chat }>();

  function live(paneKey: unknown): paneKey is string {
    return (
      typeof paneKey === "string" &&
      deps.panes().some((pane) => pane.paneKey === paneKey && !pane.exited)
    );
  }

  function none(token: string): ClaudeView {
    try {
      deps.log(`claude-view: ${token}`);
    } catch {
      // A failing logger cannot turn a none into a throw.
    }
    return NONE;
  }

  /** Keeps the caches to live panes and their sessions. */
  function prune(livePanes: ReadonlySet<string>): void {
    for (const paneKey of sessions.keys()) if (!livePanes.has(paneKey)) sessions.delete(paneKey);
    const ids = new Set<string>();
    for (const { session } of sessions.values()) if (session) ids.add(session.sessionId);
    for (const id of parsed.keys()) if (!ids.has(id)) parsed.delete(id);
    try {
      deps.lookup.retain(ids);
    } catch {
      // Only a cache.
    }
  }

  async function sessionFor(paneKey: string): Promise<PaneClaudeSession | undefined> {
    const cached = sessions.get(paneKey);
    if (cached !== undefined && deps.now() - cached.at < PANE_SESSION_TTL_MS) {
      return cached.session;
    }
    const processes = await deps.scanAgents().catch(() => {
      throw new Error("scan");
    });
    // A job sent to the background does not own the screen, so its
    // prompt and spinner would be the shell's. Unknown (no job columns)
    // is allowed; the screen reader finds nothing in a plain shell.
    const candidates = processes.filter(
      (process) => process.terminalPaneKey === paneKey && process.foreground !== false,
    );
    let session: PaneClaudeSession | undefined;
    try {
      for (const process of candidates) {
        session = await deps.lookup.forProcess(process);
        if (session !== undefined) break;
      }
    } catch {
      throw new Error("lookup");
    }
    // A session with no transcript yet is looked up again next time, so
    // its first turn shows as soon as Claude writes it.
    if (session === undefined || session.transcriptPath !== undefined) {
      sessions.set(paneKey, { session, at: deps.now() });
    } else sessions.delete(paneKey);
    return session;
  }

  async function chatOf(session: PaneClaudeSession, path: string): Promise<Chat> {
    const stat = await deps.statFile(path);
    const last = parsed.get(session.sessionId);
    if (
      last !== undefined &&
      last.path === path &&
      last.size === stat.size &&
      last.mtimeMs === stat.mtimeMs
    ) {
      return last.chat;
    }
    const chat = parseChatTranscript(await deps.readTail(path));
    parsed.set(session.sessionId, { path, size: stat.size, mtimeMs: stat.mtimeMs, chat });
    return chat;
  }

  return {
    forgetPane(paneKey) {
      sessions.delete(paneKey);
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
          sessions.delete(paneKey);
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
