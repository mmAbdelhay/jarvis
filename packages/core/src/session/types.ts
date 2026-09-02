import type { AgentConfig } from "../registry/types.js";

export type SessionState = "starting" | "running" | "waiting" | "done" | "dead";

export type Session = {
  id: string;
  /**
   * The configured project this session's cwd belongs to, or null when it
   * belongs to none.
   *
   * Null is ordinary rather than exceptional: a session imported from a
   * transcript is recorded wherever it was actually started, and most work
   * on a machine happens in directories the user never declared in
   * `projects:` — 95 of 125 on the machine this was measured against. Such
   * a row is still worth having, because projectPath, summary and resume
   * all work without a project name. `sessionLabel()` is the single place
   * that turns a null into something displayable.
   */
  project: string | null;
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
  /**
   * Where the transcript this session was imported from lives, when it was
   * imported at all.
   *
   * A session Jarvis spawned has a pty backlog to replay and leaves this
   * unset. One started in a terminal has no backlog — only the file — so
   * without the path, showing it would mean scanning every agent directory
   * for a file named after its id on every click.
   */
  transcriptPath?: string;
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
  /**
   * Records a session read back from a transcript on disk, rather than one
   * this process is running.
   *
   * Two writers touch one row — `SessionManager` through `upsert` above and
   * the transcript importer through this — so the boundary between them is
   * explicit rather than implied.
   *
   * `owned` is true when `SessionManager` is currently running this id. For
   * such a session the pty observes `state`, `endedAt` and `exitCode`
   * directly and the importer can only infer them, so an implementation
   * must not write those three columns at all — and must not create a row
   * that does not exist yet, which would mean inventing a state for a live
   * session. Only the descriptive columns (project, projectPath, agentId,
   * model, summary, startedAt, lastActivityAt, branch) are the importer's
   * to write there.
   *
   * For an unowned id the importer is authoritative and the row is inserted
   * whole — but a row that already exists keeps its recorded state,
   * endedAt, exitCode and git counts, because those came from watching a
   * process a transcript knows nothing about.
   */
  upsertImported(session: Session, options: { owned: boolean }): void;
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

/**
 * Starts one agent process.
 *
 * `sessionId` is the id SessionManager minted for this session, passed so a
 * spawner can hand it to the CLI (`--session-id`) and the transcript that
 * session writes lands under the id Jarvis already knows it by. Optional
 * because not every spawner has a flag for it — the piped spawner ignores
 * it — and because leaving it optional keeps every two-argument spawner,
 * production and test, satisfying this type unchanged.
 */
export type Spawner = (
  agent: AgentConfig,
  projectPath: string,
  sessionId?: string,
) => ProcessHandle;

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
