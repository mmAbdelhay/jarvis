import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  isSessionState,
  type Session,
  type SessionEditPatch,
  type SessionStore,
} from "@jarvis/core";

// Bumped whenever the table shape changes. Each bump adds a migration
// branch below instead of dropping and recreating the table, so an
// existing db always opens without losing rows.
const SCHEMA_VERSION = 5;

/**
 * Sqlite-backed `SessionStore` — this is `platform`'s one and only OS-facing
 * piece of the history feature; `core` sees only the `SessionStore`
 * interface. Uses `node:sqlite` (available inside Electron 44 / Node
 * 24.18.1, confirmed by spike), never `better-sqlite3`, which needs a
 * postinstall native build this machine's `ignore-scripts=true` npmrc
 * deliberately blocks.
 */
export function createSqliteSessionStore(dbPath: string): SessionStore {
  // `~/.config/jarvis/sessions.db` sits beside `jarvis.yaml`, whose
  // directory already exists by the time this runs (loadConfig() just
  // read it) — but mkdir here too, following the same
  // create-the-directory-on-first-use precedent as loadConfig()'s
  // `mkdir(config.brain.cwd, ...)`, so this store is safe to point at any
  // path, not only the one directory that happens to already exist.
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);
  try {
    migrate(db);
    reconcileStaleSessions(db);
  } catch (error) {
    // A failed migration is a failed start, but not a leaked handle: on
    // Windows the open file would keep its directory undeletable for as long
    // as this process lives.
    db.close();
    throw error;
  }

  const upsertStmt = db.prepare(`
    INSERT INTO sessions (
      id, project, projectPath, agentId, model, state, summary,
      startedAt, lastActivityAt, endedAt, exitCode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      projectPath = excluded.projectPath,
      agentId = excluded.agentId,
      model = excluded.model,
      state = excluded.state,
      summary = excluded.summary,
      startedAt = excluded.startedAt,
      lastActivityAt = excluded.lastActivityAt,
      endedAt = excluded.endedAt,
      exitCode = excluded.exitCode
  `);

  // The importer's write for a session SessionManager is currently
  // running. `state`, `endedAt` and `exitCode` are absent from this
  // statement by construction rather than by discipline: the pty observes
  // those directly and a transcript can only guess at them.
  //
  // An UPDATE, not an upsert: an owned id with no row is a race against
  // SessionManager's own insert, and zero rows matched is exactly the
  // wanted no-op there (node:sqlite does not throw for it — the same
  // property updateGit below relies on). Inserting instead would mean
  // choosing a state for a session that is alive.
  const importOwnedStmt = db.prepare(`
    UPDATE sessions
    SET project = ?, projectPath = ?, agentId = ?, model = ?, summary = ?,
        startedAt = ?, lastActivityAt = ?, branch = ?
    WHERE id = ?
  `);

  // The importer's write for every other session — the terminal-started
  // ones, which are the point of importing at all. Inserted whole; but the
  // conflict branch is descriptive-only, so re-importing a session Jarvis
  // ran in some earlier run does not overwrite the exit code and git counts
  // that only a live process ever saw with a transcript's guesses.
  const importUnownedStmt = db.prepare(`
    INSERT INTO sessions (
      id, project, projectPath, agentId, model, state, summary,
      startedAt, lastActivityAt, endedAt, exitCode, branch, transcriptPath
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = excluded.project,
      projectPath = excluded.projectPath,
      agentId = excluded.agentId,
      model = excluded.model,
      summary = excluded.summary,
      startedAt = excluded.startedAt,
      lastActivityAt = excluded.lastActivityAt,
      branch = excluded.branch,
      transcriptPath = excluded.transcriptPath
  `);

  // Bug 7: every overridden field falls back to the underlying row's own
  // value via COALESCE — a NULL override column means "no override", never
  // "override to NULL" (see `edit()`'s own doc: an empty-string patch value
  // clears by writing NULL here, not by writing ""). Only the five fields
  // a user can actually edit are joined this way; every other column
  // (projectPath, startedAt, branch, the git counts, transcriptPath, …)
  // comes straight from `sessions` because nothing above ever offers to
  // edit them.
  //
  // `project` is the one field where NULL isn't the only meaningful
  // override value: `s.project` is itself nullable ("no configured
  // project", from the importer), so a plain COALESCE can't tell "no
  // override" apart from "override to no project" — both would read as
  // NULL. `edit()` resolves that by storing an explicit "" in
  // `session_overrides.project` for "override to no project", reserving
  // NULL there for "no override"; this CASE is the matching read side —
  // NULL still falls through to `s.project`, but "" is the sentinel that
  // becomes a real null, not the underlying value.
  const historyStmt = db.prepare(`
    SELECT s.id AS id,
           CASE WHEN o.project IS NULL THEN s.project
                WHEN o.project = '' THEN NULL
                ELSE o.project END AS project,
           s.projectPath AS projectPath,
           COALESCE(o.agentId, s.agentId) AS agentId,
           COALESCE(o.model, s.model) AS model,
           COALESCE(o.state, s.state) AS state,
           COALESCE(o.summary, s.summary) AS summary,
           s.startedAt AS startedAt,
           s.lastActivityAt AS lastActivityAt,
           s.endedAt AS endedAt,
           s.exitCode AS exitCode,
           s.branch AS branch,
           s.insertions AS insertions,
           s.deletions AS deletions,
           s.changed_files AS changed_files,
           s.transcriptPath AS transcriptPath
    FROM sessions s
    LEFT JOIN session_overrides o ON o.id = s.id
    ORDER BY s.lastActivityAt DESC
  `);

  const updateGitStmt = db.prepare(`
    UPDATE sessions
    SET branch = ?, insertions = ?, deletions = ?, changed_files = ?
    WHERE id = ?
  `);

  const selectOverrideStmt = db.prepare(`
    SELECT summary, project, agentId, model, state FROM session_overrides WHERE id = ?
  `);

  const upsertOverrideStmt = db.prepare(`
    INSERT INTO session_overrides (id, summary, project, agentId, model, state, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      summary = excluded.summary,
      project = excluded.project,
      agentId = excluded.agentId,
      model = excluded.model,
      state = excluded.state,
      updatedAt = excluded.updatedAt
  `);

  // Set by close(). A session can still end after the core's shutdown has
  // closed the store (an agent killed on quit exits a moment later), so
  // every call after that is a no-op rather than a throw from a closed db.
  let closed = false;

  return {
    upsert(session: Session): void {
      if (closed) return;
      upsertStmt.run(
        session.id,
        session.project,
        session.projectPath,
        session.agentId,
        session.model ?? null,
        session.state,
        session.summary,
        session.startedAt,
        session.lastActivityAt,
        session.endedAt ?? null,
        session.exitCode ?? null,
      );
    },
    upsertImported(session: Session, options: { owned: boolean }): void {
      if (closed) return;
      if (options.owned) {
        importOwnedStmt.run(
          session.project,
          session.projectPath,
          session.agentId,
          session.model ?? null,
          session.summary,
          session.startedAt,
          session.lastActivityAt,
          session.branch ?? "",
          session.id,
        );
        return;
      }
      importUnownedStmt.run(
        session.id,
        session.project,
        session.projectPath,
        session.agentId,
        session.model ?? null,
        session.state,
        session.summary,
        session.startedAt,
        session.lastActivityAt,
        session.endedAt ?? null,
        session.exitCode ?? null,
        session.branch ?? "",
        session.transcriptPath ?? null,
      );
    },
    history(): Session[] {
      if (closed) return [];
      return historyStmt.all().map(rowToSession);
    },
    updateGit(
      sessionId: string,
      git: { branch: string; insertions: number; deletions: number; changedFiles: number },
    ): void {
      // No existence check first: an UPDATE against a missing id simply
      // matches zero rows (node:sqlite does not throw for that), which is
      // exactly the "do nothing, don't throw" behaviour a race between the
      // tracker and a row's removal needs — see the interface doc comment.
      if (closed) return;
      updateGitStmt.run(git.branch, git.insertions, git.deletions, git.changedFiles, sessionId);
    },
    edit(id: string, patch: SessionEditPatch): void {
      // Merge in JS rather than a single SQL upsert: a key `patch` omits
      // must keep whatever this id's row already holds (or NULL, for a
      // first edit), which needs the existing row read back first — a
      // plain INSERT ... ON CONFLICT can only replace a column, not leave
      // it "whatever it already was" without also naming that value.
      if (closed) return;
      const existing = selectOverrideStmt.get(id) as
        | {
            summary: string | null;
            project: string | null;
            agentId: string | null;
            model: string | null;
            state: string | null;
          }
        | undefined;
      const resolve = (value: string | undefined, current: string | null): string | null => {
        if (value === undefined) return current;
        // An empty string clears the override — it is never stored as "".
        return value === "" ? null : value;
      };
      // `project` alone gets its own resolver: `null` in the patch is the
      // UI's explicit "No project" choice, stored as "" — the sentinel the
      // historyStmt CASE above turns back into a real null on read, kept
      // distinct from the column's own NULL ("no override"). `""` in the
      // patch still means "clear the override" like every other field.
      const resolveProject = (
        value: string | null | undefined,
        current: string | null,
      ): string | null => {
        if (value === undefined) return current;
        if (value === null) return "";
        return value === "" ? null : value;
      };
      upsertOverrideStmt.run(
        id,
        resolve(patch.summary, existing?.summary ?? null),
        resolveProject(patch.project, existing?.project ?? null),
        resolve(patch.agentId, existing?.agentId ?? null),
        resolve(patch.model, existing?.model ?? null),
        resolve(patch.state, existing?.state ?? null),
        Date.now(),
      );
    },
    close(): void {
      closed = true;
      // node:sqlite throws on a second close; a store closed twice (a signal
      // handler racing a clean quit) is not worth a crash.
      try {
        db.close();
      } catch {
        // Already closed.
      }
    },
  };
}

// FROZEN: `createSchemaV1` below creates the table shape phase 1 shipped.
// Once shipped, it is never edited again — not even to add a phase-2
// column. A fresh db (version 0) must always end up at the *latest* schema
// after `migrate()` runs, so every later change is instead a new,
// append-only `if (version < N) { db.exec("ALTER TABLE ...") }` branch
// below this one, each bumping `SCHEMA_VERSION` by one. Editing
// `createSchemaV1` to add a column AND adding an `ALTER TABLE ADD COLUMN`
// branch for that same column gives a fresh db the column twice and
// throws "duplicate column name" — this is the mistake this comment exists
// to head off.
function createSchemaV1(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      projectPath TEXT NOT NULL,
      agentId TEXT NOT NULL,
      model TEXT,
      state TEXT NOT NULL,
      summary TEXT NOT NULL,
      startedAt INTEGER NOT NULL,
      lastActivityAt INTEGER NOT NULL,
      endedAt INTEGER,
      exitCode INTEGER
    )
  `);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  // No `as` cast onto the row shape: node:sqlite types `all()` as
  // `Record<string, SQLOutputValue>[]`, so `row.name` narrows to `string`
  // via `typeof` alone, same as the row validation in `rowToSession` below.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((row) => typeof row.name === "string" && row.name === column);
}

// Adds a column only if it is not already there. `migrate` below also
// wraps the whole version-2 step in one transaction so a crash mid-way
// can no longer leave `user_version` behind what the table shape actually
// is — but this guard stays regardless, because it is what recovers a
// database that already reached that half-migrated state under the
// *previous*, unwrapped version of this function (some `ALTER TABLE`
// statements applied, `PRAGMA user_version` write never reached): without
// it, re-entering `if (version < 2)` on the next launch re-runs
// `ALTER TABLE … ADD COLUMN branch …` against a table that already has it
// and sqlite throws "duplicate column name", bricking every subsequent
// launch.
function addColumnIfMissing(db: DatabaseSync, table: string, ddl: string, column: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(ddl);
}

/**
 * Steps a database up to SCHEMA_VERSION one version at a time. Never drops
 * or recreates a table: this file holds the user's real session history
 * and a "recreate on mismatch" migration silently deletes it.
 */
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;

  if (version >= SCHEMA_VERSION) return;

  // The whole step — every ALTER plus the PRAGMA user_version write that
  // marks it done — runs as one transaction. Without this, a process that
  // dies partway through (a crash, a force-quit) can leave some columns
  // added but `user_version` still at the old value; the next launch would
  // then re-enter this branch and re-run an ALTER against a column that
  // already exists. Wrapped, a crash mid-migration rolls every statement
  // back (verified: PRAGMA user_version participates in the rollback same
  // as the ALTERs), so the db is left exactly as it was and the next
  // launch retries the whole step cleanly. addColumnIfMissing above is the
  // separate guard that recovers a database already left half-migrated by
  // an earlier, unwrapped build of this function.
  db.exec("BEGIN");
  try {
    if (version < 1) {
      createSchemaV1(db);
    }

    if (version < 2) {
      // Phase 2: what each session changed on disk, so the history panel
      // can show it after the session and its worktree are long gone.
      // Defaults make every pre-existing row valid without a backfill.
      addColumnIfMissing(
        db,
        "sessions",
        "ALTER TABLE sessions ADD COLUMN branch TEXT NOT NULL DEFAULT ''",
        "branch",
      );
      addColumnIfMissing(
        db,
        "sessions",
        "ALTER TABLE sessions ADD COLUMN insertions INTEGER NOT NULL DEFAULT 0",
        "insertions",
      );
      addColumnIfMissing(
        db,
        "sessions",
        "ALTER TABLE sessions ADD COLUMN deletions INTEGER NOT NULL DEFAULT 0",
        "deletions",
      );
      addColumnIfMissing(
        db,
        "sessions",
        "ALTER TABLE sessions ADD COLUMN changed_files INTEGER NOT NULL DEFAULT 0",
        "changed_files",
      );
    }

    if (version < 3) {
      // Phase 3: `project` becomes nullable. A session imported from a
      // transcript is recorded wherever it was actually started, and most
      // of those directories are not in `projects:` — 95 of the 125
      // transcripts measured — so "no project" has to be storable.
      //
      // Sqlite has no ALTER COLUMN, and node:sqlite refuses the
      // writable_schema route outright ("table sqlite_master may not be
      // modified"), so the only supported way to drop a NOT NULL is the
      // rebuild sqlite's own documentation prescribes: create the new
      // shape, copy every row across, drop the old table, rename. It runs
      // inside the transaction migrate() already opened, so a crash
      // anywhere in it leaves the original table with its rows untouched.
      //
      // This is a *copying* rebuild. The rule this file states — never
      // drop and recreate — is about never losing a row, which a bare
      // CREATE would; the INSERT…SELECT below is what keeps that promise,
      // and session-store.test.ts asserts both the copy (from a v2 file
      // built by hand) and the source-level shape of it.
      db.exec(`
        CREATE TABLE sessions_v3 (
          id TEXT PRIMARY KEY,
          project TEXT,
          projectPath TEXT NOT NULL,
          agentId TEXT NOT NULL,
          model TEXT,
          state TEXT NOT NULL,
          summary TEXT NOT NULL,
          startedAt INTEGER NOT NULL,
          lastActivityAt INTEGER NOT NULL,
          endedAt INTEGER,
          exitCode INTEGER,
          branch TEXT NOT NULL DEFAULT '',
          insertions INTEGER NOT NULL DEFAULT 0,
          deletions INTEGER NOT NULL DEFAULT 0,
          changed_files INTEGER NOT NULL DEFAULT 0
        )
      `);
      // Columns named explicitly rather than `SELECT *`: the old table's
      // physical column order depends on which migration created it, and a
      // positional copy would silently transpose values the day that
      // changes.
      db.exec(`
        INSERT INTO sessions_v3 (
          id, project, projectPath, agentId, model, state, summary,
          startedAt, lastActivityAt, endedAt, exitCode,
          branch, insertions, deletions, changed_files
        )
        SELECT id, project, projectPath, agentId, model, state, summary,
               startedAt, lastActivityAt, endedAt, exitCode,
               branch, insertions, deletions, changed_files
        FROM sessions
      `);
      db.exec("DROP TABLE sessions");
      db.exec("ALTER TABLE sessions_v3 RENAME TO sessions");
    }

    if (version < 4) {
      // Phase 4: where an imported session's transcript lives. Nullable
      // because a session Jarvis spawned has no transcript of its own to
      // point at — it has a pty backlog instead — so "unset" is the honest
      // value rather than a placeholder path.
      addColumnIfMissing(
        db,
        "sessions",
        "ALTER TABLE sessions ADD COLUMN transcriptPath TEXT",
        "transcriptPath",
      );
    }

    if (version < 5) {
      // Phase 5 (bug 7 — "edit any session record"): a user's edit lives in
      // its own table rather than a column on `sessions`, so `upsert()` and
      // `upsertImported()` never have to know overrides exist at all — a
      // session progressing or a transcript rescan simply overwrites
      // `sessions` the way it always has, and `history()`'s own JOIN is the
      // only place the two are reconciled. A NULL column is "no override
      // for this field" — never "override to NULL" — which is what lets
      // `edit()` clear a field by writing NULL back rather than needing a
      // second sentinel.
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_overrides (
          id TEXT PRIMARY KEY,
          summary TEXT,
          project TEXT,
          agentId TEXT,
          model TEXT,
          state TEXT,
          updatedAt INTEGER NOT NULL
        )
      `);
    }

    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// A row still in a non-terminal state ("starting" / "running" / "waiting")
// the moment the store is *opened* cannot belong to a session from this
// run — this function runs before `createSqliteSessionStore` returns,
// before `SessionManager` has started any session — so it can only be a
// row left behind by a previous run that never reached a terminal state on
// disk. That happens whenever the previous process didn't exit cleanly
// through `will-quit` (a hard kill, `SIGKILL`, a crash, a power loss), and
// even on a clean quit as a backstop for anything the quit-time sweep
// missed. A startup sweep is the one mechanism guaranteed to run on the
// *next* launch regardless of how the previous one ended, so it — not a
// will-quit-only sweep — is what keeps `endedAt IS NULL` rows from sorting
// to the top of `history()` (which orders by `lastActivityAt DESC`)
// forever.
function reconcileStaleSessions(db: DatabaseSync): void {
  db.exec(`
    UPDATE sessions
    SET state = 'dead', endedAt = lastActivityAt
    WHERE endedAt IS NULL AND state NOT IN ('done', 'dead')
  `);
}

// No `as` cast onto the row's shape: sqlite is flexibly typed and this
// process's own `SCHEMA_VERSION`/migration guarantees are no proof against
// a hand-edited file, a partially-applied future migration, or an older
// build's row shape. Every column is validated on the way out, the same
// per-field pattern config.ts's parseConfig() uses for its own
// `as`-then-validate cast — a missing or wrong-typed column throws a
// specific error naming the column, rather than silently producing
// `project: undefined` (rendered as the literal string "undefined") or an
// `undefined` `startedAt` that turns into `NaN` the first time it's used
// in arithmetic.
function rowToSession(raw: unknown): Session {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("sessions.db returned a non-object row");
  }
  const row = raw as Record<string, unknown>;

  const id = requireString(row, "id");
  // Nullable since the v2->v3 migration, and null is an ordinary value
  // here rather than an absence: a session started in a directory that is
  // in no configured project still has a row worth keeping.
  const project = requireNullableString(row, "project");
  const projectPath = requireString(row, "projectPath");
  const agentId = requireString(row, "agentId");
  const model = requireNullableString(row, "model");
  const state = requireString(row, "state");
  if (!isSessionState(state)) {
    throw new Error(`sessions.db has an unrecognised session state: ${state}`);
  }
  const summary = requireString(row, "summary");
  const startedAt = requireNumber(row, "startedAt");
  const lastActivityAt = requireNumber(row, "lastActivityAt");
  const endedAt = requireNullableNumber(row, "endedAt");
  const exitCode = requireNullableNumber(row, "exitCode");
  // NOT NULL DEFAULT columns since the v1->v2 migration — never absent,
  // never NULL, so validated (not nullable) like startedAt/lastActivityAt
  // rather than omitted-when-unset like model/endedAt/exitCode above.
  const branch = requireString(row, "branch");
  const insertions = requireNumber(row, "insertions");
  const deletions = requireNumber(row, "deletions");
  const changedFiles = requireNumber(row, "changed_files");
  // Nullable by design: a session Jarvis spawned has a pty backlog rather
  // than a transcript, so unset is the honest value.
  const transcriptRaw = row["transcriptPath"];
  const transcriptPath =
    typeof transcriptRaw === "string" && transcriptRaw !== "" ? transcriptRaw : null;

  return {
    id,
    project,
    projectPath,
    agentId,
    ...(model === null ? {} : { model }),
    state,
    summary,
    startedAt,
    lastActivityAt,
    ...(endedAt === null ? {} : { endedAt }),
    ...(exitCode === null ? {} : { exitCode }),
    branch,
    insertions,
    deletions,
    changedFiles,
    ...(transcriptPath === null ? {} : { transcriptPath }),
  };
}

function requireString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`sessions.db row is missing a string \`${key}\` column (got ${typeof value})`);
  }
  return value;
}

function requireNullableString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new Error(
      `sessions.db row's \`${key}\` column must be a string or null (got ${typeof value})`,
    );
  }
  return value;
}

function requireNumber(row: Record<string, unknown>, key: string): number {
  const value = row[key];
  if (typeof value !== "number") {
    throw new Error(`sessions.db row is missing a numeric \`${key}\` column (got ${typeof value})`);
  }
  return value;
}

function requireNullableNumber(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "number") {
    throw new Error(
      `sessions.db row's \`${key}\` column must be a number or null (got ${typeof value})`,
    );
  }
  return value;
}
