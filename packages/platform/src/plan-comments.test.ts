import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanCommentStore } from "./plan-comments.js";

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-plan-comments-"));
  return join(dir, "plan-comments.json");
}

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-plan-comments-"));
}

function clock(start = 1000): { now: () => number; advance: () => void } {
  let value = start;
  return { now: () => value, advance: () => (value += 1) };
}

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? `id-${index}`;
}

describe("createPlanCommentStore", () => {
  it("lists no comments for a path before any file exists", async () => {
    const store = createPlanCommentStore(await tempFile());

    const result = await store.list("plans/a.md");

    expect(result).toEqual([]);
  });

  it("adds a comment and lists it back by path", async () => {
    const file = await tempFile();
    const { now } = clock();
    const store = createPlanCommentStore(file, now, ids("c1"));

    const added = await store.add({
      path: "plans/a.md",
      blockId: "b1",
      quote: "some quote",
      body: "please fix this",
    });

    expect(added).toEqual({
      id: "c1",
      path: "plans/a.md",
      blockId: "b1",
      quote: "some quote",
      body: "please fix this",
      createdAt: 1000,
    });

    const result = await store.list("plans/a.md");
    expect(result).toEqual([added]);
  });

  it("keeps comments for one path separate from another", async () => {
    const store = createPlanCommentStore(await tempFile(), clock().now, ids("c1", "c2"));

    await store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "on a" });
    await store.add({ path: "plans/b.md", blockId: "b1", quote: "", body: "on b" });

    expect(await store.list("plans/a.md")).toHaveLength(1);
    expect(await store.list("plans/b.md")).toHaveLength(1);
  });

  it("updates a comment's body in place", async () => {
    const store = createPlanCommentStore(await tempFile(), clock().now, ids("c1"));
    const added = await store.add({ path: "plans/a.md", blockId: "b1", quote: "q", body: "first" });

    const updated = await store.update(added.id, "revised body");

    expect(updated).toEqual({ ...added, body: "revised body" });
    expect(await store.list("plans/a.md")).toEqual([updated]);
  });

  it("returns undefined updating a comment that does not exist", async () => {
    const store = createPlanCommentStore(await tempFile());

    const result = await store.update("missing", "new body");

    expect(result).toBeUndefined();
  });

  it("removes a comment", async () => {
    const store = createPlanCommentStore(await tempFile(), clock().now, ids("c1"));
    const added = await store.add({
      path: "plans/a.md",
      blockId: "b1",
      quote: "",
      body: "gone soon",
    });

    const result = await store.remove(added.id);

    expect(result).toBe(true);
    expect(await store.list("plans/a.md")).toEqual([]);
  });

  it("removing a comment that does not exist returns false", async () => {
    const store = createPlanCommentStore(await tempFile());

    const result = await store.remove("missing");

    expect(result).toBe(false);
  });

  it("markSent sets sentAt on the given ids", async () => {
    const file = await tempFile();
    const c = clock();
    const store = createPlanCommentStore(file, c.now, ids("c1", "c2"));
    const first = await store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "one" });
    c.advance();
    const second = await store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "two" });
    c.advance();

    await store.markSent([first.id]);

    const result = await store.list("plans/a.md");
    expect(result).toEqual([{ ...first, sentAt: 1002 }, second]);
  });

  it("recovers from a corrupt file, renaming it aside", async () => {
    const file = await tempFile();
    await writeFile(file, "{ not json", "utf8");
    const store = createPlanCommentStore(file, () => 42);

    const result = await store.list("plans/a.md");

    expect(result).toEqual([]);
    const dir = join(file, "..");
    const entries = await readdir(dir);
    expect(entries).toContain(`${basename(file)}.corrupt-42`);
  });

  it("recovers from a file whose comments entries are invalid (e.g. null)", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ v: 1, comments: [null] }), "utf8");
    const store = createPlanCommentStore(file, () => 43);

    const result = await store.list("plans/a.md");

    expect(result).toEqual([]);
    const entries = await readdir(join(file, ".."));
    expect(entries).toContain(`${basename(file)}.corrupt-43`);
  });

  it("recovers from a file whose comments entries are missing required fields", async () => {
    const file = await tempFile();
    await writeFile(
      file,
      JSON.stringify({
        v: 1,
        comments: [{ id: "c1", path: "plans/a.md", blockId: "b1", quote: "", createdAt: 1 }],
      }),
      "utf8",
    );
    const store = createPlanCommentStore(file, () => 44);

    const result = await store.list("plans/a.md");

    expect(result).toEqual([]);
    const entries = await readdir(join(file, ".."));
    expect(entries).toContain(`${basename(file)}.corrupt-44`);
  });

  it("works normally again after recovering from a corrupt file", async () => {
    const file = await tempFile();
    await writeFile(file, "{ not json", "utf8");
    const store = createPlanCommentStore(file, clock().now, ids("c1"));

    const added = await store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "hi" });

    expect(await store.list("plans/a.md")).toEqual([added]);
  });

  it("rejects an empty body without writing anything", async () => {
    const dir = await tempDir();
    const file = join(dir, "plan-comments.json");
    const store = createPlanCommentStore(file);

    await expect(
      store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "   " }),
    ).rejects.toThrow(/1-4000/);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects a body over 4000 characters with a message naming the bound", async () => {
    const store = createPlanCommentStore(await tempFile());

    await expect(
      store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "x".repeat(5000) }),
    ).rejects.toThrow(/1-4000/);
  });

  it("trims body and quote", async () => {
    const store = createPlanCommentStore(await tempFile(), undefined, ids("c1"));

    const added = await store.add({
      path: "plans/a.md",
      blockId: "b1",
      quote: "  the quote  ",
      body: "  the body  ",
    });

    expect(added.body).toBe("the body");
    expect(added.quote).toBe("the quote");
  });

  it("truncates a quote over 500 characters instead of rejecting it", async () => {
    const store = createPlanCommentStore(await tempFile(), undefined, ids("c1"));

    const added = await store.add({
      path: "plans/a.md",
      blockId: "b1",
      quote: "q".repeat(600),
      body: "fine",
    });

    expect(added.quote).toHaveLength(500);
  });

  it("truncating a quote does not split a surrogate pair", async () => {
    const store = createPlanCommentStore(await tempFile(), undefined, ids("c1"));
    // 499 ASCII chars + a 2-code-unit emoji straddling the 500 boundary, so
    // a naive slice(0, 500) would cut the emoji's low surrogate off.
    const quote = `${"q".repeat(499)}😀${"q".repeat(50)}`;

    const added = await store.add({ path: "plans/a.md", blockId: "b1", quote, body: "fine" });

    expect(added.quote.length).toBeLessThanOrEqual(500);
    expect(added.quote).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it("update() clears sentAt, re-queuing an edited comment that had already been sent", async () => {
    const store = createPlanCommentStore(await tempFile(), clock().now, ids("c1"));
    const added = await store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "one" });
    await store.markSent([added.id]);

    const updated = await store.update(added.id, "revised");

    expect(updated?.sentAt).toBeUndefined();
    expect((await store.list("plans/a.md"))[0]?.sentAt).toBeUndefined();
  });

  it("markSent is a no-op (and does not touch the file) when no id matches", async () => {
    const file = await tempFile();
    const store = createPlanCommentStore(file, clock().now, ids("c1"));
    await store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "one" });
    const before = await stat(file);

    await store.markSent(["missing-id"]);

    const after = await stat(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("persists both of two concurrent adds", async () => {
    const store = createPlanCommentStore(await tempFile(), clock().now, ids("c1", "c2"));

    const [a, b] = await Promise.all([
      store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "first" }),
      store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "second" }),
    ]);

    const result = await store.list("plans/a.md");
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("leaves no temp files behind after a write", async () => {
    const dir = await tempDir();
    const file = join(dir, "plan-comments.json");
    const store = createPlanCommentStore(file, clock().now, ids("c1"));

    await store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "hi" });

    expect(await readdir(dir)).toEqual([basename(file)]);
  });

  it("writes the file as { v: 1, comments } JSON", async () => {
    const file = await tempFile();
    const store = createPlanCommentStore(file, clock().now, ids("c1"));

    await store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "hi" });

    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.v).toBe(1);
    expect(parsed.comments).toHaveLength(1);
  });

  it("add() rejects and writes nothing when the file path is unreadable (a directory, not a file)", async () => {
    const dir = await tempDir();
    // Using the directory itself as the "file" path makes every readFile()
    // fail with EISDIR instead of ENOENT — a transient/permission-shaped
    // failure, not "no file yet".
    const store = createPlanCommentStore(dir, clock().now, ids("c1"));

    await expect(
      store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "hi" }),
    ).rejects.toThrow();

    // Nothing besides the pre-existing directory itself should exist —
    // in particular, add() must not have replaced it with a file.
    expect(await readdir(join(dir, ".."))).toContain(basename(dir));
  });
});
