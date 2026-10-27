// The phone's chat view of a Terminal pane running Claude Code
// (terminal:claudeView), its verified prompt answers (terminal:answer), and
// the "look again" push (terminal:claudeViewChanged).
//
// The view joins two sources: the session's transcript tail for the turns
// and model, and the pane's headless screen for what Claude shows right now
// (a prompt, the mode, the spinner). Nothing here logs a path, a session
// name, or any transcript or screen text — only category tokens.

import { readClaudeScreen } from "@jarvis/core";
import { type ExternalAgentProcess, parseChatTranscript } from "@jarvis/platform";
import type { ClaudeAnswerResult, ClaudeView, TerminalPaneInfo } from "@jarvis/wire";
import type { PaneClaudeLookup } from "./pane-claude-session.js";

/** Pushes for one pane are at most this often apart. */
export const CLAUDE_VIEW_DEBOUNCE_MS = 300;

/** Where a pane's transcript appears: its directory and its file name, so a
 *  directory watch also sees a transcript Claude has not written yet. */
export type TranscriptLocation = { dir: string; file: string };

export type ClaudeViewDeps = {
  panes(): readonly TerminalPaneInfo[];
  /** A fresh process scan. */
  scanAgents(): Promise<readonly ExternalAgentProcess[]>;
  lookup: Pick<PaneClaudeLookup, "forProcess">;
  /** The transcript's tail, already bounded (CHAT_TAIL_BYTES). */
  readTail(path: string): Promise<string>;
  screenText(paneKey: string): string | undefined;
  write(paneKey: string, data: string): void;
  log(token: string): void;
  /** Tells the notifier which transcript to watch for this pane. */
  follow(paneKey: string, transcript: TranscriptLocation): void;
  /** Undoes a follow, for a pane that exited while it was being set up. */
  forget(paneKey: string): void;
};

const NONE: ClaudeView = { kind: "none" };

export function createClaudeViewHandlers(deps: ClaudeViewDeps): {
  view(paneKey: unknown): Promise<ClaudeView>;
  answer(paneKey: unknown, index: unknown, label: unknown): ClaudeAnswerResult;
} {
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

  return {
    async view(paneKey) {
      try {
        if (!live(paneKey)) return NONE;
      } catch {
        return none("panes");
      }
      let processes: readonly ExternalAgentProcess[];
      try {
        processes = await deps.scanAgents();
      } catch {
        return none("scan");
      }
      // A job sent to the background does not own the screen, so its
      // prompt and spinner would be the shell's. Unknown (no job columns)
      // is allowed; the screen reader finds nothing in a plain shell.
      const candidates = processes.filter(
        (process) => process.terminalPaneKey === paneKey && process.foreground !== false,
      );
      let session: Awaited<ReturnType<PaneClaudeLookup["forProcess"]>>;
      try {
        for (const process of candidates) {
          session = await deps.lookup.forProcess(process);
          if (session !== undefined) break;
        }
      } catch {
        return none("lookup");
      }
      if (session === undefined) return NONE;
      try {
        deps.follow(paneKey, { dir: session.transcriptsDir, file: `${session.sessionId}.jsonl` });
      } catch {
        none("follow"); // Costs live pushes for the transcript, not the view.
      }
      // The shell can exit while the scan or lookup awaits. Its exit has
      // already forgotten the pane, so this follow re-added a dead one —
      // and with it a watch nothing would ever close.
      try {
        if (!live(paneKey)) {
          deps.forget(paneKey);
          return NONE;
        }
      } catch {
        return none("panes");
      }

      let chat: ReturnType<typeof parseChatTranscript> = { turns: [] };
      if (session.transcriptPath !== undefined) {
        try {
          chat = parseChatTranscript(await deps.readTail(session.transcriptPath));
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
 * Says "look again" for a pane when it prints or its transcript changes, at
 * most once per CLAUDE_VIEW_DEBOUNCE_MS: the first event schedules the push,
 * later ones inside the window ride on it. A throttle, not a trailing
 * debounce — Claude's spinner redraws continuously, and a debounce that
 * waited for quiet would never fire while it works.
 *
 * Transcript watches are per directory, shared by every pane whose session
 * lives there, and only for panes the view handler has followed; a pane's
 * entry goes when its shell exits, or on `forget`. A watch that errors is
 * dropped, so the next follow watches that directory again.
 */
export function createClaudeViewNotifier(deps: ClaudeViewNotifierDeps): {
  follow(paneKey: string, transcript: TranscriptLocation): void;
  forget(paneKey: string): void;
  stop(): void;
} {
  const pending = new Map<string, () => void>();
  const followed = new Map<string, TranscriptLocation>();
  const watchers = new Map<string, { close(): void }>();
  let stopped = false;

  function log(token: string): void {
    try {
      deps.log(`claude-view: ${token}`);
    } catch {
      // Diagnostics cannot break the notifier.
    }
  }

  function bump(paneKey: string): void {
    if (stopped || pending.has(paneKey)) return;
    pending.set(
      paneKey,
      deps.schedule(() => {
        pending.delete(paneKey);
        if (stopped) return;
        try {
          deps.emit(paneKey);
        } catch {
          log("emit");
        }
      }, CLAUDE_VIEW_DEBOUNCE_MS),
    );
  }

  function closeUnused(dir: string): void {
    for (const location of followed.values()) if (location.dir === dir) return;
    watchers.get(dir)?.close();
    watchers.delete(dir);
  }

  function forget(paneKey: string): void {
    const location = followed.get(paneKey);
    followed.delete(paneKey);
    pending.get(paneKey)?.();
    pending.delete(paneKey);
    if (location !== undefined) closeUnused(location.dir);
  }

  const stopOutput = deps.onOutput(bump);
  const stopExit = deps.onExit(forget);

  return {
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
              if (location.dir === dir && (file === null || file === location.file)) bump(key);
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
      for (const cancel of pending.values()) cancel();
      pending.clear();
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      followed.clear();
    },
  };
}
