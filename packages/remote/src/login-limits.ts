// The owner-login brute-force policy (Phase 0), behind owner-auth.ts's
// `LoginLimits` seam. Two throttles, both pure over an injected `Clock`:
//
// - Per device: after 5 failed attempts the device is locked out for 60 s;
//   every further failure (once that lockout has passed) locks it out
//   again for twice as long, capped at 1 hour. A success resets it. The
//   desktop is notified (naming the device) at most once per device per
//   15 minutes, so escalations cannot spam it.
// - Global: 20 failures across all devices within a rolling hour refuse
//   every login for 15 minutes and notify the desktop.
//
// Every attempt a lockout refuses is audited as `login-refused`, coalesced
// so a flood cannot push older evidence out of the rotating audit log: at
// most one line per (device, scope) per 60 s window, carrying how many
// refusals the window saw. A window's line is written by the first limits
// call after the window closes or its lockout ends (there is no timer).
//
// State is in memory only: a restart forgets every count, lockout and
// not-yet-written refusal count. The per-device map drops entries whose
// lockout is over and whose last failure is over an hour old, and never
// holds more than MAX_TRACKED_LOGIN_DEVICES (evicting the least recently
// failed).

import type { AuditEvent } from "./audit.js";
import type { Clock } from "./io.js";
import type { DesktopNoticeKind, LoginLimits } from "./owner-auth.js";

export const DEVICE_FAILURES_BEFORE_LOCKOUT = 5;
export const DEVICE_LOCKOUT_BASE_MS = 60_000;
export const DEVICE_LOCKOUT_MAX_MS = 60 * 60_000;
export const GLOBAL_FAILURE_LIMIT = 20;
export const GLOBAL_FAILURE_WINDOW_MS = 60 * 60_000;
export const GLOBAL_LOCKOUT_MS = 15 * 60_000;
export const REFUSED_AUDIT_WINDOW_MS = 60_000;
export const DEVICE_FAILURE_MEMORY_MS = 60 * 60_000;
export const MAX_TRACKED_LOGIN_DEVICES = 1024;
export const DEVICE_LOCKOUT_NOTICE_INTERVAL_MS = 15 * 60_000;

export type LoginLimitsDeps = {
  now: Clock;
  audit: { record(event: AuditEvent): void };
  notifyDesktop(kind: DesktopNoticeKind, deviceName?: string): void;
  /** The paired device's name for the device-lockout notice. */
  deviceName?(deviceId: string): string | undefined;
  log?(line: string): void;
};

type DeviceEntry = { failures: number; blockedUntil: number; lastFailureAt: number };

type RefusalScope = "device" | "global" | "capacity";
type PendingRefusals = {
  deviceId: string;
  source: string;
  scope: RefusalScope;
  count: number;
  /** The window's end, or its lockout's end if that comes first. */
  flushAt: number;
};

export type LoginLimitsWithStats = LoginLimits & {
  /** Test-only: the device ids currently tracked, least recently failed first. */
  trackedDeviceIds(): string[];
};

export function createLoginLimits(deps: LoginLimitsDeps): LoginLimitsWithStats {
  const { now } = deps;
  const log = deps.log ?? (() => {});
  const devices = new Map<string, DeviceEntry>();
  const pendingRefusals = new Map<string, PendingRefusals>();
  // Failure times within the rolling window, oldest first; never longer
  // than GLOBAL_FAILURE_LIMIT.
  const failureStamps: number[] = [];
  let globalBlockedUntil = 0;
  // When each device's lockout last reached the desktop.
  const deviceNoticeAt = new Map<string, number>();

  function record(event: AuditEvent): void {
    try {
      deps.audit.record(event);
    } catch {
      log("login-limits: audit record failed");
    }
  }

  function notify(...notice: [kind: DesktopNoticeKind, deviceName?: string]): void {
    try {
      deps.notifyDesktop(...notice);
    } catch {
      log("login-limits: notifyDesktop failed");
    }
  }

  /** The desktop hears a device's lockout at most once per interval. */
  function notifyDeviceLockout(deviceId: string): void {
    const at = now();
    const last = deviceNoticeAt.get(deviceId);
    if (last !== undefined && at - last < DEVICE_LOCKOUT_NOTICE_INTERVAL_MS) return;
    for (const [id, noticeAt] of deviceNoticeAt) {
      if (at - noticeAt >= DEVICE_LOCKOUT_NOTICE_INTERVAL_MS) deviceNoticeAt.delete(id);
    }
    deviceNoticeAt.set(deviceId, at);
    let name: string | undefined;
    try {
      name = deps.deviceName?.(deviceId);
    } catch {
      log("login-limits: deviceName failed");
    }
    if (name === undefined) notify("locked-out-device");
    else notify("locked-out-device", name);
  }

  /** Writes every coalesced refusal count whose window or lockout is over. */
  function flushDueRefusals(): void {
    const at = now();
    for (const [key, pending] of pendingRefusals) {
      if (at < pending.flushAt) continue;
      pendingRefusals.delete(key);
      const { deviceId, source, scope, count } = pending;
      record({ kind: "login-refused", deviceId, source, scope, count });
    }
  }

  /** Forgets devices whose lockout is over and whose last failure is over an hour old. */
  function pruneDevices(): void {
    const at = now();
    for (const [deviceId, entry] of devices) {
      if (at >= entry.blockedUntil && entry.lastFailureAt <= at - DEVICE_FAILURE_MEMORY_MS) {
        devices.delete(deviceId);
      }
    }
  }

  function failDevice(deviceId: string, source: string): void {
    const previous = devices.get(deviceId);
    if (previous === undefined) pruneDevices();
    const entry = previous ?? { failures: 0, blockedUntil: 0, lastFailureAt: 0 };
    entry.failures += 1;
    entry.lastFailureAt = now();
    // Delete-then-set keeps the map in least-recently-failed order.
    devices.delete(deviceId);
    devices.set(deviceId, entry);
    if (devices.size > MAX_TRACKED_LOGIN_DEVICES) {
      const oldest = devices.keys().next().value;
      if (oldest !== undefined) devices.delete(oldest);
    }
    const over = entry.failures - DEVICE_FAILURES_BEFORE_LOCKOUT;
    if (over < 0) return;
    const lockout = Math.min(DEVICE_LOCKOUT_MAX_MS, DEVICE_LOCKOUT_BASE_MS * 2 ** over);
    entry.blockedUntil = now() + lockout;
    record({ kind: "locked-out", deviceId, source, scope: "device" });
    notifyDeviceLockout(deviceId);
  }

  function failGlobally(deviceId: string, source: string): void {
    const at = now();
    const cutoff = at - GLOBAL_FAILURE_WINDOW_MS;
    while (failureStamps.length > 0 && (failureStamps[0] as number) <= cutoff) {
      failureStamps.shift();
    }
    failureStamps.push(at);
    if (failureStamps.length > GLOBAL_FAILURE_LIMIT) failureStamps.shift();
    if (failureStamps.length < GLOBAL_FAILURE_LIMIT || at < globalBlockedUntil) return;
    globalBlockedUntil = at + GLOBAL_LOCKOUT_MS;
    record({ kind: "locked-out", deviceId, source, scope: "global" });
    notify("locked-out-global");
  }

  function lockoutEnd(deviceId: string, scope: RefusalScope): number {
    if (scope === "capacity") return Number.POSITIVE_INFINITY;
    return scope === "global" ? globalBlockedUntil : (devices.get(deviceId)?.blockedUntil ?? now());
  }

  return {
    allow(deviceId) {
      flushDueRefusals();
      const at = now();
      if (at < globalBlockedUntil) return false;
      const entry = devices.get(deviceId);
      return entry === undefined || at >= entry.blockedUntil;
    },

    failed(deviceId, source) {
      flushDueRefusals();
      failDevice(deviceId, source);
      failGlobally(deviceId, source);
    },

    succeeded(deviceId) {
      flushDueRefusals();
      devices.delete(deviceId);
    },

    refused(deviceId, source, reason) {
      flushDueRefusals();
      const at = now();
      const scope: RefusalScope =
        reason === "capacity" ? "capacity" : at < globalBlockedUntil ? "global" : "device";
      const key = `${scope}\u{0}${deviceId}`;
      const pending = pendingRefusals.get(key);
      if (pending !== undefined) {
        pending.count += 1;
        pending.source = source;
        return;
      }
      const flushAt = Math.min(at + REFUSED_AUDIT_WINDOW_MS, lockoutEnd(deviceId, scope));
      pendingRefusals.set(key, {
        deviceId,
        source,
        scope,
        count: 1,
        flushAt: Math.max(flushAt, at),
      });
    },

    trackedDeviceIds() {
      return [...devices.keys()];
    },
  };
}
