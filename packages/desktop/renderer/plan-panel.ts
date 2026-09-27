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

function relativeTime(mtimeMs: number): string {
  const elapsed = Math.max(0, Date.now() - mtimeMs);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function sourceLabel(entry: PlanEntry | undefined, t: PlanPanelHooks["t"]): string {
  if (entry?.source === "session") return t("planSourceSession");
  if (entry?.source === "planMode") return t("planSourceMode");
  if (entry?.source === "repo") {
    return `${t("planSourceRepo")} · ${entry.repoKind === "spec" ? t("planKindSpec") : t("planKindPlan")}`;
  }
  return t("planKindPlan");
}

/** Replace, rather than merely disable, network images so no later mutation can restore their URL. */
function removeRemoteImages(container: HTMLElement): void {
  for (const image of container.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (src.startsWith("data:image/")) continue;
    const replacement = el("span", "plan-panel__image-alt", image.getAttribute("alt") ?? "");
    image.replaceWith(replacement);
  }
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

  function renderEmpty(): void {
    root.replaceChildren();
    const empty = el("div", "plan-panel__empty");
    empty.append(
      el("h2", "plan-panel__empty-title", t("planEmptyTitle")),
      el("p", "plan-panel__empty-hint", t("planEmptyHint")),
    );
    root.append(empty);
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
          const meta = [entry.project, entry.repoKind].filter(Boolean).join(" · ");
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

  function renderHeader(): HTMLElement {
    const header = el("header", "plan-panel__header");
    const top = el("div", "plan-panel__header-main");
    const name = button("plan-panel__file", fileName(currentDoc?.path ?? ""));
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
      el("span", "plan-panel__path", dirName(currentDoc?.path ?? "")),
      el(
        "span",
        "plan-panel__updated",
        `${t("planUpdated")} · ${relativeTime(currentDoc?.mtimeMs ?? Date.now())}`,
      ),
    );
    header.append(top, sub);
    return header;
  }

  function commentBox(): HTMLElement | undefined {
    if (!draft) return undefined;
    const box = el("div", "plan-panel__comment-box");
    if (draft.quote) box.append(el("blockquote", "plan-panel__comment-quote", draft.quote));
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
      if (!currentDoc || !draft || textarea.value.trim() === "") return;
      await api.plansAddComment(currentDoc.path, draft.blockId, draft.quote, textarea.value.trim());
      draft = undefined;
      comments = await api.plansComments(currentDoc.path);
      renderDocument();
    };
    add.addEventListener("click", () => void save());
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Escape") cancelDraft();
      if (event.key === "Enter" && event.metaKey) void save();
    });
    actions.append(cancel, add);
    box.append(textarea, actions);
    queueMicrotask(() => textarea.focus());
    return box;
  }

  function openCommentPopover(comment: AnchoredComment, pin: HTMLElement): void {
    root.querySelector(".plan-panel__comment-popover")?.remove();
    const popover = el("div", "plan-panel__comment-popover");
    const body = el("p", "plan-panel__comment-body", comment.body);
    const edit = button("plan-panel__secondary", t("planEdit"), "edit-comment");
    const remove = button("plan-panel__danger", t("planDelete"), "delete-comment");
    edit.addEventListener("click", () => {
      const input = el("textarea", "plan-panel__comment-input");
      input.value = comment.body;
      const save = button("plan-panel__primary", t("planSave"), "save-comment");
      save.addEventListener("click", async () => {
        await api.plansUpdateComment(comment.id, input.value.trim());
        if (currentDoc) comments = await api.plansComments(currentDoc.path);
        renderDocument();
      });
      popover.replaceChildren(input, save);
      input.focus();
    });
    remove.addEventListener("click", async () => {
      await api.plansDeleteComment(comment.id);
      if (currentDoc) comments = await api.plansComments(currentDoc.path);
      renderDocument();
    });
    popover.append(body, edit, remove);
    pin.after(popover);
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
    // Plan HTML is produced by the trusted markdown service. Network-capable
    // images are removed synchronously before this detached node enters DOM.
    content.innerHTML = block.html;
    removeRemoteImages(content);
    for (const comment of blockComments) wrapFirstText(content, comment.quote);
    content.addEventListener("click", () => hooks.onBlockClick?.(block, content));
    row.append(gutter, content);
    if (draft?.blockId === block.id) {
      const box = commentBox();
      if (box) row.append(box);
    }
    return row;
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
    send.addEventListener("click", async () => {
      if (!currentDoc || queued.length === 0) return;
      await api.plansSend(
        paneKey,
        currentDoc.path,
        queued.map((comment) => comment.id),
      );
      comments = await api.plansComments(currentDoc.path);
      renderDocument();
    });
    actions.append(later, send);
    tray.append(actions);
    return tray;
  }

  function renderDocument(): void {
    if (!currentDoc) {
      renderEmpty();
      return;
    }
    root.replaceChildren(renderHeader());
    if (pickerVisible) root.append(renderPicker());
    const body = el("div", "plan-panel__body");
    if (sourceVisible) {
      body.append(
        el(
          "pre",
          "plan-panel__source",
          (currentDoc.blocks as PlanBlock[]).map((block) => block.source).join("\n"),
        ),
      );
    } else {
      for (const block of currentDoc.blocks as PlanBlock[]) body.append(renderBlock(block));
    }
    root.append(body, renderTray());
  }

  async function refreshList(): Promise<void> {
    if (!paneKey || disposed) return;
    list = await api.plansList(paneKey, cwd);
  }

  async function loadDocument(path: string): Promise<void> {
    const request = ++loadId;
    const result = await api.plansRead(path);
    if (disposed || request !== loadId || !result.ok) return;
    const nextComments = await api.plansComments(path);
    if (disposed || request !== loadId) return;
    currentDoc = result.value;
    comments = nextComments;
    sourceVisible = false;
    draft = undefined;
    renderDocument();
  }

  function selectionChanged(): void {
    root.querySelector('[data-action="comment-selection"]')?.remove();
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
    action.addEventListener("click", () => {
      draft = { blockId: startBlock.dataset.blockId ?? "", quote: text };
      selection.removeAllRanges();
      renderDocument();
    });
    root.append(action);
  }
  document.addEventListener("mouseup", selectionChanged);

  return {
    element: root,
    setPane(nextPaneKey, nextCwd) {
      paneKey = nextPaneKey;
      cwd = nextCwd;
    },
    async open(path) {
      setOpen(true);
      await refreshList();
      const target = path ?? list.session?.path;
      if (target) await loadDocument(target);
      else {
        currentDoc = undefined;
        comments = [];
        renderEmpty();
      }
    },
    close() {
      setOpen(false);
    },
    toggle() {
      if (root.hidden) void this.open(currentDoc?.path);
      else this.close();
    },
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
      document.removeEventListener("mouseup", selectionChanged);
      root.remove();
    },
  };
}
