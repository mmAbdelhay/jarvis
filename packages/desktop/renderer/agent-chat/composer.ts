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
  tokens,
  type Translate,
} from "./dom.js";
import { createMenu, type MenuItem } from "./menus.js";

/** The most one send carries, as agentSend counts it. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const MAX_INPUT_PX = 220;
const FILES_DEBOUNCE_MS = 120;
const COMMANDS_TTL_MS = 60_000;
/** What an older version kept on disk: removed whenever a composer is built. */
const OLD_DRAFT_PREFIX = "jarvis.agentChatDraft.";
/** Unsent text per pane, in memory only: it survives a tab switch and a pane rebuilt in
 *  this window, and is never written anywhere (it may hold anything). */
const drafts = new Map<string, string>();

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
  /** Something was sent or changed: look at the agent again. */
  changed(): void;
  /** Files may also be dropped anywhere on this element. */
  dropTarget: HTMLElement;
};

export type Composer = {
  element: HTMLElement;
  update(view: AgentOf, locked: boolean, narrow?: boolean): void;
  focus(): void;
  value(): string;
  /** Whether the keys are in the box. */
  hasFocus(): boolean;
  addFiles(files: readonly File[]): Promise<void>;
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
    modeButton,
    modelButton,
    el("span", "ac-spacer"),
    context,
    stopButton,
    sendButton,
  );
  element.append(
    chipRow,
    input,
    bar,
    suggest.element,
    modeMenu.element,
    modelMenu.element,
    fileInput,
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
  let token = 0;
  let cancelFiles: (() => void) | undefined;
  let mention: { start: number; end: number } | undefined;

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
    sendButton.disabled = sending || locked;
    stopButton.hidden = !(working && view?.caps.stop === true);
    input.disabled = locked;
    attach.disabled = locked || view?.caps.attach === false;
    attach.hidden = view?.caps.attach === false;
  }

  function paintChips(): void {
    chipRow.replaceChildren();
    chipRow.hidden = attachments.length === 0;
    for (const item of attachments) {
      const chip = el("span", "ac-attachment");
      chip.dataset["state"] = item.state;
      const name = el("span", "ac-attachment__name", item.name);
      name.dir = "auto";
      chip.append(name);
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
  options.dropTarget.addEventListener("dragover", (event) => {
    if (event.dataTransfer?.types?.includes("Files") === true) {
      event.preventDefault();
      options.dropTarget.dataset["dropping"] = "true";
    }
  });
  options.dropTarget.addEventListener("dragleave", () => {
    delete options.dropTarget.dataset["dropping"];
  });
  options.dropTarget.addEventListener("drop", (event) => {
    delete options.dropTarget.dataset["dropping"];
    const files = dropped(event);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  });

  // ---- suggestions ----
  function closeSuggest(): void {
    suggest.close();
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    mention = undefined;
    token++;
    cancelFiles?.();
  }

  function showSuggest(
    items: MenuItem[],
    replace: { start: number; end: number },
    pick: (item: MenuItem) => string,
  ): void {
    mention = replace;
    const choose = (item: MenuItem): void => {
      const text = pick(item);
      const at = mention ?? replace;
      input.value = `${input.value.slice(0, at.start)}${text}${input.value.slice(at.end)}`;
      const caret = at.start + text.length;
      input.setSelectionRange(caret, caret);
      closeSuggest();
      saveDraft();
      grow();
      input.focus();
    };
    if (suggest.isOpen()) suggest.setItems(items);
    else suggest.open(items, choose);
    input.setAttribute("aria-expanded", "true");
    const active = suggest.activeId();
    if (active !== undefined) input.setAttribute("aria-activedescendant", active);
  }

  async function loadCommands(): Promise<AgentCommandInfo[]> {
    const session = view?.sessionId ?? "";
    if (
      commands !== undefined &&
      commands.session === session &&
      options.now() - commands.at < COMMANDS_TTL_MS
    ) {
      return commands.list;
    }
    const answer = await api.commands();
    commands = { at: options.now(), session, list: answer.commands };
    return answer.commands;
  }

  async function suggestCommands(
    prefix: string,
    replace: { start: number; end: number },
  ): Promise<void> {
    const mine = ++token;
    let list: AgentCommandInfo[];
    try {
      list = await loadCommands();
    } catch {
      return;
    }
    if (mine !== token) return;
    const lower = prefix.toLowerCase();
    const starts = list.filter((command) => command.name.toLowerCase().startsWith(lower));
    const rest = list.filter(
      (command) =>
        !command.name.toLowerCase().startsWith(lower) && command.name.toLowerCase().includes(lower),
    );
    suggest.setEmpty(t("agentChatNoSuggestions"));
    const items = [...starts, ...rest].slice(0, 30).map<MenuItem>((command) => ({
      id: command.name,
      label: `/${command.name}`,
      mono: true,
      ...(command.description !== undefined ? { note: command.description } : {}),
    }));
    if (items.length === 0) {
      closeSuggest();
      return;
    }
    showSuggest(items, replace, (item) => `${item.label} `);
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
    const command = /^\/([\w:.-]*)$/.exec(before);
    if (command !== null && view?.caps.commands === true) {
      void suggestCommands(command[1] ?? "", { start: 0, end: caret });
      return;
    }
    const file = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (file !== null && view?.caps.files === true) {
      const query = file[1] ?? "";
      suggestFiles(query, { start: caret - query.length - 1, end: caret });
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
    if (sending || locked) return;
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
    } else if (!threw) {
      // What was typed stays; the reason is shown.
      options.note(t(SEND_REFUSALS[outcome.reason]));
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
    refreshSuggestions();
  });
  input.addEventListener("click", refreshSuggestions);
  input.addEventListener("blur", () => closeSuggest());
  input.addEventListener("keydown", (event) => {
    if (!options.chatKey(event)) return;
    if (event.isComposing || event.keyCode === 229) return;
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
        if (!result.ok) options.note(t(STOP_REFUSALS[result.reason]));
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
            if (!result.ok) options.note(t(MODE_REFUSALS[result.reason]));
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
      if (!result.ok) options.note(t(COMMAND_REFUSALS[result.reason]));
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
    const used = next.context;
    if (used === undefined) return undefined;
    if (used.leftPercent !== undefined) {
      return fmtNode(t("agentChatContextLeft"), { n: `${used.leftPercent}%` });
    }
    return fmtNode(t("agentChatContextUsed"), { n: tokens(used.used) });
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
