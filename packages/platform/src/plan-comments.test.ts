import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPlanCommentStore } from "./plan-comments.js";

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-plan-comments-"));
  return join(dir, "plan-comments.json");
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
    expect(entries).toContain(`${file.split("/").pop()}.corrupt-42`);
  });

  it("rejects an empty body", async () => {
    const store = createPlanCommentStore(await tempFile());

    await expect(
      store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "   " }),
    ).rejects.toThrow();
  });

  it("rejects a body over 4000 characters", async () => {
    const store = createPlanCommentStore(await tempFile());

    await expect(
      store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "x".repeat(5000) }),
    ).rejects.toThrow();
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

  it("writes the file as { v: 1, comments } JSON", async () => {
    const file = await tempFile();
    const store = createPlanCommentStore(file, clock().now, ids("c1"));

    await store.add({ path: "plans/a.md", blockId: "b1", quote: "", body: "hi" });

    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.v).toBe(1);
    expect(parsed.comments).toHaveLength(1);
  });
});
