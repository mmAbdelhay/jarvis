import {
  gitFailureText,
  type GitChanges,
  type GitFileDiff,
  type GitProvider,
  type Session,
  type SessionChanges,
  type SystemMetrics,
  type Turn,
} from "@jarvis/core";
import { MESSAGES } from "./messages.js";

export type VoiceNotice = { text: string; language: "ar" | "en" };

export type IpcChannels = {
  "metrics:update": SystemMetrics;
  "sessions:update": Session[];
  "turn:new": Turn;
  "voice:listening": boolean;
  "voice:notice": VoiceNotice;
  "git:counts": SessionChanges[];
};

// Every git call the renderer can make returns this. Failures arrive as text
// already localised in the main process, because the renderer has no access
// to the user's configured language and must never build user-facing strings
// of its own (Global Constraints: one bilingual message lane).
export type GitViewResult<T> =
  | { ok: true; value: T }
  | { ok: false; text: string; language: "ar" | "en" };

// The spec requires the Changes view to "name the session that produced" the
// diff, so the session travels with the changes rather than being looked up
// separately by the renderer.
export type ChangesView = {
  session: {
    id: string;
    project: string;
    projectPath: string;
    agentId: string;
    lastActivityAt: number;
  };
  changes: GitChanges;
};

export type GitHandlers = {
  changes(sessionId: string): Promise<GitViewResult<ChangesView>>;
  fileDiff(sessionId: string, path: string): Promise<GitViewResult<GitFileDiff>>;
  setStaged(sessionId: string, path: string, staged: boolean): Promise<GitViewResult<null>>;
  commit(sessionId: string, message: string): Promise<GitViewResult<null>>;
};

export type GitHandlerDeps = {
  git: GitProvider;
  sessions: { get(id: string): Session | undefined };
  /** The user's configured primary language, used for every failure string. */
  language: "ar" | "en";
  /** ChangeTracker.refresh — called after anything that mutates the repo. */
  refresh(): Promise<void>;
};

// Sessions, not renderer-supplied paths, are the only route into GitProvider
// here: the main process owns the sessionId -> projectPath mapping, so a
// compromised renderer can request git data only for a repo a real session
// is already running against, never an arbitrary filesystem path.
export function createGitHandlers(deps: GitHandlerDeps): GitHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  function repoFor(sessionId: string): Session | undefined {
    return deps.sessions.get(sessionId);
  }

  return {
    async changes(sessionId) {
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      const outcome = await deps.git.changes(session.projectPath);
      if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));

      return {
        ok: true,
        value: {
          session: {
            id: session.id,
            project: session.project,
            projectPath: session.projectPath,
            agentId: session.agentId,
            lastActivityAt: session.lastActivityAt,
          },
          changes: outcome.value,
        },
      };
    },

    async fileDiff(sessionId, path) {
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      const outcome = await deps.git.diff(session.projectPath, path);
      if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));
      return { ok: true, value: outcome.value };
    },

    async setStaged(sessionId, path, staged) {
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      const outcome = staged
        ? await deps.git.stage(session.projectPath, [path])
        : await deps.git.unstage(session.projectPath, [path]);
      if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));

      await deps.refresh();
      return { ok: true, value: null };
    },

    async commit(sessionId, message) {
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      const outcome = await deps.git.commit(session.projectPath, message);
      if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));

      await deps.refresh();
      return { ok: true, value: null };
    },
  };
}

export type RendererApi = {
  send(text: string, language: "ar" | "en"): Promise<void>;
  // Drives the exact same start/stop path as the Alt+Space / Alt+Shift+Space
  // global hotkey — the renderer's mic button is a second control on one
  // voice implementation, not a separate click-to-talk feature.
  startVoice(): Promise<void>;
  stopVoice(): Promise<void>;
  onMetrics(cb: (m: SystemMetrics) => void): void;
  onSessions(cb: (s: Session[]) => void): void;
  onTurn(cb: (t: Turn) => void): void;
  onListening(cb: (listening: boolean) => void): void;
  // A transient status, distinct from a turn: e.g. "recorded but heard
  // nothing" — shown briefly in the voice-state element, never added to
  // the conversation as a hollow turn.
  onNotice(cb: (notice: VoiceNotice) => void): void;
  // Session history is pulled on demand (when the history panel opens),
  // not pushed like sessions:update — there is no live subscriber to keep
  // in sync, only a snapshot to render once.
  getHistory(): Promise<Session[]>;
  // Git. Each returns a GitViewResult, never rejects for a git-level problem:
  // the spec requires a git error to be shown in the Changes view and never
  // to block the assistant.
  gitChanges(sessionId: string): Promise<GitViewResult<ChangesView>>;
  gitDiff(sessionId: string, path: string): Promise<GitViewResult<GitFileDiff>>;
  gitSetStaged(sessionId: string, path: string, staged: boolean): Promise<GitViewResult<null>>;
  gitCommit(sessionId: string, message: string): Promise<GitViewResult<null>>;
  onChangeCounts(cb: (changes: SessionChanges[]) => void): void;
};

export type WiringDeps = {
  send(channel: string, payload: unknown): void;
  readMetrics(): Promise<SystemMetrics>;
  intervalMs: number;
  onSessionsChange(cb: (sessions: Session[]) => void): () => void;
  onTurn(cb: (turn: Turn) => void): () => void;
  onChangeCounts(cb: (changes: SessionChanges[]) => void): () => void;
  /** ChangeTracker.refresh; it guards its own re-entrancy. */
  refreshChanges(): Promise<void>;
  changesIntervalMs: number;
};

export function buildWiring(deps: WiringDeps): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let changesTimer: ReturnType<typeof setInterval> | undefined;
  const unsubscribes: (() => void)[] = [];

  return {
    start() {
      unsubscribes.push(
        deps.onSessionsChange((s) => {
          deps.send("sessions:update", s);
          // A session starting or dying almost always changes what is on
          // disk, so re-read git then rather than waiting for the next tick.
          void deps.refreshChanges();
        }),
      );
      unsubscribes.push(deps.onTurn((t) => deps.send("turn:new", t)));
      unsubscribes.push(deps.onChangeCounts((c) => deps.send("git:counts", c)));

      timer = setInterval(() => {
        deps.readMetrics()
          .then((metrics) => deps.send("metrics:update", metrics))
          .catch(() => {
            // A failed sample is skipped; the next tick tries again.
          });
      }, deps.intervalMs);

      changesTimer = setInterval(() => {
        void deps.refreshChanges();
      }, deps.changesIntervalMs);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (changesTimer !== undefined) clearInterval(changesTimer);
      changesTimer = undefined;
      while (unsubscribes.length > 0) unsubscribes.pop()?.();
    },
  };
}
