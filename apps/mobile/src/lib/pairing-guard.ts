// "Is a clear of this machine's pairing in flight right now", per machine. It
// closes a real race: Settings' manual unpair (settings-store.ts) disconnects,
// then clears the keychain record asynchronously; if the user backs out to
// /dashboard (Settings is pushed over it, so a back gesture lands there
// directly) while that clear is still pending, the connect-on-entry would
// otherwise read the not-yet-removed record and reconnect with a token that's
// about to be invalidated. Every clearer sets this for its own machine, and
// machine-sessions.ts refuses to connect that machine meanwhile. Clearing
// machine A blocks connecting to A only.
//
// M12 Task 8 (R-M6, deferred from M6): a plain boolean was shared by two
// independent clearers (Settings' own `unpair()` and the automatic
// `unpaired-handler.ts`) — if both happen to overlap, the second one to
// finish sets the flag `false` even though the first is still running,
// briefly opening the exact race this flag exists to close. A counter
// fixes it: `true` increments, `false` decrements (clamped at 0 — an
// unmatched `false` never goes negative), and `isClearingPairing()` reads
// "count > 0", so it stays `true` until every clearer that began has
// ended.

import type { MachineId } from "./machine-index";

const clearingCounts = new Map<MachineId | null, number>();

export function isClearingPairing(id: MachineId | null): boolean {
  return (clearingCounts.get(id) ?? 0) > 0;
}

export function setClearingPairing(id: MachineId | null, value: boolean): void {
  const next = (clearingCounts.get(id) ?? 0) + (value ? 1 : -1);
  if (next > 0) clearingCounts.set(id, next);
  else clearingCounts.delete(id);
}
