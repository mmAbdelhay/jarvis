import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ReviewComment } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { createReviewStore } from "./review-store.js";

// The controller-ruled composite key: `${prKey}|${kind}|${id}`.
function key(prKey: string, c: ReviewComment): string {
  return `${prKey}|${c.kind}|${c.id}`;
}

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-review-store-"));
  return join(dir, "reviews.json");
}

function comment(
  id: string,
  overrides: Partial<ReviewComment> = {},
): ReviewComment {
  return {
    id,
    kind: "issue",
    author: "alice",
    isBot: false,
    body: `body ${id}`,
    createdAt: Number(id.replace(/\D/g, "")) || 1,
    ...overrides,
  };
}

const PR = "acme/app#7";

describe("createReviewStore", () => {
  it("starts empty when no file exists", async () => {
    const store = createReviewStore(await tempFile());

    expect(await store.cursor(PR)).toBeUndefined();
    expect(await store.isFirstRun("acme/app")).toBe(true);
    expect(await store.listQueued()).toEqual([]);
    expect(await store.thread(PR)).toEqual([]);
    expect(await store.manualLinks()).toEqual(new Map());
    expect(await store.paused()).toEqual(new Set());
    expect(await store.wasNotified("x")).toBe(false);
  });

  it("keeps queued and delivered state across a reopen", async () => {
    const file = await tempFile();
    const first = createReviewStore(file);
    await first.upsertComments(PR, [comment("c1"), comment("c2")], "queued");
    await first.markDelivered([key(PR, comment("c1"))], "pane-1", 500);

    const reopened = createReviewStore(file);

    expect(await reopened.thread(PR)).toEqual([
      {
        prKey: PR,
        comment: comment("c1"),
        state: "delivered",
        deliveredTo: "pane-1",
        deliveredAt: 500,
      },
      { prKey: PR, comment: comment("c2"), state: "queued" },
    ]);
    expect(await reopened.listQueued(PR)).toEqual([
      { prKey: PR, comment: comment("c2"), state: "queued" },
    ]);
  });

  it("leaves a delivered comment delivered when it is upserted again", async () => {
    const store = createReviewStore(await tempFile());
    await store.upsertComments(PR, [comment("c1")], "queued");
    await store.markDelivered([key(PR, comment("c1"))], "pane-1", 500);

    await store.upsertComments(PR, [comment("c1")], "queued");
    await store.upsertComments(PR, [comment("c1")], "history");

    expect(await store.thread(PR)).toEqual([
      {
        prKey: PR,
        comment: comment("c1"),
        state: "delivered",
        deliveredTo: "pane-1",
        deliveredAt: 500,
      },
    ]);
    expect(await store.listQueued()).toEqual([]);
  });

  it("never downgrades queued to history, but promotes history to queued", async () => {
    const store = createReviewStore(await tempFile());
    await store.upsertComments(PR, [comment("c1")], "queued");
    await store.upsertComments(PR, [comment("c2")], "history");

    await store.upsertComments(PR, [comment("c1")], "history");
    await store.upsertComments(PR, [comment("c2")], "queued");

    expect((await store.thread(PR)).map((entry) => entry.state)).toEqual([
      "queued",
      "queued",
    ]);
  });

  it("keys comments by PR, kind and id so equal ids of different kinds do not collide", async () => {
    const store = createReviewStore(await tempFile());
    await store.upsertComments(
      PR,
      [comment("c1"), comment("c1", { kind: "review-inline" })],
      "queued",
    );
    await store.upsertComments("acme/app#8", [comment("c1")], "queued");

    expect(await store.listQueued()).toHaveLength(3);
    expect(await store.listQueued(PR)).toHaveLength(2);
  });

  it("records own comments in the thread but never as queued", async () => {
    const store = createReviewStore(await tempFile());
    await store.markOwn(PR, comment("c3"));
    await store.upsertComments(PR, [comment("c3")], "queued");

    expect(await store.thread(PR)).toEqual([
      { prKey: PR, comment: comment("c3"), state: "own" },
    ]);
    expect(await store.listQueued()).toEqual([]);
  });

  it("orders the thread by creation time", async () => {
    const store = createReviewStore(await tempFile());
    await store.upsertComments(PR, [comment("c9"), comment("c2")], "queued");
    await store.markOwn(PR, comment("c5"));

    expect((await store.thread(PR)).map((entry) => entry.comment.id)).toEqual([
      "c2",
      "c5",
      "c9",
    ]);
  });

  it("persists cursors, seeding, links, pauses and notifications", async () => {
    const file = await tempFile();
    const store = createReviewStore(file);
    await store.setCursor(PR, { etag: 'W/"abc"', since: 100 });
    await store.markSeeded("acme/app", 50);
    await store.setManualLink(PR, "pane-1");
    await store.setManualLink("acme/app#8", null);
    await store.setPaused("pane-1", true);
    await store.setPaused("pane-2", true);
    await store.setPaused("pane-2", false);
    await store.markNotified("requested:acme/app#7");

    const reopened = createReviewStore(file);

    expect(await reopened.cursor(PR)).toEqual({ etag: 'W/"abc"', since: 100 });
    expect(await reopened.isFirstRun("acme/app")).toBe(false);
    expect(await reopened.isFirstRun("acme/other")).toBe(true);
    expect(await reopened.manualLinks()).toEqual(
      new Map<string, string | null>([
        [PR, "pane-1"],
        ["acme/app#8", null],
      ]),
    );
    expect(await reopened.paused()).toEqual(new Set(["pane-1"]));
    expect(await reopened.wasNotified("requested:acme/app#7")).toBe(true);
    expect(await reopened.wasNotified("requested:acme/app#8")).toBe(false);
  });

  it("writes a versioned file", async () => {
    const file = await tempFile();
    await createReviewStore(file).markSeeded("acme/app", 1);

    const parsed = JSON.parse(await readFile(file, "utf8")) as { v: number };
    expect(parsed.v).toBe(1);
  });

  it("moves a corrupt file aside, preserving its bytes, and starts empty", async () => {
    const file = await tempFile();
    const original = "{ not json at all";
    await writeFile(file, original, "utf8");
    const store = createReviewStore(file, () => 42);

    expect(await store.listQueued()).toEqual([]);

    const entries = await readdir(dirname(file));
    expect(entries).toContain(`${basename(file)}.bad-42`);
    expect(await readFile(`${file}.bad-42`, "utf8")).toBe(original);
  });

  it("moves a well-formed JSON file with the wrong shape aside", async () => {
    const file = await tempFile();
    const original = JSON.stringify({ v: 1, comments: { k: null } });
    await writeFile(file, original, "utf8");
    const store = createReviewStore(file, () => 43);

    expect(await store.isFirstRun("acme/app")).toBe(true);
    expect(await readFile(`${file}.bad-43`, "utf8")).toBe(original);
  });

  it("works normally after recovering from a corrupt file", async () => {
    const file = await tempFile();
    await writeFile(file, "garbage", "utf8");
    const store = createReviewStore(file, () => 44);

    await store.upsertComments(PR, [comment("c1")], "queued");

    expect(await createReviewStore(file).listQueued()).toHaveLength(1);
  });

  it("does not lose an update under concurrent writes", async () => {
    const file = await tempFile();
    const store = createReviewStore(file);

    await Promise.all([
      store.upsertComments(PR, [comment("c1")], "queued"),
      store.upsertComments(PR, [comment("c2")], "queued"),
      store.setCursor(PR, { since: 9 }),
      store.markSeeded("acme/app", 1),
      store.setPaused("pane-1", true),
      store.markNotified("n1"),
      store.setManualLink(PR, "pane-1"),
    ]);

    const reopened = createReviewStore(file);
    expect(await reopened.listQueued(PR)).toHaveLength(2);
    expect(await reopened.cursor(PR)).toEqual({ since: 9 });
    expect(await reopened.isFirstRun("acme/app")).toBe(false);
    expect(await reopened.paused()).toEqual(new Set(["pane-1"]));
    expect(await reopened.wasNotified("n1")).toBe(true);
    expect((await reopened.manualLinks()).get(PR)).toBe("pane-1");
  });

  it("leaves no temp files behind after writes", async () => {
    const file = await tempFile();
    const store = createReviewStore(file);
    await store.markNotified("a");
    await store.markNotified("b");

    expect(await readdir(dirname(file))).toEqual([basename(file)]);
  });
});
