// Task 7: one pane's parsed Claude view and keyed refresh notifications.
// Dependencies are injected; terminal content is never logged.
import {
  CLAUDE_ANSWER_CHANNEL,
  CLAUDE_VIEW_CHANGED,
  CLAUDE_VIEW_CHANNEL,
  type ClaudeAnswerResult,
  type ClaudeView,
  parseClaudeView,
} from "@jarvis/wire";
import type { RpcClient } from "./rpc-client";
import { matchesPaneExit } from "./terminal-stream";

export type ClaudeViewState = { view: ClaudeView; tab: "chat" | "term"; answering: boolean };
export type ClaudeViewStore = {
  get(): ClaudeViewState;
  subscribe(fn: (state: ClaudeViewState) => void): () => void;
  setTab(tab: ClaudeViewState["tab"]): void;
  open(): void;
  close(): void;
  refresh(): Promise<void>;
  answer(index: number, label: string): Promise<ClaudeAnswerResult>;
};

/** Cheap equality for two views: enough to tell whether anything the chat
 *  shows changed, without walking every turn. */
export function sameClaudeView(a: ClaudeView, b: ClaudeView): boolean {
  if (a.kind === "none" || b.kind === "none") return a.kind === b.kind;
  const lastA = a.turns.at(-1);
  const lastB = b.turns.at(-1);
  const promptKey = (view: typeof a) =>
    view.prompt === undefined
      ? ""
      : `${view.prompt.question}\n${view.prompt.options.map((option) => option.label).join("\n")}`;
  return (
    a.sessionId === b.sessionId &&
    a.title === b.title &&
    a.model === b.model &&
    a.mode === b.mode &&
    a.working === b.working &&
    a.turns.length === b.turns.length &&
    lastA?.role === lastB?.role &&
    lastA?.text === lastB?.text &&
    lastA?.tools.length === lastB?.tools.length &&
    promptKey(a) === promptKey(b)
  );
}

export function createClaudeViewStore(deps: {
  client: RpcClient;
  paneKey: string;
  log(line: string): void;
}): ClaudeViewStore {
  let state: ClaudeViewState = { view: { kind: "none" }, tab: "term", answering: false };
  const listeners = new Set<(state: ClaudeViewState) => void>();
  const target = { ch: CLAUDE_VIEW_CHANGED, key: deps.paneKey };
  let opened = false;
  let seenClaude = false;
  let generation = 0;
  let off: (() => void) | undefined;
  let inFlight: Promise<void> | undefined;
  let queued = false;
  /** A push arrived while the Term tab hid the chat: refetch on Chat. */
  let stale = false;

  function setState(patch: Partial<ClaudeViewState>): void {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn(state);
  }

  function refresh(): Promise<void> {
    // A closed store fetches nothing and changes no state.
    if (!opened) return Promise.resolve();
    if (inFlight) {
      queued = true;
      return inFlight;
    }
    const current = generation;
    const run = async () => {
      do {
        queued = false;
        try {
          const result = await deps.client.call(CLAUDE_VIEW_CHANNEL, [deps.paneKey], {
            whenNotOpen: "reject",
          });
          if (current !== generation) return;
          if (result.ok) {
            const view = parseClaudeView(result.value);
            const tab = view.kind === "none" ? "term" : seenClaude ? state.tab : "chat";
            // Claude gone: a later Claude in this pane opens on Chat again.
            seenClaude = view.kind === "claude";
            // An unchanged view re-renders nothing.
            if (tab !== state.tab || !sameClaudeView(view, state.view)) setState({ view, tab });
          } else deps.log("claude-view: refresh failed");
        } catch {
          deps.log("claude-view: refresh failed");
        }
      } while (queued && current === generation);
      // Cleared as the loop exits, not in a `.finally`: a refresh() landing
      // in the microtasks between would join this finished run and be lost.
      if (inFlight === promise) inFlight = undefined;
    };
    const promise: Promise<void> = run();
    inFlight = promise;
    return promise;
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setTab(tab) {
      setState({ tab: state.view.kind === "none" ? "term" : tab });
      if (state.tab === "chat" && stale) {
        stale = false;
        void refresh();
      }
    },
    refresh,
    open() {
      if (opened) return;
      opened = true;
      off = deps.client.onPush(CLAUDE_VIEW_CHANGED, (payload) => {
        if (!opened || !matchesPaneExit(payload, deps.paneKey)) return;
        // Term shows the live stream already; the chat catches up when it
        // is shown again. With no Claude in the pane, keep looking.
        if (state.tab === "term" && state.view.kind === "claude") stale = true;
        else void refresh();
      });
      deps.client.subscribe(target);
      void refresh();
    },
    close() {
      if (!opened) return;
      opened = false;
      stale = false;
      generation++;
      queued = false;
      inFlight = undefined;
      off?.();
      off = undefined;
      deps.client.unsubscribe(target);
    },
    // One answer at a time: a second answer() while one is pending rejects
    // unsent ("claude-view: answer pending"), and `answering` stays true
    // until the first settles. After close() no answer changes state.
    async answer(index, label) {
      if (state.answering) throw new Error("claude-view: answer pending");
      setState({ answering: true });
      try {
        const result = await deps.client.call(CLAUDE_ANSWER_CHANNEL, [deps.paneKey, index, label], {
          whenNotOpen: "reject",
        });
        if (!result.ok) throw new Error("claude-view: answer failed");
        const value = result.value as Partial<ClaudeAnswerResult> | null;
        if (value?.ok === true) return { ok: true };
        if (value?.ok === false && (value.reason === "gone" || value.reason === "changed")) {
          if (value.reason === "changed") await refresh();
          return { ok: false, reason: value.reason };
        }
        throw new Error("claude-view: invalid answer reply");
      } finally {
        if (opened) setState({ answering: false });
        else state = { ...state, answering: false };
      }
    },
  };
}
