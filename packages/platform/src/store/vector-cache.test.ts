import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openVectorCache } from "./vector-cache.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("openVectorCache", () => {
  it("stores vectors by model and text, and misses otherwise", () => {
    const cache = openVectorCache({ path: ":memory:", now: () => 1 });
    cache.set("nomic-embed-text", "search_document: hello", new Float32Array([0.5, -1, 2]));
    expect([...(cache.get("nomic-embed-text", "search_document: hello") ?? [])]).toEqual([
      0.5, -1, 2,
    ]);
    expect(cache.get("other-model", "search_document: hello")).toBeUndefined();
    expect(cache.get("nomic-embed-text", "search_query: hello")).toBeUndefined();
    cache.close();
  });

  it("survives a reopen, in a 0600 file under a created directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vc-"));
    dirs.push(dir);
    const path = join(dir, "cache", "tool-index.sqlite");
    const first = openVectorCache({ path, now: () => 1 });
    first.set("m", "t", new Float32Array([1, 2]));
    first.close();
    const second = openVectorCache({ path, now: () => 2 });
    expect([...(second.get("m", "t") ?? [])]).toEqual([1, 2]);
    second.close();
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("keeps the most recently used rows when it prunes", () => {
    let clock = 0;
    const cache = openVectorCache({ path: ":memory:", now: () => ++clock, maxRows: 3 });
    for (let i = 0; i < 99; i++) cache.set("m", `old-${i}`, new Float32Array([i]));
    cache.get("m", "old-0");
    cache.set("m", "new", new Float32Array([7]));
    expect(cache.get("m", "new")).toBeDefined();
    expect(cache.get("m", "old-0")).toBeDefined();
    expect(cache.get("m", "old-5")).toBeUndefined();
    cache.close();
  });
});
