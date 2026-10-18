import type { DeliveryWait, LinkResult, QueuedComment } from "@jarvis/core";
import type { RendererApi } from "../src/ipc.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";
import type { ReviewListItem, ReviewStatus, ReviewThread } from "../src/review-service.js";
import { detectLanguage, formatAgo } from "./format.js";

// The Reviews page (Task 11): every PR the poller knows on the left, the
// selected one's comments on the right, with its link to a Terminal pane
// and the actions that paste into it. Comment bodies, diff hunks, titles
// and logins all come from GitHub and are untrusted: no innerHTML anywhere
// in this file — every string goes in through textContent.

export type ReviewsApi = Pick<
  RendererApi,
  | "reviewsStatus"
  | "reviewsList"
  | "reviewsThread"
  | "reviewsReply"
  | "reviewsLink"
  | "reviewsDeliverNow"
  | "reviewsSendReview"
  | "reviewsPostSummary"
  | "reviewsPollNow"
  | "reviewsRequeue"
  | "reviewsOpenOnGithub"
  | "onReviewsChanged"
>;

export type ReviewsPane = { paneKey: string; label: string };

export type ReviewsViewDeps = {
  api: ReviewsApi;
  /** The open Terminal panes a PR can be linked to, labelled for people. */
  panes(): Promise<ReviewsPane[]>;
  /** Shows a Terminal pane (Workspace route, its tab active). */
  openPane(paneKey: string): void;
  now?(): number;
};

export type ReviewsView = {
  /** Re-reads status, the PR list and the open thread. */
  refresh(): Promise<void>;
  /** Selects a PR and reads its thread. */
  open(prKey: string): Promise<void>;
};

/** Every wait reason the page has a label for: core's DeliveryWait, plus
 *  "unsupported" (controller ruling — an agent whose idle state cannot be
 *  read, e.g. Copilot). */
export const REVIEW_WAIT_LABEL_KEYS: readonly (DeliveryWait | "unsupported")[] = [
  "no-link",
  "ambiguous",
  "no-agent",
  "approval-prompt",
  "busy",
  "typing",
  "batching",
  "paused",
  "nothing",
  "unsupported",
];

/** Waits that will not clear on their own: the user has to act. */
const STUCK: ReadonlySet<string> = new Set([
  "no-link",
  "ambiguous",
  "no-agent",
  "paused",
  "unsupported",
]);

const UNLINK = "__unlink";
/** GitHub's own limit on a comment body; longer is refused before IPC. */
export const REVIEW_REPLY_MAX = 65_536;
const L = PRIMARY_LANGUAGE;

const $ = (id: string): HTMLElement => {
  const element = document.getElementById(id);
  if (element === null) throw new Error(`Missing element #${id}`);
  return element;
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) setText(node, text);
  return node;
}

/** Text and direction together, so an Arabic title or comment reads RTL. */
function setText(node: HTMLElement, text: string): void {
  const language = detectLanguage(text);
  node.dir = language === "ar" ? "rtl" : "ltr";
  node.classList.toggle("arabic", language === "ar");
  node.textContent = text;
}

function button(text: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function dot(state: string): HTMLElement {
  return el("span", `reviews-dot reviews-dot--${state}`);
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function keyOf(item: { pr: { repo: string; number: number } }): string {
  return `${item.pr.repo}#${item.pr.number}`;
}

function repoName(repo: string): string {
  return repo.split("/").pop() ?? repo;
}

/** The STATE column: what the row's dot and words say. */
function stateOf(item: ReviewListItem): { kind: string; text: string } {
  if (item.queued > 0) {
    const stuck =
      item.link.kind !== "linked" || (item.waitReason !== null && STUCK.has(item.waitReason));
    return stuck
      ? { kind: "waiting", text: MESSAGES.reviewsStateWaiting(item.queued, L) }
      : { kind: "queued", text: MESSAGES.reviewsStateQueued(item.queued, L) };
  }
  if (item.pr.role === "review-requested") {
    return { kind: "review", text: MESSAGES.reviewsStateToReview(L) };
  }
  if (item.delivered > 0) return { kind: "delivered", text: MESSAGES.reviewsStateDelivered(L) };
  return { kind: "none", text: MESSAGES.reviewsStateNone(L) };
}

/** The live panes of every open Terminal tab, labelled "project — tab",
 *  with a pane number when a tab is split. */
export async function listTerminalPanes(
  api: Pick<RendererApi, "workspaceSnapshot" | "terminalPanes">,
): Promise<ReviewsPane[]> {
  const snapshot = await api.workspaceSnapshot();
  const result: ReviewsPane[] = [];
  for (const tab of snapshot.tabs) {
    if (tab.kind !== "terminal") continue;
    const name = tab.customTitle || tab.title || MESSAGES.reviewsPaneFallback(L);
    const live = (await api.terminalPanes(tab.id)).filter((pane) => !pane.exited);
    live.forEach((pane, index) => {
      const suffix = live.length > 1 ? ` · ${index + 1}` : "";
      result.push({ paneKey: pane.paneKey, label: `${tab.project} — ${name}${suffix}` });
    });
  }
  return result;
}

export function initReviews(deps: ReviewsViewDeps): ReviewsView {
  const { api } = deps;
  const now = deps.now ?? (() => Date.now());

  let status: ReviewStatus | undefined;
  let items: ReviewListItem[] = [];
  let selected: string | undefined;
  let thread: ReviewThread | undefined;
  let paneLabels = new Map<string, string>();
  let checkedAt: number | undefined;
  /** The review comment the composer answers, or top level. */
  let replyTo: { id: string; author: string } | undefined;
  /** Unsent reply text per PR, so a draft never follows the user to
   *  another PR and switching back restores it. */
  const drafts = new Map<string, string>();
  /** Change link picker open for the selected PR. */
  let picking = false;
  let notice: { text: string; bad: boolean } | undefined;

  // Static labels: the skeleton in index.html carries ids, not words.
  setText($("reviews-title"), MESSAGES.reviewsTitle(L));
  setText($("reviews-search-label"), MESSAGES.reviewsSearch(L));
  setText($("reviews-repo-label"), MESSAGES.reviewsRepoLabel(L));
  setText($("reviews-role-label"), MESSAGES.reviewsRoleLabel(L));
  const search = $("reviews-search") as HTMLInputElement;
  search.placeholder = MESSAGES.reviewsSearch(L);
  const repoSelect = $("reviews-repo") as HTMLSelectElement;
  const roleSelect = $("reviews-role") as HTMLSelectElement;
  for (const [value, label] of [
    ["", MESSAGES.reviewsRoleAll(L)],
    ["mine", MESSAGES.reviewsRoleMine(L)],
    ["review-requested", MESSAGES.reviewsRoleRequested(L)],
  ] as const) {
    const option = el("option", undefined, label);
    option.value = value;
    roleSelect.append(option);
  }
  const poll = $("reviews-poll");
  poll.setAttribute("aria-label", MESSAGES.reviewsCheckNow(L));
  poll.title = MESSAGES.reviewsCheckNow(L);
  poll.addEventListener("click", () => void pollNow());
  search.addEventListener("input", () => renderList());
  repoSelect.addEventListener("change", () => renderList());
  roleSelect.addEventListener("change", () => renderList());

  api.onReviewsChanged((prKey) => {
    void refresh(prKey);
  });

  function paneLabel(paneKey: string): string {
    return paneLabels.get(paneKey) ?? MESSAGES.reviewsPaneFallback(L);
  }

  async function pollNow(): Promise<void> {
    try {
      await api.reviewsPollNow();
    } catch {
      // The status line below says what gh is doing; a failed poll is not
      // the page's to report.
    }
    await refresh(null);
  }

  /** `changed`: the PR a reviews:changed push named (null: any). */
  async function refresh(changed: string | null = null): Promise<void> {
    try {
      const [nextStatus, nextItems, panes] = await Promise.all([
        api.reviewsStatus(),
        api.reviewsList(),
        deps.panes().catch(() => [] as ReviewsPane[]),
      ]);
      status = nextStatus;
      items = nextItems;
      paneLabels = new Map(panes.map((pane) => [pane.paneKey, pane.label]));
      checkedAt = now();
    } catch {
      return;
    }
    renderBadge();
    renderStatus();
    renderList();
    if (selected !== undefined && (changed === null || changed === selected)) {
      await loadThread(selected);
    }
  }

  async function loadThread(prKey: string): Promise<void> {
    try {
      const next = await api.reviewsThread(prKey);
      if (selected !== prKey) return;
      thread = next;
    } catch {
      if (selected !== prKey) return;
      thread = undefined;
    }
    renderThread();
  }

  async function open(prKey: string): Promise<void> {
    if (selected !== prKey) {
      replyTo = undefined;
      picking = false;
      notice = undefined;
    }
    selected = prKey;
    renderList();
    await loadThread(prKey);
  }

  function renderBadge(): void {
    const badge = document.getElementById("nav-reviews-count");
    if (badge === null) return;
    const total = items.reduce((sum, item) => sum + item.queued, 0);
    badge.hidden = total === 0;
    badge.textContent = total === 0 ? "" : String(total);
  }

  function renderStatus(): void {
    const setup = $("reviews-setup");
    const board = $("reviews-board");
    const listening = $("reviews-listening");
    const gh = status?.gh ?? null;
    const ok = gh !== null && gh.kind === "ok";
    setup.hidden = ok;
    board.hidden = !ok;
    if (gh !== null && gh.kind === "ok") {
      setText(
        listening,
        status?.enabled === false
          ? MESSAGES.reviewsOff(L)
          : MESSAGES.reviewsListening(gh.login, hhmm(checkedAt ?? now()), L),
      );
    } else {
      listening.textContent = "";
      renderSetup(setup, gh);
    }
    const errors = $("reviews-errors");
    errors.replaceChildren();
    const entries = Object.entries(status?.repoErrors ?? {});
    errors.hidden = entries.length === 0;
    for (const [repo, message] of entries)
      errors.append(el("div", undefined, `${repo}: ${message}`));
  }

  function renderSetup(setup: HTMLElement, gh: ReviewStatus["gh"]): void {
    setup.replaceChildren();
    const [title, hint] =
      gh === null
        ? [MESSAGES.reviewsSetupChecking(L), ""]
        : gh.kind === "no-gh"
          ? [MESSAGES.reviewsSetupNoGh(L), MESSAGES.reviewsSetupNoGhHint(L)]
          : [MESSAGES.reviewsSetupLoggedOut(L), MESSAGES.reviewsSetupLoggedOutHint(L)];
    const head = el("div", "reviews-setup-title");
    head.append(dot(gh === null ? "queued" : "waiting"), el("span", undefined, title));
    setup.append(head);
    if (hint !== "") setup.append(el("div", "reviews-setup-hint mono", hint));
    setup.append(el("div", "reviews-setup-note", MESSAGES.reviewsSetupNote(L)));
    setup.append(button(MESSAGES.reviewsCheckAgain(L), "reviews-btn", () => void pollNow()));
  }

  function filtered(): ReviewListItem[] {
    const query = search.value.trim().toLowerCase();
    const repo = repoSelect.value;
    const role = roleSelect.value;
    return items.filter((item) => {
      if (repo !== "" && item.pr.repo !== repo) return false;
      if (role !== "" && item.pr.role !== role) return false;
      if (query === "") return true;
      const haystack = `#${item.pr.number} ${item.pr.title} ${item.pr.repo} ${item.pr.headRef}`;
      return haystack.toLowerCase().includes(query);
    });
  }

  function renderRepoOptions(): void {
    const repos = [...new Set(items.map((item) => item.pr.repo))].sort();
    const current = repoSelect.value;
    repoSelect.replaceChildren();
    const all = el("option", undefined, MESSAGES.reviewsAllRepos(L));
    all.value = "";
    repoSelect.append(all);
    for (const repo of repos) {
      const option = el("option", undefined, repo);
      option.value = repo;
      repoSelect.append(option);
    }
    repoSelect.value = repos.includes(current) ? current : "";
  }

  function linkChip(item: ReviewListItem): HTMLElement {
    if (item.pr.role === "review-requested") {
      return el(
        "span",
        "reviews-chip reviews-chip--linked",
        MESSAGES.reviewsChipRequested(item.pr.author, L),
      );
    }
    if (item.link.kind === "linked") {
      return el(
        "span",
        "reviews-chip reviews-chip--linked",
        MESSAGES.reviewsChipLinked(paneLabel(item.link.paneKey), L),
      );
    }
    if (item.link.kind === "ambiguous") {
      return el("span", "reviews-chip reviews-chip--ambiguous", MESSAGES.reviewsChipAmbiguous(L));
    }
    return el("span", "reviews-chip", MESSAGES.reviewsChipNone(L));
  }

  function renderList(): void {
    renderRepoOptions();
    const list = $("reviews-list");
    list.replaceChildren();
    const head = el("div", "reviews-grid reviews-head");
    head.append(
      el("span", undefined, MESSAGES.reviewsColPr(L)),
      el("span", undefined, MESSAGES.reviewsColState(L)),
      el("span", undefined, MESSAGES.reviewsColLast(L)),
    );
    list.append(head);
    const rows = filtered();
    if (rows.length === 0) {
      list.append(
        el(
          "div",
          "reviews-empty",
          items.length === 0 ? MESSAGES.reviewsEmpty(L) : MESSAGES.reviewsNoMatch(L),
        ),
      );
      return;
    }
    for (const item of rows) {
      const key = keyOf(item);
      const row = el("button", "reviews-grid reviews-row");
      row.type = "button";
      row.classList.toggle("reviews-row--on", key === selected);
      row.addEventListener("click", () => void open(key));

      const main = el("span", "reviews-row-main");
      const title = el("span", "reviews-row-title");
      title.append(
        el("span", "mono reviews-num", `#${item.pr.number}`),
        el("span", undefined, item.pr.title),
      );
      const chips = el("span", "reviews-chips");
      chips.append(el("span", "reviews-repo mono", repoName(item.pr.repo)), linkChip(item));
      main.append(title, chips);

      const state = stateOf(item);
      const stateCell = el("span", `reviews-state mono reviews-state--${state.kind}`);
      stateCell.append(dot(state.kind), el("span", undefined, state.text));

      const last = el(
        "span",
        "reviews-last mono",
        item.lastActivity === 0 ? "—" : formatAgo(item.lastActivity, now(), L),
      );
      row.append(main, stateCell, last);
      list.append(row);
    }
  }

  function showNotice(text: string, bad: boolean): void {
    notice = { text, bad };
    const node = document.getElementById("reviews-notice");
    if (node === null) return;
    node.hidden = false;
    node.classList.toggle("reviews-notice--bad", bad);
    setText(node, text);
  }

  /** Runs a delivery action and says whether it went out, or why not. */
  async function deliver(run: () => Promise<{ sent: true } | { sent: false; wait: DeliveryWait }>) {
    try {
      const outcome = await run();
      if (outcome.sent) showNotice(MESSAGES.reviewsSent(L), false);
      else showNotice(MESSAGES.reviewsNotSent(MESSAGES.reviewsWait(outcome.wait, L), L), true);
    } catch {
      showNotice(MESSAGES.reviewsActionFailed(L), true);
    }
  }

  async function link(prKey: string, paneKey: string | null): Promise<void> {
    picking = false;
    try {
      await api.reviewsLink(prKey, paneKey);
    } catch {
      showNotice(MESSAGES.reviewsActionFailed(L), true);
    }
    await refresh(prKey);
  }

  function picker(prKey: string, options: ReviewsPane[], unlink: boolean): HTMLSelectElement {
    const select = el("select", "reviews-select reviews-picker");
    select.setAttribute("aria-label", MESSAGES.reviewsChooseTab(L));
    const placeholder = el("option", undefined, MESSAGES.reviewsChooseTab(L));
    placeholder.value = "";
    select.append(placeholder);
    for (const pane of options) {
      const option = el("option", undefined, pane.label);
      option.value = pane.paneKey;
      select.append(option);
    }
    if (unlink) {
      const option = el("option", undefined, MESSAGES.reviewsUnlink(L));
      option.value = UNLINK;
      select.append(option);
    }
    select.addEventListener("change", () => {
      if (select.value === "") return;
      void link(prKey, select.value === UNLINK ? null : select.value);
    });
    return select;
  }

  function linkBar(prKey: string, current: ReviewThread): HTMLElement {
    const bar = el("div", "reviews-linkbar");
    const linkResult: LinkResult = current.link;
    if (linkResult.kind === "linked") {
      bar.append(
        el("span", "reviews-chip reviews-chip--linked mono", paneLabel(linkResult.paneKey)),
      );
      bar.append(
        el(
          "span",
          "reviews-muted",
          linkResult.how === "auto"
            ? MESSAGES.reviewsLinkedAuto(current.pr.headRef, L)
            : MESSAGES.reviewsLinkedManual(L),
        ),
      );
    } else if (linkResult.kind === "ambiguous") {
      bar.append(el("span", "reviews-muted", MESSAGES.reviewsAmbiguous(L)));
      bar.append(
        picker(
          prKey,
          linkResult.paneKeys.map((paneKey) => ({ paneKey, label: paneLabel(paneKey) })),
          false,
        ),
      );
    } else {
      bar.append(el("span", "reviews-chip mono", MESSAGES.reviewsChipNone(L)));
    }
    if (current.waitReason !== null) {
      const stuck = STUCK.has(current.waitReason);
      const wait = el("span", `reviews-wait mono reviews-state--${stuck ? "waiting" : "queued"}`);
      wait.append(
        dot(stuck ? "waiting" : "queued"),
        el("span", undefined, MESSAGES.reviewsWait(current.waitReason, L)),
      );
      bar.append(wait);
    }
    bar.append(el("span", "reviews-spacer"));
    if (linkResult.kind === "linked") {
      const paneKey = linkResult.paneKey;
      bar.append(button(MESSAGES.reviewsOpenTab(L), "reviews-link", () => deps.openPane(paneKey)));
    }
    if (linkResult.kind !== "ambiguous") {
      bar.append(
        button(
          linkResult.kind === "linked" ? MESSAGES.reviewsChangeLink(L) : MESSAGES.reviewsLinkTab(L),
          "reviews-btn reviews-btn--small",
          () => {
            picking = !picking;
            renderThread();
          },
        ),
      );
    }
    if (picking && linkResult.kind !== "ambiguous") {
      const choices = [...paneLabels].map(([paneKey, label]) => ({ paneKey, label }));
      const row = el("div", "reviews-pickrow");
      if (choices.length === 0) row.append(el("span", "reviews-muted", MESSAGES.reviewsNoTabs(L)));
      row.append(picker(prKey, choices, linkResult.kind === "linked"));
      bar.append(row);
    }
    return bar;
  }

  function commentNode(prKey: string, entry: QueuedComment, all: QueuedComment[]): HTMLElement {
    const { comment, state } = entry;
    const article = el("article", `reviews-comment reviews-comment--${state}`);
    if (comment.inReplyTo !== undefined) article.classList.add("reviews-comment--reply");

    const head = el("div", "reviews-comment-head");
    const own = state === "own";
    head.append(
      el(
        "span",
        `mono reviews-author${own ? " reviews-author--own" : ""}`,
        own ? MESSAGES.reviewsYou(L) : `@${comment.author}`,
      ),
    );
    const where =
      comment.kind === "review-inline" && comment.path !== undefined
        ? `${comment.path}${comment.line === undefined ? "" : `:${comment.line}`}`
        : comment.kind === "review-body"
          ? MESSAGES.reviewsKindReview(L)
          : MESSAGES.reviewsKindIssue(L);
    head.append(
      el(
        "span",
        `mono reviews-where${comment.kind === "review-inline" ? " reviews-where--path" : ""}`,
        where,
      ),
    );
    head.append(el("span", "reviews-spacer"));

    if (state === "queued") {
      head.append(
        el(
          "span",
          "mono reviews-state--queued",
          MESSAGES.reviewsCommentQueued(hhmm(comment.createdAt), L),
        ),
      );
      head.append(
        button(
          MESSAGES.reviewsDeliverNow(L),
          "reviews-btn reviews-btn--small reviews-btn--accent",
          () => {
            void deliver(() => api.reviewsDeliverNow(prKey));
          },
        ),
      );
    } else if (state === "delivered") {
      const replied = all.some(
        (other) => other.state === "own" && other.comment.inReplyTo === comment.id,
      );
      const text = MESSAGES.reviewsCommentDelivered(
        hhmm(entry.deliveredAt ?? comment.createdAt),
        L,
      );
      head.append(
        el(
          "span",
          "mono reviews-muted",
          replied ? `${text} · ${MESSAGES.reviewsCommentReplied(L)}` : text,
        ),
      );
    } else if (state === "history") {
      head.append(el("span", "mono reviews-muted", MESSAGES.reviewsCommentHistory(L)));
      head.append(
        button(
          MESSAGES.reviewsSendToSession(L),
          "reviews-btn reviews-btn--small reviews-btn--accent",
          () => {
            void requeue(prKey, comment.id);
          },
        ),
      );
    } else {
      head.append(el("span", "mono reviews-muted", hhmm(comment.createdAt)));
    }
    if (!own && comment.kind === "review-inline") {
      head.append(
        button(MESSAGES.reviewsReply(L), "reviews-btn reviews-btn--small", () => {
          replyTo = { id: comment.id, author: comment.author };
          renderThread();
          document.getElementById("reviews-reply-input")?.focus();
        }),
      );
    }
    article.append(head);

    if (comment.diffHunk !== undefined && comment.diffHunk !== "") {
      const hunk = el("pre", "reviews-hunk mono");
      for (const line of comment.diffHunk.split("\n").slice(-6)) {
        const span = el(
          "span",
          line.startsWith("+")
            ? "reviews-hunk-add"
            : line.startsWith("-")
              ? "reviews-hunk-del"
              : undefined,
        );
        span.textContent = `${line}\n`;
        hunk.append(span);
      }
      article.append(hunk);
    }
    article.append(el("p", "reviews-body", comment.body));
    return article;
  }

  async function requeue(prKey: string, commentId: string): Promise<void> {
    try {
      const ok = await api.reviewsRequeue(prKey, commentId);
      showNotice(ok ? MESSAGES.reviewsRequeued(L) : MESSAGES.reviewsActionFailed(L), !ok);
    } catch {
      showNotice(MESSAGES.reviewsActionFailed(L), true);
    }
  }

  async function sendReply(prKey: string, input: HTMLTextAreaElement): Promise<void> {
    const body = input.value.trim();
    if (body === "") return;
    if (body.length > REVIEW_REPLY_MAX) {
      showNotice(MESSAGES.reviewsReplyTooLong(REVIEW_REPLY_MAX, L), true);
      return;
    }
    const target = replyTo?.id;
    try {
      await api.reviewsReply(prKey, body, target);
      drafts.delete(prKey);
      if (selected === prKey) {
        replyTo = undefined;
        notice = undefined;
        renderThread();
      }
    } catch {
      showNotice(MESSAGES.reviewsReplyFailed(L), true);
    }
  }

  function composer(prKey: string): HTMLElement {
    const form = el("form", "reviews-composer");
    form.id = "reviews-reply";
    if (replyTo !== undefined) {
      const target = el("div", "reviews-replying");
      target.append(
        el("span", "mono", MESSAGES.reviewsReplyingTo(replyTo.author, L)),
        button(MESSAGES.reviewsCancel(L), "reviews-link", () => {
          replyTo = undefined;
          renderThread();
        }),
      );
      form.append(target);
    }
    const label = el("label", "reviews-sr", MESSAGES.reviewsReplyLabel(L));
    label.htmlFor = "reviews-reply-input";
    // A textarea: replies are often several lines. Enter is a newline;
    // Cmd/Ctrl+Enter (or the Reply button) sends.
    const input = el("textarea", "reviews-input reviews-reply-input");
    input.id = "reviews-reply-input";
    input.dir = "auto";
    input.rows = 2;
    input.maxLength = REVIEW_REPLY_MAX;
    input.value = drafts.get(prKey) ?? "";
    input.addEventListener("input", () => {
      if (input.value === "") drafts.delete(prKey);
      else drafts.set(prKey, input.value);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        void sendReply(prKey, input);
      }
    });
    const login = status?.gh?.kind === "ok" ? status.gh.login : "";
    input.placeholder = MESSAGES.reviewsReplyPlaceholder(login, L);
    const submit = el("button", "reviews-btn reviews-btn--primary", MESSAGES.reviewsReply(L));
    submit.type = "submit";
    form.append(label, input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void sendReply(prKey, input);
    });
    return form;
  }

  function renderThread(): void {
    const pane = $("reviews-thread");
    // A half-typed reply survives re-renders through `drafts`, keyed by PR
    // (a reviews:changed push must not eat what the user is writing).
    pane.replaceChildren();
    if (selected === undefined || thread === undefined) {
      pane.append(el("div", "reviews-empty", MESSAGES.reviewsPickPr(L)));
      return;
    }
    const prKey = selected;
    const current = thread;

    const head = el("div", "reviews-thread-head");
    const title = el("span", "reviews-thread-title");
    title.append(
      el("span", "mono reviews-num", `#${current.pr.number}`),
      el("span", undefined, current.pr.title),
    );
    head.append(
      title,
      el("span", "mono reviews-muted", current.pr.headRef),
      el("span", "reviews-spacer"),
    );
    if (current.pr.role === "review-requested" && current.link.kind === "linked") {
      const paneKey = current.link.paneKey;
      head.append(
        button(MESSAGES.reviewsAskReview(L), "reviews-btn", () => {
          void deliver(() => api.reviewsSendReview(prKey, paneKey));
        }),
      );
    }
    head.append(
      button(MESSAGES.reviewsPostSummary(L), "reviews-btn", () => {
        void deliver(() => api.reviewsPostSummary(prKey));
      }),
      button(MESSAGES.reviewsOpenGithub(L), "reviews-btn", () => {
        void api.reviewsOpenOnGithub(prKey).catch(() => undefined);
      }),
    );
    pane.append(head, linkBar(prKey, current));

    const noticeNode = el("div", "reviews-notice");
    noticeNode.id = "reviews-notice";
    noticeNode.setAttribute("role", "status");
    noticeNode.hidden = notice === undefined;
    if (notice !== undefined) {
      noticeNode.classList.toggle("reviews-notice--bad", notice.bad);
      setText(noticeNode, notice.text);
    }
    pane.append(noticeNode);

    const comments = el("div", "reviews-comments");
    for (const entry of current.comments)
      comments.append(commentNode(prKey, entry, current.comments));
    pane.append(comments, composer(prKey));
  }

  renderThread();
  return { refresh: () => refresh(null), open };
}
