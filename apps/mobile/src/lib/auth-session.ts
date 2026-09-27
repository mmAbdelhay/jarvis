// Phase 0 owner login, the phone's half (pure logic — refresh-store.ts is
// the native adapter). Every /rpc connection opens locked; this module
// unlocks it with the owner password (`auth:login`) or the stored refresh
// token (`auth:refresh`, read only after the device-owner check —
// Face ID, fingerprint or the device passcode), keeps it
// unlocked by refreshing at 80% of the access lifetime, resumes a
// reconnect's locked welcome with the still-valid access token
// (`auth:resume`), and locks again after `idleMs` without a touch.
//
// Rules:
// - The access token lives in memory only. It is never written anywhere.
// - The refresh token rotates on every refresh; the laptop treats a
//   replayed old one as theft and revokes the whole login (except a retry
//   right after a lost reply: keep the token held, never guess). So the stored
//   copy is always the newest: it is written before the new access token
//   is used, and if that write fails the stale stored copy is deleted.
// - Refreshes are serialized: one `auth:refresh` in flight at a time.
// - The idle lock is client-side only: the access token and the in-memory
//   refresh token are dropped (the stored one stays for biometric unlock).
// - Log lines are fixed text: never a token or a password.

import { AUTH_STATE_CHANNEL, AUTH_TOKEN_PATTERN } from "@jarvis/wire";
import type { AuthArgs, AuthLockReason, AuthTokens, PasskeyLoginOptions } from "@jarvis/wire";
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

/** The device-owner check in front of the stored refresh token
 *  (device-auth.ts wraps expo-local-authentication). */
export type DeviceAuth = {
  /** False when the phone has no passcode (nor biometrics): no refresh
   *  token is stored, so every unlock needs the password. */
  hasPasscode(): Promise<boolean>;
  /** Face ID / fingerprint, falling back to the device passcode. True
   *  only when the owner passed it. */
  authenticate(): Promise<boolean>;
};

/** A non-secret "a refresh token is stored" flag (prefs.json): lets the
 *  unlock screen skip the device-owner prompt when there is nothing to
 *  read, without touching the keychain. */
export type RefreshStoredFlag = {
  read(): Promise<boolean>;
  write(stored: boolean): Promise<void>;
};

export type AuthLockCause = "idle" | AuthLockReason;

export type UnlockOutcome =
  | "unlocked"
  /** Nothing stored (or biometrics changed): use the password. */
  | "no-stored-token"
  /** The device-owner check was dismissed or failed. */
  | "cancelled"
  /** The stored token was refused (reused, revoked, expired) and deleted. */
  | "password-required"
  | "wrong-password"
  | "rate-limited"
  | "offline"
  | "failed"
  /** The laptop has no web origin / certificate name for passkeys. */
  | "passkey-unsupported"
  /** The laptop refused the passkey assertion. */
  | "passkey-refused";

/** What `auth:passkeyFinish` takes: the browser's assertion, base64url. */
export type PasskeyAssertion = AuthArgs["auth:passkeyFinish"];
/** Runs the browser's passkey sheet for these options; `undefined` when
 *  the owner dismissed it. */
export type GetPasskeyAssertion = (
  options: PasskeyLoginOptions,
) => Promise<PasskeyAssertion | undefined>;

export type AuthView = {
  /** Locked by this phone (idle, logout, a refused refresh) even if the
   *  connection itself is not currently "locked" (e.g. reconnecting). */
  lockedLocally: boolean;
  lockCause?: AuthLockCause;
  /** An automatic resume/refresh is in flight: the unlock screen waits
   *  instead of raising the biometric prompt over it. */
  busy: boolean;
  biometricUnavailable: boolean;
  /** The unlock screen may raise the device-owner check on its own: true
   *  at launch and on every return to the foreground, false after an
   *  in-app idle lock, a logout, or once an unlock was attempted. */
  autoPrompt: boolean;
};

export type AuthSessionDeps = {
  rpc: Pick<RpcClient, "call" | "onState" | "onPush" | "state" | "unlock" | "lock">;
  clock: Clock;
  /** Plain secure storage (no per-read prompt): rotation writes never
   *  prompt. The device-owner check gates reads instead. */
  refreshStore: SecureStore;
  refreshStoredFlag: RefreshStoredFlag;
  deviceAuth: DeviceAuth;
  /** The browser build (controller ruling, 13b fix round 1): the stored
   *  refresh token only serves the automatic sign-in at page load. After
   *  that first attempt — and so after any idle lock, logout or return to
   *  the tab — unlocking needs a passkey or the password, and a return to
   *  the foreground never re-arms `autoPrompt`. Native keeps the stored
   *  token behind the device-owner check at every unlock. */
  storedUnlockAtLaunchOnly?: boolean;
  idleMs: number;
  log(line: string): void;
};

export type AuthSession = {
  get(): AuthView;
  subscribe(listener: (view: AuthView) => void): () => void;
  unlockWithPassword(password: string): Promise<UnlockOutcome>;
  unlockWithStoredRefresh(): Promise<UnlockOutcome>;
  unlockWithPasskey(getAssertion: GetPasskeyAssertion): Promise<UnlockOutcome>;
  /** The device-owner gate's answer may have changed (the browser's "Keep
   *  me signed in"): off deletes the stored token; on, while unlocked,
   *  rotates once so the new token is stored through the normal path. */
  storagePolicyChanged(): Promise<void>;
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

function isRemoteCode(result: RpcResult, code: string): boolean {
  return !result.ok && result.error.kind === "remote" && result.error.code === code;
}

function parseLoginOptions(value: unknown): PasskeyLoginOptions | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.challenge !== "string" || typeof raw.rpId !== "string") return undefined;
  if (
    raw.allowCredentials !== undefined &&
    (!Array.isArray(raw.allowCredentials) ||
      !raw.allowCredentials.every((id) => typeof id === "string"))
  ) {
    return undefined;
  }
  return value as PasskeyLoginOptions;
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
    biometricUnavailable: false,
    autoPrompt: true,
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
  // Browser build: the one launch sign-in with the stored token is still
  // available (see storedUnlockAtLaunchOnly).
  let launchSignInAvailable = true;
  // The flag's last known value: written only when it changes.
  let storedFlag: boolean | undefined;

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

  async function setStoredFlag(stored: boolean): Promise<void> {
    if (storedFlag === stored) return;
    storedFlag = stored;
    try {
      await deps.refreshStoredFlag.write(stored);
    } catch {
      deps.log("auth: writing the stored-token flag failed");
    }
  }

  /** True when a refresh token may be stored. An unreadable flag answers
   *  true: the keychain read then decides. */
  async function mayHaveStored(): Promise<boolean> {
    if (storedFlag !== undefined) return storedFlag;
    try {
      storedFlag = await deps.refreshStoredFlag.read();
      return storedFlag;
    } catch {
      return true;
    }
  }

  /** Clears the flag first: a flag that says "none" over a leftover token
   *  only costs a password entry, never a prompt over nothing. */
  async function deleteStored(): Promise<void> {
    await setStoredFlag(false);
    try {
      await deps.refreshStore.delete(REFRESH_TOKEN_KEY);
    } catch {
      deps.log("auth: deleting the stored refresh token failed");
    }
  }

  function lockLocally(cause: AuthLockCause): void {
    launchSignInAvailable = false;
    dropSession();
    setView({ lockedLocally: true, lockCause: cause, autoPrompt: false });
    deps.rpc.lock();
  }

  async function hasPasscode(): Promise<boolean> {
    let has = false;
    try {
      has = await deps.deviceAuth.hasPasscode();
    } catch {
      has = false;
    }
    if (view.biometricUnavailable === has) setView({ biometricUnavailable: !has });
    return has;
  }

  function idleLock(): void {
    deps.log("auth: idle lock");
    lockLocally("idle");
  }

  async function storeRefreshToken(token: string): Promise<void> {
    if (!(await hasPasscode())) {
      // No passcode: nothing may sit on disk without a device lock.
      await deleteStored();
      return;
    }
    try {
      await deps.refreshStore.set(REFRESH_TOKEN_KEY, token);
      // The gate may have closed while writing (the browser's "Keep me
      // signed in" switched off): take the token back out.
      if (!(await hasPasscode())) {
        await deleteStored();
        return;
      }
      await setStoredFlag(true);
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
    // Signed in: the page-load sign-in (browser) is behind us.
    launchSignInAvailable = false;
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
        const startedEpoch = epoch;
        const result = await deps.rpc.call("auth:resume", [{ accessToken: access.token }]);
        // Dropped meanwhile (idle lock, logout, a revocation): stay locked.
        if (startedEpoch !== epoch || view.lockedLocally) return;
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
    // Nothing left to unlock with: no automatic device-owner prompt.
    setView({ lockedLocally: true, lockCause: reason, autoPrompt: false });
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
    if (view.autoPrompt) setView({ autoPrompt: false });
    if (deps.storedUnlockAtLaunchOnly === true) {
      if (!launchSignInAvailable) return "no-stored-token";
      launchSignInAvailable = false;
    }
    if (refreshing !== undefined) return refreshing;
    if (!(await hasPasscode())) return "no-stored-token";
    // Nothing stored (first launch after pairing, after a logout): no prompt.
    if (!(await mayHaveStored())) return "no-stored-token";
    let passed = false;
    try {
      passed = await deps.deviceAuth.authenticate();
    } catch {
      passed = false;
    }
    if (!passed) return "cancelled"; // the token is never read
    // Single-flight across the prompt: a refresh that started meanwhile
    // already spent the stored token; never replay it.
    if (refreshing !== undefined) return refreshing;
    let stored: string | undefined;
    try {
      stored = await deps.refreshStore.get(REFRESH_TOKEN_KEY);
    } catch {
      return "failed";
    }
    if (stored === undefined) {
      await setStoredFlag(false);
      return "no-stored-token";
    }
    if (refreshing !== undefined) return refreshing;
    touch();
    return refreshWith(stored);
  }

  async function unlockWithPasskey(getAssertion: GetPasskeyAssertion): Promise<UnlockOutcome> {
    const startedEpoch = epoch;
    const begin = await deps.rpc.call("auth:passkeyBegin", [{}]);
    if (!begin.ok) {
      if (isRemoteCode(begin, "unsupported")) return "passkey-unsupported";
      return failureOutcome(begin);
    }
    const options = parseLoginOptions(begin.value);
    if (options === undefined) {
      deps.log("auth: malformed passkey options");
      return "failed";
    }
    let assertion: PasskeyAssertion | undefined;
    try {
      assertion = await getAssertion(options);
    } catch {
      deps.log("auth: the passkey sheet failed");
      return "failed";
    }
    if (assertion === undefined) return "cancelled";
    const finish = await deps.rpc.call("auth:passkeyFinish", [assertion]);
    if (!finish.ok) {
      if (isForbidden(finish)) return "passkey-refused";
      if (isRemoteCode(finish, "unsupported")) return "passkey-unsupported";
      return failureOutcome(finish);
    }
    const tokens = parseTokens(finish.value);
    if (tokens === undefined) {
      deps.log("auth: malformed passkey reply");
      return "failed";
    }
    touch();
    return (await adoptTokens(tokens, startedEpoch)) ? "unlocked" : "failed";
  }

  async function storagePolicyChanged(): Promise<void> {
    if (!(await hasPasscode())) {
      await deleteStored();
      // A deleted record may linger on disk: spend the token it held with
      // one rotation, keeping the new pair in memory only (the gate is off,
      // so adoptTokens stores nothing).
      if (refreshToken !== undefined) await refreshWith(refreshToken);
      return;
    }
    // Rotating (single-flight) stores the fresh token through adoptTokens,
    // so no write here can ever race a rotation with an older token.
    if (refreshToken !== undefined) await refreshWith(refreshToken);
  }

  /** Local effects first, so an offline (or hanging) `auth:logout` can
   *  never leave the phone unlocked or the stored token behind. */
  async function logout(): Promise<void> {
    lockLocally("logout");
    await deleteStored();
    await deps.rpc.call("auth:logout", [{}]);
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
    if (!active) return;
    // Timers may not have run while suspended: check both deadlines now.
    if (access !== undefined && deps.clock.now() - lastActivityAt >= idleMs) idleLock();
    // A return to the foreground may raise the device-owner check itself
    // (also after the idle lock just above) — never in the browser, where
    // only the page load signs in automatically.
    if (!view.autoPrompt && deps.storedUnlockAtLaunchOnly !== true) setView({ autoPrompt: true });
    if (access === undefined) return;
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
    unlockWithPasskey,
    storagePolicyChanged,
    logout,
    forget,
    touch,
    setAppActive,
    setIdleMs,
    dispose,
  };
}
