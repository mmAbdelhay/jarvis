// The owner-login side of the `/rpc` protocol (Phase 0): what each
// `auth:*` request does, with no knowledge of sockets or frames. The
// connection owns its own locked/unlocked state; this module only reads it
// (`AuthContext.session`) and answers with an outcome plus an optional
// effect (`unlock` until the access token's expiry, or `lock`) that the
// connection applies. One instance serves the whole bridge, so the
// password-check limit and the invalidation generation below are
// bridge-wide.
//
// Never logged or audited: a password or any token. Audit lines carry the
// device id and source only.

import { AUTH_CHANNELS } from "@jarvis/wire";
import type { AuditEvent } from "./audit.js";
import type { AuthenticatedDevice } from "./connection.js";
import type { OwnerStore } from "./owner.js";
import type {
  AuthArgs,
  AuthChannel,
  AuthLockReason,
  AuthStatus,
  AuthTokens,
  RemoteErrorCode,
} from "./protocol.js";
import type { SessionStore } from "./sessions.js";

/** scrypt at N=2^17 costs ~128 MiB per check: at most this many run at once, bridge-wide. */
export const MAX_CONCURRENT_PASSWORD_CHECKS = 2;
/** Checks waiting for a slot; one more is refused `rate-limited` without being queued. */
export const MAX_QUEUED_PASSWORD_CHECKS = 8;

/** An unlocked connection's login: it stays unlocked until `until` (epoch ms). */
export type AuthSession = { until: number; familyId: string };

export type AuthContext = {
  device: AuthenticatedDevice;
  source: string;
  /** `undefined` while the connection is locked. */
  session: AuthSession | undefined;
};

export type AuthEffect = { unlock: AuthSession } | { lock: AuthLockReason };

export type AuthOutcome =
  | { kind: "value"; value: unknown; effect?: AuthEffect }
  | { kind: "error"; code: RemoteErrorCode };

/**
 * Brute-force policy seam (Task 5 fills it). `allow` is asked before a
 * password is checked; `failed`/`succeeded` hear every checked attempt.
 */
export type LoginLimits = {
  allow(deviceId: string, source: string): boolean;
  failed(deviceId: string, source: string): void;
  succeeded(deviceId: string, source: string): void;
};

/** What the desktop shows an OS notification for (main.ts, bilingual). */
export type DesktopNoticeKind = "locked-out-global" | "refresh-reuse";

export const NO_LOGIN_LIMITS: LoginLimits = {
  allow: () => true,
  failed: () => {},
  succeeded: () => {},
};

/** What a connection needs from the owner-login module. */
export type OwnerAuth = {
  /**
   * The session a connection starts with right after its `hello`. The
   * bridge's instance always answers `undefined`: every v2 connection opens
   * locked. Test doubles may answer an unlocked session.
   */
  sessionAtHello(device: AuthenticatedDevice): AuthSession | undefined;
  /** `args` is already validated by `parseAuthArgs`. Never rejects. */
  handle<C extends AuthChannel>(
    channel: C,
    args: AuthArgs[C],
    context: AuthContext,
  ): Promise<AuthOutcome>;
};

export type BridgeOwnerAuth = OwnerAuth & {
  /**
   * An owner-credential invalidation just happened (password change,
   * passkey delete, sign out everywhere). A login or refresh already in
   * flight is refused and its fresh family revoked, so nothing issued
   * against the old credentials outlives the invalidation.
   */
  invalidate(): void;
};

export type OwnerAuthDeps = {
  owner: Pick<OwnerStore, "verifyPassword"> & { listPasskeys(): readonly unknown[] };
  sessions: Pick<SessionStore, "issue" | "refresh" | "verifyAccess" | "revokeFamily">;
  audit: { record(event: AuditEvent): void };
  log(line: string): void;
  /** Locks every open connection unlocked by `familyId` (after logout or refresh-token reuse). */
  lockFamily(familyId: string, reason: AuthLockReason): void;
  limits?: LoginLimits;
  /** A desktop OS notification (refresh-token reuse). Defaults to a no-op. */
  notifyDesktop?(kind: DesktopNoticeKind): void;
};

const AUTH_CHANNEL_SET: ReadonlySet<string> = new Set(AUTH_CHANNELS);

export function isAuthChannel(channel: string): channel is AuthChannel {
  return AUTH_CHANNEL_SET.has(channel);
}

const FORBIDDEN: AuthOutcome = { kind: "error", code: "forbidden" };
const RATE_LIMITED: AuthOutcome = { kind: "error", code: "rate-limited" };
const INTERNAL: AuthOutcome = { kind: "error", code: "internal" };
const UNSUPPORTED: AuthOutcome = { kind: "error", code: "unsupported" };

export function createOwnerAuth(deps: OwnerAuthDeps): BridgeOwnerAuth {
  const { owner, sessions, audit, log, lockFamily } = deps;
  const limits = deps.limits ?? NO_LOGIN_LIMITS;
  const notifyDesktop = deps.notifyDesktop ?? (() => {});

  // Bumped by every invalidation; a login/refresh compares it across its
  // awaits.
  let generation = 0;

  let activeChecks = 0;
  const waitingChecks: Array<() => void> = [];

  // One refresh at a time per device. The store alone already lets only
  // one of two concurrent refreshes of the same token win; serializing here
  // keeps that true of the whole handler path, whatever the store does.
  const refreshChains = new Map<string, Promise<unknown>>();

  function record(event: AuditEvent): void {
    try {
      audit.record(event);
    } catch {
      log("owner-auth: audit record failed");
    }
  }

  function notify(kind: DesktopNoticeKind): void {
    try {
      notifyDesktop(kind);
    } catch {
      log("owner-auth: notifyDesktop failed");
    }
  }

  /**
   * Whether a family just issued or rotated is still live right before the
   * connection unlocks with it: a logout, reuse revoke or device revoke
   * that landed while this request awaited must win.
   */
  function stillLive(deviceId: string, access: string, familyId: string): boolean {
    return sessions.verifyAccess(deviceId, access)?.familyId === familyId;
  }

  function hasPasskeys(): boolean {
    return owner.listPasskeys().length > 0;
  }

  /** `undefined` when both the running and the waiting slots are full. */
  function withPasswordSlot<T>(task: () => Promise<T>): Promise<T> | undefined {
    if (
      activeChecks >= MAX_CONCURRENT_PASSWORD_CHECKS &&
      waitingChecks.length >= MAX_QUEUED_PASSWORD_CHECKS
    ) {
      return undefined;
    }
    const slot = new Promise<void>((resolve) => {
      if (activeChecks < MAX_CONCURRENT_PASSWORD_CHECKS) {
        activeChecks += 1;
        resolve();
      } else {
        waitingChecks.push(() => {
          activeChecks += 1;
          resolve();
        });
      }
    });
    return slot.then(task).finally(() => {
      activeChecks -= 1;
      waitingChecks.shift()?.();
    });
  }

  function tokensOf(issued: {
    access: string;
    refresh: string;
    accessExpiresAt: number;
  }): AuthTokens {
    return {
      accessToken: issued.access,
      refreshToken: issued.refresh,
      accessExpiresAt: issued.accessExpiresAt,
    };
  }

  /** Revokes a family issued across an invalidation; the caller refuses the request. */
  async function discardFamily(familyId: string): Promise<void> {
    try {
      await sessions.revokeFamily(familyId);
    } catch {
      log("owner-auth: revoking a stale family failed");
    }
  }

  async function login(password: string, context: AuthContext): Promise<AuthOutcome> {
    const { device, source } = context;
    if (!limits.allow(device.id, source)) return RATE_LIMITED;
    const startedAt = generation;
    const checked = withPasswordSlot(() => owner.verifyPassword(password));
    if (checked === undefined) return RATE_LIMITED;
    let ok: boolean;
    try {
      ok = await checked;
    } catch {
      log("owner-auth: password check failed");
      return INTERNAL;
    }
    // A lockout that started while this check ran (parallel attempts from
    // the same device, or the global trip) refuses it without saying
    // whether the password was right.
    if (!limits.allow(device.id, source)) return RATE_LIMITED;
    if (!ok) {
      limits.failed(device.id, source);
      record({ kind: "login-failed", deviceId: device.id, source });
      return FORBIDDEN;
    }
    let issued: Awaited<ReturnType<typeof sessions.issue>>;
    try {
      issued = await sessions.issue(device.id);
    } catch {
      log("owner-auth: issuing a session failed");
      return INTERNAL;
    }
    if (generation !== startedAt) {
      await discardFamily(issued.familyId);
      return FORBIDDEN;
    }
    if (!stillLive(device.id, issued.access, issued.familyId)) return FORBIDDEN;
    limits.succeeded(device.id, source);
    record({ kind: "login-succeeded", deviceId: device.id, source });
    return {
      kind: "value",
      value: tokensOf(issued),
      effect: { unlock: { until: issued.accessExpiresAt, familyId: issued.familyId } },
    };
  }

  async function refreshNow(token: string, context: AuthContext): Promise<AuthOutcome> {
    const { device, source } = context;
    const startedAt = generation;
    let result: Awaited<ReturnType<typeof sessions.refresh>>;
    try {
      result = await sessions.refresh(device.id, token);
    } catch {
      log("owner-auth: refreshing a session failed");
      return INTERNAL;
    }
    if (result.kind === "invalid") return FORBIDDEN;
    if (result.kind === "reuse") {
      record({ kind: "refresh-reuse", deviceId: device.id, source });
      lockFamily(result.familyId, "signed-out");
      notify("refresh-reuse");
      return FORBIDDEN;
    }
    if (generation !== startedAt) {
      await discardFamily(result.familyId);
      return FORBIDDEN;
    }
    if (!stillLive(device.id, result.access, result.familyId)) return FORBIDDEN;
    return {
      kind: "value",
      value: tokensOf(result),
      effect: { unlock: { until: result.accessExpiresAt, familyId: result.familyId } },
    };
  }

  function refresh(token: string, context: AuthContext): Promise<AuthOutcome> {
    const deviceId = context.device.id;
    const previous = refreshChains.get(deviceId) ?? Promise.resolve();
    const task = previous.then(() => refreshNow(token, context));
    refreshChains.set(deviceId, task);
    void task.finally(() => {
      if (refreshChains.get(deviceId) === task) refreshChains.delete(deviceId);
    });
    return task;
  }

  function resume(token: string, context: AuthContext): AuthOutcome {
    const verified = sessions.verifyAccess(context.device.id, token);
    if (verified === undefined) return FORBIDDEN;
    const status: AuthStatus = {
      locked: false,
      hasPasskeys: hasPasskeys(),
      accessExpiresAt: verified.expiresAt,
    };
    return {
      kind: "value",
      value: status,
      effect: { unlock: { until: verified.expiresAt, familyId: verified.familyId } },
    };
  }

  async function logout(context: AuthContext): Promise<AuthOutcome> {
    const { session } = context;
    if (session === undefined) return { kind: "value", value: null };
    try {
      await sessions.revokeFamily(session.familyId);
    } catch {
      // The family is already gone from memory; only the write failed.
      log("owner-auth: persisting a logout failed");
    }
    lockFamily(session.familyId, "logout");
    return { kind: "value", value: null, effect: { lock: "logout" } };
  }

  function status(context: AuthContext): AuthOutcome {
    const { session } = context;
    const value: AuthStatus =
      session === undefined
        ? { locked: true, hasPasskeys: hasPasskeys() }
        : { locked: false, hasPasskeys: hasPasskeys(), accessExpiresAt: session.until };
    return { kind: "value", value };
  }

  async function dispatch(
    channel: AuthChannel,
    args: AuthArgs[AuthChannel],
    context: AuthContext,
  ): Promise<AuthOutcome> {
    switch (channel) {
      case "auth:status":
        return status(context);
      case "auth:login":
        return login((args as AuthArgs["auth:login"]).password, context);
      case "auth:refresh":
        return refresh((args as AuthArgs["auth:refresh"]).refreshToken, context);
      case "auth:resume":
        return resume((args as AuthArgs["auth:resume"]).accessToken, context);
      case "auth:logout":
        return logout(context);
      case "auth:passkeyFinish":
        // A lockout refuses passkey logins as well as password ones.
        if (!limits.allow(context.device.id, context.source)) return RATE_LIMITED;
        return UNSUPPORTED;
      case "auth:passkeyBegin":
      case "auth:passkeyRegisterBegin":
      case "auth:passkeyRegisterFinish":
        return UNSUPPORTED;
    }
  }

  return {
    sessionAtHello: () => undefined,

    async handle(channel, args, context) {
      try {
        return await dispatch(channel, args, context);
      } catch {
        log(`owner-auth: ${channel} failed`);
        return INTERNAL;
      }
    },

    invalidate() {
      generation += 1;
    },
  };
}
