// The owner-login side of the `/rpc` protocol (Phase 0): what each
// `auth:*` request does, with no knowledge of sockets or frames. The
// connection owns its own locked/unlocked state; this module only reads it
// (`AuthContext.session`) and answers with an outcome plus an optional
// effect (`unlock` until the access token's expiry, or `lock`) that the
// connection applies. One instance serves the whole bridge, so the
// password-check limit and the invalidation generation below are
// bridge-wide.
//
// Passkeys (WebAuthn): the relying party is the configured certificate's
// DNS name and the expected origin the web listener's `https://<name>:<port>`;
// while either is unknown every passkey ceremony answers `unsupported`.
// Challenges are single use, keyed to the connection, and dropped with it.
//
// Never logged or audited: a password, any token, or any key. Audit lines
// carry the device id and source only (plus a credential id's prefix for
// an added passkey).

import { AUTH_CHANNELS } from "@jarvis/wire";
import type { AuditEvent } from "./audit.js";
import type { AuthenticatedDevice } from "./connection.js";
import { sanitizeDeviceName } from "./devices.js";
import type { Clock, RandomBytes } from "./io.js";
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
import {
  clientDataChallenge,
  createChallengeStore,
  verifyAssertion,
  verifyRegistration,
} from "./webauthn.js";

/** scrypt at N=2^17 costs ~128 MiB per check: at most this many run at once, bridge-wide. */
export const MAX_CONCURRENT_PASSWORD_CHECKS = 2;
/** Checks waiting for a slot; one more is refused `rate-limited` without being queued. */
export const MAX_QUEUED_PASSWORD_CHECKS = 8;
/** How long a browser may take over one passkey ceremony (the challenge lives as long). */
export const PASSKEY_TIMEOUT_MS = 120_000;

/** An unlocked connection's login: it stays unlocked until `until` (epoch ms). */
export type AuthSession = { until: number; familyId: string };

export type AuthContext = {
  /** Process-local and unique per connection: what passkey challenges are keyed to. */
  connectionId: string;
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
 * password is checked; `failed`/`succeeded` hear every checked attempt, and
 * `refused` every attempt a lockout turned away (audited, coalesced).
 */
export type LoginLimits = {
  allow(deviceId: string, source: string): boolean;
  failed(deviceId: string, source: string): void;
  succeeded(deviceId: string, source: string): void;
  refused(deviceId: string, source: string): void;
};

/** What the desktop shows an OS notification for (main.ts, bilingual). */
export type DesktopNoticeKind = "locked-out-global" | "refresh-reuse";

export const NO_LOGIN_LIMITS: LoginLimits = {
  allow: () => true,
  failed: () => {},
  succeeded: () => {},
  refused: () => {},
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
  /** The connection is gone: its passkey challenges go with it. */
  connectionClosed(connectionId: string): void;
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
  owner: Pick<
    OwnerStore,
    | "verifyPassword"
    | "listPasskeys"
    | "addPasskey"
    | "deletePasskey"
    | "updateSignCount"
    | "ownerHandle"
  >;
  random: RandomBytes;
  now: Clock;
  sessions: Pick<SessionStore, "issue" | "refresh" | "verifyAccess" | "revokeFamily">;
  audit: { record(event: AuditEvent): void };
  log(line: string): void;
  /** Locks every open connection unlocked by `familyId` (after logout or refresh-token reuse). */
  lockFamily(familyId: string, reason: AuthLockReason): void;
  limits?: LoginLimits;
  /** A desktop OS notification (refresh-token reuse). Defaults to a no-op. */
  notifyDesktop?(kind: DesktopNoticeKind): void;
  /** The WebAuthn relying party id: the configured certificate's DNS name. */
  rpId?(): string | undefined;
  /** The web listener's origin, `https://<name>:<port>` (Phase 1). */
  webOrigin?(): string | undefined;
  /** A passkey was just registered remotely (desktop Settings refreshes). */
  onPasskeyAdded?(): void;
  /**
   * Takes back a passkey stored across an invalidation. The bridge runs its
   * full passkey delete (every session revoked, every connection locked,
   * sidecars torn down), so a login made with the credential while it was
   * briefly stored dies with it. Defaults to `owner.deletePasskey`.
   */
  removePasskey?(credentialId: string): Promise<unknown>;
};

const AUTH_CHANNEL_SET: ReadonlySet<string> = new Set(AUTH_CHANNELS);

export function isAuthChannel(channel: string): channel is AuthChannel {
  return AUTH_CHANNEL_SET.has(channel);
}

const FORBIDDEN: AuthOutcome = { kind: "error", code: "forbidden" };
const RATE_LIMITED: AuthOutcome = { kind: "error", code: "rate-limited" };
const INTERNAL: AuthOutcome = { kind: "error", code: "internal" };
const UNSUPPORTED: AuthOutcome = { kind: "error", code: "unsupported" };
const LOCKED: AuthOutcome = { kind: "error", code: "locked" };
const BAD_REQUEST: AuthOutcome = { kind: "error", code: "bad-request" };

type RelyingParty = { rpId: string; origin: string };

const PUBLIC_KEY_PARAMS = [
  { type: "public-key", alg: -7 },
  { type: "public-key", alg: -257 },
] as const;

export function createOwnerAuth(deps: OwnerAuthDeps): BridgeOwnerAuth {
  const { owner, sessions, audit, log, lockFamily } = deps;
  const limits = deps.limits ?? NO_LOGIN_LIMITS;
  const notifyDesktop = deps.notifyDesktop ?? (() => {});
  const challenges = createChallengeStore({ random: deps.random, now: deps.now });
  // The token family each connection's pending registration was begun
  // under: a finish from any other login (after a lock and a new login,
  // say) is refused, so a password re-entry never outlives its session.
  const registering = new Map<string, string>();

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

  /** `undefined` until both the certificate name and the web origin are known and agree. */
  function relyingParty(): RelyingParty | undefined {
    const rpId = deps.rpId?.();
    const webOrigin = deps.webOrigin?.();
    if (rpId === undefined || webOrigin === undefined) return undefined;
    let url: URL;
    try {
      url = new URL(webOrigin);
    } catch {
      return undefined;
    }
    if (url.protocol !== "https:" || url.hostname !== rpId.toLowerCase()) return undefined;
    // The hostname is already lower case: the rpIdHash a browser signs is
    // over the lower-case name, whatever case the certificate carries.
    return { rpId: url.hostname, origin: url.origin };
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

  /** An attempt a lockout turns away: reported to the limits (which audit it) and refused. */
  function refuseLockedOut(deviceId: string, source: string): AuthOutcome {
    limits.refused(deviceId, source);
    return RATE_LIMITED;
  }

  /**
   * The owner password through the bridge-wide limits and scrypt queue:
   * `undefined` when it is right, otherwise the outcome to answer. A wrong
   * one counts toward the lockout and is audited `login-failed`.
   */
  async function checkPassword(
    password: string,
    context: AuthContext,
  ): Promise<AuthOutcome | undefined> {
    const { device, source } = context;
    if (!limits.allow(device.id, source)) return refuseLockedOut(device.id, source);
    // A lockout that started while this attempt waited for a slot refuses
    // it before scrypt runs.
    const checked = withPasswordSlot(async () =>
      limits.allow(device.id, source) ? await owner.verifyPassword(password) : undefined,
    );
    if (checked === undefined) return RATE_LIMITED;
    let ok: boolean | undefined;
    try {
      ok = await checked;
    } catch {
      log("owner-auth: password check failed");
      return INTERNAL;
    }
    // A lockout that started while this check ran (parallel attempts from
    // the same device, or the global trip) refuses it without saying
    // whether the password was right.
    if (ok === undefined || !limits.allow(device.id, source)) {
      return refuseLockedOut(device.id, source);
    }
    if (!ok) {
      limits.failed(device.id, source);
      record({ kind: "login-failed", deviceId: device.id, source });
      return FORBIDDEN;
    }
    return undefined;
  }

  /** A failed passkey login: counted toward the lockout like a wrong password. */
  function passkeyFailed(context: AuthContext): AuthOutcome {
    const { device, source } = context;
    limits.failed(device.id, source);
    record({ kind: "login-failed", deviceId: device.id, source, method: "passkey" });
    return FORBIDDEN;
  }

  /** Issues a token family for a login verified since `startedAt` and unlocks with it. */
  async function openSession(
    context: AuthContext,
    startedAt: number,
    method?: "passkey",
  ): Promise<AuthOutcome> {
    const { device, source } = context;
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
    record({
      kind: "login-succeeded",
      deviceId: device.id,
      source,
      ...(method !== undefined ? { method } : {}),
    });
    return {
      kind: "value",
      value: tokensOf(issued),
      effect: { unlock: { until: issued.accessExpiresAt, familyId: issued.familyId } },
    };
  }

  async function login(password: string, context: AuthContext): Promise<AuthOutcome> {
    const startedAt = generation;
    const refused = await checkPassword(password, context);
    if (refused !== undefined) return refused;
    return openSession(context, startedAt);
  }

  function passkeyBegin(context: AuthContext): AuthOutcome {
    const party = relyingParty();
    if (party === undefined) return UNSUPPORTED;
    const challenge = challenges.issue(context.connectionId, "login");
    return {
      kind: "value",
      value: {
        challenge,
        rpId: party.rpId,
        allowCredentials: owner.listPasskeys().map((passkey) => passkey.credentialId),
        userVerification: "required",
        timeout: PASSKEY_TIMEOUT_MS,
      },
    };
  }

  async function passkeyFinish(
    args: AuthArgs["auth:passkeyFinish"],
    context: AuthContext,
  ): Promise<AuthOutcome> {
    const { device, source, connectionId } = context;
    // A lockout refuses passkey logins as well as password ones.
    if (!limits.allow(device.id, source)) return refuseLockedOut(device.id, source);
    const party = relyingParty();
    if (party === undefined) return UNSUPPORTED;
    const startedAt = generation;
    const challenge = clientDataChallenge(args.clientDataJSON);
    if (challenge === undefined || !challenges.consume(connectionId, "login", challenge)) {
      return passkeyFailed(context);
    }
    // Credential ids are public (they are in every passkeyBegin answer):
    // a plain lookup is fine.
    const passkey = owner.listPasskeys().find((entry) => entry.credentialId === args.credentialId);
    if (passkey === undefined) return passkeyFailed(context);
    const verified = verifyAssertion({
      clientDataJSON: args.clientDataJSON,
      authenticatorData: args.authenticatorData,
      signature: args.signature,
      expectedChallenge: challenge,
      expectedOrigin: party.origin,
      rpId: party.rpId,
      publicKey: passkey.publicKey,
      alg: passkey.alg,
      storedSignCount: passkey.signCount,
    });
    if (!verified.ok) return passkeyFailed(context);
    // The new count is in memory the moment this is called (no await
    // between the lookup above and here), so a concurrent assertion of the
    // same credential is checked against it; only the write lands later.
    // A failed write is logged and the login goes ahead: the count holds
    // in memory, but after a restart the older on-disk count is back in
    // force, re-opening the window a cloned authenticator could use.
    try {
      await owner.updateSignCount(passkey.credentialId, verified.signCount);
    } catch {
      log("owner-auth: persisting a passkey sign count failed");
    }
    // A lockout that started while the count was written refuses it.
    if (!limits.allow(device.id, source)) return refuseLockedOut(device.id, source);
    return openSession(context, startedAt, "passkey");
  }

  async function passkeyRegisterBegin(
    password: string,
    context: AuthContext,
  ): Promise<AuthOutcome> {
    const { session, connectionId } = context;
    if (session === undefined) return LOCKED;
    const party = relyingParty();
    if (party === undefined) return UNSUPPORTED;
    const startedAt = generation;
    const refused = await checkPassword(password, context);
    if (refused !== undefined) return refused;
    if (generation !== startedAt) return FORBIDDEN;
    let handle: string;
    try {
      handle = await owner.ownerHandle();
    } catch {
      log("owner-auth: storing the owner handle failed");
      return INTERNAL;
    }
    const challenge = challenges.issue(connectionId, "register");
    registering.set(connectionId, session.familyId);
    return {
      kind: "value",
      value: {
        challenge,
        rpId: party.rpId,
        user: { id: handle, name: "owner", displayName: "Jarvis owner" },
        excludeCredentials: owner.listPasskeys().map((passkey) => passkey.credentialId),
        pubKeyCredParams: PUBLIC_KEY_PARAMS.map((param) => ({ ...param })),
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        attestation: "none",
        timeout: PASSKEY_TIMEOUT_MS,
      },
    };
  }

  async function passkeyRegisterFinish(
    args: AuthArgs["auth:passkeyRegisterFinish"],
    context: AuthContext,
  ): Promise<AuthOutcome> {
    const { session, connectionId, device, source } = context;
    if (session === undefined) return LOCKED;
    const challenge = clientDataChallenge(args.clientDataJSON);
    if (challenge === undefined || !challenges.consume(connectionId, "register", challenge)) {
      return FORBIDDEN;
    }
    const beganUnder = registering.get(connectionId);
    registering.delete(connectionId);
    if (beganUnder !== session.familyId) return FORBIDDEN;
    const party = relyingParty();
    if (party === undefined) return UNSUPPORTED;
    const verified = verifyRegistration({
      clientDataJSON: args.clientDataJSON,
      attestationObject: args.attestationObject,
      expectedChallenge: challenge,
      expectedOrigin: party.origin,
      rpId: party.rpId,
    });
    if (!verified.ok || verified.credentialId !== args.credentialId) return FORBIDDEN;
    const label = sanitizeDeviceName(args.label);
    if (label === "") return BAD_REQUEST;
    if (owner.listPasskeys().some((entry) => entry.credentialId === verified.credentialId)) {
      return BAD_REQUEST;
    }
    const startedAt = generation;
    try {
      await owner.addPasskey({
        credentialId: verified.credentialId,
        publicKey: verified.publicKey,
        alg: verified.alg,
        signCount: verified.signCount,
        label,
        createdAt: deps.now(),
      });
    } catch {
      log("owner-auth: storing a passkey failed");
      return INTERNAL;
    }
    // An invalidation (password change, sign out everywhere) that landed
    // while the passkey was written wins: the passkey is taken back out,
    // through the same invalidation a desktop delete runs.
    if (generation !== startedAt) {
      try {
        if (deps.removePasskey !== undefined) await deps.removePasskey(verified.credentialId);
        else await owner.deletePasskey(verified.credentialId);
      } catch {
        log("owner-auth: removing a stale passkey failed");
      }
      return FORBIDDEN;
    }
    record({
      kind: "passkey-added",
      deviceId: device.id,
      source,
      credentialPrefix: verified.credentialId.slice(0, 8),
    });
    try {
      deps.onPasskeyAdded?.();
    } catch {
      log("owner-auth: onPasskeyAdded failed");
    }
    return { kind: "value", value: null };
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
      case "auth:passkeyBegin":
        return passkeyBegin(context);
      case "auth:passkeyFinish":
        return passkeyFinish(args as AuthArgs["auth:passkeyFinish"], context);
      case "auth:passkeyRegisterBegin":
        return passkeyRegisterBegin(
          (args as AuthArgs["auth:passkeyRegisterBegin"]).password,
          context,
        );
      case "auth:passkeyRegisterFinish":
        return passkeyRegisterFinish(args as AuthArgs["auth:passkeyRegisterFinish"], context);
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

    connectionClosed(connectionId) {
      challenges.drop(connectionId);
      registering.delete(connectionId);
    },

    invalidate() {
      generation += 1;
    },
  };
}
