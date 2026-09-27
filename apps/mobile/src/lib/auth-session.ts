// Phase 0 owner login, the phone's half (pure logic — refresh-store.ts is
// the native adapter). Every /rpc connection opens locked; this module
// unlocks it with the owner password (`auth:login`) or the stored refresh
// token (`auth:refresh`, read behind the biometric prompt), keeps it
// unlocked by refreshing at 80% of the access lifetime, resumes a
// reconnect's locked welcome with the still-valid access token
// (`auth:resume`), and locks again after `idleMs` without a touch.
//
// Rules:
// - The access token lives in memory only. It is never written anywhere.
// - The refresh token rotates on every refresh; the laptop treats a
//   replayed old one as theft and revokes the whole login. So the stored
//   copy is always the newest: it is written before the new access token
//   is used, and if that write fails the stale stored copy is deleted.
// - Refreshes are serialized: one `auth:refresh` in flight at a time.
// - The idle lock is client-side only: the access token and the in-memory
//   refresh token are dropped (the stored one stays for biometric unlock).
// - Log lines are fixed text: never a token or a password.

import { AUTH_STATE_CHANNEL, AUTH_TOKEN_PATTERN } from "@jarvis/wire";
import type { AuthLockReason, AuthTokens } from "@jarvis/wire";
import type { Clock } from "./clock";
import type { RpcClient, RpcResult } from "./rpc-client";
import type { SecureStore } from "./secure-store";

export const REFRESH_TOKEN_KEY = "jarvis.refresh";
/** Refresh once this fraction of the access token's lifetime has passed. */
export const REFRESH_AT_FRACTION = 0.8;
/** An access token this close to expiry is not worth resuming with. */
const RESUME_MARGIN_MS = 5_000;
/** Clamp for the lifetime read off `accessExpiresAt` (laptop clock): a
 *  phone clock far ahead must not turn into a refresh loop. */
const MIN_LIFETIME_MS = 60_000;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1_000;

/** The biometric-gated store the refresh token lives in. */
export type RefreshStore = SecureStore & {
  /** False when the phone has no passcode/biometrics: nothing can be
   *  stored, so every unlock needs the password. */
  canUseBiometrics(): boolean;
};

export type AuthLockCause = "idle" | AuthLockReason;

export type UnlockOutcome =
  | "unlocked"
  /** Nothing stored (or biometrics changed): use the password. */
  | "no-stored-token"
  /** The biometric prompt was dismissed or failed. */
  | "cancelled"
  /** The stored token was refused (reused, revoked, expired) and deleted. */
  | "password-required"
  | "wrong-password"
  | "rate-limited"
  | "offline"
  | "failed";

export type AuthView = {
  /** Locked by this phone (idle, logout, a refused refresh) even if the
   *  connection itself is not currently "locked" (e.g. reconnecting). */
  lockedLocally: boolean;
  lockCause?: AuthLockCause;
  /** An automatic resume/refresh is in flight: the unlock screen waits
   *  instead of raising the biometric prompt over it. */
  busy: boolean;
  biometricUnavailable: boolean;
};

export type AuthSessionDeps = {
  rpc: Pick<RpcClient, "call" | "onState" | "onPush" | "state" | "unlock" | "lock">;
  clock: Clock;
  refreshStore: RefreshStore;
  idleMs: number;
  log(line: string): void;
};

export type AuthSession = {
  get(): AuthView;
  subscribe(listener: (view: AuthView) => void): () => void;
  unlockWithPassword(password: string): Promise<UnlockOutcome>;
  unlockWithStoredRefresh(): Promise<UnlockOutcome>;
  /** `auth:logout` (revokes this login on the laptop), deletes the stored
   *  refresh token and locks. */
  logout(): Promise<void>;
  /** Unpair: drop every token, memory and disk, without any request. */
  forget(): Promise<void>;
  /** A user interaction: restarts the idle window. */
  touch(): void;
  setAppActive(active: boolean): void;
  setIdleMs(ms: number): void;
  dispose(): void;
};

function parseTokens(value: unknown): AuthTokens | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.accessToken !== "string" || !AUTH_TOKEN_PATTERN.test(raw.accessToken)) {
    return undefined;
  }
  if (typeof raw.refreshToken !== "string" || !AUTH_TOKEN_PATTERN.test(raw.refreshToken)) {
    return undefined;
  }
  if (typeof raw.accessExpiresAt !== "number" || !Number.isFinite(raw.accessExpiresAt)) {
    return undefined;
  }
  return {
    accessToken: raw.accessToken,
    refreshToken: raw.refreshToken,
    accessExpiresAt: raw.accessExpiresAt,
  };
}

function failureOutcome(result: RpcResult & { ok: false }): UnlockOutcome {
  const { error } = result;
  if (error.kind === "offline" || error.kind === "timeout") return "offline";
  if (error.kind === "remote" && error.code === "rate-limited") return "rate-limited";
  return "failed";
}

function isForbidden(result: RpcResult): boolean {
  return !result.ok && result.error.kind === "remote" && result.error.code === "forbidden";
}

function isLockReason(value: unknown): value is AuthLockReason {
  return value === "expired" || value === "logout" || value === "signed-out";
}

export function createAuthSession(deps: AuthSessionDeps): AuthSession {
  const listeners = new Set<(view: AuthView) => void>();
  let view: AuthView = {
    lockedLocally: false,
    busy: false,
    biometricUnavailable: !deps.refreshStore.canUseBiometrics(),
  };

  let idleMs = deps.idleMs;
  // Memory only, both of them.
  let access: { token: string; expiresAt: number } | undefined;
  let refreshToken: string | undefined;
  let refreshDueAt: number | undefined;
  let refreshTimer: unknown;
  let idleTimer: unknown;
  let lastActivityAt = deps.clock.now();
  let refreshing: Promise<UnlockOutcome> | undefined;
  let disposed = false;
  // Bumped whenever the session is dropped (idle lock, logout, a revoked
  // login, unpair): a login/refresh reply that lands afterwards must not
  // unlock again.
  let epoch = 0;

  function setView(patch: Partial<AuthView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) {
      try {
        listener(view);
      } catch {
        deps.log("auth: a listener threw");
      }
    }
  }

  function cancelRefreshTimer(): void {
    if (refreshTimer !== undefined) deps.clock.clearTimeout(refreshTimer);
    refreshTimer = undefined;
    refreshDueAt = undefined;
  }

  function cancelIdleTimer(): void {
    if (idleTimer !== undefined) deps.clock.clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  function armIdleTimer(): void {
    cancelIdleTimer();
    if (access === undefined || disposed) return;
    const remaining = lastActivityAt + idleMs - deps.clock.now();
    idleTimer = deps.clock.setTimeout(
      () => {
        idleTimer = undefined;
        if (deps.clock.now() - lastActivityAt >= idleMs) idleLock();
        else armIdleTimer();
      },
      Math.max(0, remaining),
    );
  }

  function armRefreshTimer(lifetimeMs: number): void {
    cancelRefreshTimer();
    const delay = Math.floor(lifetimeMs * REFRESH_AT_FRACTION);
    refreshDueAt = deps.clock.now() + delay;
    refreshTimer = deps.clock.setTimeout(() => {
      refreshTimer = undefined;
      refreshDueAt = undefined;
      void scheduledRefresh();
    }, delay);
  }

  /** Drops both in-memory tokens and both timers. */
  function dropSession(): void {
    epoch += 1;
    access = undefined;
    refreshToken = undefined;
    cancelRefreshTimer();
    cancelIdleTimer();
  }

  async function deleteStored(): Promise<void> {
    try {
      await deps.refreshStore.delete(REFRESH_TOKEN_KEY);
    } catch {
      deps.log("auth: deleting the stored refresh token failed");
    }
  }

  function lockLocally(cause: AuthLockCause): void {
    dropSession();
    setView({ lockedLocally: true, lockCause: cause });
    deps.rpc.lock();
  }

  function idleLock(): void {
    deps.log("auth: idle lock");
    lockLocally("idle");
  }

  async function storeRefreshToken(token: string): Promise<void> {
    if (!deps.refreshStore.canUseBiometrics()) {
      if (!view.biometricUnavailable) setView({ biometricUnavailable: true });
      return;
    }
    try {
      await deps.refreshStore.set(REFRESH_TOKEN_KEY, token);
      if (view.biometricUnavailable) setView({ biometricUnavailable: false });
    } catch {
      // A stale stored copy must never be replayed later: delete it.
      deps.log("auth: storing the refresh token failed");
      await deleteStored();
    }
  }

  /** Stores the rotated refresh token first, then takes the new access
   *  token into use and unlocks the connection. False when the session was
   *  dropped while the request was in flight (`startedEpoch` is stale):
   *  after an idle lock the rotated token is still stored (the old stored
   *  one is now spent), after a revocation it is not. */
  async function adoptTokens(tokens: AuthTokens, startedEpoch: number): Promise<boolean> {
    const receivedAt = deps.clock.now();
    const lifetime = Math.min(
      MAX_LIFETIME_MS,
      Math.max(MIN_LIFETIME_MS, tokens.accessExpiresAt - receivedAt),
    );
    if (startedEpoch !== epoch && view.lockCause !== "idle") return false;
    await storeRefreshToken(tokens.refreshToken);
    if (startedEpoch !== epoch) return false;
    access = { token: tokens.accessToken, expiresAt: receivedAt + lifetime };
    refreshToken = tokens.refreshToken;
    // Not a touch: a background refresh must not postpone the idle lock
    // (the unlock paths the owner drives call touch() themselves).
    armRefreshTimer(lifetime);
    armIdleTimer();
    setView({ lockedLocally: false, lockCause: undefined });
    deps.rpc.unlock();
    return true;
  }

  /** The one `auth:refresh` path (serialized). */
  function refreshWith(token: string): Promise<UnlockOutcome> {
    if (refreshing !== undefined) return refreshing;
    const run = async (): Promise<UnlockOutcome> => {
      const startedEpoch = epoch;
      const result = await deps.rpc.call("auth:refresh", [{ refreshToken: token }]);
      if (result.ok) {
        const tokens = parseTokens(result.value);
        if (tokens === undefined) {
          deps.log("auth: malformed refresh reply");
          return "failed";
        }
        return (await adoptTokens(tokens, startedEpoch)) ? "unlocked" : "failed";
      }
      if (isForbidden(result)) {
        deps.log("auth: refresh refused");
        if (startedEpoch !== epoch) return "password-required";
        dropSession();
        await deleteStored();
        return "password-required";
      }
      return failureOutcome(result);
    };
    refreshing = run().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function scheduledRefresh(): Promise<void> {
    if (refreshToken === undefined) return;
    const outcome = await refreshWith(refreshToken);
    if (outcome === "password-required") lockLocally("signed-out");
  }

  /** A locked connection with a session still in memory: resume while the
   *  access token is valid, else refresh with the in-memory token. */
  async function autoUnlock(): Promise<void> {
    if (access === undefined && refreshToken === undefined) return;
    setView({ busy: true });
    try {
      if (access !== undefined && access.expiresAt - deps.clock.now() > RESUME_MARGIN_MS) {
        const result = await deps.rpc.call("auth:resume", [{ accessToken: access.token }]);
        if (result.ok && (result.value as { locked?: unknown } | null)?.locked === false) {
          deps.rpc.unlock();
          return;
        }
        if (!isForbidden(result)) return; // offline: the next welcome retries
        access = undefined;
      }
      if (refreshToken !== undefined) {
        const outcome = await refreshWith(refreshToken);
        if (outcome === "password-required") {
          setView({ lockedLocally: true, lockCause: "signed-out" });
        }
      }
    } finally {
      setView({ busy: false });
    }
  }

  const unsubscribeState = deps.rpc.onState((state) => {
    if (state !== "locked") return;
    // Never call back into the client from inside its own notification.
    queueMicrotask(() => {
      if (disposed || deps.rpc.state() !== "locked") return;
      void autoUnlock();
    });
  });

  const unsubscribePush = deps.rpc.onPush(AUTH_STATE_CHANNEL, (payload) => {
    const reason = (payload as { reason?: unknown } | null)?.reason;
    if (!isLockReason(reason)) return;
    deps.log(`auth: laptop locked reason=${reason}`);
    // The access token is spent either way.
    access = undefined;
    if (reason === "expired") {
      setView({ lockCause: reason });
      return;
    }
    // logout / signed-out: this login's refresh tokens were revoked too.
    dropSession();
    setView({ lockedLocally: true, lockCause: reason });
    void deleteStored();
  });

  async function unlockWithPassword(password: string): Promise<UnlockOutcome> {
    const startedEpoch = epoch;
    const result = await deps.rpc.call("auth:login", [{ password }]);
    if (!result.ok) {
      if (isForbidden(result)) return "wrong-password";
      return failureOutcome(result);
    }
    const tokens = parseTokens(result.value);
    if (tokens === undefined) {
      deps.log("auth: malformed login reply");
      return "failed";
    }
    touch();
    return (await adoptTokens(tokens, startedEpoch)) ? "unlocked" : "failed";
  }

  async function unlockWithStoredRefresh(): Promise<UnlockOutcome> {
    if (!deps.refreshStore.canUseBiometrics()) return "no-stored-token";
    if (refreshing !== undefined) return refreshing;
    let stored: string | undefined;
    try {
      stored = await deps.refreshStore.get(REFRESH_TOKEN_KEY);
    } catch {
      return "cancelled";
    }
    if (stored === undefined) return "no-stored-token";
    touch();
    return refreshWith(stored);
  }

  async function logout(): Promise<void> {
    dropSession();
    await deps.rpc.call("auth:logout", [{}]);
    await deleteStored();
    setView({ lockedLocally: true, lockCause: "logout" });
    deps.rpc.lock();
  }

  async function forget(): Promise<void> {
    dropSession();
    await deleteStored();
    setView({ lockedLocally: false, lockCause: undefined });
  }

  function touch(): void {
    lastActivityAt = deps.clock.now();
  }

  function setAppActive(active: boolean): void {
    if (!active || access === undefined) return;
    // Timers may not have run while suspended: check both deadlines now.
    if (deps.clock.now() - lastActivityAt >= idleMs) {
      idleLock();
      return;
    }
    touch();
    armIdleTimer();
    if (refreshDueAt !== undefined && deps.clock.now() >= refreshDueAt) {
      cancelRefreshTimer();
      void scheduledRefresh();
    }
  }

  function setIdleMs(ms: number): void {
    idleMs = ms;
    armIdleTimer();
  }

  function dispose(): void {
    disposed = true;
    dropSession();
    unsubscribeState();
    unsubscribePush();
    listeners.clear();
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    unlockWithPassword,
    unlockWithStoredRefresh,
    logout,
    forget,
    touch,
    setAppActive,
    setIdleMs,
    dispose,
  };
}
