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
// - A kept scope is used only for the pairing it was built on. One whose record
//   is gone, or that a read finds under a new credential, is dropped, so a
//   session's old tokens are never offered to whoever holds that address now.
// - `forget` clears one machine by its id, and only then moves the screen off
//   it, so another machine's keys and scope are never in play.
//
// `current()` has an answer from the start, the null scope, since a store that
// has not opened cannot say which machine is active. The null scope holds no
// machine and is never connected. It has nowhere to write a refresh token, so
// no later machine can ever read one of its tokens.

import type { AuthTokens } from "@jarvis/wire";
import type { AuthChannel, AuthSession, DeviceAuth, RefreshLock } from "./auth-session";
import { createAuthSession } from "./auth-session";
import { dropClearFailedSignal, setClearFailedSignal } from "./clear-failed-signal";
import type { Clock } from "./clock";
import { type ConnectStoredOutcome, connectFromStoredPairing, endpointOf } from "./connect-stored";
import type { ConnectionStore } from "./connection-store";
import { createConnectionStore } from "./connection-store";
import type { MachineId } from "./machine-index";
import type { MachineStore } from "./machine-store";
import { machineLabel } from "./machine-switcher";
import { afterClearRetry, afterForgetRoute } from "./pair-flow";
import { isClearingPairing, setClearingPairing } from "./pairing-guard";
import type { PairingRecord } from "./pairing-record";
import type { Credential, Endpoint, RpcClient } from "./rpc-client";
import { createRpcClient } from "./rpc-client";
import { setRevokedSignal } from "./revoked-signal";
import type { NavigatorGate } from "./scope-routing";
import type { SecureStore } from "./secure-store";
import type { Transport } from "./transport";
import { type UnpairedOutcome, createUnpairedHandler } from "./unpaired-handler";

const DEFAULT_QUIESCE_MS = 3_000;
// Never written: the null scope's store ignores what it is given.
const NO_MACHINE_REFRESH_KEY = "jarvis.m.none";
const NO_INDEX_LOGOUT_LINE = "machines: a logout with no open store reached the legacy token only";

export type MachineScope = {
  id: MachineId | null;
  generation: number;
  client: RpcClient;
  connectionStore: ConnectionStore;
  authSession: AuthSession;
};

type BuiltScope = Omit<MachineScope, "generation">;

export type SwitchOutcome = "switched" | "same" | "unknown" | "superseded";

export type ForgetCause = "revoked" | "unpair" | "pair-again";

export type ForgetOutcome =
  | { kind: "clearFailed" }
  | { kind: "next"; id: MachineId }
  | { kind: "none" };

export type MachineSessions = {
  current(): MachineScope;
  subscribe(cb: (scope: MachineScope) => void): () => void;
  /** At launch: connects `preferred` if held, else the last active machine,
   *  unless `shouldConnect` refuses: the store has opened either way. */
  start(preferred?: MachineId, shouldConnect?: () => boolean): Promise<ConnectStoredOutcome>;
  /** Connects the machine on screen, or the active one once that is gone. */
  reconnect(shouldConnect?: () => boolean): Promise<ConnectStoredOutcome>;
  switchTo(id: MachineId): Promise<SwitchOutcome>;
  setAppActive(active: boolean): void;
  isAppActive(): boolean;
  /** Told only when the answer changes. */
  subscribeAppActive(cb: (active: boolean) => void): () => void;
  /** The idle window, for every machine's session, on screen or not, and for
   *  those built later. */
  setIdleMs(ms: number): void;
  /** Clears this one machine, then moves off it if it is on screen: to the first
   *  remaining machine, or to the null scope. Never rejects. When the store
   *  could not remove it, the machine stays and the clear-failed signal names
   *  it. A second call for an id still being forgotten does nothing, and shares
   *  the first one's answer. `null` is the null scope's own: nothing to remove,
   *  but a store that could not open is not "nothing". */
  forget(id: MachineId | null, cause: ForgetCause): Promise<ForgetOutcome>;
  /** A pairing or a join just made: stores it, then goes to it. Rejects only when
   *  the store refused it, with nothing changed. A switch that does not get there
   *  leaves the machine held: its own outcome is the store's `activeId`. Tokens
   *  from a join reach the session before its connection, so the locked welcome
   *  resumes with them. Without any, the unlock screen shows. */
  addAndSwitch(
    record: PairingRecord,
    credential: Credential,
    tokens?: AuthTokens,
  ): Promise<MachineId>;
  /** A pairing or a join that finished after its screen went: stores and seeds it
   *  as `addAndSwitch` does, and stops there. The machine on screen stays, and the
   *  new one waits in the switcher. */
  add(record: PairingRecord, credential: Credential, tokens?: AuthTokens): Promise<MachineId>;
};

export function createMachineSessions(deps: {
  store: MachineStore;
  buildScope(id: MachineId | null): BuiltScope;
  prepareSwitch(): void;
  /** After `prepareSwitch`, when no next scope could be published: whatever
   *  it set up for a change of tree will not get one. */
  switchAbandoned(): void;
  log(line: string): void;
  quiesceMs?: number;
}): MachineSessions {
  const { store } = deps;
  const quiesceMs = deps.quiesceMs ?? DEFAULT_QUIESCE_MS;
  const listeners = new Set<(scope: MachineScope) => void>();
  const appActiveListeners = new Set<(active: boolean) => void>();
  const scopes = new Map<MachineId, BuiltScope>();
  const scopeKeys = new Map<MachineId, string>();
  /** The pairing each kept scope last connected with. */
  const scopeCredentials = new Map<MachineId, Credential>();
  const forgetting = new Map<MachineId | null, Promise<ForgetOutcome>>();
  let generation = 0;
  let scope: MachineScope = { ...deps.buildScope(null), generation };
  let appActive = true;
  let idleMs: number | undefined;
  let latestAttempt = 0;
  let switchesInFlight = 0;
  let lastSwitch: Promise<unknown> = Promise.resolve();

  function retire(built: BuiltScope): void {
    built.connectionStore.dispose();
    built.authSession.dispose();
  }

  /** Never reused from here on. One still on screen stays until the next
   *  publish, which retires it. */
  function dropScope(id: MachineId): void {
    const kept = scopes.get(id);
    scopes.delete(id);
    scopeKeys.delete(id);
    scopeCredentials.delete(id);
    if (kept !== undefined && scope.client !== kept.client) retire(kept);
  }

  /** The kept scope, unless its machine now lives under another key: a store
   *  self-heal can drop a machine with no word to this object, and pairing it
   *  again may not use the legacy slot. A scope's key never changes. */
  function keptScope(id: MachineId): BuiltScope | undefined {
    const kept = scopes.get(id);
    if (kept === undefined || scopeKeys.get(id) === store.refreshKey(id)) return kept;
    dropScope(id);
    return undefined;
  }

  /** A new credential means a new pairing, whoever healed the old one away and
   *  whatever key it lives under. The address may now be another machine, and
   *  the old session's tokens must not be offered to it. */
  function noteCredential(id: MachineId, credential: Credential): void {
    const known = scopeCredentials.get(id);
    if (known !== undefined) {
      if (known.deviceId !== credential.deviceId || known.token !== credential.token) dropScope(id);
    }
    scopeCredentials.set(id, credential);
  }

  function scopeOf(id: MachineId): BuiltScope {
    let built = keptScope(id);
    if (built === undefined) {
      built = deps.buildScope(id);
      if (idleMs !== undefined) built.authSession.setIdleMs(idleMs);
      scopes.set(id, built);
      scopeKeys.set(id, store.refreshKey(id));
    }
    return built;
  }

  /** Just before a connect of a client that may have been on screen before: a
   *  stale screen's calls queue on a closed client, and must not replay. */
  function connectClean(client: RpcClient, endpoint: Endpoint, credential: Credential): void {
    client.disconnect();
    client.connect(endpoint, credential);
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
    // Only one client is ever connected. A switch has closed it already; a
    // scope dropped from under the screen has not.
    if (old.client !== built.client && old.client.state() !== "closed") old.client.disconnect();
    generation += 1;
    scope = { ...built, generation };
    for (const listener of [...listeners]) {
      try {
        listener(scope);
      } catch {
        deps.log("machines: a listener threw");
      }
    }
    // A null scope is never used again: the disconnect above has closed its
    // client, and its banner would say offline. Each publish of one is new.
    const oldIsKept = old.id !== null && scopes.get(old.id)?.client === old.client;
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
            noteCredential(id, credential);
            if (scope.id === id && isLive(scope)) scope.client.connect(endpoint, credential);
            else connectClean(publish(scopeOf(id)).client, endpoint, credential);
          },
        },
        shouldConnect: () =>
          attempt === latestAttempt && !isClearingPairing(id) && (shouldConnect?.() ?? true),
      });
      if (outcome === "unpaired") {
        // Refused by a switch, not for want of a pairing: answer for what it
        // left on screen.
        if (attempt !== latestAttempt) return connectActive(shouldConnect);
        // Its record is gone. Pairing that address again must start clean.
        if (!store.has(id)) dropScope(id);
      }
      return outcome;
    } catch {
      deps.log("machines: connecting failed");
      return "failed";
    }
  }

  /** `leftClosed`: the machine being left has closed its client already. */
  async function runSwitch(
    id: MachineId,
    attempt: number,
    leftClosed: boolean,
  ): Promise<SwitchOutcome> {
    let loaded: Awaited<ReturnType<MachineStore["load"]>>;
    try {
      loaded = await store.load(id);
    } catch {
      deps.log("machines: reading a machine for a switch failed");
      return "unknown";
    }
    if (loaded === undefined) {
      // Pairing that address again must start clean.
      dropScope(id);
      return "unknown";
    }
    noteCredential(id, loaded.credential);

    await scope.authSession.quiesce(quiesceMs);
    if (attempt !== latestAttempt) return "superseded";

    try {
      deps.prepareSwitch();
    } catch {
      deps.log("machines: preparing the switch failed");
    }
    if (!leftClosed) scope.client.disconnect();

    try {
      await store.setActive(id);
    } catch {
      deps.log("machines: recording the active machine failed");
    }

    // Published even if superseded by now: the old client is closed either
    // way, and only the latest attempt connects.
    let next: MachineScope | undefined;
    try {
      // `setActive` refuses a machine that has gone, and that throw is caught
      // above: only this stops `loaded`, read before a removal, being connected.
      if (store.has(id)) next = publish(scopeOf(id));
      else deps.log("machines: the next machine went during the switch");
    } catch {
      deps.log("machines: publishing the next machine failed");
    }
    if (next === undefined) {
      // The machine went during the wait, or the store closed. The old machine
      // stays on screen, closed, and its banner offers the retry.
      try {
        deps.switchAbandoned();
      } catch {
        deps.log("machines: abandoning the switch failed");
      }
      return "unknown";
    }
    if (attempt !== latestAttempt) return "superseded";
    if (!isClearingPairing(id)) {
      connectClean(next.client, endpointOf(loaded.record), loaded.credential);
    }
    return "switched";
  }

  function startSwitch(id: MachineId, leftClosed: boolean): Promise<SwitchOutcome> {
    latestAttempt += 1;
    switchesInFlight += 1;
    const run = runSwitch(id, latestAttempt, leftClosed).finally(() => {
      switchesInFlight -= 1;
    });
    lastSwitch = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    return startSwitch(id, false);
  }

  async function add(
    record: PairingRecord,
    credential: Credential,
    tokens?: AuthTokens,
  ): Promise<MachineId> {
    const id = await store.add(record, credential);
    try {
      // A new credential: an old scope at this address is dropped here, before
      // these tokens could land in it.
      noteCredential(id, credential);
      if (tokens !== undefined) await scopeOf(id).authSession.adoptJoinTokens(tokens);
    } catch {
      // The machine is held, and its unlock screen is the way in.
      deps.log("machines: seeding a new machine's session failed");
    }
    return id;
  }

  async function addAndSwitch(
    record: PairingRecord,
    credential: Credential,
    tokens?: AuthTokens,
  ): Promise<MachineId> {
    const id = await add(record, credential, tokens);
    try {
      await startSwitch(id, false);
    } catch {
      deps.log("machines: switching to a new machine failed");
    }
    return id;
  }

  /** The machine has gone: whatever was on screen for it moves on. */
  async function moveOff(id: MachineId, cause: ForgetCause): Promise<ForgetOutcome> {
    // A switch in flight decides what is on screen.
    while (switchesInFlight > 0) await lastSwitch;
    if (scope.id !== id && scope.id !== null) return { kind: "next", id: scope.id };
    let next = store.nextAfter(id);
    while (next !== undefined) {
      const outcome = await startSwitch(next, true);
      // Gone from the index means its record was found unusable, so the one
      // after it. Still held means a read failed: the banner's retry reconnects.
      if (outcome !== "unknown" || store.has(next)) return { kind: "next", id: next };
      next = store.nextAfter(id);
    }
    moveToNullScope(cause);
    return { kind: "none" };
  }

  function moveToNullScope(cause: ForgetCause): void {
    latestAttempt += 1;
    if (scope.id === null) return;
    // Built first: a signal with no publish to take it would reach the next
    // machine's tree.
    const built = deps.buildScope(null);
    // Before the publish: the listener that brings the new tree takes it.
    if (cause === "revoked") setRevokedSignal();
    publish(built);
  }

  async function runForget(id: MachineId, cause: ForgetCause): Promise<ForgetOutcome> {
    deps.log(`machines: forgetting a machine, ${cause}`);
    setClearingPairing(id, true);
    try {
      const built = scopes.get(id) ?? (scope.id === id ? scope : undefined);
      try {
        built?.client.disconnect();
      } catch {
        deps.log("machines: disconnecting a machine being forgotten failed");
      }
      await store.open();
      try {
        await built?.authSession.forget();
      } catch {
        deps.log("machines: forgetting a machine's session failed");
      }
      try {
        await store.remove(id);
      } catch {
        deps.log("machines: removing a machine failed");
        setClearFailedSignal(id);
        return { kind: "clearFailed" };
      }
      dropScope(id);
    } finally {
      setClearingPairing(id, false);
    }
    try {
      return await moveOff(id, cause);
    } catch {
      deps.log("machines: moving off a forgotten machine failed");
      // The next machine reached the screen before the throw: it stays.
      if (scope.id !== id && scope.id !== null) return { kind: "next", id: scope.id };
      // The store closed under the move. /pair says so, as `check-failed`, and
      // its route needs the null scope on screen, or it is dropped and the user
      // stays on the removed machine's tree.
      moveToNullScope(cause);
      return { kind: "none" };
    }
  }

  async function forgetNullScope(): Promise<ForgetOutcome> {
    await store.open();
    try {
      store.activeId();
      return { kind: "none" };
    } catch {
      setClearFailedSignal(null);
      return { kind: "clearFailed" };
    }
  }

  return {
    current: () => scope,
    subscribe(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async start(preferred, shouldConnect) {
      if (preferred !== undefined && (await store.open()) === "ok" && store.has(preferred)) {
        try {
          await store.setActive(preferred);
        } catch {
          deps.log("machines: recording the active machine failed");
        }
      }
      return connectActive(shouldConnect);
    },
    reconnect: connectActive,
    switchTo,
    addAndSwitch,
    add,
    setAppActive(active) {
      const changed = active !== appActive;
      appActive = active;
      applyAppActive(scope);
      if (changed) for (const listener of [...appActiveListeners]) listener(active);
    },
    isAppActive: () => appActive,
    subscribeAppActive(cb) {
      appActiveListeners.add(cb);
      return () => {
        appActiveListeners.delete(cb);
      };
    },
    setIdleMs(ms) {
      idleMs = ms;
      scope.authSession.setIdleMs(ms);
      for (const built of scopes.values()) built.authSession.setIdleMs(ms);
    },
    forget(id, cause) {
      const running = forgetting.get(id);
      if (running !== undefined) return running;
      const run = (id === null ? forgetNullScope() : runForget(id, cause))
        .catch((): ForgetOutcome => {
          // Nothing above should reject: the promise to every caller is kept.
          deps.log("machines: forgetting a machine failed");
          setClearFailedSignal(id);
          return { kind: "clearFailed" };
        })
        .finally(() => {
          forgetting.delete(id);
        });
      forgetting.set(id, run);
      return run;
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
      // With no index there is no knowing a machine's own key: its token stays
      // on the disk, whichever machine the owner meant.
      if ((await deps.store.open()) === "failed") deps.log(NO_INDEX_LOGOUT_LINE);
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

/** Who must be on screen for a route an outcome asked for to still apply. */
function machineOnScreenAfter(id: MachineId | null, outcome: ForgetOutcome): MachineId | null {
  switch (outcome.kind) {
    case "clearFailed":
      return id;
    case "next":
      return outcome.id;
    case "none":
      return null;
  }
}

// Each run of `forget` answers one object, shared by any second caller.
const acted = new WeakSet<ForgetOutcome>();

/** Where a forget leaves the user, acted on once however many callers shared
 *  it: a second `router.replace` could remount /pair, which has already taken
 *  its one-shot signal. A route goes through the gate, and when it runs checks
 *  that the machine it was meant for is still the one on screen. */
export function applyForgetOutcome(deps: {
  id: MachineId | null;
  cause: ForgetCause;
  outcome: ForgetOutcome;
  sessions: Pick<MachineSessions, "current">;
  gate: NavigatorGate;
  navigateToPair(): void;
  /** The automatic path's notice: no user asked for this. */
  noticeRemoved?(): void;
}): void {
  const { outcome } = deps;
  if (acted.has(outcome)) return;
  acted.add(outcome);
  if (afterForgetRoute(deps.cause, outcome) === "pair") {
    const expected = machineOnScreenAfter(deps.id, outcome);
    // Left for the next /pair, it would name a machine the user moved past.
    const dropSignal = (): void => {
      if (outcome.kind === "clearFailed") dropClearFailedSignal(deps.id);
    };
    deps.gate.navigate(() => {
      if (deps.sessions.current().id === expected) deps.navigateToPair();
      else dropSignal();
    }, dropSignal);
    return;
  }
  if (deps.cause === "revoked") deps.noticeRemoved?.();
}

/** /pair's retry of a failed clear: the id its signal carried, and nothing else.
 *  Its own failure stays on that phase, and a success is past it, so either way
 *  it leaves no signal for a later visit: another caller may have failed on this
 *  machine while /pair was up. With nothing left, the scan is next. `next` names
 *  a machine and promises no more: if reading it failed, the removed machine's
 *  closed tree is still on screen, so the caller must go there itself
 *  (`openHeldMachine`). */
export async function retryClear(
  sessions: Pick<MachineSessions, "forget">,
  id: MachineId | null,
): Promise<"scan" | "clearFailed" | { next: MachineId }> {
  const outcome = await sessions.forget(id, "unpair");
  dropClearFailedSignal(id);
  if (outcome.kind === "next") return { next: outcome.id };
  return afterClearRetry(outcome.kind !== "clearFailed");
}

/** The record goes with the machine, so its label is read before. */
async function labelBefore(
  id: MachineId,
  loadRecord: (id: MachineId) => Promise<PairingRecord | undefined>,
): Promise<string> {
  let record: PairingRecord | undefined;
  try {
    record = await loadRecord(id);
  } catch {
    // Named from the id below.
  }
  return record === undefined ? id.slice(0, id.lastIndexOf("_")) : machineLabel(record);
}

/** The one clear-and-route for a machine: its connection store's reaction to a
 *  revocation, and the banner's "Pair again". The id is fixed, so a clear that
 *  ends after a switch still clears that machine, and leaves the new machine's
 *  screen alone. */
export function unpairedHandlerFor(deps: {
  id: MachineId | null;
  cause: "revoked" | "pair-again";
  sessions: Pick<MachineSessions, "current" | "forget">;
  loadRecord(id: MachineId): Promise<PairingRecord | undefined>;
  gate: NavigatorGate;
  navigateToPair(): void;
  noticeRemoved?(name: string): void;
  log(line: string): void;
}): () => Promise<UnpairedOutcome> {
  let label = "";
  return createUnpairedHandler({
    forget: async () => {
      if (deps.id !== null && deps.noticeRemoved !== undefined) {
        label = await labelBefore(deps.id, deps.loadRecord);
      }
      return deps.sessions.forget(deps.id, deps.cause);
    },
    afterForget: (outcome) =>
      applyForgetOutcome({
        id: deps.id,
        cause: deps.cause,
        outcome,
        sessions: deps.sessions,
        gate: deps.gate,
        navigateToPair: deps.navigateToPair,
        noticeRemoved: () => deps.noticeRemoved?.(label),
      }),
    log: deps.log,
  });
}

/** `deps.prepareSwitch` for the app: back to /dashboard, with the stack
 *  dismissed. Safe from any route, including /unlock and /pair. With no
 *  navigator mounted it asks for nothing: the router would throw later, from
 *  an effect nothing here can catch. The new tree mounts whichever route the
 *  router is on, and a machine that is locked brings up its own /unlock. */
export function prepareSwitchRoute(
  router: { canDismiss(): boolean; dismissAll(): void; replace(route: "/dashboard"): void },
  gate: NavigatorGate,
  log: (line: string) => void,
): void {
  if (!gate.isReady()) {
    log("machines: no navigator to prepare for the switch");
    return;
  }
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
