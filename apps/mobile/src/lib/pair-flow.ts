// Pure decision logic pulled out of `app/pair.tsx` (Task 5 fix rounds 1-2,
// findings C1, I2/Important-2, Important-1): screens stay thin, so the "can
// a new pairing attempt start right now" guard, the link → confirm/needsHost
// transition, and the already-paired fail-closed decision all live here,
// testable without a React Native renderer.

import type { AuthTokens, PairingLink } from "@jarvis/wire";
import { parsePairingUri } from "@jarvis/wire";
import type { MessageKey } from "./i18n";
import { DEFAULT_BRIDGE_PORT, parseMachineAddress } from "./machine-address";
import { type MachineId, machineIdOf } from "./machine-index";
import type { ForgetCause, ForgetOutcome, SwitchOutcome } from "./machine-sessions";
import { MachineLimitError, type MachineEntry } from "./machine-store";
import { JOINED_HOST, type JoinOutcome, needsHost, withHost } from "./pairing";
import { PairingAlreadyExistsError, type PairingRecord } from "./pairing-record";
import type { Credential } from "./rpc-client";

export type PairFlowPhaseKind =
  | "checking"
  | "alreadyPaired"
  | "clearFailed"
  | "sameMachine"
  | "join"
  | "scan"
  | "needsHost"
  | "confirm"
  | "waiting"
  | "error"
  | "success";

/**
 * A new pairing attempt — from a scan, a pasted link, or a `jarvis://` deep
 * link — may only begin from the "scan" step, and, in the browser, never while
 * it holds a machine. Both are load-bearing:
 *
 * - the phase check stops a second, concurrent link from clobbering one
 *   already in flight (ruling C1c);
 * - `held` is the browser's refusal, one machine per origin (ruling C1a): a
 *   phone holds many, so it passes `false`, and answers the one link it must
 *   refuse, for a machine it already holds, with `intakeLink`'s `sameMachine`.
 */
export function canStartIntake(params: { held: boolean; phaseKind: PairFlowPhaseKind }): boolean {
  if (params.held) return false;
  return params.phaseKind === "scan";
}

/** What a link does next on a phone. Never starts a pairing: `step` has no such
 *  variant, and a held machine's link stops short of any store or socket. */
export type LinkIntake =
  | { kind: "dropped" }
  | { kind: "invalid" }
  | { kind: "checkFailed" }
  | { kind: "limit" }
  | { kind: "sameMachine"; id: MachineId }
  | { kind: "step"; link: PairingLink; step: IntakeStep };

export function intakeLink(params: {
  phaseKind: PairFlowPhaseKind;
  uri: string;
  isHeld(id: MachineId): boolean;
  atLimit(): boolean;
}): LinkIntake {
  if (!canStartIntake({ held: false, phaseKind: params.phaseKind })) return { kind: "dropped" };
  const link = parsePairingUri(params.uri);
  if (link === undefined) return { kind: "invalid" };
  const step = intakeStep(link);
  // A link with no address yet has no id: `heldAfterHost` asks once it has one.
  if (step.kind === "needsHost") return { kind: "step", link, step };
  try {
    const id = heldAfterHost(link, params.isHeld);
    if (id !== undefined) return { kind: "sameMachine", id };
    if (params.atLimit()) return { kind: "limit" };
  } catch {
    return { kind: "checkFailed" };
  }
  return { kind: "step", link, step };
}

/** The held machine this link's address lands on. */
export function heldAfterHost(
  link: PairingLink,
  isHeld: (id: MachineId) => boolean,
): MachineId | undefined {
  const id = machineIdOf(link);
  return isHeld(id) ? id : undefined;
}

/** Where a pairing or a join ends. Nothing here holds a secret. */
export type SaveStep =
  | { kind: "success"; id: MachineId }
  | { kind: "sameMachine"; id: MachineId }
  | { kind: "limit" }
  | { kind: "saveFailed" };

/** The store's own refusals are what stand behind every earlier check. A failed
 *  save leaves the machine on screen as it was. After a join it also leaves a
 *  device entry on the target that nobody holds tokens for: that machine's device
 *  list shows it, and it can be revoked there. */
export async function savePairing(
  addAndSwitch: (
    record: PairingRecord,
    credential: Credential,
    tokens?: AuthTokens,
  ) => Promise<MachineId>,
  record: PairingRecord,
  credential: Credential,
  tokens?: AuthTokens,
): Promise<SaveStep> {
  try {
    return { kind: "success", id: await addAndSwitch(record, credential, tokens) };
  } catch (err) {
    if (err instanceof PairingAlreadyExistsError) {
      return { kind: "sameMachine", id: machineIdOf(record) };
    }
    if (err instanceof MachineLimitError) return { kind: "limit" };
    return { kind: "saveFailed" };
  }
}

export type JoinFailure =
  | "short-name"
  | "invalid"
  | "refused"
  | "rate-limited"
  | "unreachable"
  | "timeout"
  | "protocol";

export function joinFailureKey(failure: JoinFailure): MessageKey {
  switch (failure) {
    case "short-name":
      return "pair.joinShortName";
    case "invalid":
      return "pair.joinInvalid";
    case "refused":
      return "pair.joinRefused";
    case "rate-limited":
      return "pair.joinRateLimited";
    // pair.timeout speaks of an approval and a new code: a join has neither.
    case "unreachable":
    case "timeout":
      return "pair.unreachable";
    case "protocol":
      return "pair.protocol";
  }
}

export function pairStepKey(kind: "limit" | "saveFailed"): MessageKey {
  return kind === "limit" ? "pair.limit" : "pair.saveFailed";
}

export type SubmitJoinDeps = {
  isHeld(id: MachineId): boolean;
  atLimit(): boolean;
  /** Everything before this is decided here: a frame is about to go. */
  waiting(): void;
  join(address: { name: string; port: number }, password: string): Promise<JoinOutcome>;
  /** The screen that asked is still up: nothing is added behind a user who left. */
  stillWanted(): boolean;
  addAndSwitch(
    record: PairingRecord,
    credential: Credential,
    tokens?: AuthTokens,
  ): Promise<MachineId>;
};

export type JoinStep =
  | SaveStep
  | { kind: "join"; failure: JoinFailure }
  | { kind: "checkFailed" }
  | { kind: "abandoned" };

/** Adding by name, from the typed text to the switch. Same id and limit are
 *  checked before any frame goes. The password goes on to `deps.join`, and is in
 *  no answer. */
export async function submitJoin(
  deps: SubmitJoinDeps,
  nameText: string,
  password: string,
): Promise<JoinStep> {
  const address = parseMachineAddress(nameText, DEFAULT_BRIDGE_PORT);
  if (address.kind !== "ok") return { kind: "join", failure: address.kind };
  const { name, port } = address;
  try {
    const id = machineIdOf({ name, host: JOINED_HOST, port });
    if (deps.isHeld(id)) return { kind: "sameMachine", id };
    if (deps.atLimit()) return { kind: "limit" };
  } catch {
    return { kind: "checkFailed" };
  }
  deps.waiting();
  let outcome: JoinOutcome;
  try {
    outcome = await deps.join({ name, port }, password);
  } catch {
    // Not read: an error here may have the frame in it.
    return { kind: "join", failure: "unreachable" };
  }
  if (!outcome.ok) return { kind: "join", failure: outcome.reason };
  if (!deps.stillWanted()) return { kind: "abandoned" };
  return savePairing(deps.addAndSwitch, outcome.record, outcome.credential, outcome.tokens);
}

/** /pair's way to a machine: the back button, `pair.openMachine`, and the machine
 *  a retried clear named. Anything but `unknown` is on its way. */
export async function openHeldMachine(
  id: MachineId,
  deps: {
    switchTo(id: MachineId): Promise<SwitchOutcome>;
    leave(): void;
    failed(): void;
    log(line: string): void;
  },
): Promise<void> {
  let outcome: SwitchOutcome;
  try {
    outcome = await deps.switchTo(id);
  } catch {
    deps.log("pair: opening a machine failed");
    deps.failed();
    return;
  }
  if (outcome === "unknown") deps.failed();
  else deps.leave();
}

/** Where /pair's back button goes: the machine on screen if it can be gone back
 *  to, else the first other one. A clear that keeps failing is what is being left
 *  (decision 11), so it is never that machine. While an answer is on its way, or
 *  once it has come, there is no back. */
export function pairBackTarget(params: {
  phaseKind: PairFlowPhaseKind;
  onScreen: MachineId | null;
  clearFailedId: MachineId | null;
  held: readonly MachineId[];
}): MachineId | undefined {
  const { phaseKind, onScreen, clearFailedId, held } = params;
  if (phaseKind === "checking" || phaseKind === "waiting" || phaseKind === "success") {
    return undefined;
  }
  const others = held.filter((id) => id !== clearFailedId);
  if (onScreen !== null && others.includes(onScreen)) return onScreen;
  return others[0];
}

/** A signal taken on arrival, for the machine on screen, or for no one: left over
 *  from a machine the user has since moved past, it says nothing about this one. */
export function clearFailedEntry(
  signal: { id: MachineId | null } | undefined,
  onScreen: MachineId | null,
): { id: MachineId | null } | undefined {
  return signal?.id === onScreen ? signal : undefined;
}

export type HeldRead = { ok: true; ids: MachineId[] } | { ok: false };

/** Fails closed on a store that could not open. One machine that cannot be read
 *  hides no other: an add of that id still reaches the store's own refusal. */
export async function readHeldMachines(
  open: () => Promise<unknown>,
  store: { listReadable(): Promise<MachineEntry[]> },
): Promise<HeldRead> {
  try {
    await open();
    const entries = await store.listReadable();
    return { ok: true, ids: entries.map((entry) => entry.id) };
  } catch {
    return { ok: false };
  }
}

/** A phone may always add a machine, so only the read can stop it. */
export function phaseAfterRead(read: HeldRead): "scan" | "checkFailed" {
  return read.ok ? "scan" : "checkFailed";
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
 * Where a forget (machine-sessions.ts) leaves the user. A failed clear and an
 * empty phone both have only /pair. With another machine on screen, only a user
 * who asked to pair goes there: nobody is stranded while working machines exist.
 */
export function afterForgetRoute(cause: ForgetCause, outcome: ForgetOutcome): "pair" | "stay" {
  if (outcome.kind !== "next") return "pair";
  return cause === "pair-again" ? "pair" : "stay";
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
