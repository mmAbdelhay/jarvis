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
  /** Older sessions exist past the last one loaded. */
  more: boolean;
  loadingMore: boolean;
  /** The search the list was loaded for ("" for none). */
  query: string;
};

export type HistoryStore = {
  get(): HistoryState;
  subscribe(fn: (state: HistoryState) => void): () => void;
  open(): void;
  select(id: string): void;
  refresh(): void;
  /** The next page, after the last session loaded. */
  loadMore(): void;
  /** Reloads the first page for this search. */
  search(query: string): void;
  close(): void;
};

/** Sessions per page: a screenful or two on a phone. */
export const HISTORY_PAGE = 50;

/**
 * A `history:list` answer: a page (`{ sessions, more }`) from a laptop that
 * pages, or the whole list from one that ignores the request — which then
 * simply has no more to load.
 */
function toPage(value: unknown): { sessions: Session[]; more: boolean } {
  if (Array.isArray(value)) return { sessions: toSessions(value), more: false };
  if (typeof value !== "object" || value === null) return { sessions: [], more: false };
  const page = value as Record<string, unknown>;
  return { sessions: toSessions(page["sessions"]), more: page["more"] === true };
}

function toSessions(value: unknown): Session[] {
  if (!Array.isArray(value)) return [];
  const sessions: Session[] = [];
  for (const item of value) {
    const session = parseSession(item);
    if (session !== undefined) sessions.push(session);
  }
  return sessions;
}

export function createHistoryStore(deps: {
  client: RpcClient;
  /** A session this screen must have whether or not it is on the first
   *  page — the transcript screen's own. Fetched by id when the page lacks
   *  it; a laptop that does not page answers the whole list anyway. */
  pinnedId?: string;
}): HistoryStore {
  const listeners = new Set<(state: HistoryState) => void>();
  let state: HistoryState = {
    sessions: [],
    transcript: [],
    stale: false,
    loading: false,
    more: false,
    loadingMore: false,
    query: "",
  };
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
    const result = await deps.client.call("history:list", [pageRequest()], {
      whenNotOpen: "reject",
    });
    if (generation !== refreshGeneration) return;
    if (result.ok) {
      const { sessions, more } = toPage(result.value);
      const pinned = deps.pinnedId;
      if (pinned !== undefined && !sessions.some((session) => session.id === pinned)) {
        const lookup = await deps.client.call("history:list", [{ limit: 1, id: pinned }], {
          whenNotOpen: "reject",
        });
        if (generation !== refreshGeneration) return;
        if (lookup.ok) {
          const found = toPage(lookup.value).sessions.find((session) => session.id === pinned);
          if (found !== undefined) sessions.push(found);
        }
      }
      const selectedId =
        state.selectedId !== undefined &&
        sessions.some((session) => session.id === state.selectedId)
          ? state.selectedId
          : undefined;
      setState({
        sessions,
        more,
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

  function pageRequest(after?: Session): Record<string, unknown> {
    return {
      limit: HISTORY_PAGE,
      ...(state.query === "" ? {} : { query: state.query }),
      ...(after === undefined
        ? {}
        : { before: { lastActivityAt: after.lastActivityAt, id: after.id } }),
    };
  }

  async function loadMoreNow(): Promise<void> {
    const last = state.sessions.at(-1);
    if (!state.more || state.loadingMore || last === undefined) return;
    const generation = refreshGeneration;
    setState({ loadingMore: true });
    const result = await deps.client.call("history:list", [pageRequest(last)], {
      whenNotOpen: "reject",
    });
    // A refresh or a new search since: this page belongs to a list that is
    // no longer on screen.
    if (generation !== refreshGeneration) return;
    if (result.ok) {
      const page = toPage(result.value);
      const known = new Set(state.sessions.map((session) => session.id));
      setState({
        sessions: [...state.sessions, ...page.sessions.filter((session) => !known.has(session.id))],
        more: page.more,
        loadingMore: false,
      });
    } else {
      setState({
        loadingMore: false,
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
    loadMore() {
      if (visible) void loadMoreNow();
    },
    search(query) {
      const trimmed = query.trim();
      if (trimmed === state.query) return;
      setState({ query: trimmed });
      refresh();
    },
    close() {
      visible = false;
      refreshGeneration += 1;
      transcriptGeneration += 1;
      unsubscribeState?.();
      unsubscribeState = undefined;
    },
  };
}
