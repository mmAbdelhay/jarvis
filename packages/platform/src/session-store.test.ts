import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "@jarvis/core";
import { createSqliteSessionStore } from "./session-store.js";

// The version this build migrates to. Pinned here rather than repeated as a
// literal in each migration test, so a bump changes one line.
const SCHEMA_VERSION = 3;

const STORE_SOURCE_PATH = fileURLToPath(new URL("./session-store.ts", import.meta.url));

const agentSession = (overrides: Partial<Session> = {}): Session => ({
  id: "s1",
  project: "acme",
  projectPath: "/p/acme",
  agentId: "claude-acme",
  model: "sonnet",
  state: "starting",
  summary: "",
  startedAt: 1000,
  lastActivityAt: 1000,
  ...overrides,
});

describe("createSqliteSessionStore", () => {
  // node:sqlite's DatabaseSync accepts ":memory:" directly — no mocking of
  // the driver, per the brief.
  it("inserts a new session and returns it from history()", () => {
    const store = createSqliteSessionStore(":memory:");
    store.upsert(agentSession());
    // The git columns are NOT NULL DEFAULT since the v1->v2 migration and
    // so always come back with real (zero/empty) values, not merely
    // undefined, even though updateGit() was never called.
    expect(store.history()).toEqual([
      { ...agentSession(), branch: "", insertions: 0, deletions: 0, changedFiles: 0 },
    ]);
  });

  it("updates the same row in place on a later transition, not a second row", () => {
    const store = createSqliteSessionStore(":memory:");
    store.upsert(agentSession());
    store.upsert(agentSession({ state: "running", summary: "Running tests", lastActivityAt: 2000 }));
    const history = store.history();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ state: "running", summary: "Running tests" });
  });

  it("records endedAt and exitCode when set", () => {
    const store = createSqliteSessionStore(":memory:");
    store.upsert(
      agentSession({ state: "dead", exitCode: 1, endedAt: 3000, lastActivityAt: 3000 }),
    );
    expect(store.history()[0]).toMatchObject({ state: "dead", exitCode: 1, endedAt: 3000 });
  });

  it("omits model, endedAt and exitCode from a row where they were never set", () => {
    const store = createSqliteSessionStore(":memory:");
    const { model, ...withoutModel } = agentSession();
    store.upsert(withoutModel);
    const row = store.history()[0];
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty("model");
    expect(row).not.toHaveProperty("endedAt");
    expect(row).not.toHaveProperty("exitCode");
  });

  it("orders history by most recently active first", () => {
    const store = createSqliteSessionStore(":memory:");
    store.upsert(agentSession({ id: "old", lastActivityAt: 1000 }));
    store.upsert(agentSession({ id: "new", lastActivityAt: 5000 }));
    store.upsert(agentSession({ id: "mid", lastActivityAt: 3000 }));
    expect(store.history().map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  it("keeps sessions with different ids as separate rows", () => {
    const store = createSqliteSessionStore(":memory:");
    store.upsert(agentSession({ id: "a" }));
    store.upsert(agentSession({ id: "b" }));
    expect(store.history()).toHaveLength(2);
  });

  describe("row validation (Important 2 — no unchecked `as` cast on a db row)", () => {
    // These simulate a drifted schema (a hand-edited file, an older build,
    // a partially-applied future migration) by writing a malformed value
    // through a second raw connection to the same file — sqlite's own
    // flexible typing allows it even into a column declared NOT NULL/
    // INTEGER, so `createSqliteSessionStore`'s own `upsert()` (which only
    // ever writes well-typed `Session` fields) can't be used to produce
    // the bad row.
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "jarvis-session-store-validate-"));
      dbPath = join(dir, "sessions.db");
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("throws a specific error when a row has an unrecognised state", () => {
      const store = createSqliteSessionStore(dbPath);
      store.upsert(agentSession());

      const raw = new DatabaseSync(dbPath);
      raw.prepare("UPDATE sessions SET state = ? WHERE id = ?").run("orbiting", "s1");
      raw.close();

      expect(() => store.history()).toThrow(/unrecognised session state: orbiting/);
    });

    it("throws a specific error instead of silently producing NaN for a non-numeric startedAt", () => {
      const store = createSqliteSessionStore(dbPath);
      store.upsert(agentSession());

      const raw = new DatabaseSync(dbPath);
      raw.prepare("UPDATE sessions SET startedAt = ? WHERE id = ?").run("not-a-number", "s1");
      raw.close();

      expect(() => store.history()).toThrow(/numeric `startedAt` column/);
    });

    it("throws a specific error for a non-string project instead of rendering the literal string \"undefined\"", () => {
      const store = createSqliteSessionStore(dbPath);
      store.upsert(agentSession());

      // A TEXT-affinity column converts a bound number to its text
      // representation on the way in, so a number alone can't reproduce
      // the drift — a blob is left as-is by TEXT affinity and comes back
      // out as a Uint8Array, which is exactly the kind of wrong-shaped
      // value a validated read must reject rather than accept as `unknown`.
      const raw = new DatabaseSync(dbPath);
      raw.prepare("UPDATE sessions SET project = ? WHERE id = ?").run(new Uint8Array([1, 2, 3]), "s1");
      raw.close();

      // "a string or null" since v3, where null became a legitimate value
      // — a blob is still neither, and still names the column it came from.
      expect(() => store.history()).toThrow(/`project` column must be a string or null/);
    });
  });

  describe("startup reconciliation of stale non-terminal rows", () => {
    it("sweeps a row still 'running' with no endedAt to 'dead' with endedAt on the next open", () => {
      const dir = mkdtempSync(join(tmpdir(), "jarvis-session-store-reconcile-"));
      const dbPath = join(dir, "sessions.db");
      try {
        const first = createSqliteSessionStore(dbPath);
        // A session that never reached a terminal state before the
        // process ended (a hard kill, a crash) — no endedAt was ever set.
        first.upsert(agentSession({ id: "stuck", state: "running", lastActivityAt: 4242 }));

        const reopened = createSqliteSessionStore(dbPath);
        const row = reopened.history().find((s) => s.id === "stuck");
        expect(row).toMatchObject({ state: "dead", endedAt: 4242 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("does not touch rows already in a terminal state", () => {
      const dir = mkdtempSync(join(tmpdir(), "jarvis-session-store-reconcile-"));
      const dbPath = join(dir, "sessions.db");
      try {
        const first = createSqliteSessionStore(dbPath);
        first.upsert(agentSession({ id: "done-one", state: "done", exitCode: 0, endedAt: 9000 }));

        const reopened = createSqliteSessionStore(dbPath);
        const row = reopened.history().find((s) => s.id === "done-one");
        expect(row).toMatchObject({ state: "done", exitCode: 0, endedAt: 9000 });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe("against a real file on disk", () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "jarvis-session-store-test-"));
      dbPath = join(dir, "sessions.db");
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("creates the db file (and its parent directory) on first use", () => {
      const nestedPath = join(dir, "nested", "sessions.db");
      const store = createSqliteSessionStore(nestedPath);
      store.upsert(agentSession());
      expect(store.history()).toHaveLength(1);
    });

    it("persists rows across a reopen, with no data loss", () => {
      const first = createSqliteSessionStore(dbPath);
      first.upsert(agentSession({ id: "a" }));
      first.upsert(agentSession({ id: "b", state: "done", exitCode: 0, endedAt: 9000 }));

      const reopened = createSqliteSessionStore(dbPath);
      const history = reopened.history();
      expect(history).toHaveLength(2);
      expect(history.find((s) => s.id === "b")).toMatchObject({
        state: "done",
        exitCode: 0,
        endedAt: 9000,
      });
    });

    it("does not recreate the schema (and drop data) on a second open at the same schema version", () => {
      const first = createSqliteSessionStore(dbPath);
      first.upsert(agentSession());

      // Opening again runs migrate() a second time against a db already at
      // the current user_version — this must be a no-op, not a table drop.
      const reopened = createSqliteSessionStore(dbPath);
      expect(reopened.history()).toHaveLength(1);

      reopened.upsert(agentSession({ id: "second" }));
      const thirdOpen = createSqliteSessionStore(dbPath);
      expect(thirdOpen.history()).toHaveLength(2);
    });
  });

  describe("git metadata migration (v1 -> v2)", () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "jarvis-session-store-migrate-"));
      dbPath = join(dir, "sessions.db");
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("adds the git columns to an existing v1 database without losing rows", () => {
      // A v1 database exactly as phase 1 wrote it — built by hand, not
      // through the current code, so this proves an *existing* file
      // survives the migration rather than merely proving today's code
      // reads its own output back.
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE sessions (
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
      seed.exec("PRAGMA user_version = 1");
      seed
        .prepare(
          `INSERT INTO sessions (id, project, projectPath, agentId, state, summary, startedAt, lastActivityAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("old-1", "acme", "/projects/acme", "claude-acme", "done", "", 1, 1);
      seed.close();

      const store = createSqliteSessionStore(dbPath);
      expect(store.history().map((session) => session.id)).toContain("old-1");

      store.updateGit("old-1", {
        branch: "feat/checkout-retry",
        insertions: 128,
        deletions: 34,
        changedFiles: 7,
      });

      const reopened = createSqliteSessionStore(dbPath);
      const row = reopened.history().find((session) => session.id === "old-1");
      expect(row).toMatchObject({
        branch: "feat/checkout-retry",
        insertions: 128,
        deletions: 34,
        changedFiles: 7,
      });

      const db = new DatabaseSync(dbPath);
      const version = db.prepare("PRAGMA user_version").get();
      db.close();
      expect(version).toMatchObject({ user_version: SCHEMA_VERSION });
    });

    it("recovers a half-migrated database — some git columns already present but user_version still 1", () => {
      // This is the realistic crash state, not a hypothetical: an earlier
      // (unwrapped) build of migrate() ran the four ALTER TABLE statements
      // and the PRAGMA user_version write as five separate, unguarded
      // statements. A process killed after some ALTERs landed but before
      // the PRAGMA write leaves exactly this shape on disk — some but not
      // all v2 columns present, user_version still 1 — and the *next*
      // launch must not throw "duplicate column name" trying to re-add a
      // column that is already there.
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE sessions (
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
      // Only the first two of the four v2 columns made it — the state a
      // crash between the 2nd and 3rd ALTER would leave behind.
      seed.exec("ALTER TABLE sessions ADD COLUMN branch TEXT NOT NULL DEFAULT ''");
      seed.exec("ALTER TABLE sessions ADD COLUMN insertions INTEGER NOT NULL DEFAULT 0");
      seed.exec("PRAGMA user_version = 1");
      seed
        .prepare(
          `INSERT INTO sessions (id, project, projectPath, agentId, state, summary, startedAt, lastActivityAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("half-1", "acme", "/projects/acme", "claude-acme", "done", "", 1, 1);
      seed.close();

      expect(() => createSqliteSessionStore(dbPath)).not.toThrow();

      const store = createSqliteSessionStore(dbPath);
      expect(store.history().map((session) => session.id)).toContain("half-1");

      store.updateGit("half-1", {
        branch: "feat/checkout-retry",
        insertions: 5,
        deletions: 2,
        changedFiles: 1,
      });
      const row = store.history().find((session) => session.id === "half-1");
      expect(row).toMatchObject({ branch: "feat/checkout-retry", deletions: 2, changedFiles: 1 });

      const db = new DatabaseSync(dbPath);
      const version = db.prepare("PRAGMA user_version").get();
      db.close();
      expect(version).toMatchObject({ user_version: SCHEMA_VERSION });
    });

    it("gives a fresh (never-migrated) database the git columns exactly once", () => {
      // Regression guard for the trap this file's migrate() comment warns
      // about: a fresh db must not define the git columns both in the v0
      // CREATE TABLE and in the v1->v2 ALTER TABLE (which would throw
      // "duplicate column name").
      expect(() => createSqliteSessionStore(dbPath)).not.toThrow();

      const db = new DatabaseSync(dbPath);
      const version = db.prepare("PRAGMA user_version").get();
      expect(version).toMatchObject({ user_version: SCHEMA_VERSION });
      db.close();
    });

    it("is idempotent — opening an already-migrated database twice is a no-op", () => {
      createSqliteSessionStore(dbPath);
      expect(() => createSqliteSessionStore(dbPath)).not.toThrow();

      const db = new DatabaseSync(dbPath);
      const version = db.prepare("PRAGMA user_version").get();
      db.close();
      expect(version).toMatchObject({ user_version: SCHEMA_VERSION });
    });

    it("defaults branch/insertions/deletions/changedFiles for a session that ends before any git metadata is recorded", () => {
      const store = createSqliteSessionStore(dbPath);
      store.upsert(agentSession({ id: "no-git", state: "dead", endedAt: 5000, lastActivityAt: 5000 }));

      const row = store.history().find((session) => session.id === "no-git");
      expect(row).toMatchObject({ branch: "", insertions: 0, deletions: 0, changedFiles: 0 });
      // Never the string "undefined" or NaN — the per-field validation on
      // read (rowToSession) must reject anything else outright rather than
      // silently coercing it.
      expect(row?.branch).not.toBe("undefined");
      expect(Number.isNaN(row?.insertions)).toBe(false);
    });

    it("records an Arabic branch name with unusual characters intact", () => {
      const store = createSqliteSessionStore(dbPath);
      store.upsert(agentSession({ id: "arabic-branch" }));
      store.updateGit("arabic-branch", {
        branch: "ميزة/إصلاح-الدفع (v2)",
        insertions: 3,
        deletions: 1,
        changedFiles: 2,
      });

      const row = store.history().find((session) => session.id === "arabic-branch");
      expect(row).toMatchObject({ branch: "ميزة/إصلاح-الدفع (v2)" });
    });

    it("updateGit on a sessionId that does not exist affects no rows and does not throw", () => {
      const store = createSqliteSessionStore(dbPath);
      store.upsert(agentSession({ id: "real" }));

      expect(() =>
        store.updateGit("does-not-exist", {
          branch: "main",
          insertions: 1,
          deletions: 1,
          changedFiles: 1,
        }),
      ).not.toThrow();

      expect(store.history()).toHaveLength(1);
      expect(store.history()[0]).toMatchObject({ branch: "" });
    });

    it("rolls back every statement — including the PRAGMA user_version write — when a mid-migration ALTER TABLE genuinely fails", () => {
      // Forces a *real* sqlite failure partway through the v1->v2 step,
      // rather than asserting the rollback comment's claim on faith: pad
      // the v1 table with dummy columns so it sits one column short of
      // sqlite's SQLITE_MAX_COLUMN limit (2000, this build's default).
      // The migration's first three ALTERs (branch, insertions, deletions)
      // then land for real, and the fourth (changed_files) genuinely
      // collides with the limit and throws — no mocking of the driver,
      // every statement here runs against a real on-disk sqlite file, the
      // same as the rest of this suite. This is what proves or disproves
      // the comment at the top of `migrate()`: if `PRAGMA user_version`
      // did not actually participate in the transaction, this test would
      // find it bumped to 2 below despite the throw.
      const seed = new DatabaseSync(dbPath);
      const padding = Array.from({ length: 1986 }, (_, i) => `extra${i} INTEGER`).join(", ");
      seed.exec(`
        CREATE TABLE sessions (
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
          exitCode INTEGER,
          ${padding}
        )
      `);
      seed.exec("PRAGMA user_version = 1");
      seed
        .prepare(
          `INSERT INTO sessions (id, project, projectPath, agentId, state, summary, startedAt, lastActivityAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run("pre-crash", "acme", "/projects/acme", "claude-acme", "done", "", 1, 1);
      seed.close();

      expect(() => createSqliteSessionStore(dbPath)).toThrow(/too many columns/);

      const check = new DatabaseSync(dbPath);
      const version = check.prepare("PRAGMA user_version").get();
      const columns = check
        .prepare("PRAGMA table_info(sessions)")
        .all()
        .map((row) => row.name);
      const rowStillThere = check.prepare("SELECT id FROM sessions WHERE id = ?").get("pre-crash");
      check.close();

      // The PRAGMA write is left exactly where it started, not bumped —
      // the single most important property of the atomic migration: it is
      // what stands between a force-quit mid-migration and a db that
      // throws "duplicate column name" on every subsequent launch.
      expect(version).toMatchObject({ user_version: 1 });
      expect(columns).not.toContain("branch");
      expect(columns).not.toContain("insertions");
      expect(columns).not.toContain("deletions");
      expect(columns).not.toContain("changed_files");
      // And the row that was already there survives untouched — a clean,
      // exact rollback of the whole transaction, not a partial one.
      expect(rowStillThere).toMatchObject({ id: "pre-crash" });
    });

    it("never drops the sessions table without copying every row into its replacement", () => {
      // A mutation guard: a migration that "fixes" a schema by recreating
      // the table silently deletes the user's whole session history, and
      // that is the failure this has always existed to catch.
      //
      // It read `expect(source).not.toMatch(/drop table/i)` until the
      // v2->v3 step, which removes a NOT NULL constraint — something sqlite
      // cannot do in place at all. Its only supported route is the rebuild
      // sqlite's own docs prescribe (new table, copy across, drop, rename),
      // and node:sqlite refuses the writable_schema alternative outright
      // ("table sqlite_master may not be modified"), so a flat ban on the
      // words would have banned the migration rather than the mistake.
      //
      // So the guard now checks the property it was always about: every
      // table drop is preceded by an INSERT copying that table's rows into
      // its replacement. A bare recreate still fails here, and the
      // row-survival tests in each migration block are the behavioural half
      // of the same promise.
      const source = readFileSync(STORE_SOURCE_PATH, "utf8");
      const drops = [...source.matchAll(/drop\s+table\s+(\w+)/gi)];
      for (const drop of drops) {
        const before = source.slice(0, drop.index);
        expect(before).toMatch(new RegExp(`INSERT INTO \\w+[\\s\\S]*?FROM ${drop[1]}\\b`, "i"));
      }
    });
  });

  describe("nullable project migration (v2 -> v3)", () => {
    let dir: string;
    let dbPath: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "jarvis-session-store-v3-"));
      dbPath = join(dir, "sessions.db");
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    // A v2 database exactly as phase 2 wrote it — built by hand, not
    // through the current code, so this proves an *existing* file survives
    // the migration rather than merely proving today's code reads its own
    // output back.
    function seedV2(): void {
      const seed = new DatabaseSync(dbPath);
      seed.exec(`
        CREATE TABLE sessions (
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
          exitCode INTEGER,
          branch TEXT NOT NULL DEFAULT '',
          insertions INTEGER NOT NULL DEFAULT 0,
          deletions INTEGER NOT NULL DEFAULT 0,
          changed_files INTEGER NOT NULL DEFAULT 0
        )
      `);
      seed.exec("PRAGMA user_version = 2");
      seed
        .prepare(
          `INSERT INTO sessions (
             id, project, projectPath, agentId, model, state, summary,
             startedAt, lastActivityAt, endedAt, exitCode,
             branch, insertions, deletions, changed_files
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "old-1",
          "acme",
          "/projects/acme",
          "claude-acme",
          "sonnet",
          "dead",
          "fixed the checkout",
          1000,
          2000,
          2000,
          1,
          "feat/checkout",
          12,
          3,
          4,
        );
      seed.close();
    }

    it("keeps every existing row, with every column intact", () => {
      seedV2();

      const store = createSqliteSessionStore(dbPath);
      const history = store.history();

      expect(history).toHaveLength(1);
      expect(history[0]).toEqual({
        id: "old-1",
        project: "acme",
        projectPath: "/projects/acme",
        agentId: "claude-acme",
        model: "sonnet",
        state: "dead",
        summary: "fixed the checkout",
        startedAt: 1000,
        lastActivityAt: 2000,
        endedAt: 2000,
        exitCode: 1,
        branch: "feat/checkout",
        insertions: 12,
        deletions: 3,
        changedFiles: 4,
      });
    });

    it("leaves the migrated database at the current version", () => {
      seedV2();
      createSqliteSessionStore(dbPath);

      const db = new DatabaseSync(dbPath);
      const version = db.prepare("PRAGMA user_version").get();
      db.close();
      expect(version).toMatchObject({ user_version: SCHEMA_VERSION });
    });

    it("stores a session with no configured project", () => {
      seedV2();
      const store = createSqliteSessionStore(dbPath);
      store.upsert(agentSession({ id: "no-project", project: null }));

      expect(store.history().find((session) => session.id === "no-project")).toMatchObject({
        project: null,
      });
    });

    it("gives a fresh database a nullable project column too", () => {
      // The trap this file's migrate() comment warns about, in its v3
      // spelling: a fresh db is created at the frozen v1 shape and must
      // then walk 2 and 3 like any other rather than stopping there.
      const store = createSqliteSessionStore(dbPath);
      expect(() => store.upsert(agentSession({ id: "fresh", project: null }))).not.toThrow();
    });

    it("is idempotent — opening an already-migrated database twice is a no-op", () => {
      seedV2();
      createSqliteSessionStore(dbPath);
      expect(() => createSqliteSessionStore(dbPath)).not.toThrow();
      expect(createSqliteSessionStore(dbPath).history()).toHaveLength(1);
    });
  });
});
