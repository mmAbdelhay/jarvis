// The composer: an auto-growing box with attachments (picker, paste, drop),
// `/` commands and `@` files as listboxes, message history on Up and Down,
// Queue or Send by what the agent can do, Stop, the mode and model menus and
// the context left. A failed send keeps what was typed and says why. Nothing
// is submitted while a file is still uploading, and the draft survives a
// switch of tab.
import type { ClaudeMode } from "@jarvis/wire";
import type { AgentAttachResult } from "../../src/agent-attach.js";
import type {
  AgentCommandResult,
  AgentModeResult,
  AgentStopResult,
} from "../../src/agent-controls.js";
import type { AgentCommandInfo, AgentFileHit } from "../../src/agent-suggest.js";
import { argumentChoices, rankCommands, readToken } from "./command-match.js";
import type { AgentSendResult } from "../../src/agent-view.js";
import type { MessageKey } from "../../src/messages.js";
import type { AgentOf, StorageLike } from "./agent-types.js";
import {
  basename,
  dirname,
  el,
  fmt,
  fmtNode,
  ICONS,
  icon,
  quotePath,
  type Translate,
} from "./dom.js";
import { hostPlatform } from "../keys.js";
import { clockText, createDictationControl, type DictationApi } from "./dictation.js";
import { fileIcon } from "../file-icons.js";
import { createMenu, type MenuItem } from "./menus.js";
import { contextOf, contextValue } from "./status.js";

/** The most one send carries, as agentSend counts it. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_INPUT_PX = 220;
const FILES_DEBOUNCE_MS = 120;
const COMMANDS_TTL_MS = 10_000;
/** What an older version kept on disk: removed whenever a composer is built. */
const OLD_DRAFT_PREFIX = "jarvis.agentChatDraft.";
/** Unsent text per pane, in memory only: it survives a tab switch and a pane rebuilt in
 *  this window, and is never written anywhere (it may hold anything). */
const drafts = new Map<string, string>();

/** The composer each pane shows now, so text that arrives for a composer that
 *  was rebuilt meanwhile still lands in the one on screen. */
const liveInsert = new Map<string, (text: string) => void>();

/** Adds to a pane's unsent text while no composer is there to show it. */
function appendAgentDraft(paneKey: string, text: string): void {
  const had = drafts.get(paneKey) ?? "";
  drafts.set(paneKey, had === "" || /\s$/.test(had) ? `${had}${text}` : `${had} ${text}`);
}

/** The pane's shell is gone for good: its unsent text goes with it. */
export function forgetAgentDraft(paneKey: string): void {
  drafts.delete(paneKey);
}

function purgeOldDrafts(storage: StorageLike | undefined): void {
  try {
    const where = storage as
      | (StorageLike & { length?: number; key?(i: number): string | null })
      | undefined;
    if (where?.key === undefined || where.length === undefined) return;
    const stale: string[] = [];
    for (let at = 0; at < where.length; at++) {
      const name = where.key(at);
      if (name?.startsWith(OLD_DRAFT_PREFIX)) stale.push(name);
    }
    for (const name of stale) where.removeItem?.(name);
  } catch {
    // Nothing to remove.
  }
}
const MODES: readonly ClaudeMode[] = ["default", "acceptEdits", "plan", "auto"];
const MODE_LABELS: Record<ClaudeMode, MessageKey> = {
  default: "agentChatModeDefault",
  auto: "agentChatModeAuto",
  plan: "agentChatModePlan",
  acceptEdits: "agentChatModeAcceptEdits",
};
const MODE_NOTES: Record<ClaudeMode, MessageKey> = {
  default: "agentChatModeNoteDefault",
  acceptEdits: "agentChatModeNoteAcceptEdits",
  plan: "agentChatModeNotePlan",
  auto: "agentChatModeNoteAuto",
};
const CLAUDE_MODELS = [
  { id: "opus", label: "Opus" },
  { id: "sonnet", label: "Sonnet" },
  { id: "haiku", label: "Haiku" },
] as const;
const SEND_REFUSALS = {
  prompt: "agentChatSendPrompt",
  draft: "agentChatSendDraft",
  gone: "agentChatSendGone",
  invalid: "agentChatSendInvalid",
} as const;
const STOP_REFUSALS = {
  gone: "agentChatSendGone",
  prompt: "agentChatSendPrompt",
  idle: "agentChatStopIdle",
  draft: "agentChatStopDraft",
  unsupported: "agentChatStopUnsupported",
} as const;
const MODE_REFUSALS = {
  gone: "agentChatSendGone",
  prompt: "agentChatSendPrompt",
  draft: "agentChatModeDraft",
  unsupported: "agentChatModeUnsupported",
  invalid: "agentChatModeUnsupported",
  unreadable: "agentChatModeUnreadable",
  stuck: "agentChatModeStuck",
} as const;
const COMMAND_REFUSALS = {
  gone: "agentChatSendGone",
  prompt: "agentChatSendPrompt",
  busy: "agentChatCommandBusy",
  draft: "agentChatSendDraft",
  invalid: "agentChatCommandInvalid",
  unknown: "agentChatCommandInvalid",
} as const;
const ATTACH_REFUSALS = {
  gone: "agentChatSendGone",
  invalid: "agentChatAttachInvalid",
  toolarge: "agentChatAttachTooLarge",
  failed: "agentChatAttachFailed",
} as const;

export type ComposerApi = {
  send(text: string): Promise<AgentSendResult>;
  stop(): Promise<AgentStopResult>;
  mode(mode: string): Promise<AgentModeResult>;
  command(command: string): Promise<AgentCommandResult>;
  commands(): Promise<{ commands: AgentCommandInfo[] }>;
  files(query: string): Promise<{ files: AgentFileHit[] }>;
  attach(file: { name: string; bytes: Uint8Array }): Promise<AgentAttachResult>;
  pathForFile?(file: File): string;
  /** Dictation into the box; without it there is no mic button. */
  dictate?: DictationApi;
};

export type ComposerOptions = {
  t: Translate;
  paneKey: string;
  api: ComposerApi;
  storage?: StorageLike;
  schedule(fn: () => void, ms: number): () => void;
  now(): number;
  /** The pane's own look at a key typed here; false = claimed. */
  chatKey(event: KeyboardEvent): boolean;
  /** Earlier messages sent to this agent, oldest first. */
  history(): string[];
  note(message: string | undefined): void;
  /** A message went out: the feed follows it to the bottom. */
  sent?(): void;
  /** An action answered "gone": the agent has left. */
  gone?(): void;
  /** Something was sent or changed: look at the agent again. */
  changed(): void;
  /** Files may also be dropped anywhere on this element. */
  dropTarget: HTMLElement;
  /** False while the pane is hidden (another tab or route); a recording ends then. */
  visible?: () => boolean;
};

export type Composer = {
  element: HTMLElement;
  update(view: AgentOf, locked: boolean, narrow?: boolean): void;
  focus(): void;
  value(): string;
  /** Whether the keys are in the box. */
  hasFocus(): boolean;
  addFiles(files: readonly File[]): Promise<void>;
  /** Ends a dictation in progress (the agent left). */
  cancelDictation(): void;
  /** The chat is no longer in view: a recording is finished, its words go to the draft. */
  paneHidden(): void;
  /** The pane is destroyed: a recording ends, a transcription in flight
   *  still lands in the pane's draft. */
  dispose(): void;
};

type Attachment = {
  id: number;
  name: string;
  kind: "image" | "file";
  state: "uploading" | "ready" | "failed";
  ref?: string;
};

/** "claude-opus-4-5-20251101" as "Opus 4.5"; other vendors' ids as they are. */
export function prettyModel(id: string | undefined, vendor: string): string | undefined {
  if (id === undefined || id === "") return undefined;
  if (vendor !== "anthropic") return id;
  const parts = id
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .split("-");
  const words = parts.filter((part) => !/^\d+$/.test(part));
  const numbers = parts.filter((part) => /^\d+$/.test(part));
  if (words.length === 0) return id;
  const name = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
  return numbers.length === 0 ? name : `${name} ${numbers.join(".")}`;
}

function extensionOf(mime: string): string {
  if (mime === "image/jpeg") return "jpg";
  const found = /^image\/(png|gif|webp|heic)$/.exec(mime)?.[1];
  return found ?? "png";
}

function kindOf(name: string, mime: string): "image" | "file" {
  return mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/i.test(name) ? "image" : "file";
}

let suggestCounter = 0;

/** The name of the folder a path is in (`src` for `a/src/b.ts`), when there is one. */
function parentName(path: string): string | undefined {
  const folder = dirname(path);
  return folder === "" || folder === "/" ? undefined : basename(folder);
}

export function createComposer(options: ComposerOptions): Composer {
  const { t, api } = options;
  const element = el("form", "agent-chat__composer ac-composer");
  element.setAttribute("aria-label", t("agentChatComposer"));
  const chipRow = el("div", "ac-attachments");
  chipRow.hidden = true;
  const input = el("textarea", "agent-chat__input ac-input");
  input.rows = 1;
  input.dir = "auto";
  input.spellcheck = false;
  input.placeholder = t("agentChatComposerHint");
  input.setAttribute("aria-label", t("agentChatComposerLabel"));
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-haspopup", "listbox");

  const suggest = createMenu({
    label: t("agentChatSuggestions"),
    empty: t("agentChatNoSuggestions"),
  });
  suggest.element.classList.add("ac-menu--suggest");
  suggest.element.id = `ac-suggest-${++suggestCounter}`;
  const suggestCount = el("div", "ac-sr-only ac-suggest-count");
  suggestCount.setAttribute("role", "status");
  suggestCount.setAttribute("aria-live", "polite");
  const argHint = el("div", "ac-arghint");
  argHint.hidden = true;
  input.setAttribute("aria-controls", suggest.element.id);
  const modeMenu = createMenu({ label: t("agentChatModeMenu"), focusable: true });
  const modelMenu = createMenu({ label: t("agentChatModelMenu"), focusable: true });

  const fileInput = el("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  fileInput.tabIndex = -1;
  fileInput.setAttribute("aria-hidden", "true");

  const bar = el("div", "ac-toolbar");
  const attach = el("button", "ac-iconbutton ac-attach");
  attach.type = "button";
  attach.append(icon(ICONS.plus, 14));
  attach.setAttribute("aria-label", t("agentChatAttach"));
  attach.title = t("agentChatAttach");
  const mic = el("button", "ac-iconbutton ac-mic");
  mic.type = "button";
  mic.hidden = api.dictate === undefined;
  mic.setAttribute("aria-pressed", "false");
  mic.append(icon(ICONS.mic, 14));
  const modeButton = el("button", "ac-textbutton ac-modebutton");
  modeButton.type = "button";
  modeButton.setAttribute("aria-haspopup", "listbox");
  const modelButton = el("button", "ac-textbutton ac-modelbutton");
  modelButton.type = "button";
  modelButton.setAttribute("aria-haspopup", "listbox");
  const context = el("span", "ac-context");
  const stopButton = el("button", "ac-stop", t("agentChatStop"));
  stopButton.type = "button";
  stopButton.hidden = true;
  const sendButton = el("button", "agent-chat__send ac-send", t("agentChatSend"));
  sendButton.type = "submit";
  bar.append(
    attach,
    mic,
    modeButton,
    modelButton,
    el("span", "ac-spacer"),
    context,
    stopButton,
    sendButton,
  );
  // The recording strip: words as well as the red dot, so colour is not alone.
  const dictationBar = el("div", "ac-dictation");
  dictationBar.hidden = true;
  dictationBar.dataset["state"] = "idle";
  const dictationDot = el("span", "ac-dictation__dot");
  dictationDot.setAttribute("aria-hidden", "true");
  const dictationLabel = el("span", "ac-dictation__label");
  const dictationTime = el("span", "ac-dictation__time");
  const dictationDone = el(
    "button",
    "ac-small-button ac-dictation__done",
    t("agentChatDictateDone"),
  );
  dictationDone.type = "button";
  const dictationCancel = el(
    "button",
    "ac-small-button ac-dictation__cancel",
    t("agentChatDictateCancel"),
  );
  dictationCancel.type = "button";
  const dictationLive = el("div", "ac-sr-only ac-dictation__live");
  dictationLive.setAttribute("role", "status");
  dictationLive.setAttribute("aria-live", "polite");
  element.append(
    chipRow,
    input,
    dictationBar,
    bar,
    argHint,
    suggest.element,
    suggestCount,
    modeMenu.element,
    modelMenu.element,
    fileInput,
    dictationLive,
  );

  // ---- state ----
  let view: AgentOf | undefined;
  let locked = false;
  let sending = false;
  let attachments: Attachment[] = [];
  let nextId = 1;
  let pastedCount = 0;
  let historyAt: number | undefined;
  let commands: { at: number; session: string; list: AgentCommandInfo[] } | undefined;
  let commandsLoad: Promise<AgentCommandInfo[]> | undefined;
  /** What the open list is for: the keys read it (exact name sends, and so on). */
  let suggestState:
    | { kind: "name"; atStart: boolean; exact: boolean }
    | { kind: "arg"; exact: boolean }
    | undefined;
  let suggestSignature = "";
  let token = 0;
  let cancelFiles: (() => void) | undefined;
  let mention: { start: number; end: number } | undefined;
  /** True while dictated text goes in: the input handler must not read a
   *  leading `/` or an `@` in it as a menu. */
  let quiet = false;
  let gone = false;

  const store = (): StorageLike | undefined => {
    try {
      return options.storage ?? window.localStorage;
    } catch {
      return undefined;
    }
  };
  function saveDraft(): void {
    if (input.value === "") drafts.delete(options.paneKey);
    else drafts.set(options.paneKey, input.value);
  }
  purgeOldDrafts(store());
  input.value = drafts.get(options.paneKey) ?? "";

  function grow(): void {
    input.style.height = "auto";
    if (input.scrollHeight > 0) {
      input.style.height = `${Math.min(input.scrollHeight, MAX_INPUT_PX)}px`;
      input.style.overflowY = input.scrollHeight > MAX_INPUT_PX ? "auto" : "hidden";
    }
  }

  const uploading = (): boolean => attachments.some((a) => a.state === "uploading");

  function paintButtons(): void {
    const working = view?.working !== undefined;
    const queue = working && view?.caps.queue === true;
    sendButton.textContent = queue ? t("agentChatQueue") : t("agentChatSend");
    sendButton.disabled = sending || locked || (dictation?.state() ?? "idle") !== "idle";
    stopButton.hidden = !(working && view?.caps.stop === true);
    input.disabled = locked;
    attach.disabled = locked || view?.caps.attach === false;
    attach.hidden = view?.caps.attach === false;
    paintMic();
  }

  const shortcut = (): string => (hostPlatform() === "darwin" ? "⌘⇧M" : "Ctrl+Shift+M");
  function paintMic(): void {
    const state = dictation?.state() ?? "idle";
    const recording = state === "recording";
    const label = t(recording ? "agentChatDictateFinish" : "agentChatDictate");
    mic.setAttribute("aria-pressed", String(recording));
    mic.setAttribute("aria-label", label);
    mic.title = fmt(t("agentChatDictateTip"), { label, keys: shortcut() });
    mic.disabled = (locked && !recording) || state === "starting" || state === "transcribing";
  }

  let paintedState: string | undefined;
  function paintDictation(): void {
    const state = dictation?.state() ?? "idle";
    dictationBar.hidden = state === "idle" || state === "starting";
    if (state !== paintedState) {
      paintedState = state;
      dictationBar.dataset["state"] = state;
      if (state === "recording") {
        dictationLabel.textContent = t("agentChatDictateRecording");
        dictationBar.replaceChildren(
          dictationDot,
          dictationLabel,
          dictationTime,
          dictationDone,
          dictationCancel,
        );
      } else if (state === "transcribing") {
        dictationLabel.textContent = t("agentChatDictateWriting");
        dictationBar.replaceChildren(dictationDot, dictationLabel, dictationCancel);
      }
    }
    dictationTime.textContent = clockText(dictation?.elapsed() ?? 0);
    paintButtons();
  }

  // ---- dictation ----
  const NOTES = {
    busy: "agentChatDictateBusy",
    silence: "agentChatDictateSilence",
    failed: "agentChatDictateFailed",
  } as const;
  const SAYS = {
    started: "agentChatDictateStarted",
    writing: "agentChatDictateWriting",
    inserted: "agentChatDictateInserted",
  } as const;

  /** Puts dictated words at the caret (over a selection) with one space where
   *  either side needs it. An undoable insert where the browser offers one;
   *  never a menu, never a send. */
  function insertDictated(raw: string): void {
    const text = raw.trim();
    if (text === "") return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const before = input.value.slice(0, start);
    const after = input.value.slice(end);
    const piece = `${before !== "" && !/\s$/.test(before) ? " " : ""}${text}${
      after !== "" && !/^\s/.test(after) ? " " : ""
    }`;
    quiet = true;
    try {
      const holder = document.activeElement;
      if (
        !input.disabled &&
        (holder === null || holder === document.body || element.contains(holder))
      ) {
        input.focus();
      }
      input.setSelectionRange(start, end);
      let inserted = false;
      if (!input.disabled && document.activeElement === input) {
        try {
          inserted = document.execCommand?.("insertText", false, piece) === true;
        } catch {
          inserted = false;
        }
      }
      if (!inserted) {
        input.setRangeText(piece, start, end, "end");
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: piece }),
        );
      }
    } finally {
      quiet = false;
    }
    closeSuggest();
    saveDraft();
    grow();
  }

  function deliverDictated(text: string): void {
    if (!gone) {
      insertDictated(text);
      return;
    }
    const other = liveInsert.get(options.paneKey);
    if (other !== undefined && other !== insertDictated) other(text);
    else appendAgentDraft(options.paneKey, text.trim());
  }

  const dictation =
    api.dictate === undefined
      ? undefined
      : createDictationControl({
          api: api.dictate,
          schedule: options.schedule,
          now: options.now,
          deliver: deliverDictated,
          changed: () => {
            if (gone) return;
            paintDictation();
            // The pane went away under a recording (a tab, a route): the
            // microphone must not stay on where nobody sees it.
            if (dictation?.state() === "recording" && options.visible?.() === false) {
              dictation.finish();
            }
          },
          announce: (what) => {
            if (gone) return;
            dictationLive.textContent = what === "none" ? "" : t(SAYS[what]);
          },
          fail: (reason) => {
            if (!gone) options.note(t(NOTES[reason]));
          },
        });
  if (api.dictate !== undefined) liveInsert.set(options.paneKey, insertDictated);

  mic.addEventListener("click", () => {
    options.note(undefined);
    dictation?.toggle();
  });
  dictationDone.addEventListener("click", () => dictation?.finish());
  dictationCancel.addEventListener("click", () => dictation?.cancel());
  // Capture: while dictating, Escape and Enter belong to dictation first.
  element.addEventListener(
    "keydown",
    (event) => {
      const state = dictation?.state() ?? "idle";
      if (state === "idle" || event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dictation?.cancel();
        return;
      }
      if (
        event.key === "Enter" &&
        event.target === input &&
        !event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (state === "recording") dictation?.finish();
      }
    },
    true,
  );
  const onShortcut = (event: KeyboardEvent): void => {
    if (dictation === undefined || event.isComposing) return;
    const mod = hostPlatform() === "darwin" ? event.metaKey : event.ctrlKey;
    if (!mod || !event.shiftKey || event.altKey || event.key.toLowerCase() !== "m") return;
    event.preventDefault();
    event.stopPropagation();
    if (!mic.disabled) {
      options.note(undefined);
      dictation.toggle();
    }
  };
  options.dropTarget.addEventListener("keydown", onShortcut, true);
  const onPageHide = (): void => dictation?.cancel();
  window.addEventListener("pagehide", onPageHide);

  function paintChips(): void {
    chipRow.replaceChildren();
    chipRow.hidden = attachments.length === 0;
    for (const item of attachments) {
      const chip = el("span", "ac-attachment");
      chip.dataset["state"] = item.state;
      const name = el("span", "ac-attachment__name", item.name);
      name.dir = "auto";
      chip.append(fileIcon(item.name), name);
      if (item.state === "uploading")
        chip.append(el("span", "ac-attachment__state", t("agentChatUploading")));
      if (item.state === "failed")
        chip.append(
          el(
            "span",
            "ac-attachment__state ac-attachment__state--failed",
            t("agentChatUploadFailed"),
          ),
        );
      const remove = el("button", "ac-attachment__remove");
      remove.type = "button";
      remove.append(icon(ICONS.close, 10));
      remove.setAttribute("aria-label", fmt(t("agentChatRemoveAttachment"), { name: item.name }));
      remove.addEventListener("click", () => {
        attachments = attachments.filter((other) => other.id !== item.id);
        paintChips();
        input.focus();
      });
      chip.append(remove);
      chipRow.append(chip);
    }
  }

  // ---- attachments ----
  async function addOne(file: File): Promise<void> {
    if (attachments.length >= MAX_ATTACHMENTS) {
      options.note(fmt(t("agentChatAttachTooMany"), { n: MAX_ATTACHMENTS }));
      return;
    }
    const mime = file.type ?? "";
    let name = file.name;
    if (name === "") name = `pasted-${++pastedCount}.${extensionOf(mime)}`;
    const item: Attachment = { id: nextId++, name, kind: kindOf(name, mime), state: "uploading" };
    let real = "";
    try {
      real = api.pathForFile?.(file) ?? "";
    } catch {
      real = "";
    }
    if (real !== "") {
      item.state = "ready";
      item.ref = quotePath(real);
      attachments.push(item);
      paintChips();
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      options.note(t("agentChatAttachTooLarge"));
      return;
    }
    attachments.push(item);
    paintChips();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await api.attach({ name, bytes });
      if (!attachments.some((other) => other.id === item.id)) return;
      if (result.ok) {
        item.state = "ready";
        item.ref = result.ref;
      } else {
        item.state = "failed";
        options.note(t(ATTACH_REFUSALS[result.reason]));
      }
    } catch {
      item.state = "failed";
      options.note(t("agentChatAttachFailed"));
    }
    paintChips();
  }

  async function addFiles(files: readonly File[]): Promise<void> {
    options.note(undefined);
    for (const file of files) await addOne(file);
  }

  attach.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const picked = Array.from(fileInput.files ?? []);
    fileInput.value = "";
    void addFiles(picked);
  });
  input.addEventListener("paste", (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  });
  const dropped = (event: DragEvent): File[] => Array.from(event.dataTransfer?.files ?? []);
  const onDragOver = (event: DragEvent): void => {
    if (event.dataTransfer?.types?.includes("Files") === true) {
      event.preventDefault();
      options.dropTarget.dataset["dropping"] = "true";
    }
  };
  const onDragLeave = (): void => {
    delete options.dropTarget.dataset["dropping"];
  };
  const onDrop = (event: DragEvent): void => {
    delete options.dropTarget.dataset["dropping"];
    const files = dropped(event);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  };
  options.dropTarget.addEventListener("dragover", onDragOver);
  options.dropTarget.addEventListener("dragleave", onDragLeave);
  options.dropTarget.addEventListener("drop", onDrop);

  // ---- suggestions ----
  function closeSuggest(): void {
    suggest.close();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    mention = undefined;
    suggestState = undefined;
    suggestSignature = "";
    suggestCount.textContent = "";
    argHint.hidden = true;
    token++;
    cancelFiles?.();
  }

  function showSuggest(
    items: MenuItem[],
    replace: { start: number; end: number },
    pick: (item: MenuItem) => string,
    reset = false,
  ): void {
    mention = replace;
    const choose = (item: MenuItem): void => {
      let text = pick(item);
      const at = mention ?? replace;
      // A space already follows the name: step over it instead of doubling it.
      const spaced = text.endsWith(" ") && input.value.charAt(at.end) === " ";
      if (spaced) text = text.slice(0, -1);
      input.value = `${input.value.slice(0, at.start)}${text}${input.value.slice(at.end)}`;
      const caret = at.start + text.length + (spaced ? 1 : 0);
      input.setSelectionRange(caret, caret);
      closeSuggest();
      saveDraft();
      grow();
      input.focus();
    };
    if (suggest.isOpen()) suggest.setItems(items, reset);
    else suggest.open(items, choose);
    input.setAttribute("aria-expanded", "true");
    const active = suggest.activeId();
    if (active !== undefined) input.setAttribute("aria-activedescendant", active);
  }

  function loadCommands(): Promise<AgentCommandInfo[]> {
    commandsLoad ??= api
      .commands()
      .then((answer) => {
        commands = { at: options.now(), session: view?.sessionId ?? "", list: answer.commands };
        return answer.commands;
      })
      .finally(() => {
        commandsLoad = undefined;
      });
    return commandsLoad;
  }

  const SOURCE_KEYS = {
    "built-in": "agentChatSourceBuiltIn",
    project: "agentChatSourceProject",
    account: "agentChatSourceAccount",
    skill: "agentChatSourceSkill",
    plugin: "agentChatSourcePlugin",
  } as const;

  /** Draws the `/` or `$` list (or the argument choices) for the text and
   *  caret as they are right now, from the cached commands. */
  function renderCommands(): void {
    if (gone) return;
    const list = commands?.list;
    const caret = input.selectionStart ?? input.value.length;
    const found =
      locked || input.selectionStart !== input.selectionEnd || list === undefined
        ? undefined
        : readToken(input.value, caret, view?.vendor === "openai");
    if (found === undefined || view?.caps.commands !== true) {
      if (list !== undefined) closeSuggest();
      return;
    }
    token++;
    cancelFiles?.();
    if (found.kind === "arg") {
      const choices = argumentChoices(list ?? [], found.name, found.query);
      const known = (list ?? []).find(
        (command) =>
          command.trigger === undefined &&
          (command.name === found.name || command.aliases?.includes(found.name) === true),
      );
      suggest.close();
      input.setAttribute("aria-expanded", "false");
      if (choices.length > 0) {
        const signature = `arg|${found.name}|${found.query}`;
        const items = choices.map<MenuItem>((choice) => ({
          id: choice,
          label: choice,
          mono: true,
        }));
        suggestState = { kind: "arg", exact: choices.includes(found.query) };
        showSuggest(
          items,
          { start: found.start, end: found.end },
          (item) => item.label,
          signature !== suggestSignature,
        );
        suggestSignature = signature;
        suggestCount.textContent = "";
        argHint.hidden = true;
        return;
      }
      closeSuggest();
      if (found.query === "" && known?.hint !== undefined) {
        argHint.textContent = known.hint;
        argHint.hidden = false;
      }
      return;
    }
    const hits = rankCommands(list ?? [], found.query, found.trigger);
    if (hits.length === 0) {
      closeSuggest();
      return;
    }
    const grouped = found.query === "";
    const items = hits.map<MenuItem>(({ command, indexes }) => {
      const sigil = command.trigger === "$" ? "$" : "/";
      return {
        id: `${sigil}${command.name}`,
        label: `${sigil}${command.name}`,
        mono: true,
        marks: indexes.map((index) => index + 1),
        ...(command.hint === undefined ? {} : { hint: command.hint }),
        ...(command.description === undefined
          ? {}
          : { note: command.description, title: command.description }),
        tag: t(SOURCE_KEYS[command.source]),
        ...(grouped ? { group: t(SOURCE_KEYS[command.source]) } : {}),
      };
    });
    const first = hits[0]?.command;
    const typed = found.full.toLowerCase();
    const exact =
      first !== undefined &&
      (first.name.toLowerCase() === typed ||
        first.aliases?.some((alias) => alias.toLowerCase() === typed) === true);
    suggestState = { kind: "name", atStart: found.atStart, exact };
    // At most 45% of the pane's height, wherever the pane is (split, pop-out).
    const paneHeight = element.closest<HTMLElement>(".agent-chat")?.clientHeight ?? 0;
    suggest.element.style.maxHeight = paneHeight > 0 ? `${Math.floor(paneHeight * 0.45)}px` : "";
    const signature = `name|${found.trigger}|${found.query}`;
    suggest.setEmpty(t("agentChatNoSuggestions"));
    showSuggest(
      items,
      { start: found.start, end: found.end },
      (item) => `${item.label} `,
      signature !== suggestSignature,
    );
    suggestSignature = signature;
    suggestCount.textContent =
      items.length === 1
        ? t("agentChatCommandsOne")
        : fmt(t("agentChatCommandsCount"), { n: items.length });
  }

  function suggestFiles(query: string, replace: { start: number; end: number }): void {
    const mine = ++token;
    cancelFiles?.();
    cancelFiles = options.schedule(() => {
      void (async () => {
        let answer: { files: AgentFileHit[] };
        try {
          answer = await api.files(query);
        } catch {
          return;
        }
        if (mine !== token) return;
        const items = answer.files.map<MenuItem>((file) => ({
          id: file.path,
          label: file.name === "" ? basename(file.path) : file.name,
          note: dirname(file.path),
          mono: true,
          icon: file.name === "" ? basename(file.path) : file.name,
          ...(parentName(file.path) === undefined
            ? {}
            : { iconParent: parentName(file.path) as string }),
        }));
        // An empty list says so and holds the Enter, instead of sending "@REA".
        suggest.setEmpty(t("agentChatNoFiles"));
        showSuggest(items, replace, (item) => `@${quotePath(item.id)} `);
      })();
    }, FILES_DEBOUNCE_MS);
  }

  function refreshSuggestions(): void {
    if (locked || input.selectionStart !== input.selectionEnd) {
      closeSuggest();
      return;
    }
    const caret = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, caret);
    const file = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (file !== null && view?.caps.files === true) {
      const query = file[1] ?? "";
      suggestState = undefined;
      suggestFiles(query, { start: caret - query.length - 1, end: caret });
      return;
    }
    if (
      view?.caps.commands === true &&
      readToken(input.value, caret, view.vendor === "openai") !== undefined
    ) {
      // From the cache at once; a list older than 10 s (or none yet) is loaded
      // and the list is drawn again for whatever is typed by then.
      const session = view.sessionId ?? "";
      renderCommands();
      const fresh =
        commands !== undefined &&
        commands.session === session &&
        options.now() - commands.at < COMMANDS_TTL_MS;
      if (!fresh) {
        void loadCommands()
          .then(() => renderCommands())
          .catch(() => undefined);
      }
      return;
    }
    closeSuggest();
  }

  // ---- history ----
  function recall(direction: -1 | 1): boolean {
    const past = options.history();
    if (past.length === 0) return false;
    if (historyAt === undefined) {
      if (direction === 1 || input.value !== "") return false;
      historyAt = past.length;
    }
    const next = historyAt + direction;
    if (next < 0) return true;
    if (next >= past.length) {
      historyAt = undefined;
      input.value = "";
    } else {
      historyAt = next;
      input.value = past[next] ?? "";
    }
    input.setSelectionRange(input.value.length, input.value.length);
    saveDraft();
    grow();
    return true;
  }

  // ---- sending ----
  function messageText(): string {
    const refs = attachments
      .filter((item) => item.state === "ready" && item.ref !== undefined)
      .map((item) => item.ref);
    const text = input.value.trimEnd();
    if (refs.length === 0) return text;
    return text === "" ? refs.join(" ") : `${text}\n\n${refs.join(" ")}`;
  }

  async function submit(): Promise<void> {
    if (sending || locked || (dictation?.state() ?? "idle") !== "idle") return;
    if (uploading()) {
      options.note(t("agentChatWaitUpload"));
      return;
    }
    const message = messageText();
    if (message.trim() === "") return;
    const sentText = input.value;
    const sentFiles = new Set(attachments.map((item) => item.id));
    if (view?.working !== undefined && view.caps.queue !== true) {
      options.note(t("agentChatBusyNoQueue"));
      return;
    }
    sending = true;
    options.note(undefined);
    paintButtons();
    let outcome: AgentSendResult;
    let threw = false;
    try {
      outcome = await api.send(message);
    } catch {
      threw = true;
      outcome = { ok: false, reason: "gone" };
      options.note(t("agentChatSendFailed"));
    }
    sending = false;
    if (outcome.ok) {
      // Only what went out: typing and files added meanwhile stay.
      if (input.value === sentText) input.value = "";
      else if (input.value.startsWith(sentText)) input.value = input.value.slice(sentText.length);
      attachments = attachments.filter((item) => !sentFiles.has(item.id));
      historyAt = undefined;
      saveDraft();
      paintChips();
      grow();
      options.note(undefined);
      options.sent?.();
    } else if (!threw) {
      // What was typed stays; the reason is shown.
      options.note(t(SEND_REFUSALS[outcome.reason]));
      if (outcome.reason === "gone") options.gone?.();
    }
    paintButtons();
    // Back to the box only if the keys were still here or nowhere.
    if (document.activeElement === input || document.activeElement === document.body) input.focus();
    options.changed();
  }

  element.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  input.addEventListener("input", () => {
    historyAt = undefined;
    saveDraft();
    grow();
    if (quiet) closeSuggest();
    else refreshSuggestions();
  });
  input.addEventListener("click", refreshSuggestions);
  input.addEventListener("compositionend", () => {
    if (!quiet) refreshSuggestions();
  });
  input.addEventListener("keyup", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") refreshSuggestions();
  });
  input.addEventListener("blur", () => closeSuggest());
  input.addEventListener("keydown", (event) => {
    if (!options.chatKey(event)) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (
      suggest.isOpen() &&
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      suggestState !== undefined
    ) {
      const sends =
        suggestState.kind === "arg"
          ? suggestState.exact && !suggest.moved()
          : suggestState.atStart
            ? suggestState.exact && !suggest.moved()
            : !suggest.moved();
      if (sends) {
        // A fully typed name, or ordinary text with a `/` in it: Enter sends.
        event.preventDefault();
        closeSuggest();
        void submit();
        return;
      }
    }
    if (suggest.isOpen() && suggest.handleKey(event)) {
      const active = suggest.activeId();
      if (active !== undefined) input.setAttribute("aria-activedescendant", active);
      else input.removeAttribute("aria-activedescendant");
      if (!suggest.isOpen()) input.setAttribute("aria-expanded", "false");
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
      return;
    }
    if (
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      !event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      !event.ctrlKey
    ) {
      const empty = input.value === "";
      if ((empty || historyAt !== undefined) && recall(event.key === "ArrowUp" ? -1 : 1)) {
        event.preventDefault();
      }
    }
  });

  // ---- stop, mode, model ----
  stopButton.addEventListener("click", () => {
    void (async () => {
      options.note(undefined);
      try {
        const result = await api.stop();
        if (!result.ok) {
          options.note(t(STOP_REFUSALS[result.reason]));
          if (result.reason === "gone") options.gone?.();
        }
      } catch {
        options.note(t("agentChatStopFailed"));
      }
      options.changed();
    })();
  });

  modeButton.addEventListener("click", () => {
    if (modeMenu.isOpen()) return modeMenu.close();
    const current = view?.mode;
    modeMenu.open(
      MODES.map<MenuItem>((mode) => ({
        id: mode,
        label: t(MODE_LABELS[mode]),
        note: mode === current ? t("agentChatCurrent") : t(MODE_NOTES[mode]),
        ...(mode === current ? { current: true } : {}),
      })),
      (item) => {
        if (item.id === current) return;
        void (async () => {
          options.note(undefined);
          try {
            const result = await api.mode(item.id);
            if (!result.ok) {
              options.note(t(MODE_REFUSALS[result.reason]));
              if (result.reason === "gone") options.gone?.();
            }
          } catch {
            options.note(t("agentChatModeUnreadable"));
          }
          options.changed();
        })();
      },
    );
  });

  async function runCommand(command: string): Promise<void> {
    options.note(undefined);
    try {
      const result = await api.command(command);
      if (!result.ok) {
        options.note(t(COMMAND_REFUSALS[result.reason]));
        if (result.reason === "gone") options.gone?.();
      }
    } catch {
      options.note(t("agentChatCommandInvalid"));
    }
    options.changed();
  }

  modelButton.addEventListener("click", () => {
    if (view === undefined) return;
    if (view.caps.model === "menu") {
      // The agent's own picker opens in the terminal drawer.
      void runCommand("/model");
      return;
    }
    if (modelMenu.isOpen()) return modelMenu.close();
    const now = (view.model ?? "").toLowerCase();
    modelMenu.open(
      [
        ...CLAUDE_MODELS.map<MenuItem>((model) => ({
          id: model.id,
          label: model.label,
          ...(now.includes(model.id) ? { current: true, note: t("agentChatCurrent") } : {}),
        })),
        // Claude's own picker, which opens in the terminal drawer.
        { id: "more", label: t("agentChatModelMore") },
      ],
      (item) => {
        if (item.id === "more") void runCommand("/model");
        else if (!now.includes(item.id)) void runCommand(`/model ${item.id}`);
      },
    );
  });

  function contextNode(next: AgentOf): DocumentFragment | undefined {
    const info = contextOf(next);
    if (info === undefined) return undefined;
    const value = contextValue(info, t);
    const key =
      info.usedPercent !== undefined
        ? "agentChatContextPercent"
        : info.leftPercent !== undefined
          ? "agentChatContextLeft"
          : "agentChatContextUsed";
    return fmtNode(t(key), { n: value.n });
  }

  grow();
  paintChips();
  paintButtons();

  return {
    element,
    focus() {
      if (!input.disabled) input.focus();
    },
    value: () => input.value,
    hasFocus: () => document.activeElement === input,
    addFiles,
    cancelDictation: () => dictation?.cancel(),
    paneHidden() {
      const state = dictation?.state();
      if (state === "recording") dictation?.finish();
      else if (state === "starting") dictation?.cancel();
    },
    dispose() {
      gone = true;
      window.removeEventListener("pagehide", onPageHide);
      options.dropTarget.removeEventListener("keydown", onShortcut, true);
      options.dropTarget.removeEventListener("dragover", onDragOver);
      options.dropTarget.removeEventListener("dragleave", onDragLeave);
      options.dropTarget.removeEventListener("drop", onDrop);
      dictation?.detach();
      if (liveInsert.get(options.paneKey) === insertDictated) liveInsert.delete(options.paneKey);
    },
    update(next, isLocked, narrow = false) {
      view = next;
      locked = isLocked;
      const modeShown = next.caps.mode && next.mode !== undefined;
      modeButton.hidden = !modeShown;
      // A question hides the agent's status row and takes its keys: the mode
      // cannot be switched meanwhile, and the button says why.
      modeButton.disabled = isLocked;
      modeButton.title = isLocked ? t("agentChatModeLocked") : "";
      if (modeShown && next.mode !== undefined) modeButton.textContent = t(MODE_LABELS[next.mode]);
      const model = prettyModel(next.model, next.vendor);
      modelButton.hidden = model === undefined && next.caps.model !== "menu";
      modelButton.textContent = model ?? t("agentChatModel");
      modelButton.setAttribute("aria-label", `${t("agentChatModelMenu")}: ${model ?? ""}`.trim());
      const node = contextNode(next);
      if (node === undefined) context.replaceChildren();
      else context.replaceChildren(node);
      context.hidden = node === undefined;
      input.placeholder = locked
        ? t("agentChatComposerLocked")
        : narrow
          ? t("agentChatComposer")
          : t("agentChatComposerHint");
      paintButtons();
    },
  };
}
