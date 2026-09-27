import type { AgentConfig } from "../registry/types.js";

export type SessionState = "starting" | "running" | "waiting" | "done" | "dead";

/** Every valid `SessionState`, in the one order they occur in a session's
 *  life — shared so a validator (the sqlite store's own row check, the
 *  desktop dispatch table's "history:edit" handler) never keeps its own,
 *  independently-drifting copy of this list. */
export const SESSION_STATES: readonly SessionState[] = [
  "starting",
  "running",
  "waiting",
  "done",
  "dead",
];

export function isSessionState(value: string): value is SessionState {
  return (SESSION_STATES as readonly string[]).includes(value);
}

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
  /**
   * Whether this row is a session Jarvis spawned itself or one the process
   * scan (process-scan.ts) found running outside it. Absent means
   * "jarvis" — every existing row and every call site that builds a
   * `Session` predates this field, and defaulting the omission to the
   * common case is what keeps them all unchanged.
   */
  origin?: "jarvis" | "external";
  /** The OS pid an "external" row was found under. Absent for a Jarvis
   *  session, which is identified by `id` instead — its pty is not
   *  guaranteed to still be the same OS process by the time anything reads
   *  this back (SessionManager never sets it on its own rows). */
  pid?: number;
};

/**
 * Persists session rows across app restarts. `core` depends only on this
 * interface — never on the OS — the same injected-seam shape as `Spawner`
 * and `CommandRunner`. The concrete sqlite-backed implementation lives in
 * `@jarvis/platform`; `@jarvis/desktop` composes it into `SessionManager`.
 */
/**
 * A user edit on top of a session's own recorded fields (bug 7: "edit any
 * session record"). Every key is optional — a patch names only the fields
 * a Save button actually changed — and, for whichever key is present, an
 * empty string clears that field's own override, reverting to whatever
 * `upsert`/`upsertImported` last wrote there rather than pinning it to "".
 *
 * Validating each field (a real SessionState, a configured project, a
 * known agent id, "not while the session is live") is the IPC handler's
 * job (dispatch.ts's "history:edit"), not this store's — the same split
 * `upsert`/`upsertImported` already draw between the shape of a row and
 * the shape of a request.
 */
export type SessionEditPatch = {
  summary?: string;
  project?: string;
  agentId?: string;
  model?: string;
  state?: SessionState | "";
};

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
  // All recorded sessions, most recently active first. Applies every
  // recorded `edit()` override on top of the row `upsert`/`upsertImported`
  // last wrote, so a later importer rescan or SessionManager transition
  // never silently wipes a user's edit.
  history(): Session[];
  /**
   * Applies a user edit on top of a session's row (bug 7) — never writes
   * into the row `upsert`/`upsertImported` maintain, so a later importer
   * rescan or SessionManager state transition can never silently wipe an
   * edit, and an edit can never silently wipe a field the transcript or
   * the live process is still the authority for. `history()` (and any
   * other row read) applies these via the underlying row as the default,
   * the override as the override.
   *
   * A key left out of `patch` leaves any existing override for that field
   * untouched. A key present with an empty string clears that field's own
   * override, reverting to whatever the underlying row holds — it does
   * not pin the field to "".
   *
   * An id with no session row yet still records the override (the same
   * "matches zero rows is fine" tolerance `updateGit` documents above) —
   * it simply has nothing to show until a row with that id exists.
   */
  edit(id: string, patch: SessionEditPatch): void;
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
  /**
   * Releases whatever the store holds open — called once, on quit.
   *
   * Optional because an in-memory fake has nothing to release. The sqlite
   * store has a file handle, and on Windows an open handle is a lock: the
   * directory it sits in cannot be removed while it is held, which is how a
   * test that opened a store left its own temp directory undeletable.
   */
  close?(): void;
}

export interface ProcessHandle {
  write(data: string): void;
  kill(): void;
  onOutput(listener: (chunk: string) => void): void;
  onExit(listener: (code: number) => void): void;
  /**
   * The OS pid this process runs under, when the spawner can report one.
   * SessionManager.ownedPids() reads this — it is how the process scan
   * (process-scan.ts) tells a Jarvis-spawned agent from one the user
   * started themselves, without which every pty child would also show up
   * as "running outside Jarvis". Optional because not every spawner runs a
   * real child process (a test double has nothing to report).
   */
  pid?: number;
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
 * reads is byte-for-byte what the agent printed. `offset` is the count of
 * UTF-16 code units emitted for this session before `chunk` (ruling 10) — a
 * client that reconnects mid-stream uses it, together with `snapshot()`'s
 * `end`, to tell whether a push it just received is one it already has.
 */
export type SessionOutput = {
  sessionId: string;
  chunk: string;
  offset: number;
};

/**
 * A cursor onto a pane's or session's retained output, returned by
 * `snapshot()`. `text` is whatever tail is still retained (never more than
 * the manager's cap); `end` is the true count of UTF-16 code units emitted
 * since the pane/session started, even once retention has trimmed `text`
 * down to less than that. A client attaches by reading `snapshot()` first,
 * then dropping any already-covered push using `end` (ruling 10).
 */
export type StreamSnapshot = {
  text: string;
  end: number;
};

export type StartInput = {
  project: string;
  projectPath: string;
  agent: AgentConfig;
};
