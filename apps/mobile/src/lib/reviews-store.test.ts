import { describe, expect, it, vi } from "vitest";
import type { RpcResult } from "./rpc-client";
import {
  createReviewsStore,
  isPrKey,
  parseReviewList,
  parseReviewThread,
  reviewAge,
  reviewCardModel,
  reviewRoute,
  reviewThreadEntries,
} from "./reviews-store";

function ok(value: unknown): RpcResult {
  return { ok: true, value };
}

function fakeClient(results: RpcResult[]) {
  const pushes = new Map<string, (payload: unknown) => void>();
  return {
    call: vi.fn(async (_channel: string, _args: unknown[]) => results.shift() ?? ok(undefined)),
    onPush: vi.fn((channel: string, handler: (payload: unknown) => void) => {
      pushes.set(channel, handler);
      return () => pushes.delete(channel);
    }),
    subscribe: vi.fn(() => ok(undefined)),
    unsubscribe: vi.fn(),
    push(channel: string, payload: unknown) {
      pushes.get(channel)?.(payload);
    },
  };
}

const pr = {
  repo: "owner/jarvis",
  number: 18,
  title: "PR comment listener",
  headRef: "feat/reviews",
  author: "me",
  url: "https://github.com/owner/jarvis/pull/18",
  isDraft: false,
  role: "mine",
};

const item = {
  pr,
  link: { kind: "linked", paneKey: "pane-1", how: "auto" },
  queued: 1,
  delivered: 2,
  waitReason: "busy",
  lastActivity: 1000,
};

const comment = {
  prKey: "owner/jarvis#18",
  comment: {
    id: "c1",
    kind: "review-inline",
    author: "colleague",
    isBot: false,
    body: "Compare logins case-insensitively.",
    path: "trigger.ts",
    line: 42,
    createdAt: 500,
  },
  state: "queued",
};

describe("isPrKey / reviewRoute", () => {
  it("accepts owner/name#N and rejects anything else", () => {
    expect(isPrKey("owner/name#18")).toBe(true);
    expect(isPrKey("my.org/my-repo_2#7")).toBe(true);
    expect(isPrKey("owner/name")).toBe(false);
    expect(isPrKey("owner/name#x")).toBe(false);
    expect(isPrKey("../x#1")).toBe(false);
    expect(isPrKey(`a/${"b".repeat(140)}#1`)).toBe(false);
    expect(isPrKey(18)).toBe(false);
  });

  it("encodes the key into one path segment", () => {
    expect(reviewRoute("owner/name#18")).toBe("/reviews/owner%2Fname%2318");
  });
});

describe("parseReviewList", () => {
  it("rebuilds each item field by field and drops extra keys", () => {
    const parsed = parseReviewList([{ ...item, secret: "x", pr: { ...pr, extra: 1 } }]);
    expect(parsed).toEqual([{ key: "owner/jarvis#18", ...item }]);
  });

  it("drops a malformed item without throwing and keeps the good ones", () => {
    const parsed = parseReviewList([
      { ...item, pr: { ...pr, number: "18" } },
      { ...item, link: { kind: "bogus" } },
      { ...item, queued: -1 },
      null,
      "x",
      { ...item, pr: { ...pr, repo: "../etc" } },
      item,
    ]);
    expect(parsed.map((row) => row.key)).toEqual(["owner/jarvis#18"]);
  });

  it("answers an empty list for a non-array", () => {
    expect(parseReviewList({ items: [] })).toEqual([]);
    expect(parseReviewList(undefined)).toEqual([]);
  });

  it("treats a missing or unknown wait reason as none", () => {
    const [row] = parseReviewList([{ ...item, waitReason: "later" }]);
    expect(row?.waitReason).toBeUndefined();
    const [none] = parseReviewList([{ ...item, waitReason: null }]);
    expect(none?.waitReason).toBeUndefined();
  });
});

describe("parseReviewThread", () => {
  it("parses the thread and drops malformed comments", () => {
    const thread = parseReviewThread({
      pr,
      link: { kind: "none" },
      waitReason: "no-link",
      comments: [
        comment,
        { ...comment, state: "weird" },
        { ...comment, comment: { ...comment.comment, body: 3 } },
      ],
    });
    expect(thread?.key).toBe("owner/jarvis#18");
    expect(thread?.link).toEqual({ kind: "none" });
    expect(thread?.comments).toHaveLength(1);
    expect(thread?.comments[0]?.comment.path).toBe("trigger.ts");
  });

  it("answers undefined for a thread whose pr is malformed", () => {
    expect(parseReviewThread({ pr: {}, link: { kind: "none" }, comments: [] })).toBeUndefined();
  });
});

describe("reviewCardModel", () => {
  it("amber with a queued chip while comments wait on a busy agent", () => {
    const [row] = parseReviewList([item]);
    const model = reviewCardModel(row!);
    expect(model.tone).toBe("warning");
    expect(model.linked).toBe(true);
    expect(model.chip).toEqual({ kind: "queued", count: 1 });
    expect(model.repoName).toBe("jarvis");
  });

  it("red with a waiting chip when nothing can receive the comments", () => {
    const [row] = parseReviewList([
      { ...item, link: { kind: "none" }, queued: 2, waitReason: "no-link" },
    ]);
    const model = reviewCardModel(row!);
    expect(model.tone).toBe("danger");
    expect(model.linked).toBe(false);
    expect(model.chip).toEqual({ kind: "waiting", count: 2 });
  });

  it("green with a delivered chip when nothing is queued", () => {
    const [row] = parseReviewList([{ ...item, queued: 0, waitReason: undefined }]);
    const model = reviewCardModel(row!);
    expect(model.tone).toBe("success");
    expect(model.chip).toEqual({ kind: "delivered" });
  });
});

describe("reviewAge", () => {
  it("answers a short Latin-digit age", () => {
    const now = 10 * 86_400_000;
    expect(reviewAge(now, now - 20_000)).toBe("now");
    expect(reviewAge(now, now - 5 * 60_000)).toBe("5m");
    expect(reviewAge(now, now - 2 * 3_600_000)).toBe("2h");
    expect(reviewAge(now, now - 3 * 86_400_000)).toBe("3d");
    expect(reviewAge(now, now + 60_000)).toBe("now");
  });
});

describe("reviewThreadEntries", () => {
  it("nests replies under their parent and marks a parent with your reply as replied", () => {
    const thread = parseReviewThread({
      pr,
      link: { kind: "none" },
      comments: [
        { ...comment, state: "delivered" },
        {
          prKey: "owner/jarvis#18",
          state: "own",
          comment: {
            id: "c2",
            kind: "review-inline",
            author: "me",
            isBot: false,
            body: "Fixed.",
            createdAt: 600,
            inReplyTo: "c1",
          },
        },
      ],
    })!;
    const entries = reviewThreadEntries(thread);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.replied).toBe(true);
    expect(entries[0]?.replies.map((reply) => reply.comment.id)).toEqual(["c2"]);
  });
});

describe("createReviewsStore", () => {
  it("loads the list", async () => {
    const client = fakeClient([ok([item])]);
    const store = createReviewsStore({ client: client as never });
    await store.load();
    expect(client.call).toHaveBeenCalledWith("reviews:list", []);
    expect(store.state.items).toHaveLength(1);
    expect(store.state.error).toBeUndefined();
  });

  it("records a load failure", async () => {
    const client = fakeClient([
      { ok: false, error: { kind: "remote", text: "nope" } } as RpcResult,
    ]);
    const store = createReviewsStore({ client: client as never });
    await store.load();
    expect(store.state.error).toEqual({ code: "loadFailed", detail: "nope" });
  });

  it("opens a thread by key", async () => {
    const client = fakeClient([ok({ pr, link: { kind: "none" }, comments: [comment] })]);
    const store = createReviewsStore({ client: client as never });
    await store.openThread("owner/jarvis#18");
    expect(client.call).toHaveBeenCalledWith("reviews:thread", ["owner/jarvis#18"]);
    expect(store.state.thread?.comments).toHaveLength(1);
  });

  it("never calls the laptop for a malformed key", async () => {
    const client = fakeClient([]);
    const store = createReviewsStore({ client: client as never });
    await store.openThread("nope");
    expect(client.call).not.toHaveBeenCalled();
    expect(store.state.error?.code).toBe("loadFailed");
  });

  it("replies and delivers on the open thread", async () => {
    const thread = { pr, link: { kind: "none" }, comments: [comment] };
    const client = fakeClient([ok(thread), ok(undefined), ok(thread), ok(undefined), ok(thread)]);
    const store = createReviewsStore({ client: client as never });
    await store.openThread("owner/jarvis#18");
    expect(await store.reply("Thanks", "c1")).toBe(true);
    expect(client.call).toHaveBeenCalledWith("reviews:reply", ["owner/jarvis#18", "Thanks", "c1"]);
    expect(await store.deliverNow()).toBe(true);
    expect(client.call).toHaveBeenCalledWith("reviews:deliverNow", ["owner/jarvis#18"]);
  });

  it("reports a refused delivery", async () => {
    const thread = { pr, link: { kind: "none" }, comments: [comment] };
    const client = fakeClient([ok(thread), ok({ ok: false, reason: "no-agent" })]);
    const store = createReviewsStore({ client: client as never });
    await store.openThread("owner/jarvis#18");
    expect(await store.deliverNow()).toBe(false);
    expect(store.state.error).toEqual({ code: "deliverFailed", detail: "no-agent" });
  });

  it("subscribes to reviews:changed and reloads the list and matching thread", async () => {
    const thread = { pr, link: { kind: "none" }, comments: [comment] };
    const client = fakeClient([ok(thread)]);
    const store = createReviewsStore({ client: client as never });
    await store.openThread("owner/jarvis#18");
    const stop = store.subscribe(() => {});
    expect(client.subscribe).toHaveBeenCalledWith("reviews:changed");
    client.call.mockClear();
    client.push("reviews:changed", "owner/jarvis#18");
    await Promise.resolve();
    const channels = client.call.mock.calls.map((call) => call[0]);
    expect(channels).toContain("reviews:list");
    expect(channels).toContain("reviews:thread");
    client.call.mockClear();
    client.push("reviews:changed", "other/repo#2");
    await Promise.resolve();
    expect(client.call.mock.calls.map((call) => call[0])).toEqual(["reviews:list"]);
    stop();
    expect(client.unsubscribe).toHaveBeenCalledWith("reviews:changed");
  });
});
