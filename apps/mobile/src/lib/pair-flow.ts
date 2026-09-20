// Pure decision logic pulled out of `app/pair.tsx` (Task 5 fix rounds 1-2,
// findings C1, I2/Important-2, Important-1): screens stay thin, so the "can
// a new pairing attempt start right now" guard, the link → confirm/needsHost
// transition, and the already-paired fail-closed decision all live here,
// testable without a React Native renderer.

import type { PairingLink } from "@jarvis/wire";
import { needsHost, withHost } from "./pairing";

export type PairFlowPhaseKind =
  | "checking"
  | "alreadyPaired"
  | "clearFailed"
  | "scan"
  | "needsHost"
  | "confirm"
  | "waiting"
  | "error"
  | "success";

/**
 * A new pairing attempt — from a scan, a pasted link, or a `jarvis://` deep
 * link — may only begin from the "scan" step, and never while a pairing
 * record already exists. Both are load-bearing:
 *
 * - the phase check stops a second, concurrent link from clobbering one
 *   already in flight (ruling C1c);
 * - the `alreadyPaired` check stops a tapped link from silently replacing
 *   an existing pairing (ruling C1a) — `jarvis://pair?...` resolves to this
 *   same screen through Expo Router's own `pair` route, whatever state the
 *   phone was already in, so the screen itself is the only place left to
 *   refuse it.
 */
export function canStartIntake(params: {
  alreadyPaired: boolean;
  phaseKind: PairFlowPhaseKind;
}): boolean {
  if (params.alreadyPaired) return false;
  return params.phaseKind === "scan";
}

/**
 * The last 4 hex characters of a fingerprint, for the confirm step (ruling
 * C1b) — enough for the user to recognise "yes, that's the code on my
 * laptop's screen" without ever showing (or the app needing to render) the
 * full 64-character value.
 */
export function fingerprintTail(fingerprint: string): string {
  return fingerprint.slice(-4);
}

/** The confirm step's display fields — host, port, the fingerprint's last 4
 * hex characters and (M11) the DNS `name` when the link is a system-trust
 * one. Never `secret`. */
export type ConfirmStep = {
  kind: "confirm";
  host: string;
  port: number;
  fingerprintTail: string;
  name?: string;
};

function toConfirmStep(link: PairingLink): ConfirmStep {
  const step: ConfirmStep = {
    kind: "confirm",
    host: link.host,
    port: link.port,
    fingerprintTail: fingerprintTail(link.fingerprint),
  };
  if (link.name !== undefined) {
    step.name = link.name;
  }
  return step;
}

export type IntakeStep = { kind: "needsHost" } | ConfirmStep;

/**
 * What a freshly parsed, valid `PairingLink` does next (Important-2,
 * ruling C1b): always a step that shows something to the user for
 * confirmation, never one that starts `pair()` — the type has no "start"
 * or "waiting" variant to return even by mistake, and the confirm variant
 * never carries `secret`.
 */
export function intakeStep(link: PairingLink): IntakeStep {
  if (needsHost(link)) {
    return { kind: "needsHost" };
  }
  return toConfirmStep(link);
}

export type HostStep = { kind: "invalid" } | ConfirmStep;

/**
 * What typing a host at the "needsHost" step does next: `withHost`'s
 * validation decides invalid vs confirm. Like `intakeStep`, the result
 * never signals "start" and never carries `secret`.
 */
export function hostStep(link: PairingLink, hostText: string): HostStep {
  const resolved = withHost(link, hostText);
  if (resolved === undefined) {
    return { kind: "invalid" };
  }
  return toConfirmStep(resolved);
}

/** The result of checking secure storage for an existing pairing record. */
export type AlreadyPairedCheck = { ok: true; paired: boolean } | { ok: false };

/**
 * Important-1: fail closed. A keychain read error must never be treated
 * as "not paired" — only a check that *succeeded* and found nothing is
 * allowed to unlock the scan step. A failed check always routes to
 * "checkFailed", regardless of whatever was known before.
 */
export function phaseAfterCheck(
  check: AlreadyPairedCheck,
): "scan" | "alreadyPaired" | "checkFailed" {
  if (!check.ok) return "checkFailed";
  return check.paired ? "alreadyPaired" : "scan";
}

/**
 * Fix round 2, I2 ruling: the phone can arrive at `/pair` because the
 * laptop unpaired it and `_layout.tsx`'s `onUnpaired` handler then failed
 * to clear the (still-present) record. That case must show a distinct
 * `clearFailed` phase — not the ordinary `checking` → `phaseAfterCheck` →
 * `alreadyPaired` path, which would read "This phone is already paired.
 * Unpair in Settings first." right under a banner that just said "This
 * phone was unpaired.", with no retry and only a Dashboard button that
 * loops back with the now-revoked token (task-6-rereview-r1.md, Important
 * 1). `clearFailedSignal` is whatever `_layout.tsx` chose to carry the
 * outcome — a route param or a shared flag; this function only makes the
 * decision pure and testable.
 */
export function entryPhaseKind(clearFailedSignal: boolean): "clearFailed" | "checking" {
  return clearFailedSignal ? "clearFailed" : "checking";
}

/**
 * What the `clearFailed` phase's retry button does next: `cleared` is the
 * outcome of retrying `clearPairing` directly (never `phaseAfterCheck` —
 * a retry that just cleared the record is already known to have nothing
 * left to find). Success moves on to the ordinary `scan` phase; failure
 * stays in `clearFailed`, with no Dashboard button (that only feeds the
 * revoked-token reconnect loop the re-review documented) — the caller
 * simply re-renders the same phase with its error text still showing.
 */
export function afterClearRetry(cleared: boolean): "scan" | "clearFailed" {
  return cleared ? "scan" : "clearFailed";
}

/**
 * Final review R-M1: whether the caller should drain — and discard — the
 * pairing-link holder (pairing-link-holder.ts) for a given entry-time
 * outcome. `"scan"` is the only outcome that legitimately still wants a
 * held link; every other outcome (already paired, the already-paired check
 * itself failed, or the phone is sitting in `clearFailed`) means the phone
 * is refusing a new pairing right now, so a link stashed for it — by a
 * cold-start deep link, or a warm one that arrived before the check
 * finished — must not linger in module memory or resurface at a later
 * scan phase (e.g. after the user unpairs), carrying a secret from a link
 * whose approval window may since have expired.
 */
export function shouldDrainPairingLink(
  nextKind: "scan" | "alreadyPaired" | "checkFailed" | "clearFailed",
): boolean {
  return nextKind !== "scan";
}
