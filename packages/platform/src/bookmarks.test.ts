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

  it("returns sorted results from add: pinned bookmarks sort first", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://b.test/", title: "B" });
    await store.add("p", { url: "https://a.test/", title: "A" });

    const result = await store.add("p", { url: "https://a.test/", title: "A" });
    // Pin the unpinned one to test sorting
    await store.setPinned("p", "https://b.test/", true);
    // Add another, should come after the pinned B even though added last
    const addResult = await store.add("p", { url: "https://c.test/", title: "C" });

    expect(addResult.ok && addResult.value.map((b) => b.url)).toEqual([
      "https://b.test/", // pinned
      "https://a.test/",
      "https://c.test/",
    ]);
  });
});

describe("pinning", () => {
  it("pins a bookmark and reports it in the returned list", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });

    const result = await store.setPinned("p", "https://a.test/", true);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value[0]?.pinned).toBe(true);
  });

  it("unpins again", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });
    await store.setPinned("p", "https://a.test/", true);

    const result = await store.setPinned("p", "https://a.test/", false);

    expect(result.ok && result.value[0]?.pinned).toBe(false);
  });

  it("refuses a thirteenth pin rather than evicting one", async () => {
    const store = createBookmarkStore(await tempFile());
    for (let i = 0; i < 13; i++) {
      await store.add("p", { url: `https://s${i}.test/`, title: `S${i}` });
    }
    for (let i = 0; i < 12; i++) {
      await store.setPinned("p", `https://s${i}.test/`, true);
    }

    const result = await store.setPinned("p", "https://s12.test/", true);

    expect(result).toEqual({ ok: false, detail: "pin-limit" });
  });

  it("pinning an unknown url is a no-op, not a failure", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });

    const result = await store.setPinned("p", "https://gone.test/", true);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toHaveLength(1);
  });

  it("pinning an unknown url when cap is full is a no-op, not a pin-limit error", async () => {
    const store = createBookmarkStore(await tempFile());
    for (let i = 0; i < 13; i++) {
      await store.add("p", { url: `https://s${i}.test/`, title: `S${i}` });
    }
    for (let i = 0; i < 12; i++) {
      await store.setPinned("p", `https://s${i}.test/`, true);
    }

    const result = await store.setPinned("p", "https://unknown.test/", true);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toHaveLength(13);
  });
});

describe("reorder", () => {
  it("rewrites order across the listed urls", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });
    await store.add("p", { url: "https://b.test/", title: "B" });

    const result = await store.reorder("p", ["https://b.test/", "https://a.test/"]);

    expect(result.ok && result.value.map((b) => b.url)).toEqual([
      "https://b.test/",
      "https://a.test/",
    ]);
  });

  it("ignores a url the project does not have", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });

    const result = await store.reorder("p", ["https://gone.test/", "https://a.test/"]);

    expect(result.ok && result.value.map((b) => b.url)).toEqual(["https://a.test/"]);
  });
});

describe("a file written before pinning existed", () => {
  it("loads with every bookmark unpinned, in the order it was written", async () => {
    const file = await tempFile();
    await writeFile(
      file,
      JSON.stringify({ p: [{ url: "https://a.test/", title: "A" }, { url: "https://b.test/", title: "B" }] }),
      "utf8",
    );
    const store = createBookmarkStore(file);

    const result = await store.list("p");

    expect(result.ok && result.value.map((b) => b.url)).toEqual([
      "https://a.test/",
      "https://b.test/",
    ]);
    expect(result.ok && result.value.every((b) => b.pinned !== true)).toBe(true);
  });
});

describe("renaming", () => {
  it("changes the title and leaves the url alone", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });

    const result = await store.rename("p", "https://a.test/", "Netflix");

    expect(result.ok && result.value[0]).toMatchObject({
      url: "https://a.test/",
      title: "Netflix",
    });
  });

  it("keeps the pin and the order, so a renamed essential stays put", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });
    await store.add("p", { url: "https://b.test/", title: "B" });
    await store.setPinned("p", "https://b.test/", true);
    await store.reorder("p", ["https://b.test/"]);

    const result = await store.rename("p", "https://b.test/", "Renamed");

    expect(result.ok && result.value[0]).toMatchObject({
      url: "https://b.test/",
      title: "Renamed",
      pinned: true,
      order: 0,
    });
  });

  it("survives a reload, so the new title is really on disk", async () => {
    const file = await tempFile();
    const store = createBookmarkStore(file);
    await store.add("p", { url: "https://a.test/", title: "A" });
    await store.rename("p", "https://a.test/", "Renamed");

    const reopened = await createBookmarkStore(file).list("p");

    expect(reopened.ok && reopened.value[0]?.title).toBe("Renamed");
  });

  it("is a no-op for a url the project does not have, like remove", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });

    const result = await store.rename("p", "https://gone.test/", "Nope");

    expect(result.ok && result.value.map((b) => b.title)).toEqual(["A"]);
  });

  it("refuses a blank title rather than writing a nameless bookmark", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });

    const result = await store.rename("p", "https://a.test/", "   ");

    expect(result).toEqual({ ok: false, detail: "blank-title" });
  });

  it("trims the title, so a stray space cannot pad the chip", async () => {
    const store = createBookmarkStore(await tempFile());
    await store.add("p", { url: "https://a.test/", title: "A" });

    const result = await store.rename("p", "https://a.test/", "  Netflix  ");

    expect(result.ok && result.value[0]?.title).toBe("Netflix");
  });
});
