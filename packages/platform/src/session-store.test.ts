import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "@jarvis/core";
import { createSqliteSessionStore } from "./session-store.js";

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
    expect(store.history()).toEqual([agentSession()]);
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

      expect(() => store.history()).toThrow(/string `project` column/);
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
});
