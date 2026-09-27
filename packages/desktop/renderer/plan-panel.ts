import type { AnchoredComment, PlanBlock, PlanComment } from "@jarvis/core";
import type { PlanDoc, PlanList, PlanResult } from "@jarvis/platform";
import type { MessageKey } from "../src/messages.js";

export type PlanPanelApi = {
  plansList(paneKey: string, cwd?: string): Promise<PlanList>;
  plansRead(path: string): Promise<PlanResult<PlanDoc>>;
  plansWriteBlock(
    path: string,
    blockId: string,
    source: string,
    baseMtimeMs: number,
  ): Promise<PlanResult<PlanDoc>>;
  plansComments(path: string): Promise<AnchoredComment[]>;
  plansAddComment(path: string, blockId: string, quote: string, body: string): Promise<PlanComment>;
  plansUpdateComment(id: string, body: string): Promise<PlanComment | undefined>;
  plansDeleteComment(id: string): Promise<boolean>;
  plansSend(
    paneKey: string,
    path: string,
    commentIds: string[],
  ): Promise<
    { ok: true; sent: number } | { ok: false; reason: "no-comments" | "forbidden" | "no-pane" }
  >;
};

export type PlanPanelHooks = {
  api: PlanPanelApi;
  t: (key: MessageKey) => string;
  onToggle?: (open: boolean) => void;
  /** Task 7 can attach editing here without changing read-mode rendering. */
  onBlockClick?: (block: PlanBlock, element: HTMLElement) => void;
  /** Task 8: a block's own rendered markdown `<a href>` was clicked. The
   *  panel always calls `preventDefault` first — main's own
   *  `setWindowOpenHandler` denies every `target=_blank` outright (every
   *  link markdown-it emits carries one), so the anchor's default action
   *  would otherwise silently do nothing. Absent leaves a link inert,
   *  same as today. */
  onLinkClick?: (href: string) => void;
};

export type PlanPanel = {
  element: HTMLElement;
  setPane(paneKey: string, cwd: string | undefined): void;
  open(path?: string): Promise<void>;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
  notifyChanged(path: string): void;
  dispose(): void;
};

type PlanEntry = PlanList["planMode"][number];
type CommentDraft = { blockId: string; quote: string };
type PlanReadError = Extract<PlanResult<PlanDoc>, { ok: false }>;
type PlanSendResult = Awaited<ReturnType<PlanPanelApi["plansSend"]>>;
type PlanSendError = Extract<PlanSendResult, { ok: false }>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className: string, text: string, action?: string): HTMLButtonElement {
  const node = el("button", className, text);
  node.type = "button";
  if (action) node.dataset.action = action;
  return node;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function dirName(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index < 0 ? "" : path.slice(0, index);
}

function relativeTime(mtimeMs: number, t: PlanPanelHooks["t"]): string {
  const elapsed = Math.max(0, Date.now() - mtimeMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return t("planRelativeNow");
  if (minutes < 60) return `${minutes}${t("planRelativeMinute")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${t("planRelativeHour")}`;
  return `${Math.floor(hours / 24)}${t("planRelativeDay")}`;
}

function repoKindLabel(
  kind: "spec" | "plan" | undefined,
  t: PlanPanelHooks["t"],
): string | undefined {
  if (kind === "spec") return t("planKindSpec");
  if (kind === "plan") return t("planKindPlan");
  return undefined;
}

function sourceLabel(entry: PlanEntry | undefined, t: PlanPanelHooks["t"]): string {
  if (entry?.source === "session") return t("planSourceSession");
  if (entry?.source === "planMode") return t("planSourceMode");
  if (entry?.source === "repo") {
    return `${t("planSourceRepo")} · ${repoKindLabel(entry.repoKind, t) ?? t("planKindPlan")}`;
  }
  return t("planKindPlan");
}

// Closed table: a reason added to PlanResult's failure branch without a
// case here is a compile error, not a runtime gap shipping an untranslated
// English sentence to an Arabic-primary user (messages.ts's own ruling).
function planErrorKey(reason: PlanReadError["reason"]): MessageKey {
  switch (reason) {
    case "forbidden":
      return "planErrorForbidden";
    case "not-found":
      return "planErrorNotFound";
    case "too-large":
      return "planErrorTooLarge";
    case "conflict":
      return "planErrorConflict";
    case "missing-block":
      return "planErrorMissingBlock";
    case "io":
      return "planErrorIo";
  }
}

function planSendErrorKey(reason: PlanSendError["reason"]): MessageKey {
  switch (reason) {
    case "no-comments":
      return "planSendErrorNoComments";
    case "forbidden":
      return "planSendErrorForbidden";
    case "no-pane":
      return "planSendErrorNoPane";
  }
}

/** Replace, rather than merely disable, network images so no later mutation can restore their URL. */
function removeRemoteImages(container: ParentNode): void {
  for (const image of container.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (src.startsWith("data:image/")) continue;
    const replacement = el("span", "plan-panel__image-alt", image.getAttribute("alt") ?? "");
    image.replaceWith(replacement);
  }
}

/**
 * Parses trusted block HTML inside an inert `<template>`. Per the HTML
 * spec a template's `.content` fragment never initiates network fetches —
 * connected to the document or not — so remote `<img>` sources are always
 * stripped before any node reaches the live DOM, regardless of a browser's
 * own eagerness to prefetch images on a plain detached element. The
 * renderer's CSP (`img-src 'self' data:` in index.html) is the second,
 * independent layer if this step is ever skipped.
 */
function parseBlockHtml(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  removeRemoteImages(template.content);
  return template.content;
}

function wrapFirstText(container: HTMLElement, quote: string): void {
  if (quote === "") return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number; end: number }> = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.textContent ?? "";
    nodes.push({ node: node as Text, start: text.length, end: text.length + value.length });
    text += value;
  }
  const quoteStart = text.indexOf(quote);
  if (quoteStart < 0) return;
  const quoteEnd = quoteStart + quote.length;
  const first = nodes.find(({ end }) => quoteStart < end);
  const last = nodes.find(({ end }) => quoteEnd <= end);
  if (!first || !last) return;

  const range = document.createRange();
  range.setStart(first.node, quoteStart - first.start);
  range.setEnd(last.node, quoteEnd - last.start);
  const mark = el("mark", "plan-quote");
  mark.append(range.extractContents());
  range.insertNode(mark);
}

export function createPlanPanel(hooks: PlanPanelHooks): PlanPanel {
  const { api, t } = hooks;
  const root = el("aside", "plan-panel");
  root.hidden = true;
  root.setAttribute("aria-label", t("planPanelLabel"));

  let paneKey = "";
  let cwd: string | undefined;
  let list: PlanList = { planMode: [], repo: [] };
  let currentDoc: PlanDoc | undefined;
  let comments: AnchoredComment[] = [];
  let sourceVisible = false;
  let pickerVisible = false;
  let trayExpanded = true;
  let showAllQueued = false;
  let draft: CommentDraft | undefined;
  let loadError: PlanReadError["reason"] | undefined;
  let actionError: string | undefined;
  let sendError: string | undefined;
  let closeActivePopover: (() => void) | undefined;
  let disposed = false;
  let loadId = 0;

  function currentEntry(): PlanEntry | undefined {
    const entries = [list.session, ...list.planMode, ...list.repo];
    return entries.find((entry) => entry?.path === currentDoc?.path);
  }

  function setOpen(value: boolean): void {
    root.hidden = !value;
    hooks.onToggle?.(value);
  }

  function renderHeader(): HTMLElement {
    const header = el("header", "plan-panel__header");
    if (!currentDoc) {
      // I4 / D3: the picker (and a way to close) must stay reachable even
      // with no document loaded yet — an empty or errored panel is not a
      // dead end.
      const top = el("div", "plan-panel__header-main");
      const openPicker = button("plan-panel__file", t("planPickerOpen"), "open-picker");
      openPicker.addEventListener("click", () => {
        pickerVisible = !pickerVisible;
        renderDocument();
      });
      const close = button("plan-panel__close", "×", "close");
      close.setAttribute("aria-label", t("planClose"));
      close.addEventListener("click", () => setOpen(false));
      top.append(openPicker, close);
      header.append(top);
      return header;
    }

    const doc = currentDoc;
    const top = el("div", "plan-panel__header-main");
    const name = button("plan-panel__file", fileName(doc.path), "open-picker");
    name.setAttribute("aria-label", t("planPickerOpen"));
    name.addEventListener("click", () => {
      pickerVisible = !pickerVisible;
      renderDocument();
    });
    const badge = el("span", "plan-panel__source-badge", sourceLabel(currentEntry(), t));
    const source = button("plan-panel__source-toggle", t("planSourceToggle"), "source");
    source.setAttribute("aria-pressed", String(sourceVisible));
    source.addEventListener("click", () => {
      sourceVisible = !sourceVisible;
      renderDocument();
    });
    const close = button("plan-panel__close", "×", "close");
    close.setAttribute("aria-label", t("planClose"));
    close.addEventListener("click", () => setOpen(false));
    top.append(name, badge, source, close);

    const sub = el("div", "plan-panel__header-sub");
    sub.append(
      el("span", "plan-panel__path", dirName(doc.path)),
      el("span", "plan-panel__updated", `${t("planUpdated")} · ${relativeTime(doc.mtimeMs, t)}`),
    );
    header.append(top, sub);
    return header;
  }

  function renderPicker(): HTMLElement {
    const picker = el("div", "plan-panel__picker");
    const search = el("input", "plan-panel__picker-search");
    search.type = "search";
    search.placeholder = t("planPickerSearch");
    const results = el("div", "plan-panel__picker-results");
    picker.append(search, results);

    let activeIndex = 0;
    let visibleEntries: PlanEntry[] = [];
    const groups: Array<{ label: MessageKey; values: PlanEntry[] }> = [
      { label: "planPickerSession", values: list.session ? [list.session] : [] },
      { label: "planPickerRecent", values: list.planMode },
      { label: "planPickerRepo", values: list.repo },
    ];

    const openEntry = (entry: PlanEntry): void => {
      pickerVisible = false;
      void loadDocument(entry.path);
    };

    const draw = (): void => {
      const query = search.value.trim().toLocaleLowerCase();
      results.replaceChildren();
      visibleEntries = [];
      for (const group of groups) {
        const values = group.values.filter((entry) =>
          entry.name.toLocaleLowerCase().includes(query),
        );
        if (values.length === 0) continue;
        const section = el("section", "plan-panel__picker-group");
        section.append(el("h3", "plan-panel__picker-heading", t(group.label)));
        for (const entry of values) {
          const index = visibleEntries.length;
          visibleEntries.push(entry);
          const item = button("plan-panel__picker-item", "");
          item.dataset.active = String(index === activeIndex);
          item.append(el("span", "plan-panel__picker-name", entry.name));
          const meta = [entry.project, repoKindLabel(entry.repoKind, t)]
            .filter(Boolean)
            .join(" · ");
          if (meta) item.append(el("span", "plan-panel__picker-meta", meta));
          item.addEventListener("click", () => openEntry(entry));
          section.append(item);
        }
        results.append(section);
      }
      if (activeIndex >= visibleEntries.length)
        activeIndex = Math.max(0, visibleEntries.length - 1);
    };

    search.addEventListener("input", () => {
      activeIndex = 0;
      draw();
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        pickerVisible = false;
        renderDocument();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        activeIndex = Math.max(0, Math.min(visibleEntries.length - 1, activeIndex + delta));
        draw();
        return;
      }
      if (event.key === "Enter") {
        const entry = visibleEntries[activeIndex];
        if (entry) openEntry(entry);
      }
    });
    draw();
    queueMicrotask(() => search.focus());
    return picker;
  }

  function commentBox(): HTMLElement | undefined {
    if (!draft) return undefined;
    const activeDraft = draft;
    const box = el("div", "plan-panel__comment-box");
    if (activeDraft.quote)
      box.append(el("blockquote", "plan-panel__comment-quote", activeDraft.quote));
    const textarea = el("textarea", "plan-panel__comment-input");
    textarea.placeholder = t("planCommentPlaceholder");
    const actions = el("div", "plan-panel__comment-actions");
    const cancel = button("plan-panel__secondary", t("planCancel"), "cancel-comment");
    const add = button("plan-panel__primary", t("planAddComment"), "add-comment");
    add.disabled = true;
    textarea.addEventListener("input", () => {
      add.disabled = textarea.value.trim() === "";
    });
    const cancelDraft = (): void => {
      draft = undefined;
      renderDocument();
    };
    cancel.addEventListener("click", cancelDraft);
    const save = async (): Promise<void> => {
      if (!currentDoc || textarea.value.trim() === "") return;
      actionError = undefined;
      try {
        await api.plansAddComment(
          currentDoc.path,
          activeDraft.blockId,
          activeDraft.quote,
          textarea.value.trim(),
        );
        draft = undefined;
        comments = await api.plansComments(currentDoc.path);
      } catch {
        actionError = t("planActionError");
      }
      renderDocument();
    };
    add.addEventListener("click", () => void save());
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") cancelDraft();
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
    });
    actions.append(cancel, add);
    box.append(textarea, actions);
    queueMicrotask(() => textarea.focus());
    return box;
  }

  function openCommentPopover(comment: AnchoredComment, pin: HTMLElement): void {
    closeActivePopover?.();
    const popover = el("div", "plan-panel__comment-popover");
    const controller = new AbortController();
    const close = (): void => {
      controller.abort();
      popover.remove();
      if (closeActivePopover === close) closeActivePopover = undefined;
    };
    closeActivePopover = close;

    const body = el("p", "plan-panel__comment-body", comment.body);
    const edit = button("plan-panel__secondary", t("planEdit"), "edit-comment");
    const remove = button("plan-panel__danger", t("planDelete"), "delete-comment");
    edit.addEventListener("click", () => {
      const input = el("textarea", "plan-panel__comment-input");
      input.value = comment.body;
      const save = button("plan-panel__primary", t("planSave"), "save-comment");
      save.disabled = input.value.trim() === "";
      input.addEventListener("input", () => {
        save.disabled = input.value.trim() === "";
      });
      save.addEventListener("click", async () => {
        if (input.value.trim() === "") return;
        actionError = undefined;
        try {
          await api.plansUpdateComment(comment.id, input.value.trim());
          if (currentDoc) comments = await api.plansComments(currentDoc.path);
        } catch {
          actionError = t("planActionError");
        }
        close();
        renderDocument();
      });
      popover.replaceChildren(input, save);
      input.focus();
    });
    remove.addEventListener("click", async () => {
      actionError = undefined;
      try {
        await api.plansDeleteComment(comment.id);
        if (currentDoc) comments = await api.plansComments(currentDoc.path);
      } catch {
        actionError = t("planActionError");
      }
      close();
      renderDocument();
    });
    popover.append(body, edit, remove);
    pin.after(popover);

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") close();
      },
      { signal: controller.signal },
    );
    document.addEventListener(
      "mousedown",
      (event) => {
        if (
          event.target instanceof Node &&
          !popover.contains(event.target) &&
          event.target !== pin
        ) {
          close();
        }
      },
      { signal: controller.signal },
    );
  }

  function renderBlock(block: PlanBlock): HTMLElement {
    const row = el("div", "plan-panel__block-row");
    const gutter = el("div", "plan-panel__gutter");
    const blockComments = comments.filter(
      (comment) => comment.anchor.kind === "block" && comment.anchor.blockId === block.id,
    );
    for (const comment of blockComments) {
      const pin = button(
        `plan-panel__pin ${comment.sentAt === undefined ? "plan-panel__pin--queued" : "plan-panel__pin--sent"}`,
        String(comment.number),
      );
      pin.setAttribute("aria-label", `${t("planCommentNumber")} ${comment.number}`);
      pin.addEventListener("click", () => openCommentPopover(comment, pin));
      gutter.append(pin);
    }
    const addPin = button("plan-panel__add-pin", "+", "block-comment");
    addPin.setAttribute("aria-label", t("planCommentOnBlock"));
    addPin.addEventListener("click", () => {
      draft = { blockId: block.id, quote: "" };
      renderDocument();
    });
    gutter.append(addPin);

    const content = el("div", "plan-block");
    content.dataset.blockId = block.id;
    content.append(parseBlockHtml(block.html));
    for (const comment of blockComments) wrapFirstText(content, comment.quote);
    content.addEventListener("click", () => hooks.onBlockClick?.(block, content));
    row.append(gutter, content);
    if (draft?.blockId === block.id) {
      const box = commentBox();
      if (box) row.append(box);
    }
    return row;
  }

  /** I2: a draft survives a same-path reload even if its block was removed
   *  from the reloaded document — there is just no row left to host it. */
  function renderDraftOrphanNotice(): HTMLElement {
    const box = el("div", "plan-panel__comment-box");
    box.append(el("p", "plan-panel__comment-quote", t("planDraftOrphaned")));
    const cancel = button("plan-panel__secondary", t("planCancel"), "cancel-comment");
    cancel.addEventListener("click", () => {
      draft = undefined;
      renderDocument();
    });
    box.append(cancel);
    return box;
  }

  function renderTray(): HTMLElement {
    const tray = el(
      "section",
      `plan-panel__tray${trayExpanded ? "" : " plan-panel__tray--collapsed"}`,
    );
    const queued = comments.filter((comment) => comment.sentAt === undefined);
    const sent = comments.filter((comment) => comment.sentAt !== undefined);
    const summary = el(
      "div",
      "plan-panel__tray-summary",
      `${comments.length} ${t("planComments")} · ${queued.length} ${t("planQueued")} · ${sent.length} ${t("planSent")}`,
    );
    tray.append(summary);
    if (sendError) tray.append(el("p", "plan-panel__send-error", sendError));
    if (!trayExpanded) {
      summary.addEventListener("click", () => {
        trayExpanded = true;
        renderDocument();
      });
      return tray;
    }
    const listNode = el("div", "plan-panel__tray-list");
    const anchoredQueued = queued.filter((comment) => comment.anchor.kind !== "orphaned");
    const visible = showAllQueued ? anchoredQueued : anchoredQueued.slice(0, 3);
    for (const comment of visible) {
      listNode.append(el("div", "plan-panel__tray-item", `${comment.number}. ${comment.body}`));
    }
    if (!showAllQueued && anchoredQueued.length > 3) {
      const show = button("plan-panel__show-all", t("planShowAll"), "show-all-comments");
      show.addEventListener("click", () => {
        showAllQueued = true;
        renderDocument();
      });
      listNode.append(show);
    }
    for (const comment of comments.filter((item) => item.anchor.kind === "orphaned")) {
      const orphan = el("div", "plan-panel__tray-item plan-panel__orphaned");
      orphan.append(
        el("span", "plan-panel__orphan-label", t("planSectionChanged")),
        el("span", "plan-panel__orphan-body", comment.body),
      );
      listNode.append(orphan);
    }
    tray.append(listNode);
    const actions = el("div", "plan-panel__tray-actions");
    const later = button("plan-panel__secondary", t("planKeepLater"), "keep-comments");
    later.addEventListener("click", () => {
      trayExpanded = false;
      renderDocument();
    });
    const send = button(
      "plan-panel__primary",
      `${t("planSendClaude")} (${queued.length})`,
      "send-comments",
    );
    send.disabled = queued.length === 0;
    send.addEventListener("click", () => void sendQueued(queued));
    actions.append(later, send);
    tray.append(actions);
    return tray;
  }

  async function sendQueued(queued: AnchoredComment[]): Promise<void> {
    if (!currentDoc || queued.length === 0) return;
    sendError = undefined;
    try {
      const result = await api.plansSend(
        paneKey,
        currentDoc.path,
        queued.map((comment) => comment.id),
      );
      if (!result.ok) {
        sendError = t(planSendErrorKey(result.reason));
        renderDocument();
        return;
      }
      comments = await api.plansComments(currentDoc.path);
      renderDocument();
    } catch {
      actionError = t("planActionError");
      renderDocument();
    }
  }

  function renderEmptyBody(): HTMLElement {
    const empty = el("div", "plan-panel__empty");
    empty.append(
      el("h2", "plan-panel__empty-title", t("planEmptyTitle")),
      el("p", "plan-panel__empty-hint", t("planEmptyHint")),
    );
    return empty;
  }

  function renderErrorBody(reason: PlanReadError["reason"]): HTMLElement {
    const box = el("div", "plan-panel__empty");
    box.append(el("p", "plan-panel__empty-hint", t(planErrorKey(reason))));
    return box;
  }

  function renderDocument(): void {
    closeActivePopover?.();
    root.replaceChildren(renderHeader());
    if (pickerVisible) root.append(renderPicker());
    const banner = actionError ? el("p", "plan-panel__action-error", actionError) : undefined;
    if (banner) root.append(banner);

    if (loadError) {
      const body = el("div", "plan-panel__body");
      body.append(renderErrorBody(loadError));
      root.append(body);
      return;
    }
    if (!currentDoc) {
      const body = el("div", "plan-panel__body");
      body.append(renderEmptyBody());
      root.append(body);
      return;
    }
    const doc = currentDoc;
    const body = el("div", "plan-panel__body");
    if (draft && !doc.blocks.some((block) => block.id === draft?.blockId)) {
      body.append(renderDraftOrphanNotice());
    }
    if (sourceVisible) {
      body.append(
        el("pre", "plan-panel__source", doc.blocks.map((block) => block.source).join("\n\n")),
      );
    } else {
      for (const block of doc.blocks) body.append(renderBlock(block));
    }
    root.append(body, renderTray());
  }

  async function refreshList(): Promise<void> {
    if (!paneKey || disposed) return;
    try {
      list = await api.plansList(paneKey, cwd);
    } catch {
      if (disposed) return;
      actionError = t("planActionError");
      renderDocument();
      return;
    }
    if (disposed) return;
    // Cheap minor: a visible picker holds a stale `list` closure once
    // refreshList resolves outside the normal open()/loadDocument flow
    // (e.g. notifyChanged for a pane whose doc isn't the one open here).
    if (pickerVisible) renderDocument();
  }

  async function loadDocument(path: string): Promise<void> {
    const request = ++loadId;
    const samePath = currentDoc?.path === path;
    let result: PlanResult<PlanDoc>;
    try {
      result = await api.plansRead(path);
    } catch {
      if (disposed || request !== loadId) return;
      actionError = t("planActionError");
      renderDocument();
      return;
    }
    if (disposed || request !== loadId) return;
    if (!result.ok) {
      currentDoc = undefined;
      comments = [];
      loadError = result.reason;
      renderDocument();
      return;
    }
    let nextComments: AnchoredComment[];
    try {
      nextComments = await api.plansComments(path);
    } catch {
      if (disposed || request !== loadId) return;
      actionError = t("planActionError");
      renderDocument();
      return;
    }
    if (disposed || request !== loadId) return;
    loadError = undefined;
    currentDoc = result.value;
    comments = nextComments;
    // I2: a same-path reload (file changed on disk) must not throw away
    // what the user was doing — only a genuinely different document resets
    // the draft, the Source toggle and the tray's "show all" state.
    if (!samePath) {
      sourceVisible = false;
      showAllQueued = false;
      draft = undefined;
      sendError = undefined;
    }
    renderDocument();
  }

  function positionSelectionButton(action: HTMLElement, range: Range, block: HTMLElement): void {
    const panelRect = root.getBoundingClientRect();
    // jsdom (no layout engine) does not implement Range.getBoundingClientRect
    // at all; a real browser always does, so this falls back to the block's
    // own rect exactly as it would for a genuinely empty range rect.
    const rangeRect =
      typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : undefined;
    const useRange = !!rangeRect && (rangeRect.width > 0 || rangeRect.height > 0);
    const rect = useRange && rangeRect ? rangeRect : block.getBoundingClientRect();
    const top = rect.top - panelRect.top - (useRange ? 32 : 0);
    const left = rect.left - panelRect.left;
    action.style.top = `${Math.max(0, top)}px`;
    action.style.left = `${Math.max(0, left)}px`;
  }

  function selectionChanged(event: MouseEvent): void {
    const existing = root.querySelector<HTMLElement>('[data-action="comment-selection"]');
    // I1: the mouseup that lands ON the existing button (mousedown, then
    // this mouseup, then click) must not remove it out from under its own
    // pending click — only a mouseup elsewhere replaces it.
    if (existing && event.target instanceof Node && existing.contains(event.target)) return;
    existing?.remove();
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return;
    const text = selection.toString().trim();
    if (text === "") return;
    const range = selection.getRangeAt(0);
    const start =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    const end =
      range.endContainer.nodeType === Node.ELEMENT_NODE
        ? (range.endContainer as Element)
        : range.endContainer.parentElement;
    const startBlock = start?.closest<HTMLElement>(".plan-block");
    const endBlock = end?.closest<HTMLElement>(".plan-block");
    if (!startBlock || startBlock !== endBlock || !root.contains(startBlock)) return;
    const action = button("plan-panel__selection-comment", t("planComment"), "comment-selection");
    // I1: keep the selection alive through the button's own mousedown so a
    // real click (mousedown → mouseup → click) still has text to act on.
    action.addEventListener("mousedown", (mousedownEvent) => mousedownEvent.preventDefault());
    action.addEventListener("click", () => {
      draft = { blockId: startBlock.dataset.blockId ?? "", quote: text };
      selection.removeAllRanges();
      renderDocument();
    });
    positionSelectionButton(action, range, startBlock);
    root.append(action);
  }
  document.addEventListener("mouseup", selectionChanged);

  // Task 8: one delegated listener for every link a block's own markdown
  // renders, rather than one per `<a>` — blocks are rebuilt wholesale on
  // every renderDocument(), so a per-anchor listener would have to be
  // rewired on every render for no benefit a single root-level one does
  // not already give. Scoped to `.plan-block` so the panel's own chrome
  // (never anchors) is untouched even if that ever changes.
  root.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const anchor = event.target.closest("a[href]");
    if (anchor === null || anchor.closest(".plan-block") === null) return;
    const href = anchor.getAttribute("href");
    if (href === null) return;
    event.preventDefault();
    hooks.onLinkClick?.(href);
  });

  async function openPanel(path?: string): Promise<void> {
    setOpen(true);
    loadError = undefined;
    actionError = undefined;
    await refreshList();
    const target = path ?? list.session?.path;
    if (target) {
      await loadDocument(target);
    } else {
      currentDoc = undefined;
      comments = [];
      renderDocument();
    }
  }

  function closePanel(): void {
    setOpen(false);
    pickerVisible = false; // Task 8 fix round 1: never leaves the picker for a later open to re-focus.
  }

  // Cheap minor: toggle() must not depend on `this` — it is handed out of
  // the returned object as a bare function reference (hotkeys, menu items).
  function togglePanel(): void {
    if (root.hidden) void openPanel(currentDoc?.path);
    else closePanel();
  }

  return {
    element: root,
    setPane(nextPaneKey, nextCwd) {
      paneKey = nextPaneKey;
      cwd = nextCwd;
    },
    open: openPanel,
    close: closePanel,
    toggle: togglePanel,
    isOpen() {
      return !root.hidden;
    },
    notifyChanged(path) {
      void refreshList();
      if (currentDoc?.path === path) void loadDocument(path);
    },
    dispose() {
      disposed = true;
      loadId += 1;
      closeActivePopover?.();
      closeActivePopover = undefined;
      document.removeEventListener("mouseup", selectionChanged);
      root.remove();
    },
  };
}
