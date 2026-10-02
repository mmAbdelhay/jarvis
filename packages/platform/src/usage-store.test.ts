import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteUsageStore, USAGE_RETENTION_MS } from "./usage-store.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
});

async function dbPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-usage-"));
  dirs.push(dir);
  return join(dir, "sessions.db");
}

describe("createSqliteUsageStore", () => {
  it("keeps readings, oldest first, and one per account and instant", async () => {
    const store = createSqliteUsageStore(await dbPath(), () => 10_000);
    store.record({ id: "claude", at: 3000, usedPercent: 50 });
    store.record({ id: "claude", at: 1000, usedPercent: 20 });
    store.record({ id: "claude", at: 1000, usedPercent: 99 });
    store.record({ id: "codex", at: 2000, usedPercent: 5 });

    expect(store.samples(1500)).toEqual([
      { id: "codex", at: 2000, usedPercent: 5 },
      { id: "claude", at: 3000, usedPercent: 50 },
    ]);
    store.close();
  });

  it("forgets readings past the retention window", async () => {
    let clock = 0;
    const store = createSqliteUsageStore(await dbPath(), () => clock);
    store.record({ id: "claude", at: 0, usedPercent: 1 });
    clock = USAGE_RETENTION_MS + 1;
    store.record({ id: "claude", at: clock, usedPercent: 2 });
    expect(store.samples(0)).toEqual([{ id: "claude", at: clock, usedPercent: 2 }]);
    store.close();
  });

  it("shares sessions.db without disturbing the session store's own tables", async () => {
    const path = await dbPath();
    const { createSqliteSessionStore } = await import("./session-store.js");
    const sessions = createSqliteSessionStore(path);
    const usage = createSqliteUsageStore(path);
    usage.record({ id: "claude", at: 1, usedPercent: 1 });
    expect(sessions.history()).toEqual([]);
    usage.close();
  });
});
