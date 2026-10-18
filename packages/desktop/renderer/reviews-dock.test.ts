// @vitest-environment jsdom
//
// The Terminal tab's Reviews dock and its PR link chip. What is under test:
// which comments the dock draws for the tab's linked PR, that every comment
// body lands as text (never markup — it is someone else's words), and that
// the dock's and the chip's buttons reach the right reviews:* channel.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewListItem, ReviewThread } from "../src/review-service.js";
import {
  createLinkChip,
  createReviewsDock,
  linkedItemFor,
  type ReviewsDockApi,
} from "./reviews-dock.js";

const pr = {
  repo: "me/jarvis",
  number: 18,
  title: "Reviews",
  headRef: "feat/reviews",
  author: "me",
  url: "https://github.com/me/jarvis/pull/18",
  isDraft: false,
  role: "mine" as const,
};

function item(overrides: Partial<ReviewListItem> = {}): ReviewListItem {
  return {
    pr,
    link: { kind: "linked", paneKey: "tab-1", how: "auto" },
    queued: 1,
    delivered: 1,
    waitReason: "approval-prompt",
    lastActivity: 1,
    ...overrides,
  };
}

const thread: ReviewThread = {
  pr,
  link: { kind: "linked", paneKey: "tab-1", how: "auto" },
  waitReason: "approval-prompt",
  comments: [
    {
      prKey: "me/jarvis#18",
      state: "delivered",
      deliveredTo: "tab-1",
      deliveredAt: new Date(2026, 9, 18, 14, 6).getTime(),
      comment: {
        id: "1",
        kind: "issue",
        author: "colleague",
        isBot: false,
        body: "Can the poller skip draft PRs?",
        createdAt: 1,
      },
    },
    {
      prKey: "me/jarvis#18",
      state: "queued",
      comment: {
        id: "2",
        kind: "review-inline",
        author: "colleague",
        isBot: false,
        body: '<img src=x onerror="alert(1)">Nit: rename tick to pollOnce.',
        path: "poller.ts",
        line: 88,
        createdAt: 2,
      },
    },
  ],
};

function api(): ReviewsDockApi & { [K in keyof ReviewsDockApi]: ReturnType<typeof vi.fn> } {
  return {
    reviewsList: vi.fn(async () => [item()]),
    reviewsThread: vi.fn(async () => thread),
    reviewsLink: vi.fn(async () => {}),
    reviewsPause: vi.fn(async () => {}),
    reviewsDeliverNow: vi.fn(async () => ({ sent: true as const })),
  };
}

const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("linkedItemFor", () => {
  it("finds the PR linked to any pane of the tab, by tab id or split key", () => {
    const linked = item({ link: { kind: "linked", paneKey: "tab-2:p1", how: "manual" } });
    expect(linkedItemFor([item(), linked], "tab-2")).toBe(linked);
    expect(linkedItemFor([item()], "tab-1")?.pr.number).toBe(18);
    expect(linkedItemFor([item({ link: { kind: "none" } })], "tab-1")).toBeUndefined();
    // "tab-10" is not a pane of "tab-1".
    expect(
      linkedItemFor([item({ link: { kind: "linked", paneKey: "tab-10", how: "auto" } })], "tab-1"),
    ).toBeUndefined();
  });
});

describe("the reviews dock", () => {
  it("renders delivered and queued comments, bodies as text only", async () => {
    const fake = api();
    const dock = createReviewsDock({ api: fake });
    document.body.append(dock.element);
    dock.open();
    await dock.setItem(item());

    const rows = dock.element.querySelectorAll(".reviews-dock__comment");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.classList.contains("reviews-dock__comment--delivered")).toBe(true);
    expect(rows[0]?.textContent).toContain("✓ delivered 14:06");
    expect(rows[1]?.classList.contains("reviews-dock__comment--queued")).toBe(true);
    expect(rows[1]?.textContent).toContain("poller.ts:88");
    expect(rows[1]?.textContent).toContain("queued");
    // Untrusted: the markup is shown, never parsed.
    expect(dock.element.querySelector("img")).toBeNull();
    expect(rows[1]?.querySelector("p")?.textContent).toBe(
      '<img src=x onerror="alert(1)">Nit: rename tick to pollOnce.',
    );
    expect(dock.element.textContent).toContain("PR #18");
    expect(dock.element.querySelector(".reviews-dock__wait")?.textContent).toContain("y/n");
  });

  it("Deliver now calls reviews:deliverNow for the PR and re-reads the thread", async () => {
    const fake = api();
    const dock = createReviewsDock({ api: fake });
    dock.open();
    await dock.setItem(item());
    fake.reviewsThread.mockClear();

    const button = dock.element.querySelector<HTMLButtonElement>(".reviews-dock__deliver");
    expect(button).not.toBeNull();
    button?.click();
    await settle();

    expect(fake.reviewsDeliverNow).toHaveBeenCalledWith("me/jarvis#18");
    expect(fake.reviewsThread).toHaveBeenCalledWith("me/jarvis#18");
  });

  it("says why when Deliver now could not send", async () => {
    const fake = api();
    fake.reviewsDeliverNow.mockResolvedValue({ sent: false, wait: "no-agent" });
    fake.reviewsThread.mockResolvedValue({ ...thread, waitReason: null });
    const dock = createReviewsDock({ api: fake });
    dock.open();
    await dock.setItem(item({ waitReason: null }));
    dock.element.querySelector<HTMLButtonElement>(".reviews-dock__deliver")?.click();
    await settle();
    await settle();

    expect(dock.element.querySelector(".reviews-dock__wait")?.textContent).toMatch(/agent/i);
  });

  it("shows an empty state with no linked PR, and never asks for a thread", async () => {
    const fake = api();
    const dock = createReviewsDock({ api: fake });
    dock.open();
    await dock.setItem(undefined);
    expect(dock.element.querySelector(".reviews-dock__empty")).not.toBeNull();
    expect(fake.reviewsThread).not.toHaveBeenCalled();
  });

  it("starts closed and reports open/close through onToggle", () => {
    const onToggle = vi.fn();
    const dock = createReviewsDock({ api: api(), onToggle });
    expect(dock.element.hidden).toBe(true);
    dock.toggle();
    expect(dock.isOpen()).toBe(true);
    expect(onToggle).toHaveBeenLastCalledWith(true);
    dock.toggle();
    expect(onToggle).toHaveBeenLastCalledWith(false);
  });
});

describe("the PR link chip", () => {
  function openMenu(chip: ReturnType<typeof createLinkChip>): HTMLElement {
    chip.element.querySelector<HTMLButtonElement>(".reviews-chip")?.click();
    const menu = chip.element.querySelector<HTMLElement>("[role=menu]");
    if (menu === null || menu.hidden) throw new Error("menu did not open");
    return menu;
  }

  it("reads PR #n · linked and says how it was linked", () => {
    const chip = createLinkChip({ api: api(), paneKey: "tab-1" });
    chip.update(item(), [item()]);
    expect(chip.element.querySelector(".reviews-chip")?.textContent).toBe("PR #18 · linked ▾");
    expect(openMenu(chip).textContent).toContain("Auto-linked: branch matches PR #18");
  });

  it("Unlink calls reviews:link(prKey, null)", async () => {
    const fake = api();
    const chip = createLinkChip({ api: fake, paneKey: "tab-1" });
    chip.update(item(), [item()]);
    const unlink = [...openMenu(chip).querySelectorAll("button")].find(
      (b) => b.textContent === "Unlink",
    );
    unlink?.click();
    await settle();
    expect(fake.reviewsLink).toHaveBeenCalledWith("me/jarvis#18", null);
  });

  it("Pause delivery calls reviews:pause for the pane", async () => {
    const fake = api();
    const chip = createLinkChip({ api: fake, paneKey: "tab-1" });
    chip.update(item(), [item()]);
    [...openMenu(chip).querySelectorAll("button")]
      .find((b) => b.textContent === "Pause delivery")
      ?.click();
    await settle();
    expect(fake.reviewsPause).toHaveBeenCalledWith("tab-1", true);
  });

  it("links the pane to another PR picked from reviews:list", async () => {
    const fake = api();
    const other = item({
      pr: { ...pr, number: 21, title: "Other <b>thing</b>" },
      link: { kind: "none" },
    });
    const chip = createLinkChip({ api: fake, paneKey: "tab-1" });
    chip.update(item(), [item(), other]);
    const menu = openMenu(chip);
    [...menu.querySelectorAll("button")]
      .find((b) => b.textContent === "Link to another PR…")
      ?.click();
    const choices = [...menu.querySelectorAll<HTMLButtonElement>(".reviews-chip__pr")];
    expect(choices).toHaveLength(1);
    expect(menu.querySelector("b")).toBeNull();
    choices[0]?.click();
    await settle();
    expect(fake.reviewsLink).toHaveBeenCalledWith("me/jarvis#21", "tab-1");
  });

  it("hides itself with no linked PR", () => {
    const chip = createLinkChip({ api: api(), paneKey: "tab-1" });
    chip.update(undefined, []);
    expect(chip.element.hidden).toBe(true);
  });
});
