// One "read a machine's stored pairing and connect" function, used by
// machine-sessions.ts for `_layout.tsx` (on reaching /dashboard) and Settings'
// `reconnect()` (settings-store.ts). Before this existed, each place read
// the keychain itself — once, correctly, in `_layout.tsx`, but Settings
// read the record and the credential as two separate calls, which could
// disagree if a pairing changed between them, and a keychain read failing
// on that second path was an unhandled promise rejection that left the
// client silently disconnected.
//
// The caller names the machine: "whichever is active" can change during the
// read, and one machine's credential must never reach another's client.
//
// The pure "given the read's outcome, what should happen" decision itself
// still lives in `dashboard-entry.ts`'s `dashboardEntryAction` — this
// function is the effectful shell around it: it performs the one
// read of the machine, calls `dashboardEntryAction` to decide, and
// calls `client.connect(...)` when that decision is "connect". No exception
// ever escapes this function: a throw from the machine store, whose open may
// have failed, becomes the `"failed"` outcome rather than a rejection the
// caller must remember to catch.
//
// `shouldConnect` closes a race a caller-side flag alone can't: a caller
// may start this function, then learn mid-flight (while the keychain read
// is still pending) that it should no longer connect — Settings' manual
// unpair clearing the very pairing this function is about to read,
// `_layout.tsx`'s /dashboard entry running while a clear from *either*
// path (Settings' manual unpair, or the automatic unpaired-handler) is
// still in flight, or a switch to another machine having begun. Passing a
// flag in at the start and only reading it up
// front wouldn't see a change that happens during the `await`; this
// function checks `shouldConnect()` again, synchronously, in the same tick
// as the decision to connect, immediately before calling `client.connect`
// — nothing can run in between that check and the call.

import { dashboardEntryAction } from "./dashboard-entry";
import type { MachineId } from "./machine-index";
import type { MachineStore } from "./machine-store";
import type { PairingRecord } from "./pairing-record";
import type { Endpoint, RpcClient } from "./rpc-client";

/**
 * - `"connected"`: a valid pairing was found, `shouldConnect()` (if given)
 *   allowed it, and `client.connect(...)` was called with it.
 * - `"unpaired"`: either the read succeeded but found no (or no longer
 *   usable) pairing, or `shouldConnect()` refused right before the
 *   connect — both are "there is nothing this call should connect with
 *   right now", and the caller routes to /pair the same way for both.
 * - `"failed"`: the keychain read itself threw, or the machine store could
 *   not open — never taken for an empty phone. The caller decides how to
 *   show that (route to /pair, per `_layout.tsx`'s existing fail-closed
 *   behaviour, or show a retryable error, per Settings' reconnect()).
 */
export type ConnectStoredOutcome = "connected" | "unpaired" | "failed";

export async function connectFromStoredPairing(deps: {
  machines: Pick<MachineStore, "load">;
  id: MachineId;
  client: Pick<RpcClient, "connect">;
  /** Checked once, synchronously, immediately before `client.connect` —
   * omit to always allow connecting. machine-sessions.ts passes the one
   * real check: the attempt is still the latest, this machine is not being
   * cleared (pairing-guard.ts), and the caller's own refusal if any. */
  shouldConnect?(): boolean;
}): Promise<ConnectStoredOutcome> {
  let loaded: Awaited<ReturnType<MachineStore["load"]>>;
  try {
    loaded = await deps.machines.load(deps.id);
  } catch {
    return "failed";
  }

  const action = dashboardEntryAction({ ok: true, found: loaded !== undefined });
  if (action === "routeToPair" || loaded === undefined) {
    return "unpaired";
  }

  if (deps.shouldConnect !== undefined && !deps.shouldConnect()) {
    return "unpaired";
  }

  deps.client.connect(endpointOf(loaded.record), loaded.credential);
  return "connected";
}

export function endpointOf(record: PairingRecord): Endpoint {
  const endpoint: Endpoint = {
    host: record.host,
    port: record.port,
    fingerprint: record.fingerprint,
  };
  if (record.name !== undefined) {
    endpoint.name = record.name;
  }
  return endpoint;
}
