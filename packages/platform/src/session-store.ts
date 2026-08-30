import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Session, SessionState, SessionStore } from "@jarvis/core";

// Bumped whenever the table shape changes. Phase 2 is expected to add
// per-session git metadata columns; each future bump adds a migration
// branch below instead of dropping and recreating the table, so an
// existing db always opens without losing rows.
const SCHEMA_VERSION = 1;

const SESSION_STATES: readonly SessionState[] = [
  "starting",
  "running",
  "waiting",
  "done",
  "dead",
];

function isSessionState(value: string): value is SessionState {
  return (SESSION_STATES as readonly string[]).includes(value);
}

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
  migrate(db);
  reconcileStaleSessions(db);

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

  const historyStmt = db.prepare(`
    SELECT id, project, projectPath, agentId, model, state, summary,
           startedAt, lastActivityAt, endedAt, exitCode
    FROM sessions
    ORDER BY lastActivityAt DESC
  `);

  return {
    upsert(session: Session): void {
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
    history(): Session[] {
      return historyStmt.all().map(rowToSession);
    },
  };
}

// FROZEN: the `version === 0` branch below creates the CURRENT table shape.
// Once shipped, it is never edited again — not even to add a phase-2
// column. A fresh db (version 0) must always end up at the *latest* schema
// after `migrate()` runs, so every later change is instead a new,
// append-only `if (version < N) { db.exec("ALTER TABLE ...") }` branch
// below this one, each bumping `SCHEMA_VERSION` by one. Editing the v0
// `CREATE TABLE` to add a column AND adding an `ALTER TABLE ADD COLUMN`
// branch for that same column gives a fresh db the column twice and
// throws "duplicate column name" — this is the mistake this comment exists
// to head off.
function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
  const version = row?.user_version ?? 0;

  if (version >= SCHEMA_VERSION) return;

  if (version === 0) {
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

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
  const project = requireString(row, "project");
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
    throw new Error(`sessions.db row's \`${key}\` column must be a string or null (got ${typeof value})`);
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
    throw new Error(`sessions.db row's \`${key}\` column must be a number or null (got ${typeof value})`);
  }
  return value;
}
