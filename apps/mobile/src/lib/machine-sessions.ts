// One session scope per machine (client, connection store, auth session), kept
// for the process lifetime, with only the active one ever connected. What
// stands between one machine's replies, tokens or state and another's screens:
//
// - Scopes share nothing. A store built on A's client can only ever hear A.
// - A scope's refresh key and flag are fixed when it is built, so a late write
//   lands under that machine's key, whichever machine is active by then.
// - A switch quiesces (a rotated token gets stored), then disconnects, which
//   settles every call in flight as `offline` and makes the old socket's late
//   frames stale, and only then publishes the new scope. Listeners remount the
//   whole tree under the new generation, orphaning every store built on the
//   old client.
// - A connect names its machine, and is refused once a later switch has begun
//   or while that machine is being cleared (pairing-guard.ts). A connect that
//   arrives during a switch waits for it, or it would bring back the machine
//   being left.
//
// `current()` has an answer from the start, the null scope, since a store that
// has not opened cannot say which machine is active. The null scope holds no
// machine and is never connected. It has nowhere to write a refresh token, so
// no later machine can ever read one of its tokens.

import type { AuthChannel, AuthSession, DeviceAuth, RefreshLock } from "./auth-session";
import { createAuthSession } from "./auth-session";
import type { Clock } from "./clock";
import { type ConnectStoredOutcome, connectFromStoredPairing, endpointOf } from "./connect-stored";
import type { ConnectionStore } from "./connection-store";
import { createConnectionStore } from "./connection-store";
import type { MachineId } from "./machine-index";
import type { MachineStore } from "./machine-store";
import { isClearingPairing } from "./pairing-guard";
import type { RpcClient } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import type { SecureStore } from "./secure-store";
import type { Transport } from "./transport";
import { type UnpairedOutcome, createUnpairedHandler } from "./unpaired-handler";

const DEFAULT_QUIESCE_MS = 3_000;
// Never written: the null scope's store ignores what it is given.
const NO_MACHINE_REFRESH_KEY = "jarvis.m.none";

export type MachineScope = {
  id: MachineId | null;
  generation: number;
  client: RpcClient;
  connectionStore: ConnectionStore;
  authSession: AuthSession;
};

type BuiltScope = Omit<MachineScope, "generation">;

export type SwitchOutcome = "switched" | "same" | "unknown" | "superseded";

export type MachineSessions = {
  current(): MachineScope;
  subscribe(cb: (scope: MachineScope) => void): () => void;
  /** At launch: connects `preferred` if held, else the last active machine. */
  start(preferred?: MachineId): Promise<ConnectStoredOutcome>;
  /** Connects the machine on screen, or the active one once that is gone. */
  reconnect(shouldConnect?: () => boolean): Promise<ConnectStoredOutcome>;
  switchTo(id: MachineId): Promise<SwitchOutcome>;
  setAppActive(active: boolean): void;
  /** Unpair: removes the machine and its session's tokens. A scope on screen
   *  stays until the next one is published, but is never reused: a machine
   *  paired again may live under other keys. Rejects when the store could not
   *  open, or could delete neither key; then nothing else changes. */
  removeMachine(id: MachineId | null): Promise<void>;
};

export function createMachineSessions(deps: {
  store: MachineStore;
  buildScope(id: MachineId | null): BuiltScope;
  prepareSwitch(): void;
  log(line: string): void;
  quiesceMs?: number;
}): MachineSessions {
  const { store } = deps;
  const quiesceMs = deps.quiesceMs ?? DEFAULT_QUIESCE_MS;
  const listeners = new Set<(scope: MachineScope) => void>();
  const scopes = new Map<MachineId, BuiltScope>();
  const scopeKeys = new Map<MachineId, string>();
  let generation = 0;
  let scope: MachineScope = { ...deps.buildScope(null), generation };
  let appActive = true;
  let latestAttempt = 0;
  let switchesInFlight = 0;
  let lastSwitch: Promise<unknown> = Promise.resolve();

  function retire(built: BuiltScope): void {
    built.connectionStore.dispose();
    built.authSession.dispose();
  }

  /** The kept scope, unless its machine now lives under another key: a store
   *  self-heal can drop a machine with no word to this object, and pairing it
   *  again may not use the legacy slot. A scope's key never changes. */
  function keptScope(id: MachineId): BuiltScope | undefined {
    const kept = scopes.get(id);
    if (kept === undefined || scopeKeys.get(id) === store.refreshKey(id)) return kept;
    scopes.delete(id);
    if (scope.client !== kept.client) retire(kept);
    return undefined;
  }

  function scopeOf(id: MachineId): BuiltScope {
    let built = keptScope(id);
    if (built === undefined) {
      built = deps.buildScope(id);
      scopes.set(id, built);
      scopeKeys.set(id, store.refreshKey(id));
    }
    return built;
  }

  /** The scope on screen is still the one kept for its machine, and held. */
  function isLive(candidate: MachineScope): boolean {
    if (candidate.id === null) return false;
    return store.has(candidate.id) && keptScope(candidate.id)?.client === candidate.client;
  }

  function applyAppActive(target: MachineScope): void {
    // The idle check first: an app back after the idle window locks before
    // its subscriptions resume.
    if (appActive) {
      target.authSession.setAppActive(true);
      target.client.setAppActive(true);
    } else {
      target.client.setAppActive(false);
      target.authSession.setAppActive(false);
    }
  }

  function publish(built: BuiltScope): MachineScope {
    const old = scope;
    generation += 1;
    scope = { ...built, generation };
    for (const listener of [...listeners]) {
      try {
        listener(scope);
      } catch {
        deps.log("machines: a listener threw");
      }
    }
    const oldIsKept = old.id === null || scopes.get(old.id)?.client === old.client;
    if (!oldIsKept && old.client !== built.client) retire(old);
    applyAppActive(scope);
    return scope;
  }

  async function connectActive(shouldConnect?: () => boolean): Promise<ConnectStoredOutcome> {
    while (switchesInFlight > 0) await lastSwitch;
    // Before any await: a switch that begins during the reads below refuses
    // this connect.
    const attempt = latestAttempt;
    try {
      if ((await store.open()) === "failed") return "failed";
      const id = isLive(scope) ? scope.id : store.activeId();
      if (id === null || id === undefined) return "unpaired";
      const outcome = await connectFromStoredPairing({
        machines: store,
        id,
        client: {
          connect(endpoint, credential) {
            const target = scope.id === id && isLive(scope) ? scope : publish(scopeOf(id));
            target.client.connect(endpoint, credential);
          },
        },
        shouldConnect: () =>
          attempt === latestAttempt && !isClearingPairing(id) && (shouldConnect?.() ?? true),
      });
      // Refused by a switch, not for want of a pairing: answer for what it
      // left on screen.
      if (outcome === "unpaired" && attempt !== latestAttempt) return connectActive(shouldConnect);
      return outcome;
    } catch {
      deps.log("machines: connecting failed");
      return "failed";
    }
  }

  async function runSwitch(id: MachineId, attempt: number): Promise<SwitchOutcome> {
    let loaded: Awaited<ReturnType<MachineStore["load"]>>;
    try {
      loaded = await store.load(id);
    } catch {
      deps.log("machines: reading a machine for a switch failed");
      return "unknown";
    }
    if (loaded === undefined) return "unknown";

    await scope.authSession.quiesce(quiesceMs);
    if (attempt !== latestAttempt) return "superseded";

    try {
      deps.prepareSwitch();
    } catch {
      deps.log("machines: preparing the switch failed");
    }
    scope.client.disconnect();

    try {
      await store.setActive(id);
    } catch {
      deps.log("machines: recording the active machine failed");
    }

    // Published even if superseded by now: the old client is closed either
    // way, and only the latest attempt connects.
    const next = publish(scopeOf(id));
    if (attempt !== latestAttempt) return "superseded";
    if (!isClearingPairing(id)) next.client.connect(endpointOf(loaded.record), loaded.credential);
    return "switched";
  }

  async function switchTo(id: MachineId): Promise<SwitchOutcome> {
    // Opens the store only if it has to: an open store answers in this tick,
    // so a read in flight is refused from the moment the switch is asked for.
    let held = false;
    try {
      held = store.has(id);
    } catch {
      await store.open();
      try {
        held = store.has(id);
      } catch {
        return "unknown";
      }
    }
    if (!held) return "unknown";
    if (switchesInFlight === 0 && scope.id === id && isLive(scope)) return "same";

    latestAttempt += 1;
    switchesInFlight += 1;
    const run = runSwitch(id, latestAttempt).finally(() => {
      switchesInFlight -= 1;
    });
    lastSwitch = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    current: () => scope,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async start(preferred) {
      if (preferred !== undefined && (await store.open()) === "ok" && store.has(preferred)) {
        try {
          await store.setActive(preferred);
        } catch {
          deps.log("machines: recording the active machine failed");
        }
      }
      return connectActive();
    },
    reconnect: connectActive,
    switchTo,
    setAppActive(active) {
      appActive = active;
      applyAppActive(scope);
    },
    async removeMachine(id) {
      await store.open();
      if (id === null) {
        // Nothing to remove, but a store that could not open is not "nothing".
        store.activeId();
        return;
      }
      await store.remove(id);
      const built = scopes.get(id);
      if (built === undefined) return;
      await built.authSession.forget();
      scopes.delete(id);
      if (scope.client !== built.client) retire(built);
    },
  };
}

export type MachineScopeDeps = {
  store: MachineStore;
  refreshStore: SecureStore;
  transport: Transport;
  clock: Clock;
  random(): number;
  client: string;
  deviceAuth: DeviceAuth;
  storedUnlockAtLaunchOnly?: boolean;
  refreshLock?: RefreshLock;
  authChannel?: AuthChannel;
  idleMs: number;
  onUnpaired(id: MachineId | null): Promise<UnpairedOutcome>;
  log(line: string): void;
};

/** What the null scope's session sees: nothing stored, nowhere to store. The
 *  one thing it can do is the owner's own logout or "keep signed in" off, with
 *  no machine's scope to do it through: the token still leaves the disk. */
function noMachineStorage(deps: MachineScopeDeps) {
  const refreshStore: SecureStore = {
    get: async () => undefined,
    set: async () => {},
    async delete() {
      await deps.store.open();
      const key = deps.store.refreshKeyWithNoScope();
      if (key !== undefined) await deps.refreshStore.delete(key);
    },
  };
  return {
    refreshStore,
    refreshKey: () => NO_MACHINE_REFRESH_KEY,
    refreshStoredFlag: { read: async () => false, write: async () => {} },
  };
}

function machineStorage(deps: MachineScopeDeps, id: MachineId) {
  const key = deps.store.refreshKey(id);
  return {
    refreshStore: deps.refreshStore,
    refreshKey: () => key,
    refreshStoredFlag: deps.store.refreshFlag(id),
  };
}

export function createMachineScopeBuilder(
  deps: MachineScopeDeps,
): (id: MachineId | null) => BuiltScope {
  return (id) => {
    const client = createRpcClient({
      transport: deps.transport,
      clock: deps.clock,
      random: deps.random,
      client: deps.client,
      log: deps.log,
    });
    const authSession = createAuthSession({
      rpc: client,
      clock: deps.clock,
      ...(id === null ? noMachineStorage(deps) : machineStorage(deps, id)),
      deviceAuth: deps.deviceAuth,
      storedUnlockAtLaunchOnly: deps.storedUnlockAtLaunchOnly,
      refreshLock: deps.refreshLock,
      authChannel: deps.authChannel,
      idleMs: deps.idleMs,
      log: deps.log,
    });
    const connectionStore = createConnectionStore({
      client,
      clock: deps.clock,
      // Runs asynchronously off the store's onState reaction, never
      // synchronously from inside it.
      onUnpaired: () => deps.onUnpaired(id),
    });
    return { id, client, connectionStore, authSession };
  };
}

/** The one clear-and-navigate for a machine: its connection store's reaction to
 *  a revocation, and the banner's "Pair again". The id is fixed, so a clear
 *  that ends after a switch still clears that machine, and leaves the new
 *  machine's screen alone. */
export function unpairedHandlerFor(deps: {
  id: MachineId | null;
  sessions: Pick<MachineSessions, "current" | "removeMachine">;
  navigateToPair(): void;
  log(line: string): void;
}): () => Promise<UnpairedOutcome> {
  return createUnpairedHandler({
    id: deps.id,
    clearPairing: () => deps.sessions.removeMachine(deps.id),
    navigateToPair: () => {
      if (deps.sessions.current().id === deps.id) deps.navigateToPair();
    },
    log: deps.log,
  });
}

/** `deps.prepareSwitch` for the app: back to /dashboard, with the stack
 *  dismissed. Safe from any route, including /unlock and /pair, and with no
 *  navigator mounted yet: the new tree mounts whichever route the router is
 *  on, and a machine that is locked brings up its own /unlock. */
export function prepareSwitchRoute(
  router: { canDismiss(): boolean; dismissAll(): void; replace(route: "/dashboard"): void },
  log: (line: string) => void,
): void {
  try {
    if (router.canDismiss()) router.dismissAll();
  } catch {
    // Nothing to dismiss. The replace below decides whether anything is mounted.
  }
  try {
    router.replace("/dashboard");
  } catch {
    log("machines: no navigator to prepare for the switch");
  }
}
