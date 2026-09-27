// The owner-login brute-force policy (Phase 0), behind owner-auth.ts's
// `LoginLimits` seam. Two throttles, both pure over an injected `Clock`:
//
// - Per device: after 5 failed attempts the device is locked out for 60 s;
//   every further failure (once that lockout has passed) locks it out
//   again for twice as long, capped at 1 hour. A success resets it.
// - Global: 20 failures across all devices within a rolling hour refuse
//   every login for 15 minutes and notify the desktop.
//
// State is in memory only: a restart forgets every count and lockout.
// Devices are paired devices (authenticated before any auth:* request), so
// the per-device map is bounded by the paired-device count.

import type { AuditEvent } from "./audit.js";
import type { Clock } from "./io.js";
import type { DesktopNoticeKind, LoginLimits } from "./owner-auth.js";

export const DEVICE_FAILURES_BEFORE_LOCKOUT = 5;
export const DEVICE_LOCKOUT_BASE_MS = 60_000;
export const DEVICE_LOCKOUT_MAX_MS = 60 * 60_000;
export const GLOBAL_FAILURE_LIMIT = 20;
export const GLOBAL_FAILURE_WINDOW_MS = 60 * 60_000;
export const GLOBAL_LOCKOUT_MS = 15 * 60_000;

export type LoginLimitsDeps = {
  now: Clock;
  audit: { record(event: AuditEvent): void };
  notifyDesktop(kind: DesktopNoticeKind): void;
  log?(line: string): void;
};

type DeviceEntry = { failures: number; blockedUntil: number };

export function createLoginLimits(deps: LoginLimitsDeps): LoginLimits {
  const { now } = deps;
  const log = deps.log ?? (() => {});
  const devices = new Map<string, DeviceEntry>();
  // Failure times within the rolling window, oldest first; never longer
  // than GLOBAL_FAILURE_LIMIT.
  const failureStamps: number[] = [];
  let globalBlockedUntil = 0;

  function record(event: AuditEvent): void {
    try {
      deps.audit.record(event);
    } catch {
      log("login-limits: audit record failed");
    }
  }

  function notify(kind: DesktopNoticeKind): void {
    try {
      deps.notifyDesktop(kind);
    } catch {
      log("login-limits: notifyDesktop failed");
    }
  }

  function failDevice(deviceId: string, source: string): void {
    const entry = devices.get(deviceId) ?? { failures: 0, blockedUntil: 0 };
    entry.failures += 1;
    devices.set(deviceId, entry);
    const over = entry.failures - DEVICE_FAILURES_BEFORE_LOCKOUT;
    if (over < 0) return;
    const lockout = Math.min(DEVICE_LOCKOUT_MAX_MS, DEVICE_LOCKOUT_BASE_MS * 2 ** over);
    entry.blockedUntil = now() + lockout;
    record({ kind: "locked-out", deviceId, source, scope: "device" });
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

  return {
    allow(deviceId) {
      const at = now();
      if (at < globalBlockedUntil) return false;
      const entry = devices.get(deviceId);
      return entry === undefined || at >= entry.blockedUntil;
    },

    failed(deviceId, source) {
      failDevice(deviceId, source);
      failGlobally(deviceId, source);
    },

    succeeded(deviceId) {
      devices.delete(deviceId);
    },
  };
}
