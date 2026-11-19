// The password-join brute-force policy, separate from the owner-login
// limiter (login-limits.ts) so failed joins can never lock out paired
// devices. One bucket shared by every source, pure over an injected `Clock`:
// after 5 failed joins every join is refused for 60 s; every further failure
// (once that lockout has passed) refuses them again for twice as long, capped
// at 1 hour. A success resets it. `source` only names the caller on audit
// lines: it never picks a bucket, so spreading guesses across addresses buys
// nothing.
//
// Every attempt a lockout refuses is coalesced into one `join-refused` line
// per REFUSED_AUDIT_WINDOW_MS, carrying the window's count and its latest
// source, so a flood cannot push older evidence out of the rotating audit
// log. The line is written by the first limits call after the window closes
// (there is no timer).
//
// State is in memory only: a restart forgets the count, the lockout and any
// not-yet-written refusal count.

import type { AuditEvent } from "./audit.js";
import type { Clock } from "./io.js";
import {
  DEVICE_FAILURES_BEFORE_LOCKOUT,
  DEVICE_LOCKOUT_BASE_MS,
  DEVICE_LOCKOUT_MAX_MS,
  REFUSED_AUDIT_WINDOW_MS,
} from "./login-limits.js";

export type JoinLimitsDeps = {
  now: Clock;
  audit: { record(event: AuditEvent): void };
};

export type JoinLimits = {
  /** False while locked out, which also counts as a refused attempt. */
  allow(source: string): boolean;
  failed(source: string): void;
  succeeded(): void;
};

type PendingRefusals = { source: string; count: number; flushAt: number };

export function createJoinLimits(deps: JoinLimitsDeps): JoinLimits {
  const { now } = deps;
  let failures = 0;
  let blockedUntil = 0;
  let pendingRefusals: PendingRefusals | undefined;

  function record(event: AuditEvent): void {
    try {
      deps.audit.record(event);
    } catch {
      // The audit line is evidence, never a reason to fail a join decision.
    }
  }

  function flushDueRefusals(): void {
    if (pendingRefusals === undefined || now() < pendingRefusals.flushAt) return;
    const { source, count } = pendingRefusals;
    pendingRefusals = undefined;
    record({ kind: "join-refused", source, count });
  }

  function refused(source: string): void {
    if (pendingRefusals !== undefined) {
      pendingRefusals.count += 1;
      pendingRefusals.source = source;
      return;
    }
    pendingRefusals = { source, count: 1, flushAt: now() + REFUSED_AUDIT_WINDOW_MS };
  }

  return {
    allow(source) {
      flushDueRefusals();
      if (now() >= blockedUntil) return true;
      refused(source);
      return false;
    },

    failed(source) {
      flushDueRefusals();
      failures += 1;
      record({ kind: "join-failed", source });
      const over = failures - DEVICE_FAILURES_BEFORE_LOCKOUT;
      if (over < 0) return;
      blockedUntil = now() + Math.min(DEVICE_LOCKOUT_MAX_MS, DEVICE_LOCKOUT_BASE_MS * 2 ** over);
    },

    succeeded() {
      flushDueRefusals();
      failures = 0;
      blockedUntil = 0;
    },
  };
}
