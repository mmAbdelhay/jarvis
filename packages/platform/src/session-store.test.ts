import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
