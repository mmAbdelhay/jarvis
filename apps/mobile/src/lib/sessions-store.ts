// The session table's own store (Task 7): the full `sessions:list` answer,
// grouped into active/ended and kept live by `sessions:update` pushes.
// Same discipline as dashboard-store.ts — every value off the wire is
// `unknown` until parsed field by field, rows are rebuilt (never spread),
// and `sessions:update` is a ref-counted subscription (Task 3 / ruling 16)
// so the Dashboard and this store can both hold it safely.
//
// See the mobile milestone 7, task 7 plan (docs/superpowers/plans)
// and rulings.md (10, 16, 17) for the behaviour this file implements.

import type { SessionState } from "@jarvis/core";
import { isSubscriptionKey } from "@jarvis/wire";
import type { RpcClient, RpcError } from "./rpc-client";
import { parseSession } from "./session-parse";

export type SessionRowView = {
  id: string;
  label: string;
  summary: string;
  state: SessionState;
  agentId: string;
  // `startedAt` added (fix round, 2026-09-19 redesign): the Sessions
  // screen's row-level "elapsed mono" field (`Sessions.dc.html`) needs a
  // start time — `parseSession` already requires and parses `startedAt` on
  // every wire `Session`, so this is a same-discipline pass-through, not a
  // new wire dependency.
  startedAt: number;
  lastActivityAt: number;
  endedAt?: number;
  // Sessions-refresh feature: a row process-scan.ts (the laptop's own scan)
  // found running outside Jarvis. Absent means "jarvis" — the ordinary row,
  // same default as the wire `Session` type itself.
  origin?: "jarvis" | "external";
};

export type SessionsView = {
  active: SessionRowView[];
  ended: SessionRowView[];
  loading: boolean;
  error?: RpcError;
};

export type SessionsStore = {
  get(): SessionsView;
  subscribe(listener: (view: SessionsView) => void): () => void;
  focus(): void;
  blur(): void;
  refresh(): Promise<void>;
  /**
   * The Sessions screen's pull-to-refresh: asks the laptop to look again
   * (re-import any new transcripts and re-scan the process table for
   * agents running outside Jarvis — process-scan.ts), then re-lists.
   *
   * A plain `refresh()` only re-reads whatever `sessions:list` already
   * has; it would never surface a process the laptop has not scanned for
   * yet. `sessions:refresh` itself already broadcasts a fresh
   * `sessions:update` this store is subscribed to while focused, but this
   * still re-lists afterward — the same "ask, then answer" shape a
   * pull-to-refresh spinner needs regardless of push timing.
   */
  pullToRefresh(): Promise<void>;
  find(id: string): SessionRowView | undefined;
};

const ACTIVE_STATES = new Set<SessionState>(["starting", "running", "waiting"]);

/**
 * The session's display label: a non-empty `project` name, else the last
 * non-empty `/`- or `\`-separated segment of `projectPath`, else `""`.
 */
export function sessionLabelOf(project: unknown, projectPath: unknown): string {
  if (typeof project === "string" && project.length > 0) {
    return project;
  }
  if (typeof projectPath === "string") {
    const segments = projectPath.split(/[/\\]/).filter((segment) => segment.length > 0);
    const last = segments.at(-1);
    if (last !== undefined) return last;
  }
  return "";
}

/**
 * Parses the `sessions:list`/`sessions:update` payload defensively: array
 * items that don't shape up as a full `Session` (the shared `parseSession`,
 * session-parse.ts) are skipped, and each row is derived field by field
 * from the result — never a spread — so extra/unexpected fields are never
 * copied through. `isSubscriptionKey` stays a row-specific check on top of
 * `parseSession`'s own (looser) `typeof id === "string"` check: this
 * store's `id` doubles as the `sessions:update` keyed-subscription id, so
 * it must additionally match the wire's own id shape.
 */
export function parseSessionList(value: unknown): SessionRowView[] {
  if (!Array.isArray(value)) return [];
  const rows: SessionRowView[] = [];
  for (const item of value) {
    const session = parseSession(item);
    if (session === undefined) continue;
    if (!isSubscriptionKey(session.id)) continue;

    const row: SessionRowView = {
      id: session.id,
      label: sessionLabelOf(session.project, session.projectPath),
      summary: session.summary,
      state: session.state,
      agentId: session.agentId,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt,
    };
    if (session.endedAt !== undefined) {
      row.endedAt = session.endedAt;
    }
    if (session.origin !== undefined) {
      row.origin = session.origin;
    }
    rows.push(row);
  }
  return rows;
}

function groupAndSort(rows: SessionRowView[]): Pick<SessionsView, "active" | "ended"> {
  const active = rows
    .filter((row) => ACTIVE_STATES.has(row.state))
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  const ended = rows
    .filter((row) => !ACTIVE_STATES.has(row.state))
    .sort((a, b) => (b.endedAt ?? b.lastActivityAt) - (a.endedAt ?? a.lastActivityAt));
  return { active, ended };
}

export function createSessionsStore(deps: { client: RpcClient }): SessionsStore {
  const listeners = new Set<(view: SessionsView) => void>();
  let rows: SessionRowView[] = [];
  let view: SessionsView = { active: [], ended: [], loading: false };
  let focused = false;
  let unsubscribePush: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;
  // Bumped on every `sessions:update` push (rule 4) *and* on every
  // `refresh()` call (rule 3): a `sessions:list` answer whose refresh
  // started before the most recent push, or before a later refresh()
  // began, is stale and must never overwrite the rows that already
  // superseded it.
  let rowsVersion = 0;
  // M12 Task 8 (M7 T7 deferred): `loading` needs its own, narrower
  // generation — bumped only by `refresh()`, never by a push. Reusing
  // `rowsVersion` for both meant a `sessions:update` push that superseded
  // an in-flight refresh() made that refresh's own answer skip re-applying
  // rows *and* unconditionally clear `loading`/set `error`, even though a
  // later, still-pending refresh() might be the one whose own answer
  // should own the spinner. Only the refresh() whose own `refreshGeneration`
  // is still current when it lands may touch `loading`.
  let refreshGeneration = 0;

  function setView(patch: Partial<SessionsView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) {
      listener(view);
    }
  }

  function applyRows(newRows: SessionRowView[]): void {
    rows = newRows;
    const grouped = groupAndSort(rows);
    setView({ active: grouped.active, ended: grouped.ended });
  }

  async function refresh(): Promise<void> {
    // Fix round 1 (Important 2): incrementing here, not just reading, makes
    // rowsVersion one shared generation counter for both races rule 3/4
    // name — a later refresh() supersedes an earlier one exactly as a push
    // does, so an older sessions:list answer can never overwrite a newer
    // refresh()'s or a push's rows.
    const startVersion = ++rowsVersion;
    // M12 Task 8: this call's own, narrower generation for `loading` —
    // never bumped by a push, only by another refresh().
    const startRefresh = ++refreshGeneration;
    setView({ loading: true });
    const result = await deps.client.call("sessions:list", []);
    const stale = rowsVersion !== startVersion;
    if (stale) {
      // Superseded by a push or a later refresh() — the rows are already
      // whatever superseded this answer, so they're left untouched. An ok
      // answer still clears a possibly-stale `error`: it proves the
      // connection works even though its own rows arrived too late to
      // apply (rule 3's "ok-stale clears error"). A failed answer here is
      // dropped outright — a superseded call's own failure says nothing
      // about the state a newer refresh()/push already established.
      if (result.ok) setView({ error: undefined });
    } else if (result.ok) {
      applyRows(parseSessionList(result.value));
      setView({ error: undefined });
    } else {
      setView({ error: result.error });
    }
    // Only the newest refresh() call may ever clear `loading` — one
    // superseded by a later refresh() (refreshGeneration moved on) returns
    // without touching it at all, leaving it to that later call's own
    // answer. A push alone never moves refreshGeneration, so it never
    // blocks this call from clearing its own spinner.
    if (refreshGeneration === startRefresh) {
      setView({ loading: false });
    }
  }

  async function pullToRefresh(): Promise<void> {
    const result = await deps.client.call("sessions:refresh", []);
    if (!result.ok) {
      // The scan itself never ran — surface it the same way a failed
      // sessions:list does, rather than silently falling through to a
      // re-list that can only repeat stale rows.
      setView({ error: result.error });
      return;
    }
    await refresh();
  }

  function focus(): void {
    if (focused) return;
    focused = true;

    unsubscribePush = deps.client.onPush("sessions:update", (payload) => {
      rowsVersion += 1;
      applyRows(parseSessionList(payload));
    });

    deps.client.subscribe("sessions:update");

    unsubscribeState = deps.client.onState((state) => {
      if (state === "open") {
        void refresh();
      }
    });

    void refresh();
  }

  function blur(): void {
    if (!focused) return;
    focused = false;

    deps.client.unsubscribe("sessions:update");
    unsubscribePush?.();
    unsubscribeState?.();
    unsubscribePush = undefined;
    unsubscribeState = undefined;
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    focus,
    blur,
    refresh,
    pullToRefresh,
    find: (id) => rows.find((row) => row.id === id),
  };
}
