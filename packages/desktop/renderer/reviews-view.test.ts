// @vitest-environment jsdom
//
// The Reviews page (Task 11). The harness lays down the page's own markup
// straight out of index.html — the region between its "Reviews view"
// markers plus the nav button — so the ids this module looks up and the ids
// the page ships with can never drift apart, then drives the module through
// a fake of the reviews:* bridge members only.
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkResult, PullRequest, QueuedComment, ReviewComment } from "@jarvis/core";
import type { ReviewListItem, ReviewStatus, ReviewThread } from "../src/review-service.js";
import { MESSAGES } from "../src/messages.js";
import {
  initReviews,
  listTerminalPanes,
  REVIEW_REPLY_MAX,
  REVIEW_WAIT_LABEL_KEYS,
  type ReviewsApi,
} from "./reviews-view.js";

// Relative to the repository root, where vitest runs — jsdom's
// import.meta.url is not a file: URL (app.test.ts reads styles.css the same way).
const html = readFileSync("packages/desktop/renderer/index.html", "utf8");

function region(start: string, end: string): string {
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from === -1 || to === -1) throw new Error(`index.html has no ${start} … ${end} region`);
  return html.slice(from, to + end.length);
}

function navButton(): string {
  const match = /<button id="nav-reviews"[\s\S]*?<\/button>/.exec(html);
  if (match === null) throw new Error("index.html has no #nav-reviews button");
  return match[0];
}

const PR: PullRequest = {
  repo: "mm/jarvis",
  number: 18,
  title: "PR comment listener",
  headRef: "feat/reviews",
  author: "mm",
  url: "https://github.com/mm/jarvis/pull/18",
  isDraft: false,
  role: "mine",
};
const KEY = "mm/jarvis#18";
const LINKED: LinkResult = { kind: "linked", paneKey: "tab-1", how: "auto" };

function comment(over: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: "c1",
    kind: "issue",
    author: "colleague",
    isBot: false,
    body: "Can the poller skip draft PRs?",
    createdAt: Date.UTC(2026, 9, 18, 14, 5),
    ...over,
  };
}

function queued(state: QueuedComment["state"], over: Partial<ReviewComment> = {}): QueuedComment {
  return { prKey: KEY, comment: comment(over), state };
}

function item(over: Partial<ReviewListItem> = {}): ReviewListItem {
  return {
    pr: PR,
    link: LINKED,
    queued: 1,
    delivered: 0,
    waitReason: null,
    lastActivity: Date.now() - 60_000,
    ...over,
  };
}

const OK_STATUS: ReviewStatus = {
  paused: [],
  repos: [],
  gh: { kind: "ok", login: "mmAbdelhay" },
  enabled: true,
  repoErrors: {},
};

function fakeApi(opts: { status?: ReviewStatus; list?: ReviewListItem[]; thread?: ReviewThread }) {
  let onChanged: (prKey: string | null) => void = () => {};
  const api = {
    reviewsStatus: vi.fn<ReviewsApi["reviewsStatus"]>(async () => opts.status ?? OK_STATUS),
    reviewsList: vi.fn<ReviewsApi["reviewsList"]>(async () => opts.list ?? [item()]),
    reviewsThread: vi.fn<ReviewsApi["reviewsThread"]>(async () => opts.thread),
    reviewsReply: vi.fn<ReviewsApi["reviewsReply"]>(async (_k, body) =>
      comment({ id: "r1", body }),
    ),
    reviewsLink: vi.fn<ReviewsApi["reviewsLink"]>(async () => {}),
    reviewsDeliverNow: vi.fn<ReviewsApi["reviewsDeliverNow"]>(async () => ({
      sent: true as const,
    })),
    reviewsSendReview: vi.fn<ReviewsApi["reviewsSendReview"]>(async () => ({
      sent: true as const,
    })),
    reviewsPostSummary: vi.fn<ReviewsApi["reviewsPostSummary"]>(async () => ({
      sent: true as const,
    })),
    reviewsPollNow: vi.fn<ReviewsApi["reviewsPollNow"]>(async () => {}),
    reviewsRequeue: vi.fn<ReviewsApi["reviewsRequeue"]>(async () => true),
    reviewsOpenOnGithub: vi.fn<ReviewsApi["reviewsOpenOnGithub"]>(async () => {}),
    onReviewsChanged: vi.fn<ReviewsApi["onReviewsChanged"]>((cb) => {
      onChanged = cb;
    }),
    changed: (prKey: string | null) => onChanged(prKey),
  };
  return api;
}

type Fake = ReturnType<typeof fakeApi>;

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const panes = [
  { paneKey: "tab-1", label: "jarvis-reviews — Terminal" },
  { paneKey: "tab-2", label: "jarvis — Terminal" },
];

async function start(api: Fake, openPane = vi.fn()) {
  const view = initReviews({
    api,
    panes: async () => panes,
    openPane,
  });
  await view.refresh();
  await flush();
  return { view, openPane };
}

function composerField(): HTMLTextAreaElement {
  return document.getElementById("reviews-reply-input") as HTMLTextAreaElement;
}

function type(field: HTMLTextAreaElement, value: string): void {
  field.value = value;
  field.dispatchEvent(new Event("input"));
}

function text(id: string): string {
  return document.getElementById(id)?.textContent ?? "";
}

beforeEach(() => {
  document.body.innerHTML = `<div class="nav">${navButton()}</div>${region(
    "<!-- Reviews view -->",
    "<!-- /Reviews view -->",
  )}`;
});

describe("Reviews page — list", () => {
  it("draws the PULL REQUEST / STATE / LAST table with one row per PR", async () => {
    const api = fakeApi({
      list: [
        item(),
        item({
          pr: { ...PR, number: 16, title: "Mobile home terminal" },
          queued: 0,
          delivered: 2,
        }),
      ],
    });
    await start(api);

    const list = document.getElementById("reviews-list");
    expect(list?.textContent).toContain(MESSAGES.reviewsColPr("en"));
    expect(list?.textContent).toContain(MESSAGES.reviewsColState("en"));
    expect(list?.textContent).toContain(MESSAGES.reviewsColLast("en"));
    const rows = list?.querySelectorAll(".reviews-row") ?? [];
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain("#18");
    expect(rows[0]?.textContent).toContain(MESSAGES.reviewsStateQueued(1, "en"));
    expect(rows[0]?.textContent).toContain(
      MESSAGES.reviewsChipLinked("jarvis-reviews — Terminal", "en"),
    );
    expect(rows[1]?.textContent).toContain(MESSAGES.reviewsStateDelivered("en"));
  });

  it("shows the queued total as the nav badge", async () => {
    const api = fakeApi({
      list: [item({ queued: 2 }), item({ pr: { ...PR, number: 3 }, queued: 1 })],
    });
    await start(api);

    const badge = document.getElementById("nav-reviews-count");
    expect(badge?.hidden).toBe(false);
    expect(badge?.textContent).toBe("3");
  });

  it("filters rows by the search box", async () => {
    const api = fakeApi({
      list: [item(), item({ pr: { ...PR, number: 21, title: "Docker logs" } })],
    });
    await start(api);
    const search = document.getElementById("reviews-search") as HTMLInputElement;
    search.value = "docker";
    search.dispatchEvent(new Event("input"));

    const rows = document.querySelectorAll("#reviews-list .reviews-row");
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain("#21");
  });

  it("shows the gh setup state instead of the board when gh is not ok", async () => {
    const api = fakeApi({
      status: { gh: { kind: "logged-out" }, enabled: true, repoErrors: {}, paused: [], repos: [] },
    });
    await start(api);

    expect(document.getElementById("reviews-setup")?.hidden).toBe(false);
    expect(document.getElementById("reviews-board")?.hidden).toBe(true);
    expect(text("reviews-setup")).toContain(MESSAGES.reviewsSetupLoggedOut("en"));
    expect(text("reviews-setup")).toContain(MESSAGES.reviewsSetupLoggedOutHint("en"));
  });

  it("re-reads the list and the open thread on reviews:changed", async () => {
    const api = fakeApi({ thread: { pr: PR, link: LINKED, waitReason: null, comments: [] } });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();
    const lists = api.reviewsList.mock.calls.length;
    const threads = api.reviewsThread.mock.calls.length;

    api.changed(KEY);
    await flush();

    expect(api.reviewsList.mock.calls.length).toBeGreaterThan(lists);
    expect(api.reviewsThread.mock.calls.length).toBeGreaterThan(threads);
  });
});

describe("Reviews page — thread", () => {
  it("never turns a comment body into markup", async () => {
    const evil = `<img src=x onerror="window.__pwned=1">`;
    const api = fakeApi({
      thread: {
        pr: PR,
        link: LINKED,
        waitReason: null,
        comments: [queued("queued", { body: evil })],
      },
    });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();

    expect(document.querySelector("img")).toBeNull();
    expect(text("reviews-thread")).toContain(evil);
  });

  it("marks each comment with its state's border class", async () => {
    const api = fakeApi({
      thread: {
        pr: PR,
        link: LINKED,
        waitReason: null,
        comments: [
          queued("delivered", { id: "a" }),
          queued("own", { id: "b", author: "mmAbdelhay" }),
          queued("queued", { id: "c" }),
        ],
      },
    });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();

    const articles = [...document.querySelectorAll("#reviews-thread .reviews-comment")];
    expect(articles.map((a) => a.className)).toEqual([
      "reviews-comment reviews-comment--delivered",
      "reviews-comment reviews-comment--own",
      "reviews-comment reviews-comment--queued",
    ]);
  });

  it.each(REVIEW_WAIT_LABEL_KEYS.filter((k) => k !== "nothing"))(
    "renders the %s wait reason's label in the link bar",
    async (reason) => {
      const api = fakeApi({
        thread: {
          pr: PR,
          link: LINKED,
          waitReason: reason as ReviewThread["waitReason"],
          comments: [queued("queued")],
        },
      });
      const { view } = await start(api);
      await view.open(KEY);
      await flush();

      expect(text("reviews-thread")).toContain(MESSAGES.reviewsWait(reason, "en"));
    },
  );

  it("has an ar and an en label for every wait reason, including unsupported agents", () => {
    for (const reason of REVIEW_WAIT_LABEL_KEYS) {
      expect(MESSAGES.reviewsWait(reason, "en")).not.toBe(reason);
      expect(MESSAGES.reviewsWait(reason, "ar")).not.toBe(MESSAGES.reviewsWait(reason, "en"));
    }
    expect(MESSAGES.reviewsWait("unsupported", "en")).toBe("agent not supported for auto-delivery");
  });

  it("shows why Deliver now did not send", async () => {
    const api = fakeApi({
      thread: { pr: PR, link: LINKED, waitReason: null, comments: [queued("queued")] },
    });
    api.reviewsDeliverNow.mockResolvedValue({ sent: false, wait: "approval-prompt" });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();

    const button = [...document.querySelectorAll<HTMLButtonElement>("#reviews-thread button")].find(
      (b) => b.textContent === MESSAGES.reviewsDeliverNow("en"),
    );
    button?.click();
    await flush();

    expect(api.reviewsDeliverNow).toHaveBeenCalledWith(KEY);
    expect(text("reviews-notice")).toBe(
      MESSAGES.reviewsNotSent(MESSAGES.reviewsWait("approval-prompt", "en"), "en"),
    );
  });

  it("offers Send to session on a first-run history comment", async () => {
    const api = fakeApi({
      thread: {
        pr: PR,
        link: LINKED,
        waitReason: null,
        comments: [queued("history", { id: "h1" })],
      },
    });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();

    const send = [...document.querySelectorAll<HTMLButtonElement>("#reviews-thread button")].find(
      (b) => b.textContent === MESSAGES.reviewsSendToSession("en"),
    );
    expect(send).toBeDefined();
    send?.click();
    await flush();

    expect(api.reviewsRequeue).toHaveBeenCalledWith(KEY, "h1");
  });

  it("asks which pane to use for an ambiguous link", async () => {
    const api = fakeApi({
      thread: {
        pr: PR,
        link: { kind: "ambiguous", paneKeys: ["tab-1", "tab-2"] },
        waitReason: "ambiguous",
        comments: [queued("queued")],
      },
    });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();

    const picker = document.querySelector<HTMLSelectElement>(
      "#reviews-thread select.reviews-picker",
    );
    expect(picker).not.toBeNull();
    const values = [...(picker?.options ?? [])].map((o) => o.value).filter((v) => v !== "");
    expect(values).toEqual(["tab-1", "tab-2"]);
    if (picker !== null) {
      picker.value = "tab-2";
      picker.dispatchEvent(new Event("change"));
    }
    await flush();

    expect(api.reviewsLink).toHaveBeenCalledWith(KEY, "tab-2");
  });

  it("Change link lists the open panes and Unlink clears the link", async () => {
    const api = fakeApi({
      thread: { pr: PR, link: LINKED, waitReason: null, comments: [] },
    });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();

    const change = [...document.querySelectorAll<HTMLButtonElement>("#reviews-thread button")].find(
      (b) => b.textContent === MESSAGES.reviewsChangeLink("en"),
    );
    change?.click();
    await flush();
    const picker = document.querySelector<HTMLSelectElement>(
      "#reviews-thread select.reviews-picker",
    );
    const labels = [...(picker?.options ?? [])].map((o) => o.textContent);
    expect(labels).toContain("jarvis — Terminal");
    expect(labels).toContain(MESSAGES.reviewsUnlink("en"));
    if (picker !== null) {
      picker.value = "__unlink";
      picker.dispatchEvent(new Event("change"));
    }
    await flush();

    expect(api.reviewsLink).toHaveBeenCalledWith(KEY, null);
  });

  it("Open tab focuses the linked pane", async () => {
    const api = fakeApi({ thread: { pr: PR, link: LINKED, waitReason: null, comments: [] } });
    const { view, openPane } = await start(api);
    await view.open(KEY);
    await flush();

    [...document.querySelectorAll<HTMLButtonElement>("#reviews-thread button")]
      .find((b) => b.textContent === MESSAGES.reviewsOpenTab("en"))
      ?.click();

    expect(openPane).toHaveBeenCalledWith("tab-1");
  });

  it("posts the composer's reply on GitHub", async () => {
    const api = fakeApi({ thread: { pr: PR, link: LINKED, waitReason: null, comments: [] } });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();

    type(composerField(), "Fixed in a1b2c3d\nAdded a test.");
    document
      .getElementById("reviews-reply")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(api.reviewsReply).toHaveBeenCalledWith(
      KEY,
      "Fixed in a1b2c3d\nAdded a test.",
      undefined,
    );
    expect(composerField().value).toBe("");
  });

  it("is a multi-line field: Enter is a newline, Cmd/Ctrl+Enter sends", async () => {
    const api = fakeApi({ thread: { pr: PR, link: LINKED, waitReason: null, comments: [] } });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();
    const field = composerField();
    expect(field.tagName).toBe("TEXTAREA");
    expect(field.dir).toBe("auto");
    type(field, "line one");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));
    await flush();
    expect(api.reviewsReply).not.toHaveBeenCalled();

    field.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, cancelable: true }),
    );
    await flush();
    expect(api.reviewsReply).toHaveBeenCalledWith(KEY, "line one", undefined);
  });

  it("keeps a reply draft per PR: it never follows you to another PR", async () => {
    const other = "mm/jarvis#16";
    const api = fakeApi({});
    api.reviewsThread.mockImplementation(async (key) => ({
      pr: key === other ? { ...PR, number: 16 } : PR,
      link: LINKED,
      waitReason: null,
      comments: [],
    }));
    const { view } = await start(api);
    await view.open(KEY);
    await flush();
    type(composerField(), "draft for 18");

    await view.open(other);
    await flush();
    expect(composerField().value).toBe("");
    document
      .getElementById("reviews-reply")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();
    expect(api.reviewsReply).not.toHaveBeenCalled();

    await view.open(KEY);
    await flush();
    expect(composerField().value).toBe("draft for 18");
  });

  it("refuses a reply longer than GitHub allows, before any IPC", async () => {
    const api = fakeApi({ thread: { pr: PR, link: LINKED, waitReason: null, comments: [] } });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();
    const field = composerField();
    expect(field.maxLength).toBe(REVIEW_REPLY_MAX);

    // A programmatic value bypasses maxLength, as a paste path might.
    type(field, "x".repeat(REVIEW_REPLY_MAX + 1));
    document
      .getElementById("reviews-reply")
      ?.dispatchEvent(new Event("submit", { cancelable: true }));
    await flush();

    expect(api.reviewsReply).not.toHaveBeenCalled();
    expect(text("reviews-notice")).toBe(MESSAGES.reviewsReplyTooLong(REVIEW_REPLY_MAX, "en"));
    expect(MESSAGES.reviewsReplyTooLong(REVIEW_REPLY_MAX, "ar")).not.toBe(
      MESSAGES.reviewsReplyTooLong(REVIEW_REPLY_MAX, "en"),
    );
  });

  it("Post session summary and Open on GitHub call their channels", async () => {
    const api = fakeApi({ thread: { pr: PR, link: LINKED, waitReason: null, comments: [] } });
    const { view } = await start(api);
    await view.open(KEY);
    await flush();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>("#reviews-thread button")];

    buttons.find((b) => b.textContent === MESSAGES.reviewsPostSummary("en"))?.click();
    buttons.find((b) => b.textContent === MESSAGES.reviewsOpenGithub("en"))?.click();
    await flush();

    expect(api.reviewsPostSummary).toHaveBeenCalledWith(KEY);
    expect(api.reviewsOpenOnGithub).toHaveBeenCalledWith(KEY);
    expect(text("reviews-notice")).toBe(MESSAGES.reviewsSent("en"));
  });
});

describe("listTerminalPanes", () => {
  it("lists every live pane of every Terminal tab, labelled by project and tab", async () => {
    const tab = (id: string, kind: string, title: string, customTitle?: string) =>
      ({ id, kind, project: "jarvis", title, customTitle }) as never;
    const result = await listTerminalPanes({
      workspaceSnapshot: async () => ({
        tabs: [
          tab("t1", "terminal", "zsh"),
          tab("t2", "web", "Docs"),
          tab("t3", "terminal", "", "agent"),
        ],
        activeTabId: undefined,
      }),
      terminalPanes: async (tabId: string) =>
        tabId === "t1"
          ? [
              { paneKey: "t1", exited: false },
              { paneKey: "t1:p2", exited: false },
              { paneKey: "t1:p3", exited: true },
            ]
          : [{ paneKey: tabId, exited: false }],
    });

    expect(result).toEqual([
      { paneKey: "t1", label: "jarvis — zsh · 1" },
      { paneKey: "t1:p2", label: "jarvis — zsh · 2" },
      { paneKey: "t3", label: "jarvis — agent" },
    ]);
  });
});
