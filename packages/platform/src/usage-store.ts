import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { UsageStore } from "@jarvis/core";

/** Readings older than this are dropped as new ones arrive: the charts look
 *  back a day and a week, and a month is plenty of margin. */
export const USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Capacity readings over time, in their own table in sessions.db.
 *
 * Its own table on its own connection rather than part of the session
 * store: it shares nothing with a session row, and keeping it out of
 * SessionStore keeps that interface — and every double of it — as it was.
 * `CREATE TABLE IF NOT EXISTS` is the whole migration: the table is new
 * and independent, so it carries no schema version of its own.
 */
export function createSqliteUsageStore(
  dbPath: string,
  now: () => number = Date.now,
): UsageStore & { close(): void } {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS capacity_samples (
        id TEXT NOT NULL,
        at INTEGER NOT NULL,
        usedPercent REAL NOT NULL,
        PRIMARY KEY (id, at)
      )
    `);
  } catch (error) {
    db.close();
    throw error;
  }
  const insert = db.prepare(
    "INSERT OR IGNORE INTO capacity_samples (id, at, usedPercent) VALUES (?, ?, ?)",
  );
  const prune = db.prepare("DELETE FROM capacity_samples WHERE at < ?");
  const since = db.prepare(
    "SELECT id, at, usedPercent FROM capacity_samples WHERE at >= ? ORDER BY at ASC",
  );
  let closed = false;

  return {
    record(sample) {
      if (closed) return;
      if (!Number.isFinite(sample.at) || !Number.isFinite(sample.usedPercent)) return;
      insert.run(sample.id, Math.round(sample.at), sample.usedPercent);
      prune.run(now() - USAGE_RETENTION_MS);
    },
    samples(from) {
      if (closed) return [];
      return since.all(from).flatMap((row) => {
        const { id, at, usedPercent } = row as Record<string, unknown>;
        return typeof id === "string" && typeof at === "number" && typeof usedPercent === "number"
          ? [{ id, at, usedPercent }]
          : [];
      });
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
