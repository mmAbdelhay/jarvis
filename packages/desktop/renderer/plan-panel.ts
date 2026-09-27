import type { AnchoredComment, PlanBlock, PlanComment } from "@jarvis/core";
import type { PlanDoc, PlanList, PlanResult } from "@jarvis/platform";
import type { MessageKey } from "../src/messages.js";
import { blockToMarkdown, isNoopEdit } from "./plan-dom-markdown.js";

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
type PlanReadError = Extract<PlanResult<PlanDoc>, { ok: false }>;
type PlanSendResult = Awaited<ReturnType<PlanPanelApi["plansSend"]>>;
type PlanSendError = Extract<PlanSendResult, { ok: false }>;

// Task 7b: in-place block editing. "rich" is a heading/paragraph/list/quote
// edited as live HTML (the formatting toolbar acts on it); "code" is a code
// block's body edited as plain text, keeping its fence/info string (never
// shown in the DOM at all — codeToMarkdown reattaches them from the
// block's own original source); "raw" is table/hr/other, edited as the
// block's raw markdown text. All three are `contenteditable`, never a
// `<textarea>`: blockToMarkdown's raw/code paths read `.textContent`, which
// only stays live for a contenteditable element — a `<textarea>`'s
// `.textContent` is frozen at its initial markup and never reflects typed
// input.
type EditMode = "rich" | "code" | "raw";

type EditingState = {
  blockId: string;
  /** The block's index in `currentDoc.blocks` when editing began — the
   *  stable anchor used to find "the same block" again after a save
   *  changes its content-hashed id (see blockId() in @jarvis/core). */
  index: number;
  mode: EditMode;
  /** Undefined only for the instant between opening the edit and
   *  renderEditingBlock building the first DOM node — every listener reads
   *  it lazily, by which point it always exists. */
  container: HTMLElement | undefined;
  /** Set only by a real `input` event in `container` — a click that opens
   *  the block and a blur that immediately follows it must never write. */
  dirty: boolean;
  baseMtimeMs: number;
  saving: boolean;
};

type ConflictState = {
  /** The block id the failed write targeted — checked first on Apply. */
  blockId: string;
  /** Index fallback for Apply, same reasoning as EditingState.index. */
  index: number;
  text: string;
  reason: "conflict" | "missing-block";
};

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

function editModeForKind(kind: PlanBlock["kind"]): EditMode {
  if (kind === "code") return "code";
  if (kind === "heading" || kind === "paragraph" || kind === "list" || kind === "quote") {
    return "rich";
  }
  return "raw"; // table | hr | other
}

/** Apply's own target-id rule: the block the failed write aimed at, if it's
 *  still there under the fresh doc — otherwise whatever now sits at the same
 *  index. A block's id is a hash of its own kind+source (@jarvis/core's
 *  blockId()), so any real content change on disk changes it; the index is
 *  what survives that when the edit's own target block is what changed. */
function pickConflictTargetId(doc: PlanDoc, state: ConflictState): string | undefined {
  if (doc.blocks.some((candidate) => candidate.id === state.blockId)) return state.blockId;
  return doc.blocks[state.index]?.id;
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
  let editing: EditingState | undefined;
  let conflict: ConflictState | undefined;
  // Set while `editing` is dirty and notifyChanged fires for this path — the
  // reload it would normally trigger is deferred until the edit is saved or
  // discarded (see notifyChanged below), and this is the one thing that
  // deferral leaves for the user to see meanwhile.
  let diskChangedWhileDirty = false;
  // Captured by renderHeader on every full render, then mutated directly (no
  // renderDocument()) by the `input` handler and by notifyChanged — a full
  // re-render would rebuild the editing block from the doc's *original*
  // html/source and silently discard whatever the user has typed.
  let unsavedBadgeEl: HTMLElement | undefined;
  let diskChangedBadgeEl: HTMLElement | undefined;

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
      unsavedBadgeEl = undefined;
      diskChangedBadgeEl = undefined;
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
    const unsaved = el("span", "plan-panel__unsaved", t("planUnsavedIndicator"));
    unsaved.hidden = !(editing?.dirty ?? false);
    unsavedBadgeEl = unsaved;
    const diskChanged = el("span", "plan-panel__disk-changed", t("planUpdatedOnDisk"));
    diskChanged.hidden = !(diskChangedWhileDirty && (editing?.dirty ?? false));
    diskChangedBadgeEl = diskChanged;
    const source = button("plan-panel__source-toggle", t("planSourceToggle"), "source");
    source.setAttribute("aria-pressed", String(sourceVisible));
    source.addEventListener("click", () => {
      sourceVisible = !sourceVisible;
      renderDocument();
    });
    const close = button("plan-panel__close", "×", "close");
    close.setAttribute("aria-label", t("planClose"));
    close.addEventListener("click", () => setOpen(false));
    top.append(name, badge, unsaved, diskChanged, source, close);

    const sub = el("div", "plan-panel__header-sub");
    sub.append(
      el("span", "plan-panel__path", dirName(doc.path)),
      el("span", "plan-panel__updated", `${t("planUpdated")} · ${relativeTime(doc.mtimeMs, t)}`),
    );
    header.append(top, sub);
    return header;
  }

  /** Mutates the badges renderHeader already put in the DOM, without a full
   *  renderDocument() — see the module-level comment on unsavedBadgeEl. */
  function updateHeaderDirtyUi(): void {
    const dirty = editing?.dirty ?? false;
    if (unsavedBadgeEl) unsavedBadgeEl.hidden = !dirty;
    if (diskChangedBadgeEl) diskChangedBadgeEl.hidden = !(diskChangedWhileDirty && dirty);
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

  // --- Task 7b: in-place block editing ---

  /** Wraps the current selection in `tag` (bold/italic/inline code) and
   *  fires the same `input` event a real keystroke would, so the one dirty
   *  listener on `container` owns flagging the edit either way. No-ops
   *  outside a real, non-collapsed selection inside `container` — there is
   *  nothing to wrap. Does not merge with or toggle off an existing tag;
   *  that level of rich-text fidelity is out of scope here. */
  function applyInlineFormat(container: HTMLElement, tag: "strong" | "em" | "code"): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;
    const wrapper = document.createElement(tag);
    wrapper.append(range.extractContents());
    range.insertNode(wrapper);
    selection.removeAllRanges();
    const after = document.createRange();
    after.selectNodeContents(wrapper);
    selection.addRange(after);
    container.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** A real Enter in a code/raw contenteditable often inserts a new block
   *  element rather than a "\n" text node — which blockToMarkdown's
   *  `.textContent` read would then silently drop, since `.textContent`
   *  never inserts a separator between sibling elements. This inserts a
   *  literal newline character instead, so what's typed is exactly what
   *  gets saved. */
  function insertPlainNewline(container: HTMLElement): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode("\n");
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    selection.removeAllRanges();
    selection.addRange(range);
    container.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Link: wraps the selection in `<a href="">`, then swaps in an inline URL
   *  input (prompt-free, per D2) rather than window.prompt — which jsdom
   *  allows but Electron's renderer throws on (testing.md's own warning). No
   *  selection, no-op: there's nothing to make a link out of. */
  function startLinkEdit(container: HTMLElement, toolbar: HTMLElement): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return;
    const anchor = document.createElement("a");
    anchor.setAttribute("href", "");
    anchor.append(range.extractContents());
    range.insertNode(anchor);
    selection.removeAllRanges();

    const input = el("input", "plan-block-edit__link-input");
    input.type = "text";
    input.placeholder = t("planLinkUrlPlaceholder");
    let settled = false;
    const commit = (): void => {
      if (settled) return;
      settled = true;
      anchor.setAttribute("href", input.value.trim());
      input.remove();
      container.dispatchEvent(new Event("input", { bubbles: true }));
      container.focus();
    };
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      anchor.replaceWith(document.createTextNode(anchor.textContent ?? ""));
      input.remove();
      container.focus();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });
    // Enter already committed above; a plain blur (clicking away) commits
    // too, same as the block itself — `settled` makes the second call inert.
    input.addEventListener("blur", commit);
    toolbar.append(input);
    queueMicrotask(() => input.focus());
  }

  /** The toolbar's amber Comment button: opens the same draft flow as the
   *  gutter's own + pin, quoting the current selection if there is one
   *  (mirrors selectionChanged's own selection-to-quote behaviour). Inserts
   *  the box directly, rather than through renderDocument() — a full
   *  re-render would rebuild the block being edited from the doc's
   *  original html/source and discard whatever the user has typed. */
  function openEditingComment(block: PlanBlock, container: HTMLElement | undefined): void {
    const selection = window.getSelection();
    const quote =
      selection && !selection.isCollapsed && container?.contains(selection.anchorNode)
        ? selection.toString().trim()
        : "";
    draft = { blockId: block.id, quote };
    const row = root
      .querySelector<HTMLElement>(`[data-block-id="${block.id}"]`)
      ?.closest<HTMLElement>(".plan-panel__block-row");
    if (!row) return;
    for (const existing of root.querySelectorAll(".plan-panel__comment-box")) existing.remove();
    const box = commentBox();
    if (box) row.append(box);
  }

  function renderToolbar(block: PlanBlock, state: EditingState): HTMLElement {
    const toolbar = el("div", "plan-block-edit__toolbar");
    const addButton = (
      className: string,
      glyph: string,
      label: string,
      onClick: () => void,
    ): void => {
      const item = button(`plan-block-edit__toolbar-btn ${className}`, glyph);
      item.setAttribute("aria-label", label);
      // Keeps the selection (and the contenteditable's own focus) alive
      // through the click — same technique as selectionChanged's own
      // comment-selection button (I1). Without it, mousedown alone would
      // blur `state.container` and collapse the selection before the click
      // handler below ever runs.
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", onClick);
      toolbar.append(item);
    };
    addButton("plan-block-edit__bold", "B", t("planFormatBold"), () => {
      if (state.container) applyInlineFormat(state.container, "strong");
    });
    addButton("plan-block-edit__italic", "I", t("planFormatItalic"), () => {
      if (state.container) applyInlineFormat(state.container, "em");
    });
    addButton("plan-block-edit__code", "</>", t("planFormatCode"), () => {
      if (state.container) applyInlineFormat(state.container, "code");
    });
    addButton("plan-block-edit__link", "🔗", t("planFormatLink"), () => {
      if (state.container) startLinkEdit(state.container, toolbar);
    });
    toolbar.append(el("span", "plan-block-edit__divider"));
    addButton("plan-block-edit__comment", t("planComment"), t("planCommentOnBlock"), () =>
      openEditingComment(block, state.container),
    );
    return toolbar;
  }

  function onEditingKeydown(event: KeyboardEvent, state: EditingState): void {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      void finishEditing("escape");
      return;
    }
    if (meta && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      void finishEditing("cmd-s");
      return;
    }
    if (state.mode !== "rich" && event.key === "Enter" && !meta) {
      event.preventDefault();
      if (state.container) insertPlainNewline(state.container);
      return;
    }
    if (state.mode !== "rich") return;
    if (meta && (event.key === "b" || event.key === "B")) {
      event.preventDefault();
      if (state.container) applyInlineFormat(state.container, "strong");
    } else if (meta && (event.key === "i" || event.key === "I")) {
      event.preventDefault();
      if (state.container) applyInlineFormat(state.container, "em");
    }
  }

  /** Builds the live editable node for `block`, fresh from its own
   *  html/source — never from `content`'s already-rendered (and possibly
   *  comment-mark-annotated) DOM, so blockToMarkdown always sees exactly
   *  what Task 1's parser produced plus the user's own edits, nothing else.
   *  Always `contenteditable`, never `<textarea>` — see EditMode's comment
   *  on why a textarea's `.textContent` would go stale under blockToMarkdown. */
  function buildEditableContainer(block: PlanBlock, mode: EditMode): HTMLElement {
    if (mode === "raw") {
      const raw = el("div", "plan-block-edit__raw");
      raw.textContent = block.source;
      return raw;
    }
    if (mode === "code") {
      const code = el("div", "plan-block-edit__code");
      code.append(parseBlockHtml(block.html));
      return code;
    }
    const rich = el("div", "plan-block-edit__rich plan-block");
    rich.append(parseBlockHtml(block.html));
    return rich;
  }

  /** Renders the block currently in `editing`. Reuses `editing.container`
   *  across re-renders once it exists, rather than rebuilding it — an
   *  unrelated action elsewhere in the panel (toggling Source, opening the
   *  picker, …) still calls the same whole-document renderDocument(), and
   *  rebuilding fresh from block.html on every one of those would silently
   *  throw away whatever the user has typed since the edit began. */
  function renderEditingBlock(block: PlanBlock): HTMLElement {
    const state = editing;
    if (!state) return el("div", "plan-block-edit");
    const wrap = el("div", "plan-block-edit");
    if (state.mode === "rich") wrap.append(renderToolbar(block, state));
    const firstRender = state.container === undefined;
    if (!state.container) {
      const container = buildEditableContainer(block, state.mode);
      container.contentEditable = "true";
      container.addEventListener("input", () => {
        if (editing !== state) return;
        state.dirty = true;
        updateHeaderDirtyUi();
      });
      container.addEventListener("keydown", (event) => onEditingKeydown(event, state));
      container.addEventListener("blur", () => void finishEditing("blur"));
      state.container = container;
    }
    wrap.append(state.container);
    wrap.append(el("p", "plan-block-edit__hint", t("planEditHint")));
    if (firstRender) queueMicrotask(() => state.container?.focus());
    return wrap;
  }

  /** Click-to-edit's entry point. Awaits the previously-editing block's own
   *  finishEditing("blur") first (same commit a real blur would trigger) so
   *  switching blocks never leaves two edits live at once; a conflict notice
   *  already owns the panel's one write path until it's resolved. */
  async function beginEditingBlock(block: PlanBlock, index: number): Promise<void> {
    if (!currentDoc || conflict) return;
    if (editing?.blockId === block.id) return; // already editing; let the click place the caret
    if (editing) await finishEditing("blur");
    if (!currentDoc || editing || conflict) return; // state moved on while we awaited
    editing = {
      blockId: block.id,
      index,
      mode: editModeForKind(block.kind),
      container: undefined,
      dirty: false,
      baseMtimeMs: currentDoc.mtimeMs,
      saving: false,
    };
    renderDocument();
  }

  /** Clears `editing` and either re-renders in place or, if a disk change
   *  was deferred while this block was dirty (notifyChanged), reloads now —
   *  "reload happens after save/discard" applies to every way an edit
   *  without a fresh write result ends, not only the conflict notice's own
   *  Discard button. */
  function exitEditing(): void {
    const path = currentDoc?.path;
    editing = undefined;
    if (diskChangedWhileDirty && path) {
      diskChangedWhileDirty = false;
      void loadDocument(path);
      return;
    }
    renderDocument();
  }

  /** Save-or-revert for the block currently in `editing`. `"escape"` always
   *  discards without writing; `"blur"`/`"cmd-s"` write only when a real
   *  `input` happened and the result isn't a no-op against the block's own
   *  source (the controller's dirty-flag ruling) — `"blur"` then exits edit
   *  mode either way, `"cmd-s"` stays in it. A conflict/missing-block result
   *  hands off to `conflict`, keeping the user's text; any other failure
   *  reason (forbidden/not-found/too-large/io) or a thrown rejection shows
   *  the generic action error and exits, same posture as this file's other
   *  async actions (save/edit/delete/send). */
  async function finishEditing(reason: "blur" | "cmd-s" | "escape"): Promise<void> {
    const state = editing;
    if (!state || !currentDoc || state.saving) return;
    const block =
      currentDoc.blocks.find((candidate) => candidate.id === state.blockId) ??
      currentDoc.blocks[state.index];
    if (!block) {
      exitEditing();
      return;
    }
    if (reason === "escape") {
      exitEditing();
      return;
    }
    const next = state.container
      ? blockToMarkdown(state.container, {
          kind: block.kind,
          level: block.level,
          source: block.source,
        })
      : block.source;
    const shouldWrite = state.dirty && !isNoopEdit(next, block.source);
    if (!shouldWrite) {
      if (reason === "blur") exitEditing();
      return;
    }
    state.saving = true;
    let result: PlanResult<PlanDoc>;
    try {
      result = await api.plansWriteBlock(currentDoc.path, block.id, next, state.baseMtimeMs);
    } catch {
      actionError = t("planActionError");
      exitEditing();
      return;
    }
    if (!result.ok) {
      if (result.reason === "conflict" || result.reason === "missing-block") {
        if (result.doc) currentDoc = result.doc;
        conflict = { blockId: block.id, index: state.index, text: next, reason: result.reason };
        editing = undefined;
        // The doc is already fresh from this failed write's own `doc`, and
        // `conflict` now owns the panel's write path — a deferred reload
        // (exitEditing) would be redundant and could clobber `conflict`.
        diskChangedWhileDirty = false;
        renderDocument();
        return;
      }
      actionError = t(planErrorKey(result.reason));
      exitEditing();
      return;
    }
    currentDoc = result.value;
    diskChangedWhileDirty = false;
    if (reason === "blur") {
      editing = undefined;
    } else {
      const fresh = currentDoc.blocks[state.index];
      editing = fresh
        ? {
            blockId: fresh.id,
            index: state.index,
            mode: state.mode,
            container: undefined,
            dirty: false,
            baseMtimeMs: currentDoc.mtimeMs,
            saving: false,
          }
        : undefined;
    }
    renderDocument();
  }

  /** The "Changed on disk — reapply your edit?" notice (D2): a standalone
   *  section, independent of which (if any) block currently occupies
   *  `conflict`'s old position — same posture as renderDraftOrphanNotice for
   *  a comment draft whose block is gone. */
  function renderConflictNotice(): HTMLElement {
    const state = conflict;
    if (!state) return el("div", "plan-panel__conflict");
    const box = el("div", "plan-panel__conflict");
    box.append(el("p", "plan-panel__conflict-notice", t("planEditConflictNotice")));
    const textarea = el("textarea", "plan-panel__conflict-textarea");
    textarea.value = state.text;
    const actions = el("div", "plan-panel__comment-actions");
    const discard = button("plan-panel__secondary", t("planDiscard"), "discard-edit-conflict");
    const apply = button("plan-panel__primary", t("planApply"), "apply-edit-conflict");
    discard.addEventListener("click", () => {
      conflict = undefined;
      const path = currentDoc?.path;
      if (diskChangedWhileDirty && path) {
        diskChangedWhileDirty = false;
        void loadDocument(path);
        return;
      }
      renderDocument();
    });
    apply.addEventListener("click", () => void applyConflict(textarea.value));
    actions.append(discard, apply);
    box.append(textarea, actions);
    return box;
  }

  async function applyConflict(text: string): Promise<void> {
    if (!currentDoc || !conflict) return;
    const targetId = pickConflictTargetId(currentDoc, conflict);
    if (targetId === undefined) {
      conflict = { ...conflict, text };
      actionError = t("planEditConflictGone");
      renderDocument();
      return;
    }
    let result: PlanResult<PlanDoc>;
    try {
      result = await api.plansWriteBlock(currentDoc.path, targetId, text, currentDoc.mtimeMs);
    } catch {
      actionError = t("planActionError");
      renderDocument();
      return;
    }
    if (!result.ok) {
      if (result.reason === "conflict" || result.reason === "missing-block") {
        if (result.doc) currentDoc = result.doc;
        conflict = { blockId: targetId, index: conflict.index, text, reason: result.reason };
        renderDocument();
        return;
      }
      actionError = t(planErrorKey(result.reason));
      renderDocument();
      return;
    }
    currentDoc = result.value;
    conflict = undefined;
    renderDocument();
  }

  function renderBlock(block: PlanBlock, index: number): HTMLElement {
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
    if (editing?.blockId === block.id) {
      content.append(renderEditingBlock(block));
    } else {
      content.append(parseBlockHtml(block.html));
      for (const comment of blockComments) wrapFirstText(content, comment.quote);
      content.addEventListener("click", () => {
        hooks.onBlockClick?.(block, content);
        void beginEditingBlock(block, index);
      });
    }
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
    if (conflict) body.append(renderConflictNotice());
    if (draft && !doc.blocks.some((block) => block.id === draft?.blockId)) {
      body.append(renderDraftOrphanNotice());
    }
    if (sourceVisible) {
      body.append(
        el("pre", "plan-panel__source", doc.blocks.map((block) => block.source).join("\n\n")),
      );
    } else {
      doc.blocks.forEach((block, index) => {
        body.append(renderBlock(block, index));
      });
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
      if (currentDoc?.path !== path) return;
      // A dirty edit's reload is deferred until it's saved or discarded
      // (finishEditing/renderConflictNotice's Discard) — an immediate
      // reload here would rebuild the block from the doc's own html/source
      // and silently drop whatever the user has typed.
      if (editing?.dirty) {
        diskChangedWhileDirty = true;
        updateHeaderDirtyUi();
        return;
      }
      void loadDocument(path);
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
