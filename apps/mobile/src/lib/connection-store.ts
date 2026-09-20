// The connection-state store (Task 6): turns the RpcClient's own
// state/lastFrameAt into the one `ConnectionView` every screen's banner
// reads (rule 1: the stale rule from global-constraints.md), latches a
// pin-mismatch warning across the reconnect attempts that follow it
// (N5 hand-off in rpc-client.ts), and drives an unpaired episode's
// clear-and-navigate exactly once (rule 3).

import type { Clock } from "./clock";
import type { ClientState, RpcClient } from "./rpc-client";

export type ConnectionView = {
  state: ClientState;
  stale: boolean;
  closeCode?: number;
  pinMismatch?: true;
};

export type ConnectionStore = {
  get(): ConnectionView;
  subscribe(listener: (view: ConnectionView) => void): () => void;
  dispose(): void;
  /** Minor 3 (fix round 1): lets a caller that lazily creates-and-caches a
   * store (e.g. `_layout.tsx`'s `useRef` guard) detect a disposed instance
   * and build a fresh one, instead of a React StrictMode double-invoked
   * effect leaving the cached ref pointing at a store whose subscription
   * and timer are already torn down. */
  isDisposed(): boolean;
};

function viewsEqual(a: ConnectionView, b: ConnectionView): boolean {
  return (
    a.state === b.state &&
    a.stale === b.stale &&
    a.closeCode === b.closeCode &&
    a.pinMismatch === b.pinMismatch
  );
}

const STALE_AFTER_MS = 10_000;
const RECHECK_INTERVAL_MS = 1_000;

export function createConnectionStore(deps: {
  client: RpcClient;
  clock: Clock;
  // `onUnpaired` reports whether it actually cleared the stored pairing.
  // Kept as this store's own narrow contract (not imported from
  // unpaired-handler.ts, which is one caller's choice of implementation,
  // not this store's business) — a `"clearFailed"` outcome is what lets
  // the episode be retried instead of being marked handled forever on a
  // failure this store has no other way to see.
  onUnpaired(): Promise<"cleared" | "clearFailed">;
}): ConnectionStore {
  const listeners = new Set<(view: ConnectionView) => void>();

  let closeCode: number | undefined;
  let pinMismatchLatched = false;
  // Guards rule 3's bite-proof: an "unpaired" state that repeats (the same
  // episode) must only trigger `onUnpaired` once. Reset whenever the state
  // leaves "unpaired", so a later, separate unpaired episode fires again.
  let unpairedNotified = false;
  let staleTimer: unknown;
  let disposed = false;
  // Minor 1 (fix round 1): the 1000ms re-check timer calls notify() every
  // tick whether or not anything actually changed — compare against the
  // last *notified* view (not every currentView() call, which get() also
  // uses) and skip re-rendering every subscriber once a second for nothing.
  let lastNotified: ConnectionView | undefined;

  function computeStale(state: ClientState): boolean {
    if (state !== "open") return true;
    if (deps.client.subscriptions().length === 0) return false;
    const lastFrameAt = deps.client.lastFrameAt();
    if (lastFrameAt === undefined) return false;
    return deps.clock.now() - lastFrameAt > STALE_AFTER_MS;
  }

  function currentView(): ConnectionView {
    const state = deps.client.state();
    const next: ConnectionView = { state, stale: computeStale(state) };
    if (closeCode !== undefined) next.closeCode = closeCode;
    if (pinMismatchLatched) next.pinMismatch = true;
    return next;
  }

  function notify(): void {
    const next = currentView();
    if (lastNotified !== undefined && viewsEqual(lastNotified, next)) return;
    lastNotified = next;
    for (const listener of [...listeners]) {
      listener(next);
    }
  }

  function disarmStaleTimer(): void {
    if (staleTimer !== undefined) {
      deps.clock.clearTimeout(staleTimer);
      staleTimer = undefined;
    }
  }

  function armStaleTimer(): void {
    disarmStaleTimer();
    staleTimer = deps.clock.setTimeout(() => {
      staleTimer = undefined;
      notify();
      // Only re-arm while still open — a state change in between already
      // disarmed this (see the onState handler below), so re-checking
      // `state()` here just avoids re-arming a timer for a state that
      // changed between the timer firing and this callback running.
      if (deps.client.state() === "open") {
        armStaleTimer();
      }
    }, RECHECK_INTERVAL_MS);
  }

  const unsubscribeState = deps.client.onState((state, detail) => {
    closeCode = detail.closeCode;
    if (detail.pinMismatch) {
      pinMismatchLatched = true;
    }
    // N1: also clear the latch on "closed" and "unpaired" — not just
    // "open". Without this, unpairing from a laptop whose certificate
    // mismatched and pairing with a different one still showed "someone
    // may be intercepting" on every connecting/reconnecting state until
    // the new laptop's first successful open, indefinitely if it was
    // unreachable.
    if (state === "open" || state === "closed" || state === "unpaired") {
      pinMismatchLatched = false;
    }

    if (state === "unpaired") {
      if (!unpairedNotified) {
        unpairedNotified = true;
        // Async and unawaited (controller carry #2): never call back into
        // the client, or run onUnpaired's own work (clearPairing, a
        // navigation), synchronously from inside this onState reaction.
        queueMicrotask(() => {
          deps
            .onUnpaired()
            .then((outcome) => {
              // A failed clear must NOT mark this episode handled — reset
              // the guard so a later "unpaired" notification (however it
              // comes about) tries again, instead of the store silently
              // treating a clearing failure as resolved. (The primary
              // recovery path is /pair's own clearFailed phase and its
              // retry button, which doesn't go through this store at all;
              // this is defence in depth for a caller that doesn't retry
              // through that screen.)
              if (outcome === "clearFailed") {
                unpairedNotified = false;
              }
            })
            .catch(() => {
              // `onUnpaired` is expected to resolve, never reject (see
              // unpaired-handler.ts) — this `.catch` is a second line of
              // defence so a contract violation is never an unhandled
              // promise rejection, and is treated the same as a reported
              // failure: not handled, so a later episode can retry.
              unpairedNotified = false;
            });
        });
      }
    } else {
      unpairedNotified = false;
    }

    if (state === "open") {
      armStaleTimer();
    } else {
      disarmStaleTimer();
    }

    notify();
  });

  if (deps.client.state() === "open") {
    armStaleTimer();
  }

  function dispose(): void {
    disposed = true;
    unsubscribeState();
    disarmStaleTimer();
    listeners.clear();
  }

  return {
    get: currentView,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose,
    isDisposed: () => disposed,
  };
}
