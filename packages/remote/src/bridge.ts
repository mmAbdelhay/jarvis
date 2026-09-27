// The bridge lifecycle: the one gate deciding whether anything listens.
// Composes the pure units from earlier tasks — devices, audit, pairing, the
// hub — behind a single `createBridge(deps)`, with an injected `listen`
// (Task 8 wires the real TLS listener) and an injected `loadCertificate`
// (certificate.ts, imported here as types only — the value import would
// pull `@peculiar/x509` into `@jarvis/remote`'s main entry).
//
// The gate (rule 3): a listener is "wanted" only while the bridge is
// enabled, not stopped, its devices and owner files are readable, an owner
// password exists (Phase 0), its configured address is a real IP literal, and — the "off by default" rule — either a
// device is already paired, a pairing window (or its confirmation, or a
// pair socket already in flight) is open. Every public method that can
// change any of those inputs awaits `reconcile()`, the only place the gate
// is ever evaluated. `reconcile()` is itself serialised on a promise queue
// so two overlapping calls (a `revoke` racing an `apply`, say) never step on
// each other opening or closing the listener.

import { join } from "node:path";
import { isHostname } from "@jarvis/wire";
import { canonicalAddress } from "./address.js";
import { createAuditLog } from "./audit.js";
import type { CertificateConfig, CertificateMaterial } from "./certificate.js";
import type {
  AuditPolicy,
  AuthorizeKey,
  ConnectionDeps,
  ErrorText,
  RequestHandler,
} from "./connection.js";
import type { DevicePush, DeviceStore } from "./devices.js";
import { createDeviceStore } from "./devices.js";
import { createHub } from "./hub.js";
import type { OwnerHashParams } from "./owner.js";
import { createOwnerStore } from "./owner.js";
import { createLoginLimits } from "./login-limits.js";
import { createOwnerAuth, type DesktopNoticeKind } from "./owner-auth.js";
import { createSessionStore } from "./sessions.js";
import { describeError } from "./io.js";
import type { Clock, RandomBytes, RemoteFs, SessionHandlers, SocketLike, Timers } from "./io.js";
import type { ChannelPolicies } from "./policy.js";
import { createPairSession } from "./pair-session.js";
import { createPairing } from "./pairing.js";
// Type-only: `proxy.ts` (node:http/node:net) never becomes reachable from
// this file's *value* imports — only its shape is needed to type
// `ListenOptions.proxy`/`BridgeDeps.createProxy`. The bridge never
// constructs a `SidecarProxy` itself; `deps.createProxy` (injected, like
// `listen`) is the only thing that ever does.
import type { SidecarProxy } from "./proxy.js";
import { CLOSE, formatPairingUri } from "./protocol.js";
import { createSidecarRegistry } from "./sidecar-registry.js";
import type { SidecarRegistry, SidecarTarget } from "./sidecar-registry.js";

export type BridgeConfig = {
  enabled: boolean;
  bindAddress: string;
  port: number;
  tls: { certPath?: string; keyPath?: string };
  sidecarProxy: boolean;
  /**
   * Minutes of idleness (rule 2) before the bridge closes its own listener;
   * 0 = never. Controller ruling (M12 Task 1): optional because the
   * desktop's `toBridgeConfig` doesn't pass it yet — Task 2 wires the real
   * value through `apply()`. Absent is treated exactly like `0`.
   */
  idleDisableMinutes?: number;
};

/**
 * The config ceiling (rule 1) — one week, in minutes. `desktop/src/config.ts`'s
 * own validator uses the identical number in its error message ("...must be
 * a whole number of minutes from 0 to 10080"); a test here asserts equality
 * so the two can never drift apart silently.
 */
export const IDLE_DISABLE_MAX_MINUTES = 10_080;

/** Fix round 1 (review minor): `recordPushQueued`'s own bound on `pushKind`
 *  — see that function's comment. */
const PUSH_KIND_MAX_CHARS = 32;

export type ListenOptions = {
  host: string;
  port: number;
  cert: string;
  key: string;
  // Passed only when the sidecar gate would be "on" for this material and
  // config (rule 5) — `listenTls` routes `/s/...` requests/upgrades to it
  // and destroys everything else under that path when it is `undefined`.
  proxy: SidecarProxy | undefined;
  onSocket(kind: "rpc" | "pair", socket: SocketLike, remoteAddress: string): SessionHandlers;
  log(line: string): void;
};

export type Listener = { port: number; close(): Promise<void> };

export type Listen = (options: ListenOptions) => Promise<Listener>;

export type RemoteProblem =
  | "bad-address"
  | "listen-failed"
  | "certificate-failed"
  | "devices-unreadable"
  | "devices-write-failed"
  /** Enabled in config, but no owner password exists yet (Phase 0): the
   *  bridge never listens without one. Config is left as it is, so setting
   *  a password is all it takes to come up. */
  | "no-owner-password"
  /** owner.json exists but could not be read or parsed — sticky, like
   *  devices-unreadable. */
  | "owner-unreadable"
  /** sessions.json exists but could not be read — sticky; the bridge never
   *  listens rather than overwrite the refresh tokens it holds. */
  | "sessions-unreadable";

/** What desktop Settings shows of the owner account — never a hash, a
 *  salt or a passkey's public key. */
export type OwnerStatus = {
  hasPassword: boolean;
  passkeys: { id: string; label: string; createdAt: number }[];
};

/** `mismatch` (the confirm field) never reaches here — it is the
 *  renderer's own check. */
export type OwnerPasswordError =
  | "too-short"
  | "too-long"
  | "current-required"
  | "current-wrong"
  | "unavailable"
  | "write-failed";

export type SetOwnerPasswordResult = { ok: true } | { ok: false; code: OwnerPasswordError };

export type RemoteDeviceStatus = {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number | undefined;
  connected: boolean;
  /** Platform only, mirroring DeviceSummary.push — never the token (M10). */
  push?: "ios" | "android";
};

export type RemotePairingStatus =
  | { kind: "closed" }
  | { kind: "open"; uri: string; expiresAt: number }
  | {
      kind: "confirming";
      requestId: string;
      deviceName: string;
      /** P15/D4: the connecting socket's source address, same value as
       *  pairing.ts's PairingStatus — see there for why. */
      address: string;
      expiresAt: number;
    };

/**
 * Rule 6: `armed` while a timer is live (`disableAt` is when it fires);
 * `disabled` is the persisted record of the last time it did — kept across
 * `apply()` calls whose config still has `enabled: false` (rule 5).
 */
export type RemoteIdleStatus =
  | { kind: "armed"; disableAt: number }
  | { kind: "disabled"; at: number; afterMinutes: number };

export type RemoteStatus = {
  enabled: boolean;
  listening:
    | {
        host: string;
        port: number;
        fingerprint: string;
        certificate: { source: "self-signed" | "configured"; hostname: string | undefined };
      }
    | undefined;
  pairing: RemotePairingStatus;
  devices: RemoteDeviceStatus[];
  problem: RemoteProblem | undefined;
  sidecarProxy: "off" | "needs-certificate" | "on";
  /**
   * Controller ruling (M12 Task 1, follow-up): optional for the same reason
   * as `BridgeDeps.onIdleDisabled`/`BridgeConfig.idleDisableMinutes` — the
   * desktop build stays green until Task 2 wires this field through its own
   * `RemoteStatus` consumers. `status()` (below) always sets it regardless.
   */
  idle?: RemoteIdleStatus;
  /**
   * Phase 0: bumped whenever the owner account changes from the remote
   * side (a passkey registered from a phone or browser), so desktop
   * Settings re-reads `ownerStatus()` without being reopened.
   */
  ownerVersion?: number;
};

/** The non-`undefined` half of `RemoteStatus.listening` — the shape this module's own `listening` variable holds. */
type ListeningInfo = Extract<RemoteStatus["listening"], object>;

export type PairingResult = "opened" | "disabled" | "unavailable";

export type BridgeDeps = {
  dir: string;
  fs: RemoteFs;
  random: RandomBytes;
  now: Clock;
  timers: Timers;
  listen: Listen;
  loadCertificate(config: CertificateConfig): Promise<CertificateMaterial>;
  createProxy(registry: SidecarRegistry): SidecarProxy | undefined;
  handle: RequestHandler;
  policies: ChannelPolicies;
  authorizeKey: AuthorizeKey;
  blobLimit: ConnectionDeps["blobLimit"];
  errorText: ErrorText;
  /** M12 Task 3: the desktop's own `auditPolicyFor` — this package never
   *  names a channel, it only asks. */
  auditPolicy(channel: string): AuditPolicy;
  enforceFileModes: boolean;
  /** Test-only: a lower scrypt cost for owner.json. Production omits it. */
  ownerHashParams?: OwnerHashParams;
  log(line: string): void;
  onStatus(status: RemoteStatus): void;
  onDeviceDisconnected(deviceId: string): void;
  /**
   * Controller ruling (M12 Task 1): optional so the desktop build stays
   * green until Task 2 wires the real handler in. Called once, after the
   * idle timer has already closed the listener and the "idle-disabled"
   * audit line and `RemoteStatus.idle` have already been updated — never
   * from `stop()` (rule 7).
   */
  onIdleDisabled?(): void;
  /** Phase 0: a desktop OS notification — a login lockout (global, or one
   *  device's, with that device's name), or a refresh token presented
   *  again. Optional; defaults to a no-op. */
  notifyDesktop?(kind: DesktopNoticeKind, deviceName?: string): void;
  /**
   * Phase 0: the web listener's origin (`https://<name>:<port>`), the
   * passkey ceremonies' expected origin. The web listener arrives in
   * Phase 1; until it answers, passkeys are `unsupported`. Optional;
   * defaults to always `undefined`.
   */
  webOrigin?(): string | undefined;
};

export type Bridge = {
  apply(config: BridgeConfig): Promise<void>;
  openPairing(): Promise<PairingResult>;
  cancelPairing(): void;
  decidePairing(requestId: string, approve: boolean): boolean;
  revoke(deviceId: string): Promise<boolean>;
  publishSidecar(
    deviceId: string,
    target: SidecarTarget,
  ):
    | { url: string }
    | {
        unavailable: "off" | "needs-certificate" | "not-listening" | "unknown-device" | "locked";
      };
  push(channel: string, payload: unknown): void;
  hasSubscriber(channel: string): boolean;
  /** Stores this device's Expo push registration beside its record. Answers
   *  "write-failed" (sets `problem = "devices-write-failed"`, the `revoke`
   *  pattern) on a persist failure — never the token, in the return value or
   *  anywhere else (M10). */
  setPushToken(
    deviceId: string,
    push: Omit<DevicePush, "registeredAt">,
  ): Promise<"ok" | "unknown-device" | "write-failed">;
  /** Clears this device's push registration; answers whether a token was
   *  actually cleared (audited `push-cleared` only when it was). */
  clearPushToken(deviceId: string, reason: "unregistered" | "not-registered"): Promise<boolean>;
  /** M12 Task 3 rule 6: records `{kind:"push-queued", deviceId, pushKind}` —
   *  never the token, the title, the body or the project. `pushKind` is
   *  validated no further than being a string (it is a wire enum
   *  upstream). */
  recordPushQueued(deviceId: string, pushKind: string): void;
  /** Every device with a registered token — the sender's send list. */
  pushTargets(): ReturnType<DeviceStore["pushTargets"]>;
  /** "Who is watching" a channel/key right now — the empty set unless a
   *  listener is actually up (M10 rule 6). */
  watchingDevices(channel: string, key?: string): ReadonlySet<string>;
  status(): RemoteStatus;
  /** Phase 0: the owner account, for desktop Settings only. */
  ownerStatus(): OwnerStatus;
  /** Sets the first owner password (`current` ignored) or changes it
   *  (`current` required and verified). The password is never logged,
   *  audited, echoed in an error or returned. */
  setOwnerPassword(current: string | undefined, next: string): Promise<SetOwnerPasswordResult>;
  /** False for an unknown id or a failed write (the passkey is gone from
   *  memory either way once it existed). */
  deletePasskey(credentialId: string): Promise<boolean>;
  signOutEverywhere(): Promise<void>;
  stop(): Promise<void>;
};

/**
 * Sticky problems (rule 5 / ruling P9): once set, never overwritten by the
 * transient bad-address recompute each reconcile step runs. `devices-unreadable`
 * and `devices-write-failed` are permanent for this bridge's lifetime;
 * `listen-failed` and `certificate-failed` are sticky only until the next
 * successful listen or the next `apply()` — both of those clear them
 * explicitly, elsewhere.
 */
function isStickyProblem(problem: RemoteProblem | undefined): boolean {
  return (
    problem === "devices-unreadable" ||
    problem === "devices-write-failed" ||
    problem === "owner-unreadable" ||
    problem === "sessions-unreadable" ||
    problem === "listen-failed" ||
    problem === "certificate-failed"
  );
}

/**
 * Rule 4's gate, factored out so both `step()` (deciding whether to hand
 * `deps.createProxy` a registry at listen time, from the certificate it
 * just loaded) and `status()` (reporting the same fact from the already-
 * `listening` record) apply the identical condition: "off" only when the
 * config itself has the toggle off; "on" only for a *configured* certificate
 * that actually carries a DNS name; "needs-certificate" for the self-signed
 * or no-SAN case in between.
 */
function computeSidecarGate(
  sidecarProxyEnabled: boolean,
  certificate: { source: "self-signed" | "configured"; hostname: string | undefined },
): "off" | "needs-certificate" | "on" {
  if (!sidecarProxyEnabled) return "off";
  if (certificate.source !== "configured" || certificate.hostname === undefined) {
    return "needs-certificate";
  }
  return "on";
}

/**
 * Rule 1: defence in depth behind `config.ts`'s own validator, and the
 * setTimeout-overflow guard the M3->M4 handover asked for. `0`/absent is
 * always valid ("never"); anything else must be a finite integer in
 * `1...IDLE_DISABLE_MAX_MINUTES` or it is treated as `0` and logged once —
 * in particular this is what keeps a non-finite value (`NaN`, `Infinity`)
 * from ever reaching `deps.timers.setTimeout` as a delay.
 */
function resolveIdleDisableMinutes(raw: number | undefined, log: (line: string) => void): number {
  if (raw === undefined) return 0;
  if (Number.isInteger(raw) && raw >= 0 && raw <= IDLE_DISABLE_MAX_MINUTES) return raw;
  log("bridge: idleDisableMinutes ignored");
  return 0;
}

export async function createBridge(deps: BridgeDeps): Promise<Bridge> {
  const auditLog = createAuditLog({
    fs: deps.fs,
    path: join(deps.dir, "audit.log"),
    now: deps.now,
    enforceFileModes: deps.enforceFileModes,
    onError: (detail) => deps.log(`bridge: audit log failed: ${detail}`),
  });

  const devices = createDeviceStore({
    fs: deps.fs,
    path: join(deps.dir, "devices.json"),
    random: deps.random,
    now: deps.now,
    enforceFileModes: deps.enforceFileModes,
    log: deps.log,
  });

  const owner = createOwnerStore({
    fs: deps.fs,
    path: join(deps.dir, "owner.json"),
    random: deps.random,
    now: deps.now,
    enforceFileModes: deps.enforceFileModes,
    ...(deps.ownerHashParams !== undefined ? { hashParams: deps.ownerHashParams } : {}),
  });

  // Rule 5: one registry for this bridge's whole lifetime, emptied (never
  // recreated) on every device revoke, listener teardown/restart and stop —
  // see the `sidecarRegistry.clear()`/`revokeDevice()` calls below.
  const sidecarRegistry = createSidecarRegistry({ random: deps.random, now: deps.now });

  let devicesReadable = true;
  let problem: RemoteProblem | undefined;
  // A failed `setPush` leaves the new record in memory so the caller can
  // retry it. This marker defers its audit line until a later call makes the
  // registration durable, even though that retry is value-identical.
  const unsavedPushRegistrations = new Set<string>();

  try {
    await devices.load();
  } catch (error) {
    devicesReadable = false;
    problem = "devices-unreadable";
    deps.log(`bridge: devices.load failed: ${describeError(error)}`);
    auditLog.record({ kind: "error", detail: describeError(error) });
  }

  let ownerReadable = true;
  try {
    await owner.load();
  } catch (error) {
    ownerReadable = false;
    problem ??= "owner-unreadable";
    deps.log(`bridge: owner.load failed: ${describeError(error)}`);
    auditLog.record({ kind: "error", detail: describeError(error) });
  }
  const sessions = createSessionStore({
    fs: deps.fs,
    path: join(deps.dir, "sessions.json"),
    random: deps.random,
    now: deps.now,
    enforceFileModes: deps.enforceFileModes,
  });
  // Loaded before anything can issue or refresh a token: the first write
  // would otherwise replace sessions.json with only the new records.
  let sessionsReadable = true;
  try {
    await sessions.load();
  } catch (error) {
    sessionsReadable = false;
    problem ??= "sessions-unreadable";
    deps.log(`bridge: sessions.load failed: ${describeError(error)}`);
    auditLog.record({ kind: "error", detail: describeError(error) });
  }

  const notifyDesktop = (...notice: [kind: DesktopNoticeKind, deviceName?: string]): void =>
    deps.notifyDesktop?.(...notice);
  // Bumped on every remote owner-account change; carried in RemoteStatus.
  let ownerVersion = 0;
  const ownerAuth = createOwnerAuth({
    owner,
    sessions,
    random: deps.random,
    now: deps.now,
    // The relying party is the configured certificate's DNS name — never a
    // self-signed one's, which no browser would accept for WebAuthn.
    rpId: () =>
      listening?.certificate.source === "configured" ? listening.certificate.hostname : undefined,
    webOrigin: () => deps.webOrigin?.(),
    onPasskeyAdded() {
      ownerVersion += 1;
      emit();
    },
    removePasskey: (credentialId) => deletePasskey(credentialId),
    audit: auditLog,
    log: deps.log,
    lockFamily(familyId, reason) {
      hub.lockFamily(familyId, reason);
    },
    // In memory only: a restart forgets every failure count and lockout.
    limits: createLoginLimits({
      now: deps.now,
      audit: auditLog,
      notifyDesktop,
      deviceName: (deviceId) => devices.list().find((device) => device.id === deviceId)?.name,
      log: deps.log,
    }),
    notifyDesktop,
  });

  // Owner-account changes (set/change password, passkey delete) run one at
  // a time: a change verifies the current password and then replaces it,
  // and two of those interleaving could both pass the check.
  let ownerQueue: Promise<unknown> = Promise.resolve();

  // No default: "the bind address comes only from config" — until the first
  // `apply()`, there is no config at all, so nothing here ever holds a
  // literal address of its own to fall back on.
  let config: BridgeConfig | undefined;
  let stopped = false;
  let pairSessions = 0;
  let listener: Listener | undefined;
  let listenerKey: string | undefined;
  let listening: ListeningInfo | undefined;
  // Controller ruling (Task 2 fix round 1): the proxy bound to the
  // *current* listener, so `revoke()` can close a revoked device's live
  // proxied sockets (an already-piped upgrade, an in-flight streamed
  // response) — `undefined` whenever nothing is listening or the gate
  // wasn't "on" for it, exactly mirroring `listening`.
  let currentProxy: SidecarProxy | undefined;
  let queue: Promise<void> = Promise.resolve();

  // M12 Task 1: the bridge's own idle timer. `idleSince` is set the moment
  // rule 2's three conditions all hold and cleared the moment any one of
  // them stops holding — never reset by anything else (rule 2/the
  // "unauthenticated socket"/"refused probe" bite-proof). `idleTimer`/
  // `idleDisableAt` mirror whatever `armIdleTimer()` last scheduled — never
  // more than one live handle (rule 3). `idleDisabled` is the latch that
  // makes `wanted` false once the timer has fired; `idleDisabledRecord` is
  // the persisted status `status()` reports afterwards (rule 5/6).
  let idleSince: number | undefined;
  let idleTimer: unknown;
  let idleDisableAt: number | undefined;
  let idleDisabled = false;
  let idleDisabledRecord: { at: number; afterMinutes: number } | undefined;
  let effectiveIdleMinutes = 0;

  function emit(): void {
    try {
      deps.onStatus(status());
    } catch (error) {
      // A throwing `onStatus` must never poison `step()`'s promise: `step`
      // is run through `reconcile()`'s queue, and every direct caller
      // (`apply`, `openPairing`, `revoke`, `stop`) awaits that same promise
      // — a rejection here would make an unrelated `apply()` reject too.
      deps.log(`bridge: onStatus threw: ${describeError(error)}`);
    }
  }

  function reconcile(): Promise<void> {
    queue = queue.then(step, step);
    return queue;
  }

  /** Rule 2's three conditions, read fresh every time — never cached. A
   *  `/pair` socket is not one of them (final review I1): until the window
   *  is open or confirming it has proven nothing, and counting it would let
   *  anyone on the network keep the port open forever. */
  function isIdleNow(): boolean {
    return (
      listening !== undefined &&
      hub.connectedDeviceIds().size === 0 &&
      pairing.status().kind === "closed"
    );
  }

  /** Rule 3: never more than one live handle. */
  function clearIdleTimer(): void {
    if (idleTimer !== undefined) {
      deps.timers.clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    idleDisableAt = undefined;
  }

  /**
   * Rule 3: arms (or re-arms) exactly one timer for `idleSince + N·60_000 −
   * now()`, clamped at 0, from the *current* `idleSince` — never resets
   * `idleSince` itself. A no-op (leaves nothing armed) while not idle or
   * while `effectiveIdleMinutes` is 0 (never).
   */
  function armIdleTimer(): void {
    clearIdleTimer();
    if (idleSince === undefined || effectiveIdleMinutes === 0) return;
    const disableAt = idleSince + effectiveIdleMinutes * 60_000;
    idleDisableAt = disableAt;
    idleTimer = deps.timers.setTimeout(fireIdleDisable, Math.max(0, disableAt - deps.now()));
  }

  /**
   * Called from every place that can change one of rule 2's three inputs:
   * the end of `step()` (`listening`), `onConnectionsChanged` (the hub's
   * connected-device count) and the pairing `onChange` callback by way of
   * `reconcile()` (pairing status). A `/pair` socket landing or settling
   * also calls it, harmlessly: `pairSessions` is not an input, so a socket
   * that never opens the window changes nothing. Never called from an auth
   * failure or a refused socket — those never touch any of the three inputs, so `idleSince` and
   * `disableAt` must not move for them either.
   */
  function checkIdle(): void {
    if (isIdleNow()) {
      if (idleSince === undefined) idleSince = deps.now();
      armIdleTimer();
    } else if (idleSince !== undefined) {
      idleSince = undefined;
      clearIdleTimer();
    }
  }

  /**
   * Rule 4. The timer has already fired (there is nothing left to clear),
   * so this only ever re-checks idleness for the race the rule describes —
   * a connection that landed between the check and this callback — and
   * does nothing in that case; whatever caused that already re-armed or
   * cleared through `checkIdle()` on its own.
   */
  function fireIdleDisable(): void {
    idleTimer = undefined;
    idleDisableAt = undefined;
    if (!isIdleNow()) return;
    idleDisabled = true;
    // Task 1 fix round 1 (controller ruling, minor 2): captured *before*
    // the awaited `reconcile()`, not read back out of `effectiveIdleMinutes`
    // once it resolves — a concurrent `apply()` landing during that await
    // could otherwise change `effectiveIdleMinutes` out from under this
    // callback, recording a minute count that was never the one that
    // actually fired. The `.then` itself is guarded the same way: a
    // `stop()` or an `apply()` that reset `idleDisabled` while `reconcile()`
    // was still in flight means this firing no longer holds, and must
    // write nothing.
    const afterMinutes = effectiveIdleMinutes;
    reconcile()
      .catch((error: unknown) => deps.log(`bridge: reconcile failed: ${describeError(error)}`))
      .then(() => {
        if (stopped || !idleDisabled) return;
        auditLog.record({ kind: "idle-disabled", afterMinutes });
        idleDisabledRecord = { at: deps.now(), afterMinutes };
        emit();
        try {
          deps.onIdleDisabled?.();
        } catch (error) {
          deps.log(`bridge: onIdleDisabled threw: ${describeError(error)}`);
        }
      });
  }

  /**
   * The only place the gate (rule 3) is evaluated. Serialised via `queue`
   * (`reconcile`, above) so a listener never gets opened and closed out of
   * order by two calls racing each other.
   */
  async function step(): Promise<void> {
    const host = config === undefined ? undefined : canonicalAddress(config.bindAddress);

    // Rule 5 / ruling P9: the transient half of `problem` (bad-address, or
    // clear) is recomputed fresh every step; the four sticky values (an
    // unreadable devices file, a write failure from `revoke`, or a
    // listen/certificate failure from below) are left exactly as their own
    // caller set them — this baseline must never clobber one of those.
    if (!isStickyProblem(problem)) {
      const active = (config?.enabled ?? false) && !stopped;
      problem = !active
        ? undefined
        : !owner.hasPassword()
          ? "no-owner-password"
          : host === undefined
            ? "bad-address"
            : undefined;
    }

    const wanted =
      config !== undefined &&
      !stopped &&
      config.enabled &&
      !idleDisabled &&
      devicesReadable &&
      ownerReadable &&
      sessionsReadable &&
      owner.hasPassword() &&
      host !== undefined &&
      (devices.count() > 0 || pairing.status().kind !== "closed" || pairSessions > 0);

    const desiredKey =
      wanted && config !== undefined && host !== undefined
        ? JSON.stringify([
            host,
            config.port,
            config.tls.certPath ?? null,
            config.tls.keyPath ?? null,
            config.sidecarProxy,
          ])
        : undefined;

    if (desiredKey !== listenerKey) {
      const oldListener = listener;
      listener = undefined;
      listening = undefined;
      listenerKey = undefined;
      currentProxy = undefined;
      if (oldListener !== undefined) {
        hub.closeAll(CLOSE.goingAway);
        // Rule 5: every live sidecar handle dies with the listener it was
        // published under — before the listener itself actually closes.
        const clearedCount = sidecarRegistry.count();
        sidecarRegistry.clear();
        if (clearedCount > 0) {
          auditLog.record({ kind: "sidecars-cleared", count: clearedCount });
        }
        try {
          await oldListener.close();
        } catch (error) {
          // A rejecting `close()` must not make `step()` (and so
          // `reconcile()`, and so every awaited public method) reject —
          // the listener is being torn down regardless; only where the
          // failure went is worth telling the operator about.
          deps.log(`bridge: listener.close failed: ${describeError(error)}`);
        }
        auditLog.record({ kind: "stopped" });
      }

      if (wanted && config !== undefined && host !== undefined) {
        let material: CertificateMaterial;
        try {
          material = await deps.loadCertificate({
            certPath: config.tls.certPath,
            keyPath: config.tls.keyPath,
          });
        } catch (error) {
          problem = "certificate-failed";
          deps.log(`bridge: loadCertificate failed: ${describeError(error)}`);
          pairing.cancel();
          checkIdle();
          emit();
          return;
        }

        // Final review, I2: the first *plain* hostname, not the first SAN —
        // a wildcard (`*.example.com`) or single-label (`localhost`) first
        // entry is not something `parsePairingUri` (@jarvis/wire) can parse
        // back out of a pairing link's `name`, so using it unfiltered here
        // would make the gate say "on" and Settings say "real certificate"
        // for a link the phone can't actually parse.
        const certificateInfo = {
          source: material.source,
          hostname: material.dnsNames.find(isHostname),
        };
        // Rule 5's last sentence: `createProxy` is only ever called when the
        // gate would be "on" for *this* material/config — never "to be safe".
        const proxy =
          computeSidecarGate(config.sidecarProxy, certificateInfo) === "on"
            ? deps.createProxy(sidecarRegistry)
            : undefined;

        let newListener: Listener;
        try {
          newListener = await deps.listen({
            host,
            port: config.port,
            cert: material.cert,
            key: material.key,
            proxy,
            onSocket,
            log: deps.log,
          });
        } catch (error) {
          problem = "listen-failed";
          deps.log(`bridge: listen failed: ${describeError(error)}`);
          pairing.cancel();
          checkIdle();
          emit();
          return;
        }

        listener = newListener;
        listenerKey = desiredKey;
        currentProxy = proxy;
        listening = {
          host,
          port: newListener.port,
          fingerprint: material.fingerprint,
          certificate: certificateInfo,
        };
        // A successful listen clears a sticky listen/certificate problem
        // from an earlier attempt (ruling P9) — but never a devices-* one,
        // which a successful listen says nothing about.
        if (problem === "listen-failed" || problem === "certificate-failed") {
          problem = undefined;
        }
        auditLog.record({
          kind: "listening",
          host,
          port: newListener.port,
          fingerprintTail: material.fingerprint.slice(-4),
        });
      }
    }

    checkIdle();
    emit();
  }

  function onSocket(
    kind: "rpc" | "pair",
    socket: SocketLike,
    remoteAddress: string,
  ): SessionHandlers {
    const source = canonicalAddress(remoteAddress) ?? remoteAddress;
    return hub.accept(kind, socket, source);
  }

  const pairing = createPairing({
    random: deps.random,
    now: deps.now,
    timers: deps.timers,
    onChange(_status, change) {
      if (change === "expired" || change === "cancelled") {
        auditLog.record({ kind: "pairing-closed", reason: change });
      }
      reconcile().catch((error: unknown) =>
        deps.log(`bridge: reconcile failed: ${describeError(error)}`),
      );
    },
  });

  const hub = createHub({
    now: deps.now,
    timers: deps.timers,
    authenticate(id, token) {
      // Rule 2: only `{ id, name }` ever reaches a request handler — never
      // the full `DeviceSummary` (which also carries `pairedAt`/`lastSeenAt`).
      const found = devices.authenticate(id, token);
      return found === undefined ? undefined : { id: found.id, name: found.name };
    },
    handle: deps.handle,
    policies: deps.policies,
    authorizeKey: deps.authorizeKey,
    blobLimit: deps.blobLimit,
    errorText: deps.errorText,
    log: deps.log,
    audit: auditLog,
    auditPolicy: deps.auditPolicy,
    ownerAuth,
    onLock(deviceId) {
      teardownDeviceSidecars(deviceId);
    },
    touch(id) {
      devices
        .touch(id)
        .then(emit, (error: unknown) =>
          deps.log(`bridge: devices.touch failed: ${describeError(error)}`),
        );
    },
    onConnectionsChanged() {
      checkIdle();
      emit();
    },
    onDeviceDisconnected(deviceId) {
      deps.onDeviceDisconnected(deviceId);
    },
    pairSession(socket, source, onFailure) {
      pairSessions += 1;
      checkIdle();
      return createPairSession(socket, {
        pairing,
        devices,
        audit: auditLog,
        timers: deps.timers,
        source,
        log: deps.log,
        onFailure: (_reason) => onFailure(),
        onSettled() {
          pairSessions -= 1;
          reconcile().catch((error: unknown) =>
            deps.log(`bridge: reconcile failed: ${describeError(error)}`),
          );
        },
      });
    },
  });

  /**
   * Rule 4, read back from the already-`listening` record rather than a
   * freshly-loaded certificate. Final review, M5: the gate can compute "on"
   * for the certificate/config the *next* listener will use while
   * `currentProxy` — the proxy actually bound to the listener that is up
   * right now — is still `undefined` (the window between `apply()` writing
   * `sidecarProxy: true` and `step()`'s restart landing). `status()` must
   * never claim "on" for a listener with no live proxy, so it falls back to
   * "needs-certificate" for exactly that window.
   */
  function sidecarProxyStatus(): "off" | "needs-certificate" | "on" {
    const enabled = config?.sidecarProxy ?? false;
    if (!enabled) return "off";
    if (listening === undefined) return "needs-certificate";
    const gate = computeSidecarGate(enabled, listening.certificate);
    if (gate === "on" && currentProxy === undefined) return "needs-certificate";
    return gate;
  }

  /** Rule 6: `armed` while a timer is live, else the persisted `disabled` record, else `undefined`. */
  function idleStatusValue(): RemoteIdleStatus | undefined {
    if (idleTimer !== undefined && idleDisableAt !== undefined) {
      return { kind: "armed", disableAt: idleDisableAt };
    }
    return idleDisabledRecord === undefined
      ? undefined
      : {
          kind: "disabled",
          at: idleDisabledRecord.at,
          afterMinutes: idleDisabledRecord.afterMinutes,
        };
  }

  function status(): RemoteStatus {
    const pairingStatus = pairing.status();
    let remotePairing: RemotePairingStatus;
    if (pairingStatus.kind === "confirming") {
      remotePairing = pairingStatus;
    } else if (pairingStatus.kind === "open" && listening !== undefined) {
      remotePairing = {
        kind: "open",
        uri: formatPairingUri({
          host: listening.host,
          port: listening.port,
          secret: pairingStatus.secret,
          fingerprint: listening.fingerprint,
          // Ruling 1/rule 7: `name` rides along only when the served
          // certificate is a configured one carrying a DNS SAN — the same
          // condition that makes the sidecar gate anything but "off".
          ...(listening.certificate.hostname !== undefined
            ? { name: listening.certificate.hostname }
            : {}),
        }),
        expiresAt: pairingStatus.expiresAt,
      };
    } else {
      // Rule 10: pairing reads as "open" only while a listener is actually
      // up — if it failed after `openPairing` opened the window, that flow
      // cancels the window anyway, but a step in between must still report
      // "closed" rather than a link nobody can reach.
      remotePairing = { kind: "closed" };
    }

    const connected = hub.connectedDeviceIds();
    const deviceStatuses: RemoteDeviceStatus[] = devices.list().map((device) => ({
      id: device.id,
      name: device.name,
      pairedAt: device.pairedAt,
      lastSeenAt: device.lastSeenAt,
      connected: connected.has(device.id),
      ...(device.push !== undefined ? { push: device.push } : {}),
    }));

    return {
      enabled: (config?.enabled ?? false) && !stopped && !idleDisabled,
      listening,
      pairing: remotePairing,
      devices: deviceStatuses,
      problem,
      sidecarProxy: sidecarProxyStatus(),
      idle: idleStatusValue(),
      ownerVersion,
    };
  }

  async function apply(newConfig: BridgeConfig): Promise<void> {
    if (stopped) return;
    // Ruling P9: a sticky listen/certificate problem is cleared at the
    // start of the next `apply()`, so a fresh attempt starts clean — but a
    // devices-* problem is untouched; nothing about a new config fixes an
    // unreadable file or a stuck write.
    if (problem === "listen-failed" || problem === "certificate-failed") {
      problem = undefined;
    }
    // Rule 5: the latch clears at the start of every apply — the config's
    // own `enabled` decides `wanted` from here on, not a stale firing from
    // before. The persisted `idle: "disabled"` record is a separate thing
    // (rule 5's next sentence): it survives an `enabled: false` apply and
    // is cleared only by one with `enabled: true`, or by `stop()`.
    idleDisabled = false;
    effectiveIdleMinutes = resolveIdleDisableMinutes(newConfig.idleDisableMinutes, deps.log);
    if (newConfig.enabled) idleDisabledRecord = undefined;
    config = {
      enabled: newConfig.enabled,
      bindAddress: newConfig.bindAddress,
      port: newConfig.port,
      sidecarProxy: newConfig.sidecarProxy,
      tls: {
        ...(newConfig.tls.certPath !== undefined ? { certPath: newConfig.tls.certPath } : {}),
        ...(newConfig.tls.keyPath !== undefined ? { keyPath: newConfig.tls.keyPath } : {}),
      },
    };
    if (!config.enabled) pairing.cancel();
    await reconcile();
  }

  async function openPairing(): Promise<PairingResult> {
    if (stopped || config === undefined || !config.enabled) return "disabled";
    if (!devicesReadable) return "unavailable";

    const { expiresAt } = pairing.open();
    auditLog.record({ kind: "pairing-opened", expiresAt });
    await reconcile();

    if (listening === undefined) {
      pairing.cancel();
      await reconcile();
      return "unavailable";
    }
    return "opened";
  }

  function cancelPairing(): void {
    pairing.cancel();
  }

  function decidePairing(requestId: string, approve: boolean): boolean {
    return pairing.decide(requestId, approve);
  }

  /**
   * Rule 5: a device's sidecar handles die before its live sidecar sockets
   * do. Controller ruling (Task 2 fix round 1): an already-piped upgrade or
   * a still-streaming response must die with its handle, not linger until
   * the phone drops it or the listener restarts. Used by revoke (before
   * `hub.closeDevice`, per the ruling's ordering) and by every lock (Phase
   * 0: sidecars follow the session). Returns the sidecar sockets closed.
   */
  function teardownDeviceSidecars(deviceId: string): number {
    const clearedCount = sidecarRegistry.revokeDevice(deviceId);
    if (clearedCount > 0) {
      auditLog.record({ kind: "sidecars-cleared", count: clearedCount });
    }
    return currentProxy?.closeDevice(deviceId) ?? 0;
  }

  async function revoke(deviceId: string): Promise<boolean> {
    unsavedPushRegistrations.delete(deviceId);
    const written = devices.revoke(deviceId);
    // Phase 0: the device's refresh tokens go with it (gone from memory now;
    // the write is awaited below).
    const sessionsRevoked = sessions.revokeDevice(deviceId);
    const closedSidecarSockets = teardownDeviceSidecars(deviceId);
    const closed = hub.closeDevice(deviceId, CLOSE.revoked);
    try {
      await sessionsRevoked;
    } catch (error) {
      deps.log(`bridge: sessions.revokeDevice failed: ${describeError(error)}`);
    }
    let ok: boolean;
    try {
      ok = await written;
    } catch (error) {
      problem = "devices-write-failed";
      deps.log(`bridge: devices.revoke failed: ${describeError(error)}`);
      ok = false;
    }
    auditLog.record({ kind: "revoked", deviceId, closedSockets: closed, closedSidecarSockets });
    await reconcile();
    return ok;
  }

  /**
   * M10 rule 6: `devices.setPush` answers "ok" whether or not it actually
   * wrote anything (an identical re-registration is a no-op on its side) —
   * this is the one place that needs to know which, so `pushTargets()` is
   * read before the call and compared, purely to decide whether to audit.
   * A failed persistence attempt is remembered until its identical retry
   * succeeds, which is when the audit record can truthfully be written.
   */
  async function setPushToken(
    deviceId: string,
    push: Omit<DevicePush, "registeredAt">,
  ): Promise<"ok" | "unknown-device" | "write-failed"> {
    const beforeTargets = devices.pushTargets();
    const before = beforeTargets.find((target) => target.deviceId === deviceId);
    const changed =
      before === undefined ||
      before.token !== push.token ||
      before.platform !== push.platform ||
      before.language !== push.language;

    function auditSuperseded(): void {
      const superseded = beforeTargets.filter(
        (target) =>
          target.deviceId !== deviceId &&
          target.token === push.token &&
          !devices.pushTargets().some((current) => current.deviceId === target.deviceId),
      );
      for (const target of superseded) {
        auditLog.record({ kind: "push-cleared", deviceId: target.deviceId, reason: "superseded" });
      }
    }

    let result: "ok" | "unknown-device";
    try {
      result = await devices.setPush(deviceId, { ...push, registeredAt: deps.now() });
    } catch {
      auditSuperseded();
      unsavedPushRegistrations.add(deviceId);
      problem = "devices-write-failed";
      deps.log("bridge: devices.setPush failed");
      return "write-failed";
    }
    if (result === "unknown-device") {
      unsavedPushRegistrations.delete(deviceId);
      return "unknown-device";
    }
    auditSuperseded();
    const wasUnsaved = unsavedPushRegistrations.delete(deviceId);
    if (changed || wasUnsaved) {
      auditLog.record({ kind: "push-registered", deviceId, platform: push.platform });
      emit();
    }
    return "ok";
  }

  async function clearPushToken(
    deviceId: string,
    reason: "unregistered" | "not-registered",
  ): Promise<boolean> {
    const hadToken = devices.pushTargets().some((target) => target.deviceId === deviceId);
    unsavedPushRegistrations.delete(deviceId);
    try {
      await devices.setPush(deviceId, undefined);
    } catch {
      problem = "devices-write-failed";
      deps.log("bridge: devices.setPush failed");
      return false;
    }
    if (!hadToken) return false;
    auditLog.record({ kind: "push-cleared", deviceId, reason });
    emit();
    return true;
  }

  function pushTargets(): ReturnType<DeviceStore["pushTargets"]> {
    return devices.pushTargets();
  }

  /**
   * Rule 6: `pushKind` is a wire `PushKind` enum upstream, so there is
   * nothing to validate about its *shape* here — but the bridge is the
   * audit log's last line of defense, not a place that trusts its caller.
   * Fix round 1 (review minor): a `pushKind` over `PUSH_KIND_MAX_CHARS` is
   * refused outright (one log line, nothing recorded) rather than
   * truncated — a truncated enum value would be a more confusing audit
   * line than none at all.
   */
  function recordPushQueued(deviceId: string, pushKind: string): void {
    if (pushKind.length > PUSH_KIND_MAX_CHARS) {
      deps.log(`bridge: recordPushQueued pushKind too long (${pushKind.length} chars), dropped`);
      return;
    }
    auditLog.record({ kind: "push-queued", deviceId, pushKind });
  }

  /** M10 rule 6: the empty set unless a listener is actually up — a phone can hold no live subscription without one (mirrors `hasSubscriber`). */
  function watchingDevices(channel: string, key?: string): ReadonlySet<string> {
    if (listening === undefined) return new Set();
    return hub.watchingDevices(channel, key);
  }

  /**
   * Rule 6: `off`/`needs-certificate` mirror `status().sidecarProxy`
   * exactly; `not-listening` is this function's own, finer-grained split of
   * what `status()` folds into "needs-certificate" — a caller (Task 4's
   * desktop) that wants to tell "connect over Tailscale" apart from "the
   * bridge isn't up right now" needs the two distinguished, even though the
   * phone-facing status field doesn't.
   */
  function publishSidecar(
    deviceId: string,
    target: SidecarTarget,
  ):
    | { url: string }
    | {
        unavailable: "off" | "needs-certificate" | "not-listening" | "unknown-device" | "locked";
      } {
    const sidecarProxyEnabled = config?.sidecarProxy ?? false;
    if (!sidecarProxyEnabled) return { unavailable: "off" };
    if (listening === undefined) return { unavailable: "not-listening" };
    if (computeSidecarGate(sidecarProxyEnabled, listening.certificate) !== "on") {
      return { unavailable: "needs-certificate" };
    }
    // Final review, M5: the gate above is "on" for the certificate/config
    // this listener was started with, but the listener actually up right
    // now might still be the one *before* `sidecarProxy` flipped to true —
    // `currentProxy` is the one source of truth for "a proxy really is
    // bound to the live listener", mirroring `sidecarProxyStatus()`.
    if (currentProxy === undefined) return { unavailable: "not-listening" };
    if (!devices.list().some((device) => device.id === deviceId)) {
      return { unavailable: "unknown-device" };
    }
    // A handle is only ever minted for a logged-in device: a request that
    // was admitted before its connection locked must not leave one behind.
    if (!hub.hasUnlockedConnection(deviceId)) return { unavailable: "locked" };

    const { handle, key } = sidecarRegistry.publish(deviceId, target);
    auditLog.record({
      kind: "sidecar-published",
      deviceId,
      sidecar: target.kind,
      handleTail: handle.slice(-4),
    });
    return { url: `/s/${handle}/?k=${key}` };
  }

  function push(channel: string, payload: unknown): void {
    hub.push(channel, payload);
  }

  /** False while not listening (rule 8) — a phone can hold no subscription without a live socket. */
  function hasSubscriber(channel: string): boolean {
    return listening !== undefined && hub.hasSubscriber(channel);
  }

  /**
   * The one place every owner-credential invalidation (spec rule 8)
   * converges: a password change, a passkey delete, "Sign out everywhere".
   * Synchronously: a login or refresh still in flight is refused, every
   * access token and refresh token is gone from memory, every open
   * connection is locked (its socket left open), and every device's sidecar
   * handles and live sidecar sockets are destroyed. Only the sessions.json
   * write lands later.
   */
  function invalidateOwnerSessions(
    reason: "password-changed" | "passkey-deleted" | "signed-out-everywhere",
  ): void {
    ownerAuth.invalidate();
    auditLog.record({ kind: "signed-out-all", reason });
    sessions.revokeAll().catch((error: unknown) => {
      deps.log(`bridge: sessions.revokeAll failed: ${describeError(error)}`);
    });
    hub.lockAll("signed-out");
    const clearedCount = sidecarRegistry.count();
    sidecarRegistry.clear();
    if (clearedCount > 0) {
      auditLog.record({ kind: "sidecars-cleared", count: clearedCount });
    }
    for (const device of devices.list()) currentProxy?.closeDevice(device.id);
  }

  function ownerStatus(): OwnerStatus {
    return {
      hasPassword: owner.hasPassword(),
      passkeys: owner.listPasskeys().map((record) => ({
        id: record.credentialId,
        label: record.label,
        createdAt: record.createdAt,
      })),
    };
  }

  function queueOwnerChange<T>(change: () => Promise<T>): Promise<T> {
    const task = ownerQueue.then(change, change);
    ownerQueue = task.catch(() => undefined);
    return task;
  }

  function setOwnerPassword(
    current: string | undefined,
    next: string,
  ): Promise<SetOwnerPasswordResult> {
    return queueOwnerChange(async (): Promise<SetOwnerPasswordResult> => {
      if (stopped || !ownerReadable) return { ok: false, code: "unavailable" };
      const hadPassword = owner.hasPassword();
      if (hadPassword) {
        if (current === undefined || current === "") {
          return { ok: false, code: "current-required" };
        }
        if (!(await owner.verifyPassword(current))) return { ok: false, code: "current-wrong" };
      }
      let result: Awaited<ReturnType<typeof owner.setPassword>>;
      try {
        result = await owner.setPassword(next);
      } catch {
        // Fixed text only: nothing thrown from a call that held the
        // password is ever interpolated into a log line.
        deps.log("bridge: owner.setPassword failed");
        return { ok: false, code: "write-failed" };
      }
      if (result !== "ok") return { ok: false, code: result };
      auditLog.record({ kind: hadPassword ? "owner-password-changed" : "owner-password-set" });
      if (hadPassword) invalidateOwnerSessions("password-changed");
      // A first password is what lets an already-enabled bridge listen.
      await reconcile();
      return { ok: true };
    });
  }

  function deletePasskey(credentialId: string): Promise<boolean> {
    return queueOwnerChange(async () => {
      if (!owner.listPasskeys().some((record) => record.credentialId === credentialId)) {
        return false;
      }
      let ok = true;
      try {
        await owner.deletePasskey(credentialId);
      } catch (error) {
        deps.log(`bridge: owner.deletePasskey failed: ${describeError(error)}`);
        ok = false;
      }
      auditLog.record({ kind: "passkey-deleted", credentialTail: credentialId.slice(-4) });
      invalidateOwnerSessions("passkey-deleted");
      return ok;
    });
  }

  async function signOutEverywhere(): Promise<void> {
    auditLog.record({ kind: "signed-out-everywhere" });
    invalidateOwnerSessions("signed-out-everywhere");
  }

  async function stop(): Promise<void> {
    stopped = true;
    // Rule 7: the timer is cleared before the listener closes — never left
    // armed for `step()`'s teardown (below, via `reconcile()`) to race
    // against. `onIdleDisabled` must never fire from `stop()`, so this is a
    // direct clear, not a `checkIdle()` call. Rule 5: `stop()` also clears
    // the persisted "disabled" record.
    clearIdleTimer();
    idleSince = undefined;
    idleDisabledRecord = undefined;
    pairing.cancel();
    // M4: rule 5 says the registry is cleared "in stop()" — this already
    // happens transitively (the reconcile() below drives step() into its
    // teardown branch, which clears it), but a direct call here makes that
    // hold on its own terms rather than depending on step()'s branching.
    const clearedCount = sidecarRegistry.count();
    sidecarRegistry.clear();
    if (clearedCount > 0) {
      auditLog.record({ kind: "sidecars-cleared", count: clearedCount });
    }
    await reconcile();
    // reconcile()'s step() above records "stopped" (and any last
    // "disconnected" lines from hub.closeAll) and may have queued a final
    // devices.touch/revoke write — all fire-and-forget, so step() itself
    // resolves without waiting for any of them to actually land on disk.
    // A caller that deletes this bridge's directory right after stop() (the
    // integration test's own teardown) would otherwise race those writes —
    // this is the fix for that carry-over.
    await auditLog.flushed();
    await devices.flushed();
    await owner.flushed();
    await sessions.flushed();
  }

  return {
    apply,
    openPairing,
    cancelPairing,
    decidePairing,
    revoke,
    publishSidecar,
    push,
    hasSubscriber,
    setPushToken,
    clearPushToken,
    pushTargets,
    recordPushQueued,
    watchingDevices,
    status,
    ownerStatus,
    setOwnerPassword,
    deletePasskey,
    signOutEverywhere,
    stop,
  };
}
