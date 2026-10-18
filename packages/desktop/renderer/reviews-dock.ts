// The Terminal tab's Reviews dock and its PR link chip (Reviews, Task 12).
//
// The dock sits beside the Plan panel, one per tab, and shows the comments
// of whichever PR is linked to one of the tab's panes: what was already
// pasted into the session, what is still queued, and — when something is
// waiting — why. The chip sits in the linked pane's own chip row and is the
// way to change that link.
//
// Comment bodies, authors, paths and PR titles are other people's text:
// every one of them lands through textContent, never markup. There is no
// innerHTML anywhere in this file.
import type { RendererApi } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import type { ReviewListItem, ReviewThread, ReviewWaitReason } from "../src/review-service.js";

export type ReviewsDockApi = Pick<
  RendererApi,
  "reviewsList" | "reviewsThread" | "reviewsLink" | "reviewsPause" | "reviewsDeliverNow"
>;

type QueuedComment = ReviewThread["comments"][number];

/** `owner/name#n` — the renderer may not value-import core's prKey. */
export function prKeyOf(item: Pick<ReviewListItem, "pr">): string {
  return `${item.pr.repo}#${item.pr.number}`;
}

/** Whether `paneKey` ("tab-1" or "tab-1:p2") is one of `tabId`'s panes. */
export function paneOfTab(paneKey: string, tabId: string): boolean {
  return paneKey === tabId || paneKey.startsWith(`${tabId}:`);
}

/** The PR linked to any pane of `tabId`, first one wins. */
export function linkedItemFor(
  items: readonly ReviewListItem[],
  tabId: string,
): ReviewListItem | undefined {
  return items.find((item) => item.link.kind === "linked" && paneOfTab(item.link.paneKey, tabId));
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ------------------------------------------------------------------ dock

export type ReviewsDockDeps = {
  api: ReviewsDockApi;
  language?: "ar" | "en";
  /** After every open/close — the caller refits its terminals. */
  onToggle?: (open: boolean) => void;
  /** "Open in Reviews": the top-nav Reviews page, on this PR. */
  onOpenInReviews?: (prKey: string) => void;
};

export type ReviewsDock = {
  element: HTMLElement;
  isOpen(): boolean;
  open(): void;
  close(): void;
  toggle(): void;
  /** The tab's linked PR (or none); re-reads its thread when open. */
  setItem(item: ReviewListItem | undefined): Promise<void>;
  /** Re-reads the current PR's thread, if the dock is open. */
  refresh(): Promise<void>;
  dispose(): void;
};

export function createReviewsDock(deps: ReviewsDockDeps): ReviewsDock {
  const language = deps.language ?? PRIMARY_LANGUAGE;
  const root = el("aside", "reviews-dock");
  root.hidden = true;
  root.setAttribute("aria-label", MESSAGES.reviewsDockToggleText(language));

  let item: ReviewListItem | undefined;
  let thread: ReviewThread | undefined;
  /** A Deliver-now refusal, shown until the next successful read. */
  let refusal: ReviewWaitReason | undefined;
  let requestId = 0;
  let disposed = false;

  function setOpen(open: boolean): void {
    if (root.hidden === !open) return;
    root.hidden = !open;
    deps.onToggle?.(open);
    if (open) void refresh();
  }

  async function refresh(): Promise<void> {
    if (disposed) return;
    const current = item;
    if (current === undefined) {
      thread = undefined;
      render();
      return;
    }
    if (root.hidden) {
      render();
      return;
    }
    const id = ++requestId;
    let next: ReviewThread | undefined;
    try {
      next = await deps.api.reviewsThread(prKeyOf(current));
    } catch {
      next = undefined;
    }
    if (id !== requestId || disposed) return; // superseded
    thread = next;
    render();
  }

  async function deliverNow(prKey: string): Promise<void> {
    try {
      const outcome = await deps.api.reviewsDeliverNow(prKey);
      refusal = outcome.sent || outcome.wait === "nothing" ? undefined : outcome.wait;
    } catch {
      refusal = undefined;
    }
    await refresh();
  }

  function stateLabel(comment: QueuedComment): string {
    switch (comment.state) {
      case "delivered":
        return MESSAGES.reviewsDockStateDelivered(
          comment.deliveredAt === undefined ? "" : hhmm(comment.deliveredAt),
          language,
        ).trimEnd();
      case "queued":
        return MESSAGES.reviewsDockStateQueued(language);
      case "own":
        return MESSAGES.reviewsDockStateOwn(language);
      default:
        return MESSAGES.reviewsDockStateHistory(language);
    }
  }

  function renderComment(prKey: string, entry: QueuedComment): HTMLElement {
    const row = el("div", `reviews-dock__comment reviews-dock__comment--${entry.state}`);
    const meta = el("div", "reviews-dock__meta");
    meta.append(el("span", "reviews-dock__author", `@${entry.comment.author}`));
    if (entry.comment.path !== undefined) {
      const where =
        entry.comment.line === undefined
          ? entry.comment.path
          : `${entry.comment.path}:${entry.comment.line}`;
      meta.append(el("span", "reviews-dock__path", where));
    }
    meta.append(el("span", "reviews-dock__spacer"));
    meta.append(el("span", "reviews-dock__state", stateLabel(entry)));
    row.append(meta, el("p", "reviews-dock__body", entry.comment.body));
    if (entry.state === "queued") {
      const button = el(
        "button",
        "reviews-dock__deliver",
        MESSAGES.reviewsDockDeliverNow(language),
      );
      button.type = "button";
      button.addEventListener("click", () => void deliverNow(prKey));
      row.append(button);
    }
    return row;
  }

  function render(): void {
    root.replaceChildren();
    const header = el("div", "reviews-dock__header");
    const close = el("button", "reviews-dock__close", "×");
    close.type = "button";
    close.title = MESSAGES.reviewsDockClose(language);
    close.setAttribute("aria-label", MESSAGES.reviewsDockClose(language));
    close.addEventListener("click", () => setOpen(false));

    const current = item;
    if (current === undefined) {
      header.append(
        el("h2", "reviews-dock__title", MESSAGES.reviewsDockToggleText(language)),
        el("span", "reviews-dock__spacer"),
        close,
      );
      const empty = el("div", "reviews-dock__empty");
      empty.append(
        el("p", "reviews-dock__empty-title", MESSAGES.reviewsDockEmpty(language)),
        el("p", "reviews-dock__empty-hint", MESSAGES.reviewsDockEmptyHint(language)),
      );
      root.append(header, empty);
      return;
    }

    const prKey = prKeyOf(current);
    const open = el("button", "reviews-dock__open", MESSAGES.reviewsDockOpenInReviews(language));
    open.type = "button";
    open.addEventListener("click", () => deps.onOpenInReviews?.(prKey));
    header.append(
      el("h2", "reviews-dock__title", MESSAGES.reviewsDockHeading(current.pr.number, language)),
      el("span", "reviews-dock__spacer"),
      open,
      close,
    );
    root.append(header);

    const comments = thread?.comments ?? [];
    const wait = refusal ?? thread?.waitReason ?? current.waitReason ?? null;
    const hasQueued = comments.some((c) => c.state === "queued") || current.queued > 0;
    if (wait !== null && (hasQueued || refusal !== undefined)) {
      root.append(el("div", "reviews-dock__wait", MESSAGES.reviewsDockWait(wait, language)));
    }

    const list = el("div", "reviews-dock__list");
    if (comments.length === 0) {
      list.append(el("p", "reviews-dock__none", MESSAGES.reviewsDockNoComments(language)));
    }
    for (const entry of comments) list.append(renderComment(prKey, entry));
    root.append(list);
  }

  render();

  return {
    element: root,
    isOpen: () => !root.hidden,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!!root.hidden),
    async setItem(next) {
      const changedPr =
        (next === undefined ? "" : prKeyOf(next)) !== (item === undefined ? "" : prKeyOf(item));
      item = next;
      if (changedPr) {
        thread = undefined;
        refusal = undefined;
      }
      await refresh();
    },
    refresh,
    dispose() {
      disposed = true;
      root.remove();
    },
  };
}

// ------------------------------------------------------------- link chip

export type LinkChipDeps = {
  api: ReviewsDockApi;
  /** The pane this chip's row belongs to — what Pause and re-link act on. */
  paneKey: string;
  language?: "ar" | "en";
};

export type LinkChip = {
  element: HTMLElement;
  /** `item` is the PR linked to this pane (none hides the chip); `all` is
   *  every PR reviews:list knows — the "Link to another PR…" choices. */
  update(
    item: ReviewListItem | undefined,
    all: readonly ReviewListItem[],
    paused?: readonly string[],
  ): void;
  dispose(): void;
};

export function createLinkChip(deps: LinkChipDeps): LinkChip {
  const language = deps.language ?? PRIMARY_LANGUAGE;
  const wrap = el("span", "reviews-chip-wrap");
  wrap.hidden = true;
  const button = el("button", "terminal-chip reviews-chip");
  button.type = "button";
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  const menu = el("div", "reviews-chip__menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", MESSAGES.reviewsDockChipMenu(language));
  menu.hidden = true;
  wrap.append(button, menu);

  let item: ReviewListItem | undefined;
  let all: readonly ReviewListItem[] = [];

  let pausedPanes: readonly string[] = [];
  const paused = (): boolean => pausedPanes.includes(deps.paneKey);

  function closeMenu(): void {
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey, true);
  }
  function onOutside(event: Event): void {
    if (event.target instanceof Node && wrap.contains(event.target)) return;
    closeMenu();
  }
  function onKey(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    closeMenu();
    button.focus();
  }

  function menuItem(text: string, onClick: () => void, extra = ""): HTMLButtonElement {
    const entry = el("button", `reviews-chip__item${extra === "" ? "" : ` ${extra}`}`, text);
    entry.type = "button";
    entry.setAttribute("role", "menuitem");
    entry.addEventListener("click", onClick);
    return entry;
  }

  function act(call: () => Promise<unknown>): void {
    closeMenu();
    void call().catch(() => {
      // The next reviews:changed push redraws whatever is true now.
    });
  }

  function renderMain(): void {
    const current = item;
    menu.replaceChildren();
    if (current === undefined || current.link.kind !== "linked") return;
    menu.append(
      el(
        "div",
        "reviews-chip__how",
        MESSAGES.reviewsDockChipHow(current.link.how, current.pr.number, language),
      ),
      menuItem(MESSAGES.reviewsDockChipLinkOther(language), renderPicker),
      menuItem(MESSAGES.reviewsDockChipPause(paused(), language), () =>
        act(() => deps.api.reviewsPause(deps.paneKey, !paused())),
      ),
      menuItem(
        MESSAGES.reviewsDockChipUnlink(language),
        () => act(() => deps.api.reviewsLink(prKeyOf(current), null)),
        "reviews-chip__item--danger",
      ),
    );
  }

  function renderPicker(): void {
    const current = item;
    menu.replaceChildren();
    const others = all.filter(
      (candidate) => current === undefined || prKeyOf(candidate) !== prKeyOf(current),
    );
    if (others.length === 0) {
      menu.append(el("div", "reviews-chip__how", MESSAGES.reviewsDockChipNoOther(language)));
      return;
    }
    for (const other of others) {
      const key = prKeyOf(other);
      menu.append(
        menuItem(
          `#${other.pr.number} ${other.pr.title} (${other.pr.repo})`,
          () =>
            act(async () => {
              if (current?.link.kind === "linked" && current.link.paneKey === deps.paneKey) {
                await deps.api.reviewsLink(prKeyOf(current), null);
              }
              await deps.api.reviewsLink(key, deps.paneKey);
            }),
          "reviews-chip__pr",
        ),
      );
    }
  }

  button.addEventListener("click", () => {
    if (!menu.hidden) {
      closeMenu();
      return;
    }
    renderMain();
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  });

  return {
    element: wrap,
    update(next, nextAll, nextPaused = []) {
      pausedPanes = nextPaused;
      item = next;
      all = nextAll;
      if (next === undefined || next.link.kind !== "linked") {
        wrap.hidden = true;
        closeMenu();
        return;
      }
      wrap.hidden = false;
      button.textContent = MESSAGES.reviewsDockChipLabel(next.pr.number, paused(), language);
      button.classList.toggle("reviews-chip--paused", paused());
      if (!menu.hidden) renderMain();
    },
    dispose() {
      closeMenu();
      wrap.remove();
    },
  };
}

// --------------------------------------------------------------- tab badge

/** Puts (or clears) the `PR #n` badge on a Workspace tab, by its id —
 *  workspace.ts tags each tab element with data-tab-id. Idempotent: a tab
 *  whose element was rebuilt simply gets a fresh badge on the next call. */
export function applyTabPrBadge(tabId: string, number: number | undefined): void {
  const selector = `.workspace-tab[data-tab-id="${CSS.escape(tabId)}"]`;
  const tab = document.querySelector<HTMLElement>(selector);
  if (tab === null) return;
  let badge = tab.querySelector<HTMLElement>(".workspace-tab-pr");
  if (number === undefined) {
    badge?.remove();
    return;
  }
  if (badge === null) {
    badge = el("span", "workspace-tab-pr");
    const close = tab.querySelector(".workspace-tab-close");
    if (close === null) tab.append(badge);
    else tab.insertBefore(badge, close);
  }
  badge.textContent = MESSAGES.reviewsDockTabBadge(number, PRIMARY_LANGUAGE);
}
