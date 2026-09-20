import type { Session } from "@jarvis/core";
import type { TranscriptEntry } from "@jarvis/wire";
import type { RpcClient } from "./rpc-client";
import { parseSession } from "./session-parse";
import { parseTranscriptEntries } from "./workspace-results";

export type HistoryState = {
  sessions: Session[];
  selectedId?: string;
  transcript: TranscriptEntry[];
  stale: boolean;
  loading: boolean;
  notice?: string;
};

export type HistoryStore = {
  get(): HistoryState;
  subscribe(fn: (state: HistoryState) => void): () => void;
  open(): void;
  select(id: string): void;
  refresh(): void;
  close(): void;
};

function toSessions(value: unknown): Session[] {
  if (!Array.isArray(value)) return [];
  const sessions: Session[] = [];
  for (const item of value) {
    const session = parseSession(item);
    if (session !== undefined) sessions.push(session);
  }
  return sessions;
}

export function createHistoryStore(deps: { client: RpcClient }): HistoryStore {
  const listeners = new Set<(state: HistoryState) => void>();
  let state: HistoryState = { sessions: [], transcript: [], stale: false, loading: false };
  let visible = false;
  let refreshGeneration = 0;
  let transcriptGeneration = 0;
  let unsubscribeState: (() => void) | undefined;

  function setState(patch: Partial<HistoryState>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  }

  function selectedKnown(id: string): boolean {
    return state.sessions.some((session) => session.id === id);
  }

  async function loadTranscript(id: string): Promise<void> {
    if (!selectedKnown(id)) return;
    const generation = ++transcriptGeneration;
    setState({ loading: true, selectedId: id, transcript: [], notice: undefined });
    const result = await deps.client.call("session:transcript", [id], { whenNotOpen: "reject" });
    if (generation !== transcriptGeneration || state.selectedId !== id) return;
    if (result.ok) {
      setState({ transcript: parseTranscriptEntries(result.value), loading: false, stale: false });
    } else {
      setState({
        loading: false,
        stale: true,
        notice: result.error.kind === "remote" ? result.error.text : undefined,
      });
    }
  }

  async function refreshNow(): Promise<void> {
    const generation = ++refreshGeneration;
    setState({ loading: true, notice: undefined });
    const result = await deps.client.call("history:list", [], { whenNotOpen: "reject" });
    if (generation !== refreshGeneration) return;
    if (result.ok) {
      const sessions = toSessions(result.value);
      const selectedId =
        state.selectedId !== undefined &&
        sessions.some((session) => session.id === state.selectedId)
          ? state.selectedId
          : undefined;
      setState({
        sessions,
        selectedId,
        transcript: selectedId === undefined ? [] : state.transcript,
        loading: false,
        stale: false,
      });
    } else {
      setState({
        loading: false,
        stale: true,
        notice: result.error.kind === "remote" ? result.error.text : undefined,
      });
    }
  }

  function refresh(): void {
    if (!visible) return;
    void refreshNow();
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    open() {
      if (visible) return;
      visible = true;
      unsubscribeState = deps.client.onState((clientState) => {
        if (clientState === "open") refresh();
      });
      refresh();
    },
    select(id) {
      if (!selectedKnown(id)) return;
      void loadTranscript(id);
    },
    refresh,
    close() {
      visible = false;
      refreshGeneration += 1;
      transcriptGeneration += 1;
      unsubscribeState?.();
      unsubscribeState = undefined;
    },
  };
}
