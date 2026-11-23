// The Chat | Term switch of a Terminal pane running a coding agent (Claude
// Code, Copilot or Codex), and the chat it turns the pane into.
//
// Main does the reading (terminal:agentView joins the agent's transcript with
// what its screen shows); this file only draws it. Everything an agent or a
// person wrote reaches the DOM through textContent and text nodes — never
// innerHTML — and a link opens only if it is https, through the existing
// safe external path. The terminal under the chat is hidden, never detached
// (terminal-pane.ts's setChatView), so the pty never changes size for it and
// nothing typed in the chat reaches the pty except through agentSend and
// agentAnswer, which main re-checks against the screen.

import type { AgentAnswerResult, AgentSendResult, AgentView } from "../src/agent-view.js";
import type { MessageKey } from "../src/messages.js";
import {
  type ChatBlock,
  type ChatInline,
  isHttpsUrl,
  linkParts,
  parseChatText,
} from "./agent-chat-text.js";

type AgentOf = Extract<AgentView, { kind: "agent" }>;
type Mode = "chat" | "term";

export type AgentChatOptions = {
  paneKey: string;
  /** The pane's own element: the switch and the chat are drawn inside it. */
  host: HTMLElement;
  api: {
    terminalAgentView(paneKey: string): Promise<AgentView>;
    terminalAgentAnswer(paneKey: string, index: number, label: string): Promise<AgentAnswerResult>;
    terminalAgentSend(paneKey: string, text: string): Promise<AgentSendResult>;
    /** The existing safe external-open path (main allows http, https, mailto only). */
    plansOpenLink(url: string): unknown;
  };
  t(key: MessageKey): string;
  /** The pane's own switch between its terminal and this chat. */
  setChatView(active: boolean, focusChat?: () => void): void;
  /** Gives the keys back to the pane's terminal. */
  focusTerm(): void;
  /** The pane's first look at a key typed in the composer; false = claimed. */
  chatKey(event: KeyboardEvent): boolean;
  /** Whether a command is running in the pane now (after a reload). */
  isRunning?(): boolean;
  /** One-shot timer; returns its cancel. */
  schedule?(fn: () => void, ms: number): () => void;
  storage?: Pick<Storage, "getItem" | "setItem">;
  /** Whether the pane is on screen; pushes for one that is not are skipped. */
  isShown?(): boolean;
};

export type AgentChat = {
  /** A command began in the pane: look for an agent at 1s, 3s and 8s. */
  commandStarted(): void;
  /** The pane regained focus: look now. */
  focused(): void;
  /** main said the view changed (terminal:claudeViewChanged). */
  refresh(): void;
  dispose(): void;
};

/** When after a command starts to look for an agent. */
export const DETECT_AT_MS: readonly number[] = [1000, 3000, 8000];
/** After those, how often to keep looking while the command still runs: a
 *  Codex or Copilot session file may only exist after the first message. */
export const KEEP_LOOKING_MS = 10000;
/** How long to wait before asking again after the agent seemed to vanish. */
const RE_ASK_MS = 2000;
/** How long after the pane is built to look for a command already running. */
const RELOAD_CHECK_MS = 1500;
const MODE_KEY = "jarvis.agentChatMode";
/** How close to the bottom still counts as "at the bottom", in px. */
const BOTTOM_SLACK_PX = 24;

const VENDOR_NAMES = { anthropic: "Claude Code", github: "Copilot", openai: "Codex" } as const;
const MODE_MESSAGES = {
  default: "agentChatModeDefault",
  auto: "agentChatModeAuto",
  plan: "agentChatModePlan",
  acceptEdits: "agentChatModeAcceptEdits",
} as const;
const SEND_REFUSALS = {
  prompt: "agentChatSendPrompt",
  gone: "agentChatSendGone",
  invalid: "agentChatSendInvalid",
} as const;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderInlines(
  inlines: readonly ChatInline[],
  openLink: (url: string) => void,
): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const inline of inlines) {
    if (inline.kind === "text") fragment.append(document.createTextNode(inline.text));
    else if (inline.kind === "bold") fragment.append(el("strong", undefined, inline.text));
    else if (inline.kind === "code") fragment.append(el("code", undefined, inline.text));
    else if (!isHttpsUrl(inline.url)) fragment.append(document.createTextNode(inline.text));
    else {
      const parts = linkParts(inline.text, inline.url);
      const link = el("a", "agent-chat__link", parts.text);
      link.href = inline.url;
      link.rel = "noopener noreferrer";
      link.addEventListener("click", (event) => {
        event.preventDefault();
        openLink(inline.url);
      });
      fragment.append(link);
      // The real host beside any label that does not plainly start with it.
      if (parts.host !== undefined) {
        fragment.append(el("span", "agent-chat__host", ` (${parts.host})`));
      }
    }
  }
  return fragment;
}

function renderBlock(block: ChatBlock, openLink: (url: string) => void): HTMLElement {
  if (block.kind === "codeBlock") {
    const pre = el("pre", "agent-chat__codeblock");
    pre.append(el("code", undefined, block.text));
    return pre;
  }
  if (block.kind === "list") {
    const list = el("div", "agent-chat__list");
    list.setAttribute("role", "list");
    for (const item of block.items) {
      const row = el("div", "agent-chat__item");
      row.setAttribute("role", "listitem");
      row.dir = "auto";
      row.append(el("span", "agent-chat__marker", item.marker), " ");
      row.append(renderInlines(item.inlines, openLink));
      list.append(row);
    }
    return list;
  }
  const paragraph = el("p", "agent-chat__para");
  paragraph.dir = "auto";
  paragraph.append(renderInlines(block.inlines, openLink));
  return paragraph;
}

type Row = { sig: string; element: HTMLElement };

export function createAgentChat(options: AgentChatOptions): AgentChat {
  const { paneKey, host, api, t } = options;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const isShown = options.isShown ?? (() => host.isConnected && host.closest("[hidden]") === null);

  function remembered(): Mode | undefined {
    try {
      const value = (options.storage ?? window.localStorage).getItem(MODE_KEY);
      return value === "chat" || value === "term" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  function remember(mode: Mode): void {
    try {
      (options.storage ?? window.localStorage).setItem(MODE_KEY, mode);
    } catch {
      // Only a convenience.
    }
  }

  // ---- the switch -------------------------------------------------------
  const bar = el("div", "agent-bar");
  bar.hidden = true;
  const tablist = el("div", "agent-switch");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", t("agentSwitchLabel"));
  const tabs = {
    chat: el("button", "agent-switch__tab", t("agentChatTab")),
    term: el("button", "agent-switch__tab", t("agentTermTab")),
  };
  for (const mode of ["chat", "term"] as const) {
    const tab = tabs[mode];
    tab.type = "button";
    tab.dataset["mode"] = mode;
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => setMode(mode, true));
  }
  tablist.append(tabs.chat, tabs.term);
  tablist.addEventListener("keydown", (event) => {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next: Mode =
      event.key === "Home"
        ? "chat"
        : event.key === "End"
          ? "term"
          : mode === "chat"
            ? "term"
            : "chat";
    setMode(next, true);
    tabs[next].focus();
  });
  bar.append(tablist);

  // ---- the chat ---------------------------------------------------------
  const panel = el("section", "agent-chat");
  panel.hidden = true;
  panel.setAttribute("aria-label", t("agentChatFeedLabel"));
  const head = el("div", "agent-chat__head");
  const nameField = el("span", "agent-chat__name");
  const titleField = el("span", "agent-chat__title");
  titleField.dir = "auto";
  const modelField = el("span", "agent-chat__model");
  const modeField = el("span", "agent-chat__mode");
  nameField.dataset["field"] = "name";
  titleField.dataset["field"] = "title";
  modelField.dataset["field"] = "model";
  modeField.dataset["field"] = "mode";
  head.append(nameField, titleField, modelField, modeField);
  const feed = el("div", "agent-chat__feed");
  feed.setAttribute("role", "log");
  feed.setAttribute("aria-live", "polite");
  feed.setAttribute("aria-label", t("agentChatFeedLabel"));
  feed.tabIndex = 0;
  const card = el("div", "agent-chat__prompt");
  card.hidden = true;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", t("agentChatQuestionLabel"));
  const form = el("form", "agent-chat__composer");
  const input = el("textarea", "agent-chat__input");
  input.rows = 2;
  input.dir = "auto";
  input.spellcheck = false;
  input.placeholder = t("agentChatComposer");
  input.setAttribute("aria-label", t("agentChatComposer"));
  const sendButton = el("button", "agent-chat__send", t("agentChatSend"));
  sendButton.type = "submit";
  form.append(input, sendButton);
  const note = el("p", "agent-chat__note");
  note.setAttribute("role", "status");
  note.hidden = true;
  panel.append(head, feed, card, note, form);
  host.prepend(bar);
  host.append(panel);

  // ---- state ------------------------------------------------------------
  let mode: Mode = "term";
  let agent: AgentOf | undefined;
  let disposed = false;
  let loading = false;
  let loadAgain = false;
  let sending = false;
  let answering = false;
  let cancelDetect: (() => void)[] = [];
  const rows = new Map<string, Row>();
  let cardSig = "";

  function showNote(message: string | undefined): void {
    note.textContent = message ?? "";
    note.hidden = message === undefined;
  }

  function focusComposer(): void {
    if (!input.disabled) input.focus();
  }

  function setMode(next: Mode, byUser: boolean): void {
    const hadFocus = byUser || host.contains(document.activeElement);
    mode = next;
    for (const which of ["chat", "term"] as const) {
      const selected = which === next;
      tabs[which].setAttribute("aria-selected", String(selected));
      tabs[which].tabIndex = selected ? 0 : -1;
    }
    panel.hidden = next !== "chat";
    if (next === "chat") {
      options.setChatView(true, focusComposer);
      if (agent !== undefined) render(agent);
      if (hadFocus) focusComposer();
    } else {
      options.setChatView(false, undefined);
      if (hadFocus) options.focusTerm();
    }
    if (byUser) remember(next);
  }
  // Term until an agent is found and the last choice says otherwise.
  setMode("term", false);

  // ---- drawing ----------------------------------------------------------
  const openLink = (url: string): void => {
    try {
      void Promise.resolve(api.plansOpenLink(url)).catch(() => undefined);
    } catch {
      // A preload without the channel: the link just does nothing.
    }
  };

  function userRow(text: string): HTMLElement {
    const row = el("div", "agent-chat__row agent-chat__row--user");
    const bubble = el("div", "agent-chat__bubble", text);
    bubble.dir = "auto";
    row.append(bubble);
    return row;
  }
  function textRow(text: string): HTMLElement {
    const row = el("div", "agent-chat__row agent-chat__row--text");
    for (const block of parseChatText(text)) row.append(renderBlock(block, openLink));
    return row;
  }
  function toolRow(tool: AgentOf["turns"][number]["tools"][number]): HTMLElement {
    const row = el("div", "agent-chat__row agent-chat__row--tool");
    row.append(el("span", "agent-chat__tool-name", tool.name));
    if (tool.target !== undefined && tool.target !== "") {
      const target = el("span", "agent-chat__tool-target", tool.target);
      target.dir = "auto";
      row.append(target);
    }
    if (tool.added !== undefined) row.append(el("span", "agent-chat__add", `+${tool.added}`));
    if (tool.removed !== undefined) row.append(el("span", "agent-chat__del", `−${tool.removed}`));
    return row;
  }
  function workingRow(view: AgentOf): HTMLElement {
    // Claude's own spinner text is shown as written; the other agents give a
    // generic busy flag, worded here so it follows the app's language.
    const label =
      view.vendor === "anthropic" && view.working !== undefined && view.working.trim() !== ""
        ? view.working
        : t("agentChatWorking");
    return el("div", "agent-chat__row agent-chat__row--working", label);
  }

  type Item = { key: string; sig: string; build(): HTMLElement };

  function itemsOf(view: AgentOf): Item[] {
    const items: Item[] = [];
    view.turns.forEach((turn, index) => {
      if (turn.role === "user") {
        if (turn.text.trim() === "") return;
        items.push({ key: `${index}u`, sig: `u${turn.text}`, build: () => userRow(turn.text) });
        return;
      }
      turn.tools.forEach((tool, at) => {
        items.push({
          key: `${index}t${at}`,
          sig: `t${JSON.stringify([tool.name, tool.target, tool.added, tool.removed])}`,
          build: () => toolRow(tool),
        });
      });
      if (turn.text.trim() !== "") {
        items.push({ key: `${index}a`, sig: `a${turn.text}`, build: () => textRow(turn.text) });
      }
    });
    if (view.working !== undefined) {
      const label = view.vendor === "anthropic" ? view.working : "";
      items.push({ key: "working", sig: `w${label}`, build: () => workingRow(view) });
    }
    return items;
  }

  function renderFeed(view: AgentOf): void {
    const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight <= BOTTOM_SLACK_PX;
    const items = itemsOf(view);
    const wanted = new Set(items.map((item) => item.key));
    for (const [key, row] of rows) {
      if (!wanted.has(key)) {
        row.element.remove();
        rows.delete(key);
      }
    }
    let cursor: ChildNode | null = feed.firstChild;
    for (const item of items) {
      let row = rows.get(item.key);
      if (row === undefined || row.sig !== item.sig) {
        // The row being replaced may be where the walk stands.
        if (row !== undefined && row.element === cursor) cursor = cursor.nextSibling;
        row?.element.remove();
        row = { sig: item.sig, element: item.build() };
        rows.set(item.key, row);
      }
      if (row.element === cursor) cursor = cursor.nextSibling;
      else feed.insertBefore(row.element, cursor);
    }
    if (items.length === 0 && feed.querySelector(".agent-chat__empty") === null) {
      feed.append(el("p", "agent-chat__empty", t("agentChatEmpty")));
    } else if (items.length > 0) {
      feed.querySelector(".agent-chat__empty")?.remove();
    }
    if (atBottom) feed.scrollTop = feed.scrollHeight;
  }

  function renderNeedsTerm(): void {
    card.hidden = false;
    if (cardSig === "needsTerm") return;
    cardSig = "needsTerm";
    card.replaceChildren();
    const question = el("p", "agent-chat__question", t("agentChatNeedsTerm"));
    question.dir = "auto";
    const button = el("button", "agent-chat__option", t("agentChatNeedsTermButton"));
    button.type = "button";
    button.addEventListener("click", () => setMode("term", true));
    const choices = el("div", "agent-chat__options");
    choices.append(button);
    card.append(question, choices);
  }

  function renderCard(view: AgentOf): void {
    const prompt = view.prompt;
    if (prompt === undefined && view.needsTerm === true) {
      renderNeedsTerm();
      return;
    }
    if (prompt === undefined) {
      card.hidden = true;
      card.replaceChildren();
      cardSig = "";
      return;
    }
    card.hidden = false;
    const sig = JSON.stringify([prompt.question, prompt.options.map((option) => option.label)]);
    if (sig === cardSig) return;
    cardSig = sig;
    card.replaceChildren();
    const question = el("p", "agent-chat__question", prompt.question);
    question.dir = "auto";
    card.append(question);
    const choices = el("div", "agent-chat__options");
    prompt.options.forEach((option, index) => {
      const button = el("button", "agent-chat__option", option.label);
      button.type = "button";
      button.dir = "auto";
      button.disabled = answering;
      button.addEventListener("click", () => void answer(index, option.label));
      choices.append(button);
    });
    card.append(choices);
  }

  function renderHead(view: AgentOf): void {
    nameField.textContent = VENDOR_NAMES[view.vendor];
    titleField.textContent = view.title ?? "";
    titleField.hidden = view.title === undefined || view.title === "";
    modelField.textContent = view.model ?? "";
    modelField.hidden = view.model === undefined || view.model === "";
    modeField.textContent = view.mode === undefined ? "" : t(MODE_MESSAGES[view.mode]);
    modeField.hidden = view.mode === undefined;
  }

  function updateComposer(): void {
    const locked = sending || agent?.prompt !== undefined || agent?.needsTerm === true;
    input.disabled = locked;
    sendButton.disabled = locked;
    for (const button of card.querySelectorAll("button")) {
      button.disabled = agent?.needsTerm === true ? false : answering;
    }
  }

  function render(view: AgentOf): void {
    renderHead(view);
    renderFeed(view);
    renderCard(view);
    updateComposer();
  }

  // ---- reading ----------------------------------------------------------
  function stopDetecting(): void {
    for (const cancel of cancelDetect) cancel();
    cancelDetect = [];
  }

  // The agent was shown and a reply says "none" (or main failed): while the
  // command still runs that may be a blip, so ask once more before leaving
  // Chat. The draft in the composer is never touched either way.
  let lostOnce = false;
  let cancelReAsk: (() => void) | undefined;
  function agentMissing(): void {
    if (agent === undefined) return;
    if (!lostOnce && options.isRunning?.() === true) {
      lostOnce = true;
      cancelReAsk?.();
      cancelReAsk = schedule(() => {
        cancelReAsk = undefined;
        if (!disposed) void load();
      }, RE_ASK_MS);
      return;
    }
    dropAgent();
  }

  function dropAgent(): void {
    lostOnce = false;
    cancelReAsk?.();
    cancelReAsk = undefined;
    if (agent === undefined) return;
    const hadFocus = host.contains(document.activeElement);
    agent = undefined;
    bar.hidden = true;
    rows.clear();
    feed.replaceChildren();
    card.replaceChildren();
    card.hidden = true;
    cardSig = "";
    showNote(undefined);
    if (mode === "chat") {
      options.setChatView(false, undefined);
      mode = "term";
      panel.hidden = true;
      if (hadFocus) options.focusTerm();
    }
    for (const which of ["chat", "term"] as const) {
      tabs[which].setAttribute("aria-selected", String(which === "term"));
      tabs[which].tabIndex = which === "term" ? 0 : -1;
    }
    updateComposer();
    // A command still running may start (or show) an agent again.
    if (options.isRunning?.() === true) {
      stopDetecting();
      cancelDetect = [schedule(keepLooking, KEEP_LOOKING_MS)];
    }
  }

  function apply(view: AgentView): void {
    if (view.kind !== "agent") {
      agentMissing();
      return;
    }
    lostOnce = false;
    cancelReAsk?.();
    cancelReAsk = undefined;
    const first = agent === undefined;
    agent = view;
    stopDetecting();
    bar.hidden = false;
    if (first && remembered() === "chat") setMode("chat", false);
    else if (mode === "chat") render(view);
  }

  async function load(): Promise<void> {
    if (disposed) return;
    if (loading) {
      loadAgain = true;
      return;
    }
    loading = true;
    try {
      const view = await api.terminalAgentView(paneKey);
      if (!disposed) apply(view);
    } catch {
      // The view stays as it was; the next ask tries again. An agent already
      // shown counts the failure like a "none".
      if (!disposed) agentMissing();
    } finally {
      loading = false;
      if (loadAgain && !disposed) {
        loadAgain = false;
        void load();
      }
    }
  }

  // ---- sending and answering -------------------------------------------
  async function submit(): Promise<void> {
    if (sending || agent?.prompt !== undefined || agent?.needsTerm === true) return;
    const text = input.value;
    if (text.trim() === "") return;
    sending = true;
    showNote(undefined);
    updateComposer();
    let outcome: AgentSendResult;
    try {
      outcome = await api.terminalAgentSend(paneKey, text);
    } catch {
      outcome = { ok: false, reason: "gone" };
      showNote(t("agentChatSendFailed"));
    }
    sending = false;
    if (outcome.ok) {
      input.value = "";
      showNote(undefined);
    } else if (note.hidden) {
      showNote(t(SEND_REFUSALS[outcome.reason]));
    }
    updateComposer();
    if (!disposed) {
      focusComposer();
      void load();
    }
  }

  async function answer(index: number, label: string): Promise<void> {
    if (answering) return;
    answering = true;
    showNote(undefined);
    updateComposer();
    try {
      const result = await api.terminalAgentAnswer(paneKey, index, label);
      if (!result.ok) {
        showNote(t(result.reason === "changed" ? "agentChatAnswerChanged" : "agentChatAnswerGone"));
      }
    } catch {
      showNote(t("agentChatAnswerGone"));
    }
    answering = false;
    updateComposer();
    if (!disposed) void load();
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });
  input.addEventListener("keydown", (event) => {
    // The pane's palette and split chords first: a claimed key is not ours.
    if (!options.chatKey(event)) return;
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void submit();
    }
  });

  // A reload while a command was running: nothing told this pane a command
  // started, so look once the pane has had a moment to replay its screen.
  const cancelReload = schedule(() => {
    if (!disposed && options.isRunning?.() === true) commandStarted();
  }, RELOAD_CHECK_MS);

  function commandStarted(): void {
    if (disposed) return;
    stopDetecting();
    cancelDetect = DETECT_AT_MS.map((ms) =>
      schedule(() => {
        if (!disposed) void load();
      }, ms),
    );
    const last = DETECT_AT_MS[DETECT_AT_MS.length - 1] ?? 0;
    cancelDetect.push(schedule(keepLooking, last + KEEP_LOOKING_MS));
  }

  // After the first looks found nothing: every 10s while a command runs, the
  // pane shows and the document is visible. Ends on an agent (stopDetecting),
  // a finished command, or dispose.
  function keepLooking(): void {
    if (disposed || agent !== undefined || options.isRunning?.() !== true) return;
    if (isShown() && document.visibilityState === "visible") void load();
    cancelDetect = [schedule(keepLooking, KEEP_LOOKING_MS)];
  }

  return {
    commandStarted,
    focused() {
      if (!disposed && isShown()) void load();
    },
    refresh() {
      // Only a pane known to run an agent: a push for any other is not ours
      // to scan for.
      if (!disposed && agent !== undefined && isShown()) void load();
    },
    dispose() {
      disposed = true;
      cancelReload();
      cancelReAsk?.();
      stopDetecting();
      bar.remove();
      panel.remove();
    },
  };
}
