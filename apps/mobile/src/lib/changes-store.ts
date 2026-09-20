import type { GitFileDiff } from "@jarvis/core";
import type { RpcClient, RpcResult } from "./rpc-client";
import {
  type ChangesView,
  parseChangesView,
  parseGitDiffResult,
  parseGitViewResult,
} from "./workspace-results";

export type ChangesState = {
  sessionId?: string;
  phase: "idle" | "loading" | "ready" | "failed";
  stale: boolean;
  busy: boolean;
  changes?: ChangesView;
  diff?: GitFileDiff;
  notice?: string;
  uncertain: boolean;
};

export type ChangesStore = {
  get(): ChangesState;
  subscribe(fn: (state: ChangesState) => void): () => void;
  open(sessionId: string): void;
  selectFile(path: string): void;
  setStaged(path: string, staged: boolean): Promise<void>;
  commit(message: string): Promise<void>;
  refresh(): void;
  close(): void;
};

// Sentinel `notice` values this store can set itself, as opposed to real
// server text (which is shown verbatim per global-constraints 7). Screens
// recognize these and show a localized string instead of the raw token.
export const ENDED_SESSION_NOTICE = "ended-session-current-tree";
// Fix round 1 (Important 1): a commit/stage tapped while disconnected used
// to fail silently (`stale: true` only, no `notice`) — the screen read
// that as "nothing went wrong" and cleared the draft. This sentinel gives
// the refusal a notice so Behaviour 3 (keep the draft) holds.
export const MUTATION_OFFLINE_NOTICE = "mutation-refused-offline";
// Fix round 2 (New Breakage 2): a mutation dropped because the user
// switched sessions while it was queued used to reuse
// MUTATION_OFFLINE_NOTICE, showing "Not connected…" on the *new* session's
// screen while the connection was fine the whole time. Distinct sentinel,
// distinct text.
export const MUTATION_SESSION_CHANGED_NOTICE = "mutation-dropped-session-changed";
// Fix round 1 (Minor): previously the raw English word "unsupported" was
// shown verbatim in both languages; now it's a token the screen translates.
export const UNSUPPORTED_NOTICE = "unsupported";

function noticeFromResult(result: RpcResult | { ok: false; text: string }): string | undefined {
  if (result.ok) return undefined;
  if ("text" in result) return result.text;
  if (result.error.kind === "remote") return result.error.text;
  if (result.error.kind === "unsupported") return UNSUPPORTED_NOTICE;
  return undefined;
}

export function createChangesStore(deps: { client: RpcClient }): ChangesStore {
  const listeners = new Set<(state: ChangesState) => void>();
  let state: ChangesState = { phase: "idle", stale: false, busy: false, uncertain: false };
  let visible = false;
  let selectedPath: string | undefined;
  let refreshInFlight = false;
  let pendingRefresh = false;
  let refreshGeneration = 0;
  let diffGeneration = 0;
  let mutationQueue = Promise.resolve();
  let unsubscribeCounts: (() => void) | undefined;
  let unsubscribeSessions: (() => void) | undefined;
  let unsubscribeState: (() => void) | undefined;

  function setState(patch: Partial<ChangesState>): void {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  }

  function endedNotice(changes: ChangesView): string | undefined {
    return changes.session.endedAt === undefined ? undefined : ENDED_SESSION_NOTICE;
  }

  function currentFiles(): string[] {
    return state.changes?.changes.files.map((file) => file.path) ?? [];
  }

  function refresh(): void {
    if (!visible || state.sessionId === undefined) return;
    if (refreshInFlight) {
      pendingRefresh = true;
      setState({ stale: true });
      return;
    }
    void refreshNow();
  }

  async function refreshNow(): Promise<void> {
    const sessionId = state.sessionId;
    if (sessionId === undefined) return;
    const generation = ++refreshGeneration;
    refreshInFlight = true;
    setState({ phase: state.phase === "idle" ? "loading" : state.phase, stale: false });
    const result = await deps.client.call("git:changes", [sessionId], { whenNotOpen: "reject" });
    if (state.sessionId !== sessionId || generation !== refreshGeneration) return;
    refreshInFlight = false;

    if (!result.ok) {
      setState({ phase: "failed", stale: true, notice: noticeFromResult(result) });
    } else {
      const parsed = parseGitViewResult(result.value, parseChangesView);
      if (parsed.ok) {
        const nextFiles = parsed.value.changes.files.map((file) => file.path);
        const nextSelected =
          selectedPath !== undefined && nextFiles.includes(selectedPath)
            ? selectedPath
            : nextFiles[0];
        selectedPath = nextSelected;
        setState({
          phase: "ready",
          stale: false,
          changes: parsed.value,
          notice: endedNotice(parsed.value),
          diff: nextSelected === undefined ? undefined : state.diff,
        });
        if (nextSelected !== undefined) loadDiff(sessionId, nextSelected);
      } else {
        setState({ phase: "failed", stale: true, notice: parsed.text });
      }
    }

    if (pendingRefresh) {
      pendingRefresh = false;
      refresh();
    }
  }

  async function loadDiff(sessionId: string, path: string): Promise<void> {
    const generation = ++diffGeneration;
    const result = await deps.client.call("git:diff", [sessionId, path], { whenNotOpen: "reject" });
    if (state.sessionId !== sessionId || selectedPath !== path || generation !== diffGeneration)
      return;
    if (!result.ok) {
      setState({ notice: noticeFromResult(result) });
      return;
    }
    const parsed = parseGitViewResult(result.value, parseGitDiffResult);
    if (parsed.ok) {
      setState({ diff: parsed.value });
    } else {
      setState({ notice: parsed.text });
    }
  }

  function subscribeVisible(): void {
    unsubscribeCounts = deps.client.onPush("git:counts", () => refresh());
    unsubscribeSessions = deps.client.onPush("sessions:update", () => refresh());
    deps.client.subscribe("git:counts");
    deps.client.subscribe("sessions:update");
    unsubscribeState = deps.client.onState((clientState) => {
      if (clientState === "open") refresh();
    });
  }

  function unsubscribeVisible(): void {
    deps.client.unsubscribe("git:counts");
    deps.client.unsubscribe("sessions:update");
    unsubscribeCounts?.();
    unsubscribeSessions?.();
    unsubscribeState?.();
    unsubscribeCounts = undefined;
    unsubscribeSessions = undefined;
    unsubscribeState = undefined;
  }

  // Fix round 1 (Important 1 + Minor): `expectedSessionId` is the session
  // that was open when the user tapped Stage/Commit, captured at enqueue
  // time (below) so it's still available if this mutation was queued
  // behind an earlier one. `buildArgs` defers reading the *current*
  // `state.sessionId` to the moment this actually runs, rather than
  // freezing it into the args array at enqueue time.
  async function runMutation(
    channel: string,
    buildArgs: (sessionId: string) => unknown[],
    expectedSessionId: string | undefined,
  ): Promise<void> {
    const sessionId = state.sessionId;
    // No session chosen at all — the screen gates Commit/Stage on this
    // too, but guard here as well since it's cheap and correct on its own.
    if (sessionId === undefined) return;
    // Fix round 2 (New Breakage 2): the user switched sessions while this
    // mutation was queued behind an earlier one. The connection is fine —
    // it's the *wrong session* now, not an offline refusal — so this gets
    // its own notice (not MUTATION_OFFLINE_NOTICE, which would wrongly
    // claim "Not connected" on the new session's screen) and an explicit
    // `refresh()` so `stale` doesn't linger until the next unrelated
    // refresh (the old code returned early here with no follow-up).
    if (sessionId !== expectedSessionId) {
      setState({ stale: true, notice: MUTATION_SESSION_CHANGED_NOTICE });
      refresh();
      return;
    }
    if (deps.client.state() !== "open") {
      setState({ stale: true, notice: MUTATION_OFFLINE_NOTICE });
      return;
    }
    setState({ busy: true, uncertain: false, notice: undefined });
    const result = await deps.client.call(channel, buildArgs(sessionId), {
      whenNotOpen: "reject",
    });
    const uncertain =
      !result.ok && (result.error.kind === "timeout" || result.error.kind === "offline");
    if (result.ok) {
      setState({ busy: false, uncertain: false });
    } else {
      setState({
        busy: false,
        stale: true,
        uncertain,
        notice: noticeFromResult(result),
      });
    }
    refresh();
  }

  function enqueueMutation(
    channel: string,
    buildArgs: (sessionId: string) => unknown[],
    expectedSessionId: string | undefined,
  ): Promise<void> {
    mutationQueue = mutationQueue.then(
      () => runMutation(channel, buildArgs, expectedSessionId),
      () => runMutation(channel, buildArgs, expectedSessionId),
    );
    return mutationQueue;
  }

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    open(sessionId) {
      if (visible) unsubscribeVisible();
      visible = true;
      selectedPath = undefined;
      refreshInFlight = false;
      pendingRefresh = false;
      diffGeneration += 1;
      setState({
        sessionId,
        phase: "loading",
        stale: false,
        busy: false,
        changes: undefined,
        diff: undefined,
        notice: undefined,
        uncertain: false,
      });
      subscribeVisible();
      refresh();
    },
    selectFile(path) {
      if (!currentFiles().includes(path) || state.sessionId === undefined) return;
      selectedPath = path;
      setState({ diff: undefined });
      loadDiff(state.sessionId, path);
    },
    setStaged(path, staged) {
      return enqueueMutation(
        "git:setStaged",
        (sessionId) => [sessionId, path, staged],
        state.sessionId,
      );
    },
    commit(message) {
      return enqueueMutation("git:commit", (sessionId) => [sessionId, message], state.sessionId);
    },
    refresh,
    close() {
      if (visible) unsubscribeVisible();
      visible = false;
      selectedPath = undefined;
      refreshGeneration += 1;
      diffGeneration += 1;
      setState({ phase: "idle", stale: false, busy: false, changes: undefined, diff: undefined });
    },
  };
}
