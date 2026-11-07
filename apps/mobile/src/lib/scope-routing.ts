// What keeps every route the layout asks for behind a mounted navigator.
//
// expo-router queues `router.push` and `replace`, then runs them from an effect
// above the layout, where a route with no navigator mounted throws "Attempted
// to navigate before mounting the Root Layout" with no error boundary to catch
// it. A try around the call catches nothing. There is no navigator on the
// keyed tree's first commit, as `PushProvider` renders null until its prefs
// load, and the old `Stack` has already gone after a remount.
//
// The route effects themselves live in a child rendered after `Stack`, so React
// runs them once `Stack`'s own effects have registered it. Anything else that
// can ask for a route on its own timing (a socket's revocation, the end of a
// reconnect, a tapped notification) goes through the gate.

import type { AuthView } from "./auth-session";
import { shouldConnectOnRoute } from "./dashboard-entry";
import type { MachineSessions } from "./machine-sessions";
import type { ClientState, RpcClient } from "./rpc-client";
import { shouldShowUnlock } from "./unlock-screen";

export type NavigatorGate = {
  isReady(): boolean;
  /** Runs at once with a navigator up. Otherwise it waits for `flush`; only the
   *  latest waits, so it must check that it still applies when it runs. */
  navigate(action: () => void): void;
  /** Runs what waited, if a navigator is up by now. */
  flush(): void;
};

export function createNavigatorGate(isReady: () => boolean): NavigatorGate {
  let waiting: (() => void) | undefined;

  function flush(): void {
    if (waiting === undefined || !isReady()) return;
    const action = waiting;
    waiting = undefined;
    action();
  }

  return {
    isReady,
    navigate(action) {
      waiting = action;
      flush();
    },
    flush,
  };
}

export type ScopeRouting = {
  connectionChanged(state: ClientState): void;
  shouldPushUnlock(input: {
    state: ClientState;
    auth: AuthView;
    pathname: string;
    /** The tree on screen belongs to a machine being left. */
    switching: boolean;
  }): boolean;
  shouldConnect(pathname: string): boolean;
};

/** One tree's route decisions. It is built per mount, so each machine's tree
 *  starts over. */
export function createScopeRouting(): ScopeRouting {
  // Set between a push and the route actually reaching /unlock, so a second
  // state change in that window can't stack a second unlock screen.
  let unlockPushPending = false;
  let launchConnectHandled = false;

  return {
    connectionChanged(state) {
      // Any move out of "locked" also clears it, so a push that never reached
      // /unlock can't block every later one.
      if (state !== "locked") unlockPushPending = false;
    },
    shouldPushUnlock({ state, auth, pathname, switching }) {
      if (pathname === "/unlock") {
        unlockPushPending = false;
        return false;
      }
      if (unlockPushPending || switching) return false;
      if (!shouldShowUnlock(state, auth, pathname)) return false;
      unlockPushPending = true;
      return true;
    },
    shouldConnect(pathname) {
      const connect = shouldConnectOnRoute(pathname, launchConnectHandled);
      launchConnectHandled = true;
      return connect;
    },
  };
}

/** Connects from whatever pairing is on disk, or routes to /pair when the read
 *  failed or found nothing. A tree no longer on screen routes nowhere. */
export async function reconnectOrPair(deps: {
  sessions: Pick<MachineSessions, "reconnect" | "current">;
  client: RpcClient;
  gate: NavigatorGate;
  navigateToPair(): void;
}): Promise<void> {
  const outcome = await deps.sessions.reconnect();
  if (outcome === "connected") return;
  deps.gate.navigate(() => {
    if (deps.sessions.current().client === deps.client) deps.navigateToPair();
  });
}
