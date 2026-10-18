// Reviews (Task 10): the reviews:* dispatch handlers — routing to the review
// service, and the argument checks every one of them runs first regardless
// of origin (a paired phone reaches every one but reviews:openOnGithub).
// dispatch.test.ts's own `fakeDeps` seeds a `reviews` fake; this file only
// overrides what each test asserts on, plans-dispatch.test.ts's pattern.
import { describe, expect, it, vi } from "vitest";
import { createDispatchTable, DESKTOP_ORIGIN, type Origin } from "./dispatch.js";
import { fakeDeps } from "./dispatch.test.js";
import { MAX_REVIEW_BODY_CHARS } from "./dispatch.js";

const REMOTE_ORIGIN: Origin = { kind: "remote", deviceId: "d1", deviceName: "Phone" };

const callAs = (
  table: ReturnType<typeof createDispatchTable>,
  origin: Origin,
  channel: string,
  ...args: unknown[]
) =>
  (table as Record<string, (a: readonly unknown[], o: Origin) => unknown>)[channel]!(args, origin);

const call = (table: ReturnType<typeof createDispatchTable>, channel: string, ...args: unknown[]) =>
  callAs(table, DESKTOP_ORIGIN, channel, ...args);

const PR = "acme/web#18";

const PULL = {
  repo: "acme/web",
  number: 18,
  title: "Fix",
  headRef: "fix",
  author: "me",
  url: "https://github.com/acme/web/pull/18",
  isDraft: false,
  role: "mine" as const,
};

function livePanes() {
  return vi.fn(() => [
    { paneKey: "pane-1", exited: false },
    { paneKey: "pane-dead", exited: true },
  ]) as never;
}

function withReviews(overrides: Partial<ReturnType<typeof fakeDeps>["reviews"]>) {
  const base = fakeDeps();
  return fakeDeps({
    reviews: { ...base.reviews, ...overrides },
    shells: { ...base.shells, panes: livePanes() },
  });
}

const BAD_KEYS: unknown[] = [
  undefined,
  7,
  "",
  "acme/web",
  "acme/web#",
  "acme/web#18;rm",
  "../x#1",
  "acme/..#1",
  "acme/web/x#18",
  `${"a".repeat(140)}/b#1`,
];

describe("reviews:* dispatch: routing", () => {
  it("reviews:status and reviews:list return the service's own values", async () => {
    const status = { gh: null, enabled: true, repoErrors: { "acme/web": "boom" } };
    const items = [{ pr: PULL, link: { kind: "none" }, queued: 1, delivered: 0 }];
    const table = createDispatchTable(
      withReviews({ status: vi.fn(() => status), list: vi.fn(async () => items as never) }),
    );
    expect(await call(table, "reviews:status")).toBe(status);
    expect(await call(table, "reviews:list")).toBe(items);
  });

  it("reviews:thread passes a valid key through, from a phone too", async () => {
    const thread = vi.fn(async () => ({ pr: PULL }) as never);
    const table = createDispatchTable(withReviews({ thread }));
    expect(await callAs(table, REMOTE_ORIGIN, "reviews:thread", PR)).toEqual({ pr: PULL });
    expect(thread).toHaveBeenCalledWith(PR);
  });

  it("reviews:reply passes body and inReplyTo through", async () => {
    const reply = vi.fn(async () => ({ id: "9" }) as never);
    const table = createDispatchTable(withReviews({ reply }));
    await call(table, "reviews:reply", PR, "thanks", "123");
    await call(table, "reviews:reply", PR, "top level");
    expect(reply).toHaveBeenNthCalledWith(1, PR, "thanks", "123");
    expect(reply).toHaveBeenNthCalledWith(2, PR, "top level", undefined);
  });

  it("reviews:link accepts a live pane or null", async () => {
    const link = vi.fn(async () => undefined);
    const table = createDispatchTable(withReviews({ link }));
    await call(table, "reviews:link", PR, "pane-1");
    await call(table, "reviews:link", PR, null);
    expect(link).toHaveBeenNthCalledWith(1, PR, "pane-1");
    expect(link).toHaveBeenNthCalledWith(2, PR, null);
  });

  it("reviews:pause, sendReview, deliverNow, postSummary, pollNow and requeue route through", async () => {
    const deps = withReviews({});
    const table = createDispatchTable(deps);
    await call(table, "reviews:pause", "pane-1", true);
    expect(await call(table, "reviews:sendReview", PR, "pane-1")).toEqual({ sent: true });
    expect(await call(table, "reviews:deliverNow", PR)).toEqual({ sent: true });
    expect(await call(table, "reviews:postSummary", PR)).toEqual({ sent: true });
    await call(table, "reviews:pollNow");
    await call(table, "reviews:requeue", PR, "55");
    expect(deps.reviews.pause).toHaveBeenCalledWith("pane-1", true);
    expect(deps.reviews.sendReview).toHaveBeenCalledWith(PR, "pane-1");
    expect(deps.reviews.deliverNow).toHaveBeenCalledWith(PR);
    expect(deps.reviews.postSummary).toHaveBeenCalledWith(PR);
    expect(deps.reviews.pollNow).toHaveBeenCalled();
    expect(deps.reviews.requeue).toHaveBeenCalledWith(PR, "55");
  });

  it("reviews:openOnGithub opens the PR's own https URL, from the service", async () => {
    const deps = withReviews({ thread: vi.fn(async () => ({ pr: PULL }) as never) });
    const table = createDispatchTable(deps);
    await call(table, "reviews:openOnGithub", PR);
    expect(deps.openExternal).toHaveBeenCalledWith(PULL.url);
  });

  it("reviews:openOnGithub refuses a non-https URL and an unknown PR", async () => {
    const thread = vi
      .fn()
      .mockResolvedValueOnce({ pr: { ...PULL, url: "file:///etc/passwd" } })
      .mockResolvedValueOnce(undefined);
    const deps = withReviews({ thread });
    const table = createDispatchTable(deps);
    await expect(call(table, "reviews:openOnGithub", PR)).rejects.toThrow();
    await expect(call(table, "reviews:openOnGithub", PR)).rejects.toThrow();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });
});

describe("reviews:* dispatch: argument checks", () => {
  it.each(BAD_KEYS)("refuses prKey %j on every PR channel", async (key) => {
    const deps = withReviews({});
    const table = createDispatchTable(deps);
    expect(await callAs(table, REMOTE_ORIGIN, "reviews:thread", key)).toBeUndefined();
    expect(await callAs(table, REMOTE_ORIGIN, "reviews:requeue", key, "1")).toBe(false);
    for (const [channel, args] of [
      ["reviews:reply", ["hi"]],
      ["reviews:link", [null]],
      ["reviews:deliverNow", []],
      ["reviews:sendReview", ["pane-1"]],
      ["reviews:postSummary", []],
      ["reviews:openOnGithub", []],
    ] as const) {
      await expect(callAs(table, REMOTE_ORIGIN, channel, key, ...args)).rejects.toThrow(
        /invalid prKey/,
      );
    }
    expect(deps.reviews.thread).not.toHaveBeenCalled();
    expect(deps.reviews.requeue).not.toHaveBeenCalled();
    expect(deps.reviews.reply).not.toHaveBeenCalled();
    expect(deps.reviews.link).not.toHaveBeenCalled();
    expect(deps.reviews.deliverNow).not.toHaveBeenCalled();
    expect(deps.reviews.sendReview).not.toHaveBeenCalled();
    expect(deps.reviews.postSummary).not.toHaveBeenCalled();
  });

  it("refuses a reply body over the limit, a non-string body and an empty one", async () => {
    const deps = withReviews({});
    const table = createDispatchTable(deps);
    await call(table, "reviews:reply", PR, "x".repeat(MAX_REVIEW_BODY_CHARS));
    expect(deps.reviews.reply).toHaveBeenCalledTimes(1);
    for (const body of ["x".repeat(MAX_REVIEW_BODY_CHARS + 1), 7, undefined, "   "]) {
      await expect(callAs(table, REMOTE_ORIGIN, "reviews:reply", PR, body)).rejects.toThrow(
        /invalid body/,
      );
    }
    expect(deps.reviews.reply).toHaveBeenCalledTimes(1);
  });

  it("refuses a non-numeric inReplyTo or requeue comment id", async () => {
    const deps = withReviews({});
    const table = createDispatchTable(deps);
    await expect(call(table, "reviews:reply", PR, "hi", "../x")).rejects.toThrow(/inReplyTo/);
    expect(await call(table, "reviews:requeue", PR, "../x")).toBe(false);
    expect(deps.reviews.reply).not.toHaveBeenCalled();
    expect(deps.reviews.requeue).not.toHaveBeenCalled();
  });

  it("refuses a paneKey that is unknown, exited or not a string", async () => {
    const deps = withReviews({});
    const table = createDispatchTable(deps);
    for (const pane of ["nope", "pane-dead", 7, undefined]) {
      await expect(callAs(table, REMOTE_ORIGIN, "reviews:link", PR, pane)).rejects.toThrow(
        /invalid paneKey/,
      );
      await expect(callAs(table, REMOTE_ORIGIN, "reviews:sendReview", PR, pane)).rejects.toThrow(
        /invalid paneKey/,
      );
      await expect(callAs(table, REMOTE_ORIGIN, "reviews:pause", pane, true)).rejects.toThrow(
        /invalid paneKey/,
      );
    }
    expect(deps.reviews.link).not.toHaveBeenCalled();
    expect(deps.reviews.sendReview).not.toHaveBeenCalled();
    expect(deps.reviews.pause).not.toHaveBeenCalled();
  });

  it("refuses a non-boolean pause flag", async () => {
    const deps = withReviews({});
    const table = createDispatchTable(deps);
    await expect(call(table, "reviews:pause", "pane-1", "yes")).rejects.toThrow(/invalid paused/);
    expect(deps.reviews.pause).not.toHaveBeenCalled();
  });
});
