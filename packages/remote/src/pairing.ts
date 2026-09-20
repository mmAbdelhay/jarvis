// A single pairing window: a 120s secret, then, the instant it matches,
// a ≤60s confirmation the laptop must decide before a device is minted.
// One window is ever open at a time — `open()` cancels whatever came
// before it. Pure over injected clock/timers/CSPRNG; `pair-session.ts`
// glues this to one socket's lifecycle, and later tasks (the hub) glue
// `onChange` to the desktop's `remote:update` broadcast.

import type { Clock, RandomBytes, Timers } from "./io.js";
import { mintSecret, secretMatches } from "./tokens.js";

export const PAIRING_TTL_MS = 120_000;
export const CONFIRMATION_TTL_MS = 60_000;

export type PairingOutcome = "approved" | "denied" | "timed-out" | "cancelled";

export type PairingStatus =
  | { kind: "closed" }
  | { kind: "open"; secret: string; expiresAt: number }
  | {
      kind: "confirming";
      requestId: string;
      deviceName: string;
      expiresAt: number;
      /** P15/D4: the connecting socket's own source address (the same
       *  value the "pairing-requested" audit event carries), canonical
       *  form. Shown in the desktop's confirmation dialog alongside the
       *  phone-chosen name — a photographed QR lets an attacker name
       *  itself "iPhone" too, but it cannot also choose the address it
       *  connects from. */
      address: string;
    };

export type PairingChange = "opened" | "expired" | "cancelled" | "requested" | "decided";

export type PairingBegin =
  | { ok: true; requestId: string; decision: Promise<PairingOutcome> }
  | { ok: false; reason: "closed" | "mismatch" | "busy" };

export type Pairing = {
  open(): { secret: string; expiresAt: number };
  cancel(): void;
  status(): PairingStatus;
  begin(candidate: string, deviceName: string, source: string): PairingBegin;
  decide(requestId: string, approve: boolean): boolean;
};

type State =
  | { kind: "closed" }
  | { kind: "open"; secret: string; expiresAt: number; timer: unknown }
  | {
      kind: "confirming";
      requestId: string;
      deviceName: string;
      address: string;
      expiresAt: number;
      timer: unknown;
      resolve: (outcome: PairingOutcome) => void;
    };

export function createPairing(deps: {
  random: RandomBytes;
  now: Clock;
  timers: Timers;
  onChange(status: PairingStatus, change: PairingChange): void;
}): Pairing {
  const { random, now, timers, onChange } = deps;
  let state: State = { kind: "closed" };

  function toStatus(): PairingStatus {
    if (state.kind === "closed") return { kind: "closed" };
    if (state.kind === "open") {
      return { kind: "open", secret: state.secret, expiresAt: state.expiresAt };
    }
    return {
      kind: "confirming",
      requestId: state.requestId,
      deviceName: state.deviceName,
      address: state.address,
      expiresAt: state.expiresAt,
    };
  }

  /**
   * Closes whatever is currently open or confirming: clears its timer,
   * resolves a pending decision `cancelled` (never anything else — a
   * timed-out close resolves for itself, below), and emits `change`. A
   * no-op when nothing is open, so `cancel()` on an already-closed window
   * emits nothing.
   */
  function closeCurrent(change: "cancelled" | "expired"): void {
    if (state.kind === "closed") return;
    timers.clearTimeout(state.timer);
    if (state.kind === "confirming") state.resolve("cancelled");
    state = { kind: "closed" };
    onChange(toStatus(), change);
  }

  /** The window's 120s timer: expires only if this exact secret is still the open one. */
  function expireIfStillOpen(secret: string): void {
    if (state.kind === "open" && state.secret === secret) closeCurrent("expired");
  }

  /** The confirmation's 60s timer: times out only if this exact request is still awaiting a decision. */
  function timeoutIfStillConfirming(requestId: string): void {
    if (state.kind !== "confirming" || state.requestId !== requestId) return;
    const resolve = state.resolve;
    timers.clearTimeout(state.timer);
    state = { kind: "closed" };
    resolve("timed-out");
    onChange(toStatus(), "expired");
  }

  return {
    open() {
      closeCurrent("cancelled");
      const secret = mintSecret(random);
      const expiresAt = now() + PAIRING_TTL_MS;
      const timer = timers.setTimeout(() => expireIfStillOpen(secret), PAIRING_TTL_MS);
      state = { kind: "open", secret, expiresAt, timer };
      onChange(toStatus(), "opened");
      return { secret, expiresAt };
    },

    cancel() {
      closeCurrent("cancelled");
    },

    status() {
      return toStatus();
    },

    begin(candidate, deviceName, source) {
      if (state.kind === "confirming") return { ok: false, reason: "busy" };
      if (state.kind === "closed") return { ok: false, reason: "closed" };
      if (now() >= state.expiresAt) {
        closeCurrent("expired");
        return { ok: false, reason: "closed" };
      }
      if (!secretMatches(candidate, state.secret)) return { ok: false, reason: "mismatch" };

      timers.clearTimeout(state.timer);
      const requestId = random(16).toString("hex");
      const expiresAt = now() + CONFIRMATION_TTL_MS;
      let resolve!: (outcome: PairingOutcome) => void;
      const decision = new Promise<PairingOutcome>((res) => {
        resolve = res;
      });
      const timer = timers.setTimeout(
        () => timeoutIfStillConfirming(requestId),
        CONFIRMATION_TTL_MS,
      );
      state = {
        kind: "confirming",
        requestId,
        deviceName,
        address: source,
        expiresAt,
        timer,
        resolve,
      };
      onChange(toStatus(), "requested");
      return { ok: true, requestId, decision };
    },

    decide(requestId, approve) {
      if (state.kind !== "confirming" || state.requestId !== requestId) return false;
      const resolve = state.resolve;
      timers.clearTimeout(state.timer);
      state = { kind: "closed" };
      resolve(approve ? "approved" : "denied");
      onChange(toStatus(), "decided");
      return true;
    },
  };
}
