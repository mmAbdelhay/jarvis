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

  function setState(patch: Partial<ClaudeViewState>): void {
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn(state);
  }

  function refresh(): Promise<void> {
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
            if (view.kind === "claude") seenClaude = true;
            setState({ view, tab });
          } else deps.log("claude-view: refresh failed");
        } catch {
          deps.log("claude-view: refresh failed");
        }
      } while (queued && current === generation);
    };
    const promise = run().finally(() => {
      if (inFlight === promise) inFlight = undefined;
    });
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
    },
    refresh,
    open() {
      if (opened) return;
      opened = true;
      off = deps.client.onPush(CLAUDE_VIEW_CHANGED, (payload) => {
        if (opened && matchesPaneExit(payload, deps.paneKey)) void refresh();
      });
      deps.client.subscribe(target);
      void refresh();
    },
    close() {
      if (!opened) return;
      opened = false;
      generation++;
      queued = false;
      inFlight = undefined;
      off?.();
      off = undefined;
      deps.client.unsubscribe(target);
    },
    async answer(index, label) {
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
        setState({ answering: false });
      }
    },
  };
}
