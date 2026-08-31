import type { AgentConfig } from "../registry/types.js";

export type SessionState = "starting" | "running" | "waiting" | "done" | "dead";

export type Session = {
  id: string;
  project: string;
  projectPath: string;
  agentId: string;
  model?: string;
  state: SessionState;
  summary: string;
  startedAt: number;
  lastActivityAt: number;
  // Set the moment the session first reaches a terminal state ("done" or
  // "dead"); absent while the session is still starting/running/waiting.
  endedAt?: number;
  // The spawned process's exit code, set alongside `endedAt` when a
  // terminal state is reached via ProcessHandle.onExit. Left unset when a
  // session is ended by SessionManager.kill() instead — a manual kill has
  // no process-reported exit code of its own, which is itself the signal
  // that distinguishes "the agent exited" from "the user stopped it".
  exitCode?: number;
  // Git metadata recorded via SessionStore.updateGit(), so a finished
  // session's changes stay visible in history after its worktree and any
  // live ChangeTracker snapshot are gone (see P21: the history panel shows
  // no change badge for a past session unless it's this recorded value,
  // never a live count re-derived after the fact). Optional here — same as
  // model/endedAt/exitCode above — because a Session value can come from
  // places other than a re-read of the store (e.g. SessionManager.start()
  // before any git data was ever recorded); the sqlite store itself always
  // returns real (possibly zero/empty) values once its schema migration
  // has run, defaulting rather than leaving them NULL.
  branch?: string;
  insertions?: number;
  deletions?: number;
  changedFiles?: number;
};

/**
 * Persists session rows across app restarts. `core` depends only on this
 * interface — never on the OS — the same injected-seam shape as `Spawner`
 * and `CommandRunner`. The concrete sqlite-backed implementation lives in
 * `@jarvis/platform`; `@jarvis/desktop` composes it into `SessionManager`.
 */
export interface SessionStore {
  // Called on every session state transition (including the initial
  // "starting" row) — upserts by `session.id`, so a session's history is
  // exactly one row that gets updated in place as it progresses.
  upsert(session: Session): void;
  // All recorded sessions, most recently active first.
  history(): Session[];
  // Records the git change counts for one already-persisted session —
  // called from ChangeTracker.onChange() as a repo's counts change, and
  // again as the session ends, so the row a finished session leaves behind
  // carries its own honest counts rather than a live number that would
  // stop updating (and so lie) the moment the session and its worktree are
  // gone. A `sessionId` with no matching row updates nothing and does not
  // throw — the tracker's own session list can race a `dead` row's removal
  // during app shutdown, and a git-count write losing that race is not an
  // error worth surfacing.
  updateGit(
    sessionId: string,
    git: { branch: string; insertions: number; deletions: number; changedFiles: number },
  ): void;
}

export interface ProcessHandle {
  write(data: string): void;
  kill(): void;
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number) => void): void;
  /**
   * Tell the process its terminal is now `cols` x `rows`. Optional because
   * not every Spawner runs its child under a pty — a plain piped process
   * has no window size to change. A terminal UI (Claude Code's included)
   * lays itself out from this, so a missing or wrong size is the difference
   * between a readable session and a mangled one.
   */
  resize?(cols: number, rows: number): void;
}

export type Spawner = (agent: AgentConfig, projectPath: string) => ProcessHandle;

/**
 * One chunk of a session's output as it is emitted. `chunk` is exactly what
 * the process wrote (newline-terminated lines, or a trailing partial line
 * flushed at close) — never re-wrapped or trimmed, so the transcript a user
 * reads is byte-for-byte what the agent printed.
 */
export type SessionOutput = {
  sessionId: string;
  chunk: string;
};

export type StartInput = {
  project: string;
  projectPath: string;
  agent: AgentConfig;
};
