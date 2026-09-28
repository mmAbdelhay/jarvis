import type { AnchoredComment, PlanBlock, PlanComment } from "@jarvis/core";
import type { PlanDoc, PlanList, PlanResult } from "@jarvis/platform";
import type { MessageKey } from "../src/messages.js";
import {
  blockToMarkdown,
  hasOnlyRichMarkup,
  isNoopEdit,
  replaceImagesWithPlaceholders,
} from "./plan-dom-markdown.js";

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
  /** The block's own kind, fixed for the life of this edit (only its
   *  source changes) — Enter's rich/list split and the paste handler both
   *  need it without re-deriving it from `currentDoc` each time. */
  kind: PlanBlock["kind"];
  mode: EditMode;
  /** Undefined only for the instant between opening the edit and
   *  renderEditingBlock building the first DOM node — every listener reads
   *  it lazily, by which point it always exists. */
  container: HTMLElement | undefined;
  /** The outer `.plan-block-edit` wrapper (toolbar + container + hint),
   *  reassigned on every renderEditingBlock call. Fix round 1, I1: the
   *  container's own blur listener checks `wrap.contains(relatedTarget)`
   *  so focusing the toolbar's own link-URL input doesn't read as leaving
   *  the edit. */
  wrap: HTMLElement | undefined;
  /** Fix round 5, item 1: the pointer position of the mouse gesture that
   *  opened this edit, if any. Consumed on the first render to put the
   *  caret where the user clicked instead of at offset 0. */
  caretPoint: CaretPoint | undefined;
  /** Set only by a real `input` event in `container` — a click that opens
   *  the block and a blur that immediately follows it must never write. */
  dirty: boolean;
  /** Fix round 1, I2: incremented on every `input` event. finishEditing
   *  snapshots this before a ⌘S save's own await and compares it after, so
   *  typing that happens *during* an in-flight save is never mistaken for
   *  "nothing changed since" and silently dropped. */
  inputCount: number;
  baseMtimeMs: number;
  saving: boolean;
};

type ConflictState = {
  /** The block id the failed write targeted — checked first on Apply. */
  blockId: string;
  /** Index fallback for Apply, same reasoning as EditingState.index. */
  index: number;
  /** Fix round 1, I4: Apply's index fallback only fires when the block now
   *  at that index is still the same kind as the one that was being
   *  edited — otherwise the whole document reshuffled and index alone
   *  proves nothing. */
  kind: PlanBlock["kind"];
  text: string;
  /** Final fix wave I3: every failed write lands here, not only a
   *  conflict — "rejected" is the IPC promise itself rejecting. */
  reason: PlanReadError["reason"] | "rejected";
};

/** A block the user clicked while a *different* block's own save (always
 *  blur-triggered — a real click on another block always blurs whatever was
 *  focused first) is still in flight. Fix round 4, item B: recorded when a
 *  mousedown/mouseup pair on the same block is confirmed (see
 *  onBlockMouseUp), never on `click` — Chromium fires no click at all when
 *  the outgoing block's blur-exit rebuilt the rows between mousedown and
 *  mouseup. Consumed once the interrupted save actually settles (see
 *  consumePendingEditTarget, called explicitly from finishEditing's own
 *  post-await handling — never by exitEditing on its own), so switching
 *  blocks while a save is in flight still opens the new one automatically
 *  instead of needing a second click. */
type PendingEditTarget = { blockId: string; index: number; point?: CaretPoint };

type CaretPoint = { x: number; y: number };

/** Both hit-test APIs, feature-detected: Chromium ships
 *  caretRangeFromPoint, the standard caretPositionFromPoint is the
 *  fallback, and jsdom has neither. */
type CaretHitTestDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

function caretRangeAt(point: CaretPoint): Range | undefined {
  const hitTest = document as CaretHitTestDocument;
  if (typeof hitTest.caretRangeFromPoint === "function") {
    return hitTest.caretRangeFromPoint(point.x, point.y) ?? undefined;
  }
  if (typeof hitTest.caretPositionFromPoint === "function") {
    const position = hitTest.caretPositionFromPoint(point.x, point.y);
    if (!position) return undefined;
    const range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  }
  return undefined;
}

/** Fix round 5, item 1: a collapsed caret at the pointer when that lands
 *  inside `container`, otherwise at the end of its last text. */
function placeCaret(container: HTMLElement, point: CaretPoint): void {
  const selection = window.getSelection();
  if (!selection) return;
  let range = caretRangeAt(point);
  if (!range || !container.contains(range.startContainer)) {
    range = document.createRange();
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let lastText: Node | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) lastText = node;
    if (lastText) range.setStart(lastText, lastText.textContent?.length ?? 0);
    else range.selectNodeContents(container);
    range.collapse(lastText !== null);
  } else {
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

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

/** Final fix wave I1 (controller ruling): a rich-kind block whose HTML
 *  holds any element its rich converter can't read back (a code block
 *  inside a list item, a list inside a quote, …) edits as raw markdown
 *  instead, so saving can never silently drop that markup. */
function editModeForBlock(block: PlanBlock): EditMode {
  const mode = editModeForKind(block.kind);
  if (mode !== "rich") return mode;
  return hasOnlyRichMarkup(inertFragment(block.html), block.kind) ? "rich" : "raw";
}

/** The failure notice's own reason line, translated. */
function conflictReasonKey(reason: ConflictState["reason"]): MessageKey {
  return reason === "rejected" ? "planActionError" : planErrorKey(reason);
}

/** Apply's own target-id rule: the block the failed write aimed at, if it's
 *  still there under the fresh doc — otherwise whatever now sits at the same
 *  index, but only if it's still the *same kind* (fix round 1, I4): the
 *  index alone proves nothing once the document has genuinely reshuffled
 *  (a block inserted/removed elsewhere), and writing the edited text onto
 *  an unrelated block would be worse than refusing. A block's id is a hash
 *  of its own kind+source (@jarvis/core's blockId()), so any real content
 *  change on disk changes it. */
function pickConflictTargetId(doc: PlanDoc, state: ConflictState): string | undefined {
  if (doc.blocks.some((candidate) => candidate.id === state.blockId)) return state.blockId;
  const atIndex = doc.blocks[state.index];
  return atIndex && atIndex.kind === state.kind ? atIndex.id : undefined;
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
  const fragment = inertFragment(html);
  removeRemoteImages(fragment);
  return fragment;
}

/** Trusted block HTML parsed inside an inert `<template>` (see
 *  parseBlockHtml): nothing in it fetches until it's moved into the live
 *  document, which only ever happens after its remote images are replaced. */
function inertFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
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
  let pendingEditTarget: PendingEditTarget | undefined;
  // Fix round 4, item B: the block id a primary-button mousedown landed on
  // (outside any link, not the block being edited). Only a mouseup that
  // resolves to the same block id — re-queried by data-block-id, since the
  // rows may have been rebuilt in between — with a collapsed selection
  // turns it into an edit.
  // Fix round 5, item 2: plus where and when that mousedown happened, so a
  // stationary pointer still confirms after a layout shift moved B away.
  let switchCandidate: { blockId: string; x: number; y: number; at: number } | undefined;
  // Fix round 3, item A: the exact mtime our own last successful
  // plansWriteBlock/applyConflict returned for a path. A file watcher
  // cannot tell "Jarvis just wrote this" apart from "something else did" —
  // this is the one thing that can: when a reload's own freshly-read mtime
  // matches, it's an echo of our own write, not a real external change.
  let lastOwnWrite: { path: string; mtimeMs: number } | undefined;
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

  /** Inserts `text` as a single literal text node at the caret — used for
   *  code/raw's Enter (a literal "\n") and for a code/raw paste (clipboard
   *  text verbatim, embedded newlines and all). A text node's content is
   *  just a string, so a literal "\n" inside it round-trips exactly through
   *  blockToMarkdown's `.textContent` reads — unlike a real Enter's default
   *  contenteditable behavior, which often inserts a *new block element*
   *  instead of a "\n" character, silently dropped by `.textContent` since
   *  it never inserts a separator between sibling elements. */
  function insertTextNode(container: HTMLElement, text: string): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.setEndAfter(node);
    selection.removeAllRanges();
    selection.addRange(range);
    container.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Fix round 3, item C: the nearest p/li/heading ancestor of `node`
   *  (stopping at `container` itself if there's none) — a single "line"
   *  for insertHardBreak's own atEnd purposes. Measuring all the way to
   *  `container`'s own end was wrong for quote, whose container can hold
   *  *several* `<p>` paragraphs: a caret at the end of the first of two
   *  would see the second paragraph's text as "content after the caret"
   *  and never add the caret-visibility filler, even though there is
   *  nothing left on that first paragraph's own line. */
  function enclosingBlockElement(node: Node, container: HTMLElement): Element {
    let current: Node | null = node;
    while (current && current !== container) {
      if (current.nodeType === Node.ELEMENT_NODE) {
        const tag = (current as Element).tagName.toLowerCase();
        if (tag === "p" || tag === "li" || /^h[1-6]$/.test(tag)) return current as Element;
      }
      current = current.parentNode;
    }
    return container;
  }

  /** Inserts `text` at the caret for *rich* mode (paragraph/heading/quote/
   *  list): each embedded newline becomes a `<br>` hard break, never a new
   *  top-level p/div/h* sibling — a literal "\n" text node here would
   *  either render as a soft break inside the same paragraph or, on a
   *  blank line, split what should be one block's markdown into two when
   *  written back. Used by both Enter (fix round 1, C1) and paste. */
  function insertHardBreak(container: HTMLElement): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();

    // Fix round 2, item 5: whether there's any real content left after the
    // caret on this same line — a lone trailing `<br>` with nothing after
    // it doesn't visually drop a real browser's caret to a new line (the
    // classic contenteditable "trailing <br> collapses" quirk), so a
    // second, caret-side filler goes in too. It never actually gets saved
    // (see withoutTrailingBreaks, used when finishEditing computes what to
    // write) — it's purely there for the caret to land on a real line, and
    // disappears again the moment real content follows it instead.
    const enclosing = enclosingBlockElement(range.endContainer, container);
    const tail = document.createRange();
    tail.setStart(range.endContainer, range.endOffset);
    tail.setEnd(enclosing, enclosing.childNodes.length);
    // Not `.childElementCount === 0` too: cloneContents() on a range whose
    // start is *inside* an ancestor (here, the caret's own <p>) and whose
    // end is outside it (the enclosing element's own top level) clones
    // that ancestor as an empty shell to hold "whatever's left of it" —
    // even when nothing is left, contributing an empty <p></p> to the
    // fragment. `.textContent` alone already answers "is there any real
    // content after the caret" correctly regardless of that wrapper.
    const atEnd = (tail.cloneContents().textContent ?? "") === "";

    const br = document.createElement("br");
    range.insertNode(br);
    if (atEnd) br.after(document.createElement("br"));

    const caret = document.createRange();
    caret.setStartAfter(br);
    caret.setEndAfter(br);
    selection.removeAllRanges();
    selection.addRange(caret);
    container.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** The last *meaningful* node in `node`'s subtree in document order —
   *  descends via `lastChild` (a void element like `<br>` has none, so it
   *  stops there and reports itself), skipping back over trailing empty
   *  text nodes at each level (fix round 3, item C: an empty text node
   *  sitting after a real trailing `<br>` — e.g. `<p>text<br></p>`'s own
   *  container boundary — would otherwise report itself as "the last
   *  node", masking that `<br>` from withoutTrailingBreaks entirely). */
  function lastLeaf(node: Node): Node {
    let current: Node = node;
    for (;;) {
      let child = current.lastChild;
      while (child && child.nodeType === Node.TEXT_NODE && (child.textContent ?? "") === "") {
        child = child.previousSibling;
      }
      if (!child) return current;
      current = child;
    }
  }

  /** A trailing `<br>` (or run of them) with nothing after it is never
   *  meaningful markdown — there is no next line for it to separate — and
   *  is exactly what insertHardBreak leaves at the very end of a block
   *  purely so a real browser's caret visibly drops to a new line (fix
   *  round 2, item 5). Removes the deepest last node repeatedly as long as
   *  it's a `<br>`, so this finds a trailing break regardless of how many
   *  levels of p/blockquote it's nested under — from a *clone*, never the
   *  live container, so the user's own caret/selection is untouched. A
   *  no-op once real content follows the break instead (typing between a
   *  hard break and its own caret-side filler moves the filler back to
   *  being the trailing one, so it alone is what this strips). */
  function withoutTrailingBreaks(container: HTMLElement): HTMLElement {
    const clone = container.cloneNode(true) as HTMLElement;
    for (;;) {
      const leaf = lastLeaf(clone);
      if (leaf.nodeName !== "BR") break;
      leaf.parentNode?.removeChild(leaf);
    }
    return clone;
  }

  function insertPastedRichText(container: HTMLElement, text: string): void {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    text.split("\n").forEach((line, index) => {
      if (index > 0) fragment.append(document.createElement("br"));
      if (line.length > 0) fragment.append(document.createTextNode(line));
    });
    const lastNode = fragment.lastChild;
    range.insertNode(fragment);
    if (lastNode) {
      range.setStartAfter(lastNode);
      range.setEndAfter(lastNode);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    container.dispatchEvent(new Event("input", { bubbles: true }));
  }

  /** Fix round 1, C1/C2: every edit mode gets a paste handler that always
   *  preventDefault()s the browser's own paste (which could otherwise
   *  insert rich HTML — multiple lines as separate <div>/<p> elements that
   *  blockToMarkdown's `.textContent`/first-match reads would flatten or
   *  drop) and inserts only the clipboard's plain text, by hand. Fix round
   *  2, item 6 (controller ruling): a heading is single-line, so a pasted
   *  newline becomes a plain space there instead of a hard break. */
  function onEditingPaste(event: ClipboardEvent, state: EditingState): void {
    event.preventDefault();
    if (!state.container) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text === "") return;
    if (state.mode !== "rich") {
      insertTextNode(state.container, text);
    } else if (state.kind === "heading") {
      insertTextNode(state.container, text.replace(/\n/g, " "));
    } else {
      insertPastedRichText(state.container, text);
    }
  }

  /** Link: wraps the selection in `<a href="">`, then swaps in an inline URL
   *  input (prompt-free, per D2) rather than window.prompt — which jsdom
   *  allows but Electron's renderer throws on (testing.md's own warning). No
   *  selection, no-op: there's nothing to make a link out of.
   *
   *  Fix round 2, item 2: the URL input's own blur used to unconditionally
   *  refocus `container` — meaning clicking anywhere *outside the whole
   *  panel* while the URL input was focused stole focus straight back into
   *  the block instead of letting it go where the user clicked, and the
   *  block was never actually committed (finishEditing("blur") never ran,
   *  since nothing ever blurred `container` itself — refocusing it
   *  *was* the last focus change). Now a blur whose relatedTarget is
   *  outside `state.wrap` entirely applies the URL without refocusing and
   *  hands off to finishEditing("blur") directly, exactly as if the user
   *  had blurred the block itself. */
  function startLinkEdit(state: EditingState, toolbar: HTMLElement): void {
    const container = state.container;
    if (!container) return;
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
    // Fix round 3, item C: set right before Enter/Escape's own
    // `input.remove()` — removing the focused `input` element fires a real
    // blur on it (relatedTarget typically unset, since focus hasn't
    // explicitly moved anywhere yet at that point), which would otherwise
    // reach the blur listener below and read as "focus left the edit
    // surface", exiting/committing a second time on top of the keydown
    // handler's own explicit `container.focus()`. This flag tells that
    // blur it's just a side effect of an already-handled Enter/Escape, not
    // a real "leaving".
    let removingViaKeydown = false;
    const applyUrl = (): void => {
      if (settled) return;
      settled = true;
      const url = input.value.trim();
      // Fix round 1, I1: an anchor nobody gave a URL is not a link — leaving
      // it wrapped would silently write `[text]()` on save.
      if (url === "") {
        anchor.replaceWith(document.createTextNode(anchor.textContent ?? ""));
      } else {
        anchor.setAttribute("href", url);
      }
      input.remove();
      container.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const cancel = (): void => {
      if (settled) return;
      settled = true;
      anchor.replaceWith(document.createTextNode(anchor.textContent ?? ""));
      input.remove();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        removingViaKeydown = true;
        applyUrl();
        container.focus(); // stay in the block, continue editing
      } else if (event.key === "Escape") {
        event.preventDefault();
        removingViaKeydown = true;
        cancel();
        container.focus();
      }
    });
    input.addEventListener("blur", (event) => {
      if (removingViaKeydown) return;
      const related = event.relatedTarget;
      const staysInWrap = related instanceof Node && !!state.wrap?.contains(related);
      applyUrl();
      if (staysInWrap) {
        container.focus();
      } else {
        // Fix round 2, item 2: focus genuinely left the edit surface — let
        // it go there (never refocus `container`, unlike the old
        // unconditional `container.focus()` this replaced, which stole
        // focus back and meant the block was never actually committed:
        // nothing else was left to blur `container` again and trigger
        // it). Hand off to finishEditing("blur") directly instead, exactly
        // as if the user had blurred the block itself.
        void finishEditing("blur");
      }
    });
    toolbar.append(input);
    queueMicrotask(() => input.focus());
  }

  /** The toolbar's amber Comment button: opens the same draft flow as the
   *  gutter's own + pin, quoting the current selection if there is one
   *  (mirrors selectionChanged's own selection-to-quote behaviour). Inserts
   *  the box directly, rather than through renderDocument() — a full
   *  re-render would rebuild the block being edited from the doc's
   *  original html/source and discard whatever the user has typed.
   *
   *  Fix round 2, item 1: resolves the block from `state.blockId` *at click
   *  time*, not from a `block` object closed over when the toolbar was
   *  built — a ⌘S save that keeps editing in place (finishEditing's own
   *  cmd-s branch) updates `state.blockId` without a re-render, so a
   *  toolbar built before that save would otherwise still hold the
   *  pre-save block and anchor the comment to an id that's no longer in
   *  `currentDoc` at all. */
  function openEditingComment(state: EditingState, container: HTMLElement | undefined): void {
    if (!currentDoc) return;
    const block = currentDoc.blocks.find((candidate) => candidate.id === state.blockId);
    if (!block) return;
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

  function renderToolbar(state: EditingState): HTMLElement {
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
      if (state.container) startLinkEdit(state, toolbar);
    });
    toolbar.append(el("span", "plan-block-edit__divider"));
    addButton("plan-block-edit__comment", t("planComment"), t("planCommentOnBlock"), () =>
      openEditingComment(state, state.container),
    );
    return toolbar;
  }

  function onEditingKeydown(event: KeyboardEvent, state: EditingState): void {
    const meta = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      // Fix round 1, minor: without this, Esc also reaches any ancestor
      // Esc-handling (a future panel-level Esc-to-close, a global keymap) —
      // the editor owns this keypress once it's handling it.
      event.stopPropagation();
      void finishEditing("escape");
      return;
    }
    if (meta && (event.key === "s" || event.key === "S")) {
      event.preventDefault();
      event.stopPropagation();
      void finishEditing("cmd-s");
      return;
    }
    if (event.key === "Enter" && !meta) {
      // Fix round 1, C1: paragraph/quote get a hard break, same as
      // Shift+Enter (shiftKey is irrelevant here — both hit this branch);
      // list is the one rich kind left alone, since Enter there creates a
      // real new <li> that renderList already knows how to read back.
      // Fix round 2, item 6 (controller ruling): heading is single-line —
      // Enter is swallowed but inserts nothing at all.
      if (state.mode === "rich") {
        if (state.kind === "list") return;
        event.preventDefault();
        if (state.kind === "heading") return;
        if (state.container) insertHardBreak(state.container);
        return;
      }
      event.preventDefault();
      if (state.container) insertTextNode(state.container, "\n");
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
    // Final fix wave I1: not parseBlockHtml — its alt-text stand-in drops
    // each remote image's src, which a save would then write back without.
    const rich = el("div", "plan-block-edit__rich plan-block");
    const fragment = inertFragment(block.html);
    replaceImagesWithPlaceholders(fragment);
    rich.append(fragment);
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
    // Reassigned on every render (even those that reuse `state.container`)
    // — the blur listener below reads it lazily, by which point it's
    // always this render's own wrap.
    state.wrap = wrap;
    if (state.mode === "rich") wrap.append(renderToolbar(state));
    const firstRender = state.container === undefined;
    if (!state.container) {
      const container = buildEditableContainer(block, state.mode);
      // setAttribute, not the `.contentEditable` property: real Chromium
      // reflects either the same way, but the property setter alone
      // leaves the element non-focusable under jsdom (no attribute is
      // ever actually set), which would make every blur/focus test below
      // silently no-op instead of exercising the real bug.
      container.setAttribute("contenteditable", state.mode === "rich" ? "true" : "plaintext-only");
      container.addEventListener("input", () => {
        if (editing !== state) return;
        state.dirty = true;
        state.inputCount += 1;
        updateHeaderDirtyUi();
      });
      container.addEventListener("keydown", (event) => onEditingKeydown(event, state));
      container.addEventListener("paste", (event) => onEditingPaste(event, state));
      container.addEventListener("blur", (event) => {
        // Fix round 1, I1: focus moving to the toolbar's own link-URL
        // input (or anywhere else inside this same edit wrapper) is not
        // leaving the edit — only a blur whose relatedTarget is outside
        // `state.wrap` entirely commits/exits.
        const related = event.relatedTarget;
        if (related instanceof Node && state.wrap?.contains(related)) return;
        void finishEditing("blur");
      });
      state.container = container;
    }
    wrap.append(state.container);
    wrap.append(el("p", "plan-block-edit__hint", t("planEditHint")));
    if (firstRender) {
      queueMicrotask(() => {
        if (editing !== state || !state.container) return;
        state.container.focus();
        const point = state.caretPoint;
        state.caretPoint = undefined;
        if (point) placeCaret(state.container, point);
      });
    }
    return wrap;
  }

  /** Click-to-edit's entry point. Awaits the previously-editing block's own
   *  finishEditing("blur") first (same commit a real blur would trigger) so
   *  switching blocks never leaves two edits live at once; a conflict notice
   *  already owns the panel's one write path until it's resolved. */
  async function beginEditingBlock(
    block: PlanBlock,
    index: number,
    caretPoint?: CaretPoint,
  ): Promise<void> {
    if (!currentDoc || conflict) return;
    if (editing?.blockId === block.id) return; // already editing; let the click place the caret
    if (editing) await finishEditing("blur");
    if (!currentDoc || editing || conflict) return; // state moved on while we awaited
    editing = {
      blockId: block.id,
      index,
      kind: block.kind,
      mode: editModeForBlock(block),
      container: undefined,
      wrap: undefined,
      dirty: false,
      inputCount: 0,
      baseMtimeMs: currentDoc.mtimeMs,
      saving: false,
      caretPoint,
    };
    renderDocument();
  }

  /** Fix round 3, item B: resolves a click-recorded switch target once the
   *  save it interrupted has actually settled — see PendingEditTarget's
   *  own comment for why this exists. Looked up by id, falling back to
   *  index the same way finishEditing/applyConflict do, since the
   *  outgoing edit's own save may have changed ids around it. Called
   *  explicitly by finishEditing's own exit points, never by exitEditing
   *  itself — exitEditing has callers (the conflict notice's Discard) that
   *  have nothing to do with a block switch and must not open one. */
  function consumePendingEditTarget(): void {
    const pending = pendingEditTarget;
    pendingEditTarget = undefined;
    if (!pending || !currentDoc || editing || conflict || disposed) return;
    const target =
      currentDoc.blocks.find((candidate) => candidate.id === pending.blockId) ??
      currentDoc.blocks[pending.index];
    if (!target) return;
    void beginEditingBlock(target, currentDoc.blocks.indexOf(target), pending.point);
  }

  /** Clears `editing` and either re-renders in place or, if a disk change
   *  was deferred while this block was dirty (notifyChanged), reloads now —
   *  "reload happens after save/discard" applies to every way an edit
   *  without a fresh write result ends, not only the conflict notice's own
   *  Discard button. Fix round 3, item B: does *not* consume a pending
   *  switch target on its own — see consumePendingEditTarget's own
   *  comment for why that's now the caller's job. */
  function exitEditing(): void {
    const path = currentDoc?.path;
    editing = undefined;
    if (diskChangedWhileDirty && path) {
      diskChangedWhileDirty = false;
      void loadDocument(path);
    } else {
      renderDocument();
    }
  }

  /** Final fix wave I3: every failed write — a conflict, any other
   *  PlanResult failure reason, or the IPC promise itself rejecting — hands
   *  the typed text to the notice (`conflict`) with its reason, never
   *  discarding it. A failure that carries a fresh `doc` (conflict,
   *  missing-block) adopts it; any other leaves `currentDoc` as it was, so
   *  Apply retries against the same base. */
  function failWrite(
    state: EditingState,
    block: PlanBlock,
    text: string,
    reason: ConflictState["reason"],
    doc: PlanDoc | undefined,
  ): void {
    if (doc) {
      currentDoc = doc;
      // The doc is already fresh from this failed write's own `doc`, and
      // `conflict` now owns the panel's write path — a deferred reload
      // (exitEditing) would be redundant and could clobber `conflict`.
      // Without a fresh doc the deferral stays: Discard reloads then.
      diskChangedWhileDirty = false;
    }
    conflict = { blockId: block.id, index: state.index, kind: block.kind, text, reason };
    editing = undefined;
    renderDocument();
    // Fix round 3, item B: `editing` just became undefined the same way
    // exitEditing() would have left it, so a block switch that was waiting
    // on *this* save still resolves — blocked, harmlessly, by
    // consumePendingEditTarget's own conflict guard.
    consumePendingEditTarget();
  }

  /** Final fix wave I6: an own write changes the edited block's id (main
   *  re-points its comments to the new id), and the watcher echo of that
   *  write is ignored, so the comments are re-fetched here. Pins and the
   *  tray are patched in place while an editor or a comment draft is open
   *  (a full render would rebuild them from scratch); otherwise the
   *  document simply re-renders. */
  async function refreshCommentsAfterOwnWrite(path: string): Promise<void> {
    let next: AnchoredComment[];
    try {
      next = await api.plansComments(path);
    } catch {
      return; // the pins just stay as they were; the write itself succeeded
    }
    if (disposed || currentDoc?.path !== path) return;
    comments = next;
    if (!editing && !draft) {
      renderDocument();
      return;
    }
    const doc = currentDoc;
    for (const row of root.querySelectorAll<HTMLElement>(".plan-panel__block-row")) {
      const id = row.querySelector<HTMLElement>(":scope > [data-block-id]")?.dataset.blockId;
      const block = doc.blocks.find((candidate) => candidate.id === id);
      const gutter = row.querySelector(":scope > .plan-panel__gutter");
      if (block && gutter) gutter.replaceWith(renderGutter(block));
    }
    root.querySelector(".plan-panel__tray")?.replaceWith(renderTray());
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
      consumePendingEditTarget();
      return;
    }
    if (reason === "escape") {
      // Fix round 2, item 4: cancelling this block's edit must not later
      // surprise-open some other block a stray click recorded — the
      // user's actual intent right now is "leave this one alone".
      pendingEditTarget = undefined;
      exitEditing();
      return;
    }
    // Raw mode holds the block's markdown verbatim, whatever its kind
    // (final fix wave I1: a rich kind can open raw too).
    const next = !state.container
      ? block.source
      : state.mode === "raw"
        ? (state.container.textContent ?? "")
        : blockToMarkdown(
            state.mode === "rich" ? withoutTrailingBreaks(state.container) : state.container,
            { kind: block.kind, level: block.level, source: block.source },
          );
    const shouldWrite = state.dirty && !isNoopEdit(next, block.source);
    if (!shouldWrite) {
      if (reason === "blur") {
        exitEditing();
        consumePendingEditTarget();
      } else {
        pendingEditTarget = undefined; // cmd-s with nothing to save: same reasoning as escape
      }
      return;
    }
    state.saving = true;
    // Fix round 1, I2: snapshotted before the await, compared after — an
    // `input` that happens while this write is in flight bumps
    // state.inputCount past this, so it's never mistaken for "nothing
    // changed since the save started" and left clean when it isn't.
    const inputCountAtSaveStart = state.inputCount;
    const blockCountBefore = currentDoc.blocks.length;
    let result: PlanResult<PlanDoc>;
    try {
      result = await api.plansWriteBlock(currentDoc.path, block.id, next, state.baseMtimeMs);
    } catch {
      if (disposed) return;
      failWrite(state, block, next, "rejected", undefined);
      return;
    }
    if (disposed) return;
    if (!result.ok) {
      failWrite(state, block, next, result.reason, result.doc);
      return;
    }
    currentDoc = result.value;
    lastOwnWrite = { path: currentDoc.path, mtimeMs: currentDoc.mtimeMs };
    diskChangedWhileDirty = false;
    state.saving = false;
    void refreshCommentsAfterOwnWrite(currentDoc.path);
    // Final fix wave I2: a ⌘S whose text no longer maps onto exactly this
    // one block (a pasted blank line split it, a raw edit added a block)
    // can't keep editing in place — the live container would still hold
    // every resulting block's text, and the next save would write all of
    // it over the first one. Exits and re-renders instead, as blur does.
    const fresh = currentDoc.blocks[state.index];
    const structureChanged =
      currentDoc.blocks.length !== blockCountBefore ||
      fresh?.start !== block.start ||
      (fresh !== undefined && fresh.end - fresh.start !== next.split("\n").length);
    if (reason === "blur" || !fresh || structureChanged) {
      exitEditing();
      consumePendingEditTarget();
      return;
    }
    // "cmd-s": keep editing the SAME container/state in place rather than
    // rebuilding it — a re-render here would reconstruct the editable DOM
    // fresh from the doc's own (just-saved) html, discarding any input
    // that happened while the write above was in flight (I2).
    state.blockId = fresh.id;
    state.baseMtimeMs = currentDoc.mtimeMs;
    state.dirty = state.inputCount !== inputCountAtSaveStart;
    // Fix round 2, item 1: the outer `.plan-block` row's own data-block-id
    // is stamped once at render time and there is no re-render here to
    // refresh it — patched directly so a text selection made right after
    // this save (selectionChanged's own closest() lookup) still anchors to
    // the block's real (now content-hashed-different) id. `state.wrap`'s
    // parent is that outer row's content element — not
    // `state.container.closest(".plan-block")`, which matches `container`
    // itself first, since the rich container also carries that class for
    // its own typography.
    state.wrap?.parentElement?.setAttribute("data-block-id", fresh.id);
    // Fix round 2, item 4: an explicit save means any switch the user was
    // mid-mousedown-into is stale — it either already completed via the
    // normal blur path, or the user changed their mind; either way it must
    // not surprise-open some other block once this save settles.
    pendingEditTarget = undefined;
    updateHeaderDirtyUi();
  }

  /** The "Changed on disk — reapply your edit?" notice (D2): a standalone
   *  section, independent of which (if any) block currently occupies
   *  `conflict`'s old position — same posture as renderDraftOrphanNotice for
   *  a comment draft whose block is gone. */
  function renderConflictNotice(): HTMLElement {
    const state = conflict;
    if (!state || !currentDoc) return el("div", "plan-panel__conflict");
    const box = el("div", "plan-panel__conflict");
    if (state.reason === "conflict" || state.reason === "missing-block") {
      box.append(el("p", "plan-panel__conflict-notice", t("planEditConflictNotice")));
    } else {
      // Final fix wave I3: a save that failed for any other reason keeps
      // the text here too, saying why.
      box.append(
        el("p", "plan-panel__conflict-notice", t("planEditSaveFailed")),
        el("p", "plan-panel__conflict-reason", t(conflictReasonKey(state.reason))),
      );
    }

    // Fix round 1, I4: shows exactly what Apply would overwrite, so the
    // user isn't reapplying blind — or, if Apply has nothing left to
    // target (pickConflictTargetId's own id-then-same-kind-index rule),
    // says so up front rather than waiting for a click to find out.
    const targetId = pickConflictTargetId(currentDoc, state);
    const targetBlock = targetId
      ? currentDoc.blocks.find((candidate) => candidate.id === targetId)
      : undefined;
    if (targetBlock) {
      box.append(el("p", "plan-panel__conflict-current-label", t("planEditConflictCurrent")));
      const preview = el("pre", "plan-panel__conflict-current");
      preview.textContent = targetBlock.source;
      box.append(preview);
    } else {
      box.append(el("p", "plan-panel__conflict-gone", t("planEditConflictGone")));
    }

    const textarea = el("textarea", "plan-panel__conflict-textarea");
    textarea.value = state.text;
    // Fix round 1, I3: without this, an unrelated re-render (toggling
    // Source, opening the picker) rebuilds this textarea from `state.text`
    // as it was when the conflict first appeared, silently dropping
    // anything typed into it since.
    textarea.addEventListener("input", () => {
      if (conflict) conflict.text = textarea.value;
    });
    const actions = el("div", "plan-panel__comment-actions");
    const discard = button("plan-panel__secondary", t("planDiscard"), "discard-edit-conflict");
    const apply = button("plan-panel__primary", t("planApply"), "apply-edit-conflict");
    discard.addEventListener("click", () => {
      conflict = undefined;
      const path = currentDoc?.path;
      if (diskChangedWhileDirty && path) {
        diskChangedWhileDirty = false;
        void loadDocument(path);
        consumePendingEditTarget();
        return;
      }
      renderDocument();
      consumePendingEditTarget();
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
      if (disposed || !conflict) return;
      conflict = { ...conflict, text, reason: "rejected" };
      renderDocument();
      return;
    }
    // Bug fix: this write already landed on disk once `result.ok` — that
    // bookkeeping must happen regardless of whether Discard already cleared
    // `conflict` (or the panel got disposed) while the write was in flight.
    // Skipping it left `currentDoc`/`lastOwnWrite` stale even though the
    // file had moved on, so the panel's own next save went out with a
    // stale mtimeMs and was falsely rejected as a conflict against itself.
    if (result.ok) {
      currentDoc = result.value;
      lastOwnWrite = { path: currentDoc.path, mtimeMs: currentDoc.mtimeMs };
      void refreshCommentsAfterOwnWrite(currentDoc.path);
    }
    if (disposed || !conflict) return;
    if (!result.ok) {
      if (result.doc) currentDoc = result.doc;
      conflict = {
        blockId: targetId,
        index: conflict.index,
        kind: conflict.kind,
        text,
        reason: result.reason,
      };
      renderDocument();
      return;
    }
    conflict = undefined;
    renderDocument();
    consumePendingEditTarget();
  }

  function blockCommentsFor(block: PlanBlock): AnchoredComment[] {
    return comments.filter(
      (comment) => comment.anchor.kind === "block" && comment.anchor.blockId === block.id,
    );
  }

  function renderGutter(block: PlanBlock): HTMLElement {
    const gutter = el("div", "plan-panel__gutter");
    for (const comment of blockCommentsFor(block)) {
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
    return gutter;
  }

  function renderBlock(block: PlanBlock): HTMLElement {
    const row = el("div", "plan-panel__block-row");
    const gutter = renderGutter(block);
    const blockComments = blockCommentsFor(block);

    const content = el("div", "plan-block");
    content.dataset.blockId = block.id;
    if (editing?.blockId === block.id) {
      content.append(renderEditingBlock(block));
    } else {
      content.append(parseBlockHtml(block.html));
      for (const comment of blockComments) wrapFirstText(content, comment.quote);
      // Fix round 4, item B: editing opens from the document-level
      // mousedown/mouseup pair (onBlockMouseDown/onBlockMouseUp), not from
      // here — Chromium delivers no click at all when the outgoing block's
      // blur-exit rebuilt the rows between mousedown and mouseup.
      content.addEventListener("click", () => hooks.onBlockClick?.(block, content));
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

  /** Whether the open edit on `path` holds the user's own typing (dirty) or
   *  a save of it (saving) — the state a reload must never re-render over. */
  function editInProgress(path: string): boolean {
    return !!editing && currentDoc?.path === path && (editing.dirty || editing.saving);
  }

  /** loadDocument's "edit in progress on this same path" branch: a real
   *  external change only flags the header badge — no re-render, edit left
   *  open. Returns whether it flagged, i.e. whether loadDocument must stop
   *  here. Fix round 4, item A: called after *every* await in loadDocument,
   *  since the edit's dirty/saving state can change during any of them. */
  function flagIfEditInProgress(path: string): boolean {
    if (!editInProgress(path)) return false;
    diskChangedWhileDirty = true;
    updateHeaderDirtyUi();
    return true;
  }

  /** Fix round 3, item A: replaces round 2's id/index re-anchor logic
   *  entirely — it kept a stale container in place across a *real*
   *  external change and risked the next save silently overwriting it.
   *  This is simpler and echo-aware:
   *   - our own write's echo (the file watcher noticing Jarvis's own
   *     save land) → do nothing at all: no re-render, edit mode and focus
   *     untouched. Detected via `lastOwnWrite`, the one thing a watcher
   *     notification can't otherwise tell apart from a real external
   *     change.
   *   - different path → exits editing, as before.
   *   - same path, real external change, editing dirty or saving (fix
   *     round 4: re-checked after every await, not only the first) → does *not*
   *     touch the DOM; only flags `diskChangedWhileDirty` (the header
   *     badge). `baseMtimeMs` deliberately stays the (now stale) value
   *     it was based on, so this block's own eventual save discovers the
   *     change the same way any other conflict is discovered — the
   *     server's own mtime check, landing in the conflict notice with
   *     the user's text kept.
   *   - same path, real external change, editing clean → exits editing
   *     (nothing of the user's own to lose) and re-renders normally,
   *     rather than trying to keep a stale container open across content
   *     that's now genuinely different on disk.
   */
  async function loadDocument(path: string): Promise<void> {
    const request = ++loadId;
    const samePath = currentDoc?.path === path;
    let result: PlanResult<PlanDoc>;
    try {
      result = await api.plansRead(path);
    } catch {
      if (disposed || request !== loadId) return;
      // Nothing is known to have changed on disk; just never re-render
      // (and so rebuild) an edit that holds the user's own typing.
      if (editInProgress(path)) return;
      actionError = t("planActionError");
      renderDocument();
      return;
    }
    if (disposed || request !== loadId) return;
    if (!result.ok) {
      if (flagIfEditInProgress(path)) return;
      currentDoc = undefined;
      comments = [];
      loadError = result.reason;
      renderDocument();
      return;
    }

    if (
      lastOwnWrite &&
      lastOwnWrite.path === path &&
      lastOwnWrite.mtimeMs === result.value.mtimeMs
    ) {
      return; // our own write's echo — do nothing at all
    }

    if (flagIfEditInProgress(path)) return;

    let nextComments: AnchoredComment[];
    try {
      nextComments = await api.plansComments(path);
    } catch {
      if (disposed || request !== loadId) return;
      if (flagIfEditInProgress(path)) return;
      actionError = t("planActionError");
      renderDocument();
      return;
    }
    if (disposed || request !== loadId) return;
    // Fix round 4, item A: typing (or a save) can start during the
    // plansComments await above even though the block was clean at the
    // first check — re-checked after every await, never trusted across one.
    if (flagIfEditInProgress(path)) return;
    loadError = undefined;
    currentDoc = result.value;
    comments = nextComments;
    if (editing) editing = undefined;
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
    // Fix round 1, I6: the rich edit container also carries `.plan-block`
    // (for its typography) but no `data-block-id` of its own — closest()
    // would otherwise find IT first for a selection made while editing,
    // producing a draft anchored to blockId "". Skipping it here means
    // closest() keeps walking up to the outer `.plan-block` (`content`,
    // renderBlock's own), which does carry the real id.
    const startBlock = start?.closest<HTMLElement>(".plan-block:not(.plan-block-edit__rich)");
    const endBlock = end?.closest<HTMLElement>(".plan-block:not(.plan-block-edit__rich)");
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

  /** The block row (`.plan-block[data-block-id]` directly under a block
   *  row) an event target sits in, resolved against the live tree. */
  function blockIdAt(target: EventTarget | null): string | undefined {
    if (!(target instanceof Element) || !root.contains(target)) return undefined;
    const content = target.closest<HTMLElement>(".plan-panel__block-row > [data-block-id]");
    return content?.dataset.blockId;
  }

  /** Fix round 4, item B: any mousedown clears a previous candidate and any
   *  pending switch (a click back into the edited block, or anywhere else,
   *  supersedes it); a primary-button mousedown on a different block,
   *  outside a link, becomes the new candidate. */
  function onBlockMouseDown(event: MouseEvent): void {
    switchCandidate = undefined;
    pendingEditTarget = undefined;
    if (event.button !== 0) return;
    if (event.target instanceof Element && event.target.closest("a")) return;
    const id = blockIdAt(event.target);
    if (!id || id === editing?.blockId) return;
    switchCandidate = { blockId: id, x: event.clientX, y: event.clientY, at: performance.now() };
  }

  /** Fix round 5, item 2: A's exit removes its toolbar/hint/outline and
   *  the rows below move, so a mouseup at the very same pointer position
   *  can land on something else (e.g. `.plan-panel__body`). A pointer that
   *  stayed put (< 5px) and released quickly (< 800ms) still counts. */
  function confirmsCandidate(
    candidate: NonNullable<typeof switchCandidate>,
    event: MouseEvent,
  ): boolean {
    if (blockIdAt(event.target) === candidate.blockId) return true;
    const moved = Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y);
    return moved < 5 && performance.now() - candidate.at < 800;
  }

  /** Fix round 4, item B: confirms the candidate when this mouseup lands on
   *  the same block (by id — the element itself may have been rebuilt
   *  since mousedown) with a collapsed selection (a drag-select never
   *  opens a block). Opens it now, or once a different block's in-flight
   *  save settles. */
  function onBlockMouseUp(event: MouseEvent): void {
    const candidate = switchCandidate;
    switchCandidate = undefined;
    if (!candidate || event.button !== 0 || !confirmsCandidate(candidate, event)) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    if (!currentDoc || conflict || editing?.blockId === candidate.blockId) return;
    const index = currentDoc.blocks.findIndex((block) => block.id === candidate.blockId);
    const block = currentDoc.blocks[index];
    if (!block) return;
    const point = { x: event.clientX, y: event.clientY };
    if (editing?.saving) {
      pendingEditTarget = { blockId: block.id, index, point };
      return;
    }
    void beginEditingBlock(block, index, point);
  }
  document.addEventListener("mousedown", onBlockMouseDown);
  document.addEventListener("mouseup", onBlockMouseUp);

  async function openPanel(path?: string): Promise<void> {
    // Final fix wave M3: reopening a hidden panel onto the document being
    // edited keeps everything as it was — a reload here would only read
    // back the same file and flag it "changed on disk" under a dirty edit.
    if (editing && path !== undefined && path === currentDoc?.path) {
      setOpen(true);
      return;
    }
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
      if (currentDoc?.path !== path) return;
      // Fix round 3, item A: the echo-vs-real-change and dirty-vs-clean
      // decisions both need the freshly *read* mtime to make correctly
      // (an echo of our own write is only knowable by comparing against
      // it) — loadDocument itself now makes them, right after its own
      // read; forwarding unconditionally is what lets it tell an echo
      // apart from a real change even while dirty, instead of this
      // deciding blind before any read happens at all.
      void loadDocument(path);
    },
    dispose() {
      disposed = true;
      loadId += 1;
      closeActivePopover?.();
      closeActivePopover = undefined;
      document.removeEventListener("mouseup", selectionChanged);
      document.removeEventListener("mousedown", onBlockMouseDown);
      document.removeEventListener("mouseup", onBlockMouseUp);
      root.remove();
    },
  };
}
