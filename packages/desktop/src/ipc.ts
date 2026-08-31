import {
  gitFailureText,
  type GitChanges,
  type GitFileDiff,
  type GitOutcome,
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
    // Set once a session reaches a terminal state (Session.endedAt).
    // gitChanges() always reads the repository's *current* working tree,
    // never a per-session snapshot, so a defined endedAt is the renderer's
    // only signal that what it is about to show is not necessarily this
    // session's own work (ruling P22) — Task 16 replaces this with real
    // per-session recorded counts, at which point the notice this drives
    // goes away for good.
    endedAt: number | undefined;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

// Sessions, not renderer-supplied paths, are the only route into GitProvider
// here: the main process owns the sessionId -> projectPath mapping, so a
// compromised renderer can request git data only for a repo a real session
// is already running against, never an arbitrary filesystem path.
export function createGitHandlers(deps: GitHandlerDeps): GitHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  function invalid(): { ok: false; text: string; language: "ar" | "en" } {
    return fail(MESSAGES.invalidArgument(deps.language));
  }

  function repoFor(sessionId: string): Session | undefined {
    return deps.sessions.get(sessionId);
  }

  // Ruling P26: the renderer already blocks a Commit click while a
  // gitSetStaged is outstanding, but that guard is one window's JavaScript,
  // not real serialization — nothing stops setStaged and commit for the
  // *same* repo from interleaving across two IPC calls in flight together
  // (e.g. a fast double-click, or two renderer code paths racing), and an
  // interleaved commit can capture a staging set that was mid-change. A
  // plain per-repo promise chain is enough: each repo's tail promise is
  // replaced with the new task chained onto the previous one, so
  // setStaged/commit for one repository always run one at a time, in the
  // order they were called, while two different repositories (two open
  // sessions) still run fully concurrently — a global lock would make the
  // app feel broken with several sessions open.
  const repoQueues = new Map<string, Promise<unknown>>();

  function enqueue<T>(repoPath: string, task: () => Promise<T>): Promise<T> {
    const previous = repoQueues.get(repoPath) ?? Promise.resolve();
    // `task` runs only after `previous` settles, whichever way it settled —
    // one repo's failed commit must not wedge that repo's queue forever.
    const run = previous.then(task, task);
    // The stored tail must never itself reject (a rejection stored here
    // would otherwise propagate into the *next* caller's `.then`, not this
    // caller's), so the chain keeps moving regardless of outcome; the
    // caller still gets the real result/rejection via `run` below.
    repoQueues.set(
      repoPath,
      run.catch(() => undefined),
    );
    return run;
  }

  // GitProvider's contract says it never throws (its own guard clauses —
  // e.g. rejecting a path outside the repo — return a GitOutcome failure,
  // not an exception), but ChangeTracker.refresh already sets the house
  // rule of not trusting that contract at the call site: it wraps every
  // provider call so a real-world throw degrades to a failure instead of
  // taking down the caller (ruling P15). This is the IPC-boundary
  // equivalent — an uncaught throw here would cross into the renderer as a
  // raw, English-only, internals-leaking IPC rejection, never a
  // GitViewResult the Changes view can render.
  async function callGit<T>(run: () => Promise<GitOutcome<T>>): Promise<GitOutcome<T>> {
    try {
      return await run();
    } catch (error) {
      return { ok: false, error: { code: "failed", detail: errorMessage(error) } };
    }
  }

  return {
    async changes(sessionId) {
      if (!isString(sessionId)) return invalid();
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      const outcome = await callGit(() => deps.git.changes(session.projectPath));
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
            endedAt: session.endedAt,
          },
          changes: outcome.value,
        },
      };
    },

    async fileDiff(sessionId, path) {
      if (!isString(sessionId) || !isString(path)) return invalid();
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      const outcome = await callGit(() => deps.git.diff(session.projectPath, path));
      if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));
      return { ok: true, value: outcome.value };
    },

    async setStaged(sessionId, path, staged) {
      if (!isString(sessionId) || !isString(path) || !isBoolean(staged)) return invalid();
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      return enqueue(session.projectPath, async () => {
        const outcome = staged
          ? await callGit(() => deps.git.stage(session.projectPath, [path]))
          : await callGit(() => deps.git.unstage(session.projectPath, [path]));
        if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));

        await deps.refresh();
        return { ok: true, value: null };
      });
    },

    async commit(sessionId, message) {
      if (!isString(sessionId) || !isString(message)) return invalid();
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      return enqueue(session.projectPath, async () => {
        const outcome = await callGit(() => deps.git.commit(session.projectPath, message));
        if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));

        await deps.refresh();
        return { ok: true, value: null };
      });
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
