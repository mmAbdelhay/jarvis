import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryKeyError, openMemoryStore, removeMemoryFile } from "./memory-store.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function tempPath() {
  const dir = await mkdtemp(join(tmpdir(), "mem-"));
  dirs.push(dir);
  return join(dir, "share", "memory.sqlite");
}
let ids = 0;
const newId = () => `id${++ids}`;

describe("openMemoryStore (design §3.9)", () => {
  it("round-trips memories with vectors, newest first", () => {
    const store = openMemoryStore({ path: ":memory:", key: randomBytes(32), newId });
    const a = store.add({
      kind: "fact",
      text: "prefers Flatpak",
      createdAt: 1,
      embedding: new Float32Array([0.5, 1]),
      embeddingModel: "nomic-embed-text",
    });
    const b = store.add({
      kind: "summary",
      text: "installed VLC",
      createdAt: 2,
      embedding: null,
      embeddingModel: null,
    });
    const listed = store.list(10);
    expect(listed.map((m) => m.id)).toEqual([b, a]);
    expect([...(listed[1]?.embedding ?? [])]).toEqual([0.5, 1]);
    expect(listed[1]).toMatchObject({
      kind: "fact",
      text: "prefers Flatpak",
      createdAt: 1,
      embeddingModel: "nomic-embed-text",
    });
    expect(store.list(1)).toHaveLength(1);
    expect(store.delete(a)).toBe(true);
    expect(store.delete(a)).toBe(false);
    store.clear();
    expect(store.all()).toEqual([]);
    store.close();
  });

  it("never writes memory text in clear, and keeps the file private", async () => {
    const path = await tempPath();
    const store = openMemoryStore({ path, key: randomBytes(32), newId });
    store.add({
      kind: "fact",
      text: "PrefersFlatpakApps",
      createdAt: 1,
      embedding: null,
      embeddingModel: null,
    });
    store.close();
    expect(readFileSync(path).includes(Buffer.from("PrefersFlatpakApps"))).toBe(false);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a key that does not open the file, and reopens with the right one", async () => {
    const path = await tempPath();
    const key = randomBytes(32);
    openMemoryStore({ path, key, newId }).close();
    expect(() => openMemoryStore({ path, key: randomBytes(32), newId })).toThrow(MemoryKeyError);
    expect(() => openMemoryStore({ path, key: randomBytes(16), newId })).toThrow(MemoryKeyError);
    openMemoryStore({ path, key, newId }).close();
  });

  it("skips a row moved to another id (AAD binds row to id)", async () => {
    const path = await tempPath();
    const key = randomBytes(32);
    const store = openMemoryStore({ path, key, newId });
    const first = store.add({
      kind: "fact",
      text: "one",
      createdAt: 1,
      embedding: null,
      embeddingModel: null,
    });
    store.add({ kind: "fact", text: "two", createdAt: 2, embedding: null, embeddingModel: null });
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE memories SET id = 'forged' WHERE id = ?").run(first);
    raw.close();
    const logs: string[] = [];
    const reopened = openMemoryStore({ path, key, newId, log: (l) => logs.push(l) });
    expect(reopened.all().map((m) => m.text)).toEqual(["two"]);
    expect(logs[0]).toContain("could not be opened");
    reopened.close();
  });

  it("removes the file and its journals", async () => {
    const path = await tempPath();
    openMemoryStore({ path, key: randomBytes(32), newId }).close();
    removeMemoryFile(path);
    expect(existsSync(path)).toBe(false);
  });
});
