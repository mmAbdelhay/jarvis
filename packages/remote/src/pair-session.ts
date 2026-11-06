// The `/pair` socket's whole lifecycle: one frame in, the laptop's
// confirmation awaited via `pairing.begin`'s decision, then exactly one
// `paired` frame out on approval — a close and nothing else on every other
// path. "Nothing is ever written before approval": the only `send` here is
// the single `paired` frame; closing a socket is not a banner.
//
// A `join` frame takes the other road on the same socket: the owner password
// instead of the laptop's confirmation, then exactly one `joined` frame.
// Every refusal of a join closes 4401, whatever the reason, and nothing here
// ever puts the password in a log, an audit line or an error.

import type { AuditLog } from "./audit.js";
import type { DeviceClient, DeviceStore } from "./devices.js";
import { deviceClientKind, sanitizeDeviceName } from "./devices.js";
import { describeError } from "./io.js";
import type { SessionHandlers, SocketLike, Timers } from "./io.js";
import type { Pairing, PairingOutcome } from "./pairing.js";
import type { AuthTokens } from "./protocol.js";
import {
  CLOSE,
  encodeMessage,
  HANDSHAKE_TIMEOUT_MS,
  parsePairFrame,
  PROTOCOL_VERSION,
} from "./protocol.js";

/** A refusal `pairing-refused` audits. */
type AuditedRefusal = "bad-frame" | "timeout" | "version" | "closed" | "mismatch" | "busy";

/** `join-refused`: a join turned away once it got to the password. */
export type PairRefusal = AuditedRefusal | "join-refused";

/** Password joins; present only while the tailnet feature is active. */
export type PairJoinDeps = {
  /** Read when the frame arrives and again after the check. */
  allowed(): boolean;
  checkPassword(password: string): Promise<"ok" | "refused">;
  /** Logged-in tokens for the device just minted; rejects when none can be given. */
  issue(deviceId: string): Promise<AuthTokens>;
  onJoined(deviceName: string, deviceId: string): void;
};

export type PairSessionDeps = {
  pairing: Pick<Pairing, "begin" | "cancel">;
  devices: Pick<DeviceStore, "add" | "revoke">;
  audit: Pick<AuditLog, "record">;
  timers: Timers;
  source: string;
  log(line: string): void;
  onFailure(reason: PairRefusal): void;
  onSettled(): void;
  join?: PairJoinDeps;
};

export function createPairSession(socket: SocketLike, deps: PairSessionDeps): SessionHandlers {
  const { pairing, devices, audit, timers, source, log, onFailure, onSettled, join } = deps;

  // awaiting-pair: the one frame hasn't arrived yet. confirming: `begin`
  // succeeded and the laptop's decision is pending. joining: a join frame
  // passed its first checks and the password check and what follows it are
  // running. done: the session has written its last word (a close) — nothing
  // further is ever sent.
  type Phase = "awaiting-pair" | "confirming" | "joining" | "done";
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
  function refuse(reason: AuditedRefusal, code: number): void {
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

    const message = parsePairFrame(text);
    if (message === undefined) {
      refuse("bad-frame", CLOSE.badFrame);
      return;
    }
    const isJoin = message.t === "join";
    // Version is checked before the secret ever reaches `pairing.begin` —
    // a stale/foreign protocol version must never spend the one guess a
    // window's secret gets.
    if (message.v !== PROTOCOL_VERSION) {
      refuse("version", isJoin ? CLOSE.unauthorized : CLOSE.versionMismatch);
      return;
    }
    const deviceName = sanitizeDeviceName(message.deviceName);
    if (deviceName === "") {
      refuse("bad-frame", isJoin ? CLOSE.unauthorized : CLOSE.badFrame);
      return;
    }

    // Phase 1: stored on the device record so Settings can label a browser.
    const client = deviceClientKind(message.client);

    if (isJoin) {
      if (join === undefined || !join.allowed()) {
        refuse("closed", CLOSE.unauthorized);
        return;
      }
      // The check may wait its turn behind other scrypt runs: as with
      // `confirming`, the handshake timer no longer applies.
      clearHandshakeTimer();
      phase = "joining";
      runJoin(join, message.password, deviceName, client).catch(() => {
        // A backstop, as in `handleDecision`. No error detail: this path
        // handled the password.
        log("pair-session: unhandled join failure");
        audit.record({ kind: "error", detail: "pair-session: unhandled join failure" });
        refuseJoin();
      });
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
      handleDecision(decision, deviceName, client).catch((error: unknown) => {
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
    if (phase === "joining") return; // `runJoin` sees `socketGone` and settles
    // Not confirming: either no pair frame ever arrived (awaiting-pair —
    // the armed handshake timer must be disarmed, or it would later fire
    // `refuse("timeout", ...)` for a socket that is already gone) or the
    // session already reached its own terminal close (done, in which case
    // all of this is a no-op).
    clearHandshakeTimer();
    phase = "done";
    settle();
  }

  async function handleDecision(
    outcome: PairingOutcome,
    deviceName: string,
    client: DeviceClient,
  ): Promise<void> {
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
      minted = await devices.add(deviceName, client);
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

  /**
   * The last word of a join that failed at or after the password. No
   * `pairing-refused` line: the join limiter audits these itself, coalesced,
   * and one line per attempt here would undo that under a flood.
   */
  function refuseJoin(): void {
    if (phase === "done") return;
    phase = "done";
    onFailure("join-refused");
    if (!socketGone) socket.close(CLOSE.unauthorized, "");
    settle();
  }

  async function revokeMinted(deviceId: string): Promise<void> {
    try {
      await devices.revoke(deviceId);
    } catch (error) {
      log(`pair-session: devices.revoke failed: ${describeError(error)}`);
      audit.record({ kind: "error", detail: describeError(error) });
    }
  }

  async function abandonJoin(deviceId: string, deviceName: string): Promise<void> {
    await revokeMinted(deviceId);
    audit.record({ kind: "pairing-denied", source, deviceName, reason: "abandoned" });
    phase = "done";
    settle();
  }

  async function runJoin(
    joining: PairJoinDeps,
    password: string,
    deviceName: string,
    client: DeviceClient,
  ): Promise<void> {
    let verdict: "ok" | "refused";
    try {
      verdict = await joining.checkPassword(password);
    } catch {
      log("pair-session: join password check failed");
      verdict = "refused";
    }
    if (verdict !== "ok" || (!socketGone && !joining.allowed())) {
      refuseJoin();
      return;
    }
    if (socketGone) {
      phase = "done";
      settle();
      return;
    }

    let minted: { deviceId: string; token: string };
    try {
      minted = await devices.add(deviceName, client);
    } catch (error) {
      log(`pair-session: devices.add failed: ${describeError(error)}`);
      audit.record({ kind: "error", detail: describeError(error) });
      refuseJoin();
      return;
    }
    if (socketGone) {
      await abandonJoin(minted.deviceId, deviceName);
      return;
    }

    let tokens: AuthTokens;
    try {
      tokens = await joining.issue(minted.deviceId);
    } catch {
      log("pair-session: issuing a join session failed");
      await revokeMinted(minted.deviceId);
      refuseJoin();
      return;
    }
    if (socketGone) {
      await abandonJoin(minted.deviceId, deviceName);
      return;
    }

    audit.record({ kind: "joined-by-password", source, deviceId: minted.deviceId, deviceName });
    socket.send(
      encodeMessage({
        t: "joined",
        v: PROTOCOL_VERSION,
        deviceId: minted.deviceId,
        token: minted.token,
        tokens,
      }),
    );
    socket.close(CLOSE.normal, "joined");
    phase = "done";
    settle();
    try {
      joining.onJoined(deviceName, minted.deviceId);
    } catch (error) {
      log(`pair-session: onJoined failed: ${describeError(error)}`);
    }
  }

  return { onText, onBinary, onClose };
}
