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

type SessionRow = {
  id: string;
  project: string;
  projectPath: string;
  agentId: string;
  model: string | null;
  state: string;
  summary: string;
  startedAt: number;
  lastActivityAt: number;
  endedAt: number | null;
  exitCode: number | null;
};

function rowToSession(raw: unknown): Session {
  const row = raw as SessionRow;
  if (!isSessionState(row.state)) {
    throw new Error(`sessions.db has an unrecognised session state: ${row.state}`);
  }
  return {
    id: row.id,
    project: row.project,
    projectPath: row.projectPath,
    agentId: row.agentId,
    ...(row.model === null ? {} : { model: row.model }),
    state: row.state,
    summary: row.summary,
    startedAt: row.startedAt,
    lastActivityAt: row.lastActivityAt,
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
    ...(row.exitCode === null ? {} : { exitCode: row.exitCode }),
  };
}
