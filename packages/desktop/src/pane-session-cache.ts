// The caches both chat views (the phone's claude-view.ts and the desktop's
// agent-view.ts) keep per pane: the pane's session (a process scan plus a
// pid-record or lock lookup, reused for a few seconds) and the last parse of
// a session's transcript (keyed by size and mtime, so an unchanged one is
// not read again).

import type { ExternalAgentProcess } from "@jarvis/platform";
import type { TerminalPaneInfo } from "@jarvis/wire";

export type PaneSessionCacheDeps<S> = {
  panes(): readonly TerminalPaneInfo[];
  /** A fresh process scan. */
  scanAgents(): Promise<readonly ExternalAgentProcess[]>;
  lookup: {
    forProcess(process: ExternalAgentProcess): Promise<S | undefined>;
    retain(sessionIds: ReadonlySet<string>): void;
  };
  now(): number;
  /** How long a found session is reused. */
  ttlMs: number;
  /** How long "no agent here" is reused. */
  noneTtlMs: number;
};

export function createPaneSessionCache<S extends { sessionId: string; transcriptPath?: string }>(
  deps: PaneSessionCacheDeps<S>,
) {
  // Pane → its session (or none), so a push storm does not run ps + lsof per call.
  const sessions = new Map<string, { session: S | undefined; at: number }>();

  return {
    /** Whether `paneKey` is a pane whose shell is still running. */
    live(paneKey: unknown): paneKey is string {
      return (
        typeof paneKey === "string" &&
        deps.panes().some((pane) => pane.paneKey === paneKey && !pane.exited)
      );
    },

    /** The session last found for a pane, whatever its age; no scan. */
    cached(paneKey: string): S | undefined {
      return sessions.get(paneKey)?.session;
    },

    /** Drops a pane's cached session. */
    forget(paneKey: string): void {
      sessions.delete(paneKey);
    },

    /** Keeps the cache to live panes; the session ids still wanted. */
    prune(livePanes: ReadonlySet<string>): Set<string> {
      for (const paneKey of sessions.keys()) if (!livePanes.has(paneKey)) sessions.delete(paneKey);
      const ids = new Set<string>();
      for (const { session } of sessions.values()) if (session) ids.add(session.sessionId);
      try {
        deps.lookup.retain(ids);
      } catch {
        // Only a cache.
      }
      return ids;
    },

    /** The pane's session; throws Error("scan") or Error("lookup"). */
    async sessionFor(paneKey: string): Promise<S | undefined> {
      const cached = sessions.get(paneKey);
      const ttl = cached?.session === undefined ? deps.noneTtlMs : deps.ttlMs;
      if (cached !== undefined && deps.now() - cached.at < ttl) {
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
      let session: S | undefined;
      try {
        for (const process of candidates) {
          session = await deps.lookup.forProcess(process);
          if (session !== undefined) break;
        }
      } catch {
        throw new Error("lookup");
      }
      // A session with no transcript yet is looked up again next time, so
      // its first turn shows as soon as the agent writes it.
      if (session === undefined || session.transcriptPath !== undefined) {
        sessions.set(paneKey, { session, at: deps.now() });
      } else sessions.delete(paneKey);
      return session;
    },
  };
}

export type ChatCacheDeps = {
  /** The transcript's tail, already bounded (CHAT_TAIL_BYTES). */
  readTail(path: string): Promise<string>;
  /** Size and mtime, so an unchanged transcript is not read again. */
  statFile(path: string): Promise<{ size: number; mtimeMs: number }>;
};

/** Session → the last parse of its transcript, keyed by path, size and mtime. */
export function createChatCache<C>(deps: ChatCacheDeps) {
  const parsed = new Map<string, { path: string; size: number; mtimeMs: number; chat: C }>();
  return {
    async get(sessionId: string, path: string, parse: (text: string) => C): Promise<C> {
      const stat = await deps.statFile(path);
      const last = parsed.get(sessionId);
      if (
        last !== undefined &&
        last.path === path &&
        last.size === stat.size &&
        last.mtimeMs === stat.mtimeMs
      ) {
        return last.chat;
      }
      const chat = parse(await deps.readTail(path));
      parsed.set(sessionId, { path, size: stat.size, mtimeMs: stat.mtimeMs, chat });
      return chat;
    },
    /** Keeps only these sessions' parses. */
    retain(sessionIds: ReadonlySet<string>): void {
      for (const id of parsed.keys()) if (!sessionIds.has(id)) parsed.delete(id);
    },
  };
}
