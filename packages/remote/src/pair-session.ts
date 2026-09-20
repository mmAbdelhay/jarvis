// The `/pair` socket's whole lifecycle: one frame in, the laptop's
// confirmation awaited via `pairing.begin`'s decision, then exactly one
// `paired` frame out on approval — a close and nothing else on every other
// path. "Nothing is ever written before approval": the only `send` here is
// the single `paired` frame; closing a socket is not a banner.

import type { AuditLog } from "./audit.js";
import type { DeviceStore } from "./devices.js";
import { sanitizeDeviceName } from "./devices.js";
import { describeError } from "./io.js";
import type { SessionHandlers, SocketLike, Timers } from "./io.js";
import type { Pairing, PairingOutcome } from "./pairing.js";
import {
  CLOSE,
  encodeMessage,
  HANDSHAKE_TIMEOUT_MS,
  parsePairMessage,
  PROTOCOL_VERSION,
} from "./protocol.js";

export type PairRefusal = "bad-frame" | "timeout" | "version" | "closed" | "mismatch" | "busy";

export type PairSessionDeps = {
  pairing: Pick<Pairing, "begin" | "cancel">;
  devices: Pick<DeviceStore, "add" | "revoke">;
  audit: Pick<AuditLog, "record">;
  timers: Timers;
  source: string;
  log(line: string): void;
  onFailure(reason: PairRefusal): void;
  onSettled(): void;
};

export function createPairSession(socket: SocketLike, deps: PairSessionDeps): SessionHandlers {
  const { pairing, devices, audit, timers, source, log, onFailure, onSettled } = deps;

  // awaiting-pair: the one frame hasn't arrived yet. confirming: `begin`
  // succeeded and the laptop's decision is pending. done: the session has
  // written its last word (a close) — nothing further is ever sent.
  type Phase = "awaiting-pair" | "confirming" | "done";
  let phase: Phase = "awaiting-pair";
  let settled = false;
  // Set the instant `onClose` fires, so a decision that resolves afterwards
  // (rule 8's "socket gone meanwhile") knows not to touch the socket again.
  let socketGone = false;
  // Set inside the decision's `.then`, before `handleDecision` runs, so a
  // later `onClose` (e.g. while `devices.add()` is still in flight) knows
  // the decision already arrived and must not call `pairing.cancel()` —
  // that could land on a window a later `open()` has since reused.
  let decided = false;
  let handshakeTimer: unknown = timers.setTimeout(
    () => refuse("timeout", CLOSE.handshakeTimeout),
    HANDSHAKE_TIMEOUT_MS,
  );

  function clearHandshakeTimer(): void {
    if (handshakeTimer === undefined) return;
    timers.clearTimeout(handshakeTimer);
    handshakeTimer = undefined;
  }

  function settle(): void {
    if (settled) return;
    settled = true;
    onSettled();
  }

  /** A refusal only means anything while still awaiting the one pair frame (rule 4). */
  function refuse(reason: PairRefusal, code: number): void {
    if (phase !== "awaiting-pair") return;
    phase = "done";
    clearHandshakeTimer();
    audit.record({ kind: "pairing-refused", source, reason });
    onFailure(reason);
    // I1: the reason never goes on the wire — an unauthenticated peer must
    // not learn *why* it was refused (bad secret vs. version vs. another
    // window already busy) before it has proven anything at all. The audit
    // log above is where `reason` actually lives.
    socket.close(code, "");
    settle();
  }

  function onText(text: string): void {
    if (phase !== "awaiting-pair") return; // frames after the first are ignored

    const message = parsePairMessage(text);
    if (message === undefined) {
      refuse("bad-frame", CLOSE.badFrame);
      return;
    }
    // Version is checked before the secret ever reaches `pairing.begin` —
    // a stale/foreign protocol version must never spend the one guess a
    // window's secret gets.
    if (message.v !== PROTOCOL_VERSION) {
      refuse("version", CLOSE.versionMismatch);
      return;
    }
    const deviceName = sanitizeDeviceName(message.deviceName);
    if (deviceName === "") {
      refuse("bad-frame", CLOSE.badFrame);
      return;
    }

    const outcome = pairing.begin(message.secret, deviceName, source);
    if (!outcome.ok) {
      // Ruling 15: every refusal reason closes 4401, whichever one it was.
      refuse(outcome.reason, CLOSE.unauthorized);
      return;
    }

    clearHandshakeTimer();
    phase = "confirming";
    audit.record({ kind: "pairing-requested", source, deviceName });
    outcome.decision.then((decision) => {
      decided = true;
      handleDecision(decision, deviceName).catch((error: unknown) => {
        // A backstop, not the primary path: every branch inside
        // `handleDecision` already catches its own failures and settles.
        // This only fires if something inside it throws in a way none of
        // those branches anticipated — and even then, `settle()` must
        // still run exactly once.
        log(`pair-session: unhandled failure: ${describeError(error)}`);
        audit.record({ kind: "error", detail: describeError(error) });
        phase = "done";
        settle();
      });
    });
  }

  // M8 rule 9: the pair socket ignores a binary frame's data and keeps its
  // M4 behaviour — a blob has nothing to do before a device is paired.
  function onBinary(_data: Uint8Array): void {
    if (phase !== "awaiting-pair") return;
    refuse("bad-frame", CLOSE.badFrame);
  }

  function onClose(_code: number): void {
    socketGone = true;
    if (phase === "confirming") {
      // Cancelling resolves the pending decision (to `"cancelled"`),
      // which is what lets `handleDecision` run and eventually settle.
      // Once the decision has already arrived (`decided`), there is
      // nothing left to cancel — `handleDecision` is already running (or
      // about to) and will settle on its own; calling `cancel()` here
      // would just reach into whatever window is *currently* open, which
      // by then may belong to an unrelated, later pairing attempt.
      if (!decided) pairing.cancel();
      return; // settles later, once the decision resolves / handleDecision finishes
    }
    // Not confirming: either no pair frame ever arrived (awaiting-pair —
    // the armed handshake timer must be disarmed, or it would later fire
    // `refuse("timeout", ...)` for a socket that is already gone) or the
    // session already reached its own terminal close (done, in which case
    // all of this is a no-op).
    clearHandshakeTimer();
    phase = "done";
    settle();
  }

  async function handleDecision(outcome: PairingOutcome, deviceName: string): Promise<void> {
    if (outcome !== "approved") {
      audit.record({ kind: "pairing-denied", source, deviceName, reason: outcome });
      // I1: same reasoning as refuse() — "mismatch" vs. "closed" vs. "busy"
      // on the wire would tell an unauthenticated peer more about the
      // pairing window's state than it has any business knowing.
      if (!socketGone) socket.close(CLOSE.pairingDenied, "");
      phase = "done";
      settle();
      return;
    }

    let minted: { deviceId: string; token: string };
    try {
      minted = await devices.add(deviceName);
    } catch (error) {
      log(`pair-session: devices.add failed: ${describeError(error)}`);
      audit.record({ kind: "error", detail: describeError(error) });
      if (!socketGone) socket.close(CLOSE.internalError, "");
      phase = "done";
      settle();
      return;
    }

    if (socketGone) {
      try {
        await devices.revoke(minted.deviceId);
        audit.record({ kind: "pairing-denied", source, deviceName, reason: "abandoned" });
      } catch (error) {
        // The device was already minted and is now unreachable either
        // way; a failed revoke must still settle rather than leave this
        // session hanging (and an unhandled rejection behind it).
        log(`pair-session: devices.revoke failed: ${describeError(error)}`);
        audit.record({ kind: "error", detail: describeError(error) });
      }
      phase = "done";
      settle();
      return;
    }

    audit.record({ kind: "paired", source, deviceId: minted.deviceId, deviceName });
    socket.send(
      encodeMessage({
        t: "paired",
        v: PROTOCOL_VERSION,
        deviceId: minted.deviceId,
        token: minted.token,
      }),
    );
    socket.close(CLOSE.normal, "paired");
    phase = "done";
    settle();
  }

  return { onText, onBinary, onClose };
}
