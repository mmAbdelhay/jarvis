// The Chat | Term switch of a Terminal pane running a coding agent (Claude
// Code, Copilot or Codex), and the chat it turns the pane into.
//
// Main does the reading (terminal:agentChat joins the agent's transcript with
// what its screen shows); this file puts the parts together — header, feed,
// question card, composer, side panel, search — and draws what main says.
// Everything an agent or a person wrote reaches the DOM through textContent
// and text nodes, never innerHTML, and a link opens only if it is https,
// through the existing safe external path. The terminal under the chat is
// hidden, never detached (terminal-pane.ts's setChatView), so the pty never
// changes size for it and nothing typed in the chat reaches the pty except
// through the agent* calls, which main re-checks against the screen.
import type { ChatItem } from "@jarvis/platform";
import type { AgentAnswerResult, AgentSendResult } from "../src/agent-view.js";
import type { RendererApi } from "../src/ipc.js";
import type { MessageKey } from "../src/messages.js";
import type { AgentChatView, AgentOf, StorageLike } from "./agent-chat/agent-types.js";
import type { CodeContext } from "./agent-chat/code.js";
import { createComposer } from "./agent-chat/composer.js";
import { createDrawer } from "./agent-chat/drawer.js";
import { el } from "./agent-chat/dom.js";
import { createFeed } from "./agent-chat/feed.js";
import { mergeLive, prependOlder } from "./agent-chat/paging.js";
import { createPanel } from "./agent-chat/panel.js";
import { createQuestion } from "./agent-chat/question.js";
import { createSearch } from "./agent-chat/search.js";
import { createShell, type Mode } from "./agent-chat/shell.js";

export type AgentChatOptions = {
  paneKey: string;
  /** The pane's own element: the switch and the chat are drawn inside it. */
  host: HTMLElement;
  api: Pick<
    RendererApi,
    | "terminalAgentChat"
    | "terminalAgentAnswer"
    | "terminalAgentSend"
    | "terminalAgentStop"
    | "terminalAgentMode"
    | "terminalAgentCommand"
    | "terminalAgentCommands"
    | "terminalAgentFiles"
    | "terminalAgentAttach"
    | "terminalAgentOpenFile"
  > & {
    /** The existing safe external-open path (main allows http, https, mailto only). */
    plansOpenLink(url: string): unknown;
    pathForFile?(file: File): string;
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
  storage?: StorageLike;
  /** Whether the pane is on screen; pushes for one that is not are skipped. */
  isShown?(): boolean;
  /** The tab's file sidebar toggle, shown in the header. */
  toggleFiles?: () => void;
  now?: () => number;
  copy?: (text: string) => void;
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
/** Pane width under which the side panel becomes chips above the composer. */
export const NARROW_PX = 1000;
const MODE_KEY = "jarvis.agentChatMode";
const PANEL_KEY = "jarvis.agentChatPanel";

const VENDOR_NAMES = { anthropic: "Claude Code", github: "Copilot", openai: "Codex" } as const;

function defaultCopy(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

export function createAgentChat(options: AgentChatOptions): AgentChat {
  const { paneKey, host, api, t } = options;
  const schedule =
    options.schedule ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  const now = options.now ?? (() => Date.now());
  const isShown = options.isShown ?? (() => host.isConnected && host.closest("[hidden]") === null);
  const storage = (): StorageLike | undefined => {
    try {
      return options.storage ?? window.localStorage;
    } catch {
      return undefined;
    }
  };

  function remembered(): Mode | undefined {
    try {
      const value = storage()?.getItem(MODE_KEY);
      return value === "chat" || value === "term" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  function remember(mode: Mode): void {
    try {
      storage()?.setItem(MODE_KEY, mode);
    } catch {
      // Only a convenience.
    }
  }
  const panelHidden = (): boolean => {
    try {
      return storage()?.getItem(PANEL_KEY) === "hidden";
    } catch {
      return false;
    }
  };
  const setPanelHidden = (hidden: boolean): void => {
    try {
      storage()?.setItem(PANEL_KEY, hidden ? "hidden" : "shown");
    } catch {
      // Only a convenience.
    }
  };

  // ---- state ------------------------------------------------------------
  let mode: Mode = "term";
  let agent: AgentOf | undefined;
  let items: ChatItem[] = [];
  let older: string | undefined;
  let loadingOlder = false;
  let disposed = false;
  let loading = false;
  let loadAgain = false;
  let answering = false;
  let cancelDetect: (() => void)[] = [];
  let cancelTick: (() => void) | undefined;
  let prependNext = false;
  /** The note on screen is the read-failed one, which a good read clears. */
  let readFailedNote = false;

  // ---- parts ------------------------------------------------------------
  const shell = createShell({
    t,
    toggleFiles: options.toggleFiles,
    onTab: (next, byUser) => setMode(next, byUser),
    currentMode: () => mode,
  });
  const { bar, panel } = shell;

  const copy = options.copy ?? defaultCopy;
  const openLink = (url: string): void => {
    try {
      void Promise.resolve(api.plansOpenLink(url)).catch(() => undefined);
    } catch {
      // A preload without the channel: the link just does nothing.
    }
  };
  const note = el("p", "agent-chat__note");
  note.setAttribute("role", "status");
  note.hidden = true;
  function showNote(message: string | undefined): void {
    note.textContent = message ?? "";
    note.hidden = message === undefined || message === "";
  }
  function openFile(path: string): void {
    void (async () => {
      try {
        const result = await api.terminalAgentOpenFile(paneKey, path);
        if (!result.ok) showNote(t("agentChatOpenFailed"));
      } catch {
        showNote(t("agentChatOpenFailed"));
      }
    })();
  }
  const code: CodeContext = { t, openLink, copy };

  const feed = createFeed({
    t,
    openLink,
    openFile,
    copy,
    loadOlder: () => void loadOlder(),
    rendered: () => search.refresh(),
  });
  const search = createSearch({
    t,
    root: feed.column,
    reveal: (node) => feed.reveal(node),
    hasOlder: () => older !== undefined,
    loadOlder,
    onClose: () => composer.focus(),
  });
  const drawer = createDrawer(host);
  const question = createQuestion({
    t,
    code,
    drawer,
    answer,
    focusComposer: () => composer.focus(),
    toTerm: () => setMode("term", true),
  });
  const side = createPanel({
    t,
    openFile,
    hidden: panelHidden,
    setHidden: (hidden) => {
      setPanelHidden(hidden);
    },
  });
  const composer = createComposer({
    t,
    paneKey,
    api: {
      send: (text) => api.terminalAgentSend(paneKey, text),
      stop: () => api.terminalAgentStop(paneKey),
      mode: (next) => api.terminalAgentMode(paneKey, next),
      command: (command) => api.terminalAgentCommand(paneKey, command),
      commands: () => api.terminalAgentCommands(paneKey),
      files: (query) => api.terminalAgentFiles(paneKey, query),
      attach: (file) => api.terminalAgentAttach(paneKey, file),
      ...(api.pathForFile === undefined
        ? {}
        : { pathForFile: (file: File) => api.pathForFile?.(file) ?? "" }),
    },
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    schedule,
    now,
    chatKey: (event) => options.chatKey(event),
    history: () => {
      const texts: string[] = [];
      for (const item of items) {
        if (
          item.kind === "user" &&
          item.text.trim() !== "" &&
          texts[texts.length - 1] !== item.text
        ) {
          texts.push(item.text);
        }
      }
      return texts;
    },
    note: showNote,
    changed: () => void load(),
    dropTarget: panel,
  });

  shell.actions.append(search.toggle, side.toggle);
  shell.top.append(search.element);
  shell.main.insertBefore(feed.element, shell.lower);
  shell.lower.append(question.element, side.chips, note, composer.element);
  shell.side.append(side.aside);
  host.prepend(bar);
  host.append(panel);

  panel.addEventListener("keydown", (event) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "f"
    ) {
      event.preventDefault();
      event.stopPropagation();
      search.open();
    }
  });

  // ---- the switch -------------------------------------------------------
  function focusComposer(): void {
    composer.focus();
  }

  function setMode(next: Mode, byUser: boolean): void {
    const hadFocus = byUser || host.contains(document.activeElement);
    mode = next;
    shell.setSelected(next);
    panel.hidden = next !== "chat";
    if (next === "chat") {
      options.setChatView(true, focusComposer);
      if (agent !== undefined) render(agent);
      if (hadFocus) focusComposer();
    } else {
      drawer.close();
      options.setChatView(false, undefined);
      if (hadFocus) options.focusTerm();
    }
    if (byUser) remember(next);
  }
  // Term until an agent is found and the last choice says otherwise.
  setMode("term", false);

  // ---- drawing ----------------------------------------------------------
  function paneWidth(): number {
    return host.clientWidth;
  }

  function layout(view: AgentOf): void {
    const width = paneWidth();
    const narrow = width > 0 && width < NARROW_PX;
    panel.dataset["narrow"] = String(narrow);
    side.update(
      {
        ...(view.todos === undefined ? {} : { todos: view.todos }),
        agents: view.agents,
        files: view.files,
        ...(view.context === undefined ? {} : { context: view.context }),
        ...(view.deriving === true ? { deriving: true } : {}),
        now: now(),
      },
      narrow,
    );
  }

  function workingSince(): number | undefined {
    for (let at = items.length - 1; at >= 0; at--) {
      const item = items[at];
      if (item?.kind === "user") return item.at;
    }
    return undefined;
  }

  function renderFeed(view: AgentOf): void {
    const prepended = prependNext;
    prependNext = false;
    feed.setItems(items, {
      ...(view.working === undefined ? {} : { working: view.working }),
      ...(view.working === undefined || workingSince() === undefined
        ? {}
        : { workingSince: workingSince() as number }),
      now: now(),
      older: loadingOlder ? "loading" : older !== undefined ? "more" : "none",
      ...(prepended ? { prepended: true } : {}),
    });
    cancelTick?.();
    cancelTick = undefined;
    if (view.working !== undefined || view.agents.some((a) => a.state === "running")) {
      cancelTick = schedule(() => {
        cancelTick = undefined;
        if (disposed || mode !== "chat" || agent === undefined) return;
        renderFeed(agent);
        layout(agent);
      }, 1000);
    }
  }

  function render(view: AgentOf): void {
    shell.setIdentity(VENDOR_NAMES[view.vendor], view.title);
    renderFeed(view);
    // The composer first: closing the drawer hands the keys to it.
    composer.update(view, view.prompt !== undefined || view.needsTerm === true);
    question.update(view, answering);
    layout(view);
    if (view.readFailed === true) {
      showNote(t("agentChatReadFailed"));
      readFailedNote = true;
    }
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
    cancelTick?.();
    cancelTick = undefined;
    if (agent === undefined) return;
    const hadFocus = host.contains(document.activeElement);
    agent = undefined;
    items = [];
    older = undefined;
    bar.hidden = true;
    drawer.close();
    feed.setItems([], { now: now(), older: "none" });
    showNote(undefined);
    if (mode === "chat") {
      options.setChatView(false, undefined);
      mode = "term";
      panel.hidden = true;
      if (hadFocus) options.focusTerm();
    }
    shell.setSelected("term");
    // A command still running may start (or show) an agent again.
    if (options.isRunning?.() === true) {
      stopDetecting();
      cancelDetect = [schedule(keepLooking, KEEP_LOOKING_MS)];
    }
  }

  function apply(view: AgentChatView): void {
    if (view.kind !== "agent") {
      agentMissing();
      return;
    }
    lostOnce = false;
    cancelReAsk?.();
    cancelReAsk = undefined;
    const first = agent === undefined;
    const sameSession = agent?.sessionId === view.sessionId;
    if (view.readFailed === true && sameSession) {
      // A read that failed keeps what is shown and says so.
      agent = { ...view, page: { items: [] } };
    } else {
      if (!sameSession) {
        items = [];
        older = undefined;
      }
      const hadOlderLoaded = items.length > view.page.items.length;
      items = mergeLive(items, view.page.items, view.reset === true || !sameSession);
      if (!hadOlderLoaded || view.reset === true || !sameSession) older = view.page.older;
      agent = view;
    }
    stopDetecting();
    bar.hidden = false;
    if (first && remembered() === "chat") setMode("chat", false);
    else if (mode === "chat")
      render(view.readFailed === true && sameSession ? (agent as AgentOf) : view);
    if (view.readFailed !== true && readFailedNote) {
      readFailedNote = false;
      showNote(undefined);
    }
  }

  async function load(): Promise<void> {
    if (disposed) return;
    if (loading) {
      loadAgain = true;
      return;
    }
    loading = true;
    try {
      const view = await api.terminalAgentChat(paneKey);
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

  /** One older page; true when it brought items. */
  async function loadOlder(): Promise<boolean> {
    const cursor = older;
    if (cursor === undefined || loadingOlder || disposed || agent === undefined) return false;
    loadingOlder = true;
    if (mode === "chat") renderFeed(agent);
    let got = false;
    try {
      const view = await api.terminalAgentChat(paneKey, { before: cursor });
      if (!disposed && view.kind === "agent" && view.sessionId === agent?.sessionId) {
        if (view.reset === true) {
          items = [...view.page.items];
        } else {
          const before = items.length;
          items = prependOlder(items, view.page.items);
          got = items.length > before;
          prependNext = got;
        }
        older = view.page.older;
      } else older = undefined;
    } catch {
      // Try again on the next scroll.
    } finally {
      loadingOlder = false;
      if (!disposed && agent !== undefined && mode === "chat") renderFeed(agent);
    }
    return got || older !== undefined;
  }

  // ---- answering --------------------------------------------------------
  async function answer(index: number, label: string): Promise<void> {
    if (answering) return;
    answering = true;
    showNote(undefined);
    if (agent !== undefined) question.update(agent, answering);
    try {
      const result: AgentAnswerResult = await api.terminalAgentAnswer(paneKey, index, label);
      if (!result.ok) {
        showNote(t(result.reason === "changed" ? "agentChatAnswerChanged" : "agentChatAnswerGone"));
      }
    } catch {
      showNote(t("agentChatAnswerGone"));
    }
    answering = false;
    if (agent !== undefined) question.update(agent, answering);
    if (!disposed) void load();
  }

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

  // The pane's width decides the side panel; watch it where the browser can.
  let sizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    sizeObserver = new ResizeObserver(() => {
      if (!disposed && agent !== undefined && mode === "chat") {
        layout(agent);
        drawer.place();
      }
    });
    sizeObserver.observe(host);
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
      cancelTick?.();
      stopDetecting();
      sizeObserver?.disconnect();
      drawer.close();
      bar.remove();
      panel.remove();
    },
  };
}

export type { AgentSendResult, AgentChatView };
