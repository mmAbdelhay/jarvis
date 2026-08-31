import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBookmarkStore } from "./bookmarks.js";

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-bookmarks-"));
  return join(dir, "bookmarks.json");
}

describe("createBookmarkStore", () => {
  it("lists no bookmarks for a project before any file exists", async () => {
    const store = createBookmarkStore(await tempFile());

    const result = await store.list("acme");

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("adds a bookmark and lists it back", async () => {
    const store = createBookmarkStore(await tempFile());

    await store.add("acme", { url: "https://github.com", title: "GitHub" });
    const result = await store.list("acme");

    expect(result).toEqual({
      ok: true,
      value: [{ url: "https://github.com", title: "GitHub" }],
    });
  });

  it("returns the updated list from add() itself, without a second list() call", async () => {
    const store = createBookmarkStore(await tempFile());

    const result = await store.add("acme", { url: "https://github.com", title: "GitHub" });

    expect(result).toEqual({
      ok: true,
      value: [{ url: "https://github.com", title: "GitHub" }],
    });
  });

  it("updates the title in place instead of duplicating an already-bookmarked URL", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("acme", { url: "https://github.com", title: "GitHub" });

    const result = await store.add("acme", { url: "https://github.com", title: "GitHub (new tab)" });

    expect(result).toEqual({
      ok: true,
      value: [{ url: "https://github.com", title: "GitHub (new tab)" }],
    });
  });

  it("keeps a project's bookmarks separate from every other project's", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("acme", { url: "https://github.com", title: "GitHub" });

    const result = await store.list("storefront");

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("removes a bookmark by URL", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("acme", { url: "https://github.com", title: "GitHub" });
    await store.add("acme", { url: "https://vercel.com", title: "Vercel" });

    const result = await store.remove("acme", "https://github.com");

    expect(result).toEqual({
      ok: true,
      value: [{ url: "https://vercel.com", title: "Vercel" }],
    });
  });

  it("removing a URL that was never bookmarked is a no-op, not a failure", async () => {
    const store = createBookmarkStore(await tempFile());

    const result = await store.remove("acme", "https://github.com");

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("persists across store instances pointed at the same file", async () => {
    const path = await tempFile();
    const first = createBookmarkStore(path);
    await first.add("acme", { url: "https://github.com", title: "GitHub" });

    const second = createBookmarkStore(path);
    const result = await second.list("acme");

    expect(result).toEqual({
      ok: true,
      value: [{ url: "https://github.com", title: "GitHub" }],
    });
  });

  it("treats a corrupt file as empty rather than throwing", async () => {
    const path = await tempFile();
    await writeFile(path, "{ not json", "utf8");
    const store = createBookmarkStore(path);

    const result = await store.list("acme");

    expect(result).toEqual({ ok: true, value: [] });
  });

  it("serializes two adds in flight so neither overwrites the other", async () => {
    const store = createBookmarkStore(await tempFile());

    await Promise.all([
      store.add("acme", { url: "https://a.com", title: "A" }),
      store.add("acme", { url: "https://b.com", title: "B" }),
    ]);

    const result = await store.list("acme");
    expect(result.ok && result.value.map((b) => b.url).sort()).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("reports a failure when the file cannot be written", async () => {
    // A regular file where a directory needs to exist — mkdir(recursive)
    // fails with ENOTDIR trying to create a directory through it.
    const dir = await mkdtemp(join(tmpdir(), "jarvis-bookmarks-"));
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "x", "utf8");
    const store = createBookmarkStore(join(blocker, "nested", "bookmarks.json"));

    const result = await store.add("acme", { url: "https://github.com", title: "GitHub" });

    expect(result.ok).toBe(false);
  });

  it("writes readable JSON to disk", async () => {
    const path = await tempFile();
    const store = createBookmarkStore(path);

    await store.add("acme", { url: "https://github.com", title: "GitHub" });

    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual({
      acme: [{ url: "https://github.com", title: "GitHub" }],
    });
  });
});
