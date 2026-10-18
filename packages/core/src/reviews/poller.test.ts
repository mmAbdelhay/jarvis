import { describe, expect, it, vi } from "vitest";
import { createReviewPoller, type ReviewEvent } from "./poller.js";
import {
  DEFAULT_REVIEWS_CONFIG,
  type PullRequest,
  type QueuedComment,
  type ReviewComment,
  type ReviewsGh,
  type ReviewsStore,
} from "./types.js";

const pr: PullRequest = {
  repo: "Acme/Repo",
  number: 1,
  title: "Fix",
  headRef: "fix",
  author: "me",
  url: "https://example.com/1",
  isDraft: false,
  role: "mine",
};
const comment = (id = "1", createdAt = 90, author = "other"): ReviewComment => ({
  id,
  createdAt,
  author,
  kind: "issue",
  isBot: false,
  body: "Please fix",
});
function setup(repos = ["acme/repo", "ACME/REPO"]) {
  let time = 100;
  let seeded = false;
  const cursors = new Map<string, { since: number; etag?: string }>();
  const entries = new Map<string, QueuedComment>();
  const notified = new Set<string>();
  const store: ReviewsStore = {
    cursor: vi.fn(async (key) => cursors.get(key)),
    setCursor: vi.fn(async (key, value) => {
      cursors.set(key, value);
    }),
    isFirstRun: vi.fn(async () => !seeded),
    markSeeded: vi.fn(async () => {
      seeded = true;
    }),
    upsertComments: vi.fn(async (key, comments, state) => {
      for (const c of comments) {
        const id = `${key}|${c.kind}|${c.id}`;
        const old = entries.get(id);
        entries.set(id, { prKey: key, comment: c, state: old?.state ?? state });
      }
    }),
    markOwn: vi.fn(async (key, c) => {
      const id = `${key}|${c.kind}|${c.id}`;
      if (!entries.has(id)) entries.set(id, { prKey: key, comment: c, state: "own" });
    }),
    listQueued: async (key) =>
      [...entries.values()].filter((e) => e.state === "queued" && (!key || key === e.prKey)),
    thread: async (key) => [...entries.values()].filter((e) => e.prKey === key),
    wasNotified: async (key) => notified.has(key),
    markNotified: async (key) => {
      notified.add(key);
    },
    markDelivered: async () => {},
    manualLinks: async () => new Map(),
    setManualLink: async () => {},
    paused: async () => new Set(),
    setPaused: async () => {},
    requeue: async () => false,
  };
  const gh: ReviewsGh = {
    status: vi.fn(async () => ({ kind: "ok" as const, login: "me" })),
    repoOf: async () => undefined,
    listPrs: vi.fn(async () => [pr]),
    listComments: vi.fn(async () => ({ kind: "ok" as const, comments: [comment()], etag: "v1" })),
    postComment: async () => comment(),
    replyToReviewComment: async () => comment(),
  };
  const events: ReviewEvent[] = [];
  const jobs: { fn: () => void; ms: number; cancel: ReturnType<typeof vi.fn> }[] = [];
  const cfg = { ...DEFAULT_REVIEWS_CONFIG, repos: { "ACME/REPO": true } };
  const poller = createReviewPoller({
    gh,
    store,
    config: () => cfg,
    repos: () => repos,
    now: () => time,
    onEvent: (e) => events.push(e),
    schedule: (fn, ms) => {
      const cancel = vi.fn();
      jobs.push({ fn, ms, cancel });
      return cancel;
    },
  });
  return {
    poller,
    gh,
    store,
    events,
    jobs,
    cfg,
    cursors,
    entries,
    setTime: (value: number) => {
      time = value;
    },
  };
}

describe("review poller", () => {
  it("seeds from GitHub and stores old comments as history without queuing", async () => {
    const t = setup();
    await t.poller.pollNow();
    expect(t.cursors.get("Acme/Repo#1")).toEqual({ since: 90, etag: "v1" });
    expect([...t.entries.values()].map((e) => e.state)).toEqual(["history"]);
    expect(await t.store.listQueued()).toEqual([]);
    expect(t.gh.listPrs).toHaveBeenCalledTimes(1);
  });
  it("queues a new comment once, emits its count, and never requeues edits", async () => {
    const t = setup();
    await t.poller.pollNow();
    vi.mocked(t.gh.listComments).mockResolvedValue({
      kind: "ok",
      comments: [comment(), comment("2", 110)],
    });
    t.setTime(120);
    await t.poller.pollNow();
    expect((await t.store.listQueued()).map((e) => e.comment.id)).toEqual(["2"]);
    expect(t.events.filter((e) => e.kind === "comments")).toEqual([
      { kind: "comments", prKey: "Acme/Repo#1", added: 1 },
    ]);
    const queued = t.entries.get("Acme/Repo#1|issue|2");
    if (queued) queued.state = "delivered";
    vi.mocked(t.gh.listComments).mockResolvedValue({
      kind: "ok",
      comments: [{ ...comment("2", 110), body: "Edited", updated_at: 130 } as ReviewComment],
    });
    await t.poller.pollNow();
    expect(await t.store.listQueued()).toEqual([]);
    expect(t.events.filter((e) => e.kind === "comments")).toHaveLength(1);
  });
  it("does not queue own or filtered comments, including late historical comments", async () => {
    const t = setup();
    await t.poller.pollNow();
    vi.mocked(t.gh.listComments).mockResolvedValue({
      kind: "ok",
      comments: [comment("2", 110, "ME"), { ...comment("3", 111), isBot: true }, comment("4", 80)],
    });
    await t.poller.pollNow();
    expect(await t.store.listQueued()).toEqual([]);
    expect(t.entries.get("Acme/Repo#1|issue|2")?.state).toBe("own");
  });
  it("logout emits status without list calls or store changes", async () => {
    const t = setup();
    await t.poller.pollNow();
    const before = [...t.entries];
    vi.mocked(t.gh.status).mockResolvedValue({ kind: "logged-out" });
    vi.mocked(t.gh.listPrs).mockClear();
    vi.mocked(t.gh.listComments).mockClear();
    vi.mocked(t.store.setCursor).mockClear();
    await t.poller.pollNow();
    expect(t.events.at(-1)).toEqual({ kind: "status", status: { kind: "logged-out" } });
    expect(t.gh.listPrs).not.toHaveBeenCalled();
    expect(t.gh.listComments).not.toHaveBeenCalled();
    expect(t.store.setCursor).not.toHaveBeenCalled();
    expect([...t.entries]).toEqual(before);
  });
  it("honours retryAt for the whole repo", async () => {
    const t = setup();
    vi.mocked(t.gh.listComments).mockResolvedValue({ kind: "rate-limited", retryAt: 200 });
    await t.poller.pollNow();
    t.setTime(199);
    await t.poller.pollNow();
    expect(t.gh.listPrs).toHaveBeenCalledTimes(1);
    t.setTime(200);
    await t.poller.pollNow();
    expect(t.gh.listPrs).toHaveBeenCalledTimes(2);
  });
  it("coalesces overlapping ticks", async () => {
    const t = setup();
    let release!: () => void;
    vi.mocked(t.gh.status).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { kind: "ok", login: "me" };
    });
    const first = t.poller.pollNow();
    const second = t.poller.pollNow();
    release();
    await Promise.all([first, second]);
    expect(t.gh.listPrs).toHaveBeenCalledTimes(1);
  });
  it("notifies a review request only once across ticks", async () => {
    const t = setup();
    vi.mocked(t.gh.listPrs).mockResolvedValue([{ ...pr, role: "review-requested" }]);
    await t.poller.pollNow();
    await t.poller.pollNow();
    expect(t.events.filter((e) => e.kind === "review-requested")).toHaveLength(1);
    expect(t.gh.listComments).not.toHaveBeenCalled();
    expect(t.events).toContainEqual({ kind: "prs", prs: [{ ...pr, role: "review-requested" }] });
  });
  it("doubles the scheduled interval below 0.1 and cancels on stop", async () => {
    const t = setup();
    vi.mocked(t.gh.listComments).mockResolvedValue({
      kind: "ok",
      comments: [],
      remainingRatio: 0.09,
    });
    t.poller.start();
    await t.poller.pollNow();
    expect(t.jobs.at(-1)?.ms).toBe(120000);
    t.poller.stop();
    expect(t.jobs.at(-1)?.cancel).toHaveBeenCalledOnce();
  });
  it("skips disabled repositories case insensitively and disabled polling", async () => {
    const t = setup();
    t.cfg.repos["ACME/REPO"] = false;
    await t.poller.pollNow();
    expect(t.gh.listPrs).not.toHaveBeenCalled();
    t.cfg.enabled = false;
    vi.mocked(t.gh.status).mockClear();
    await t.poller.pollNow();
    expect(t.gh.status).not.toHaveBeenCalled();
  });
  it.each(["gh", "store"])("isolates a %s failure to its repo", async (source) => {
    const t = setup(["broken/repo", "Acme/Repo"]);
    t.cursors.set("Acme/Repo#1", { since: 80 });
    if (source === "gh") vi.mocked(t.gh.listPrs).mockRejectedValueOnce(new Error("broken"));
    else vi.mocked(t.store.isFirstRun).mockRejectedValueOnce(new Error("broken"));
    await t.poller.pollNow();
    expect((await t.store.listQueued()).map((e) => e.comment.id)).toEqual(["1"]);
    expect(t.events).toContainEqual({ kind: "repo-error", repo: "broken/repo", message: "broken" });
    expect(t.events.at(-1)).toEqual({ kind: "prs", prs: [pr] });
  });
  it("queues on an already-cursored PR after a partial first tick", async () => {
    const t = setup();
    vi.mocked(t.gh.listPrs).mockResolvedValue([pr, { ...pr, number: 2 }]);
    vi.mocked(t.gh.listComments)
      .mockResolvedValueOnce({ kind: "ok", comments: [comment()] })
      .mockResolvedValueOnce({ kind: "rate-limited", retryAt: 200 });
    await t.poller.pollNow();
    t.setTime(200);
    vi.mocked(t.gh.listComments).mockResolvedValue({ kind: "ok", comments: [comment("new", 110)] });
    await t.poller.pollNow();
    expect((await t.store.listQueued("Acme/Repo#1")).map((e) => e.comment.id)).toEqual(["new"]);
  });
  it("uses persisted repo time for new and reopened PRs after restart", async () => {
    const t = setup();
    await t.poller.pollNow();
    const restarted = createReviewPoller({
      gh: t.gh,
      store: t.store,
      config: () => t.cfg,
      repos: () => [pr.repo],
      now: () => 999999,
      onEvent: () => {},
      schedule: () => () => {},
    });
    vi.mocked(t.gh.listPrs).mockResolvedValue([
      { ...pr, number: 2 },
      { ...pr, number: 3 },
    ]);
    vi.mocked(t.gh.listComments)
      .mockResolvedValueOnce({ kind: "ok", comments: [comment("new", 110)] })
      .mockResolvedValueOnce({ kind: "ok", comments: [comment("old", 80)] });
    await restarted.pollNow();
    expect((await t.store.listQueued()).map((e) => e.comment.id)).toEqual(["new"]);
    expect(t.entries.get("Acme/Repo#3|issue|old")?.state).toBe("history");
  });
  it("uses GitHub time and a five minute overlap despite local clock skew", async () => {
    const t = setup();
    t.setTime(1060000);
    vi.mocked(t.gh.listComments).mockResolvedValue({
      kind: "ok",
      comments: [comment("old", 1000000)],
    });
    await t.poller.pollNow();
    vi.mocked(t.gh.listComments).mockResolvedValue({
      kind: "ok",
      comments: [comment("new", 1001000)],
    });
    await t.poller.pollNow();
    expect(t.gh.listComments).toHaveBeenLastCalledWith(pr, { since: 700000 });
    expect((await t.store.listQueued()).map((e) => e.comment.id)).toEqual(["new"]);
    expect(t.cursors.get("Acme/Repo#1")?.since).toBe(1001000);
  });
  it("retains the last PR list while a repo is rate limited", async () => {
    const t = setup();
    vi.mocked(t.gh.listComments).mockResolvedValue({ kind: "rate-limited", retryAt: 200 });
    await t.poller.pollNow();
    await t.poller.pollNow();
    expect(t.events.at(-1)).toEqual({ kind: "prs", prs: [pr] });
  });
});
