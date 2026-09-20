// A tiny, app-wide "is a pairing clear in flight right now" flag. There is
// exactly one `RpcClient` and one stored pairing for the whole app
// (rpc-context.tsx), so a single mutable flag — not one scoped to a
// screen's own store — is enough to close a real race: Settings' manual
// unpair (settings-store.ts) disconnects, then clears the keychain record
// asynchronously; if the user backs out to /dashboard (Settings is pushed
// over it, so a back gesture lands there directly) while that clear is
// still pending, `_layout.tsx`'s own connect-on-entry would otherwise read
// the not-yet-removed record and reconnect with a token that's about to
// be invalidated. Both sides check/set this same flag — Settings sets it
// for the duration of its own clear, `_layout.tsx`'s entry point passes
// `() => !isClearingPairing()` as `connectFromStoredPairing`'s
// `shouldConnect`.
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
let clearingCount = 0;

export function isClearingPairing(): boolean {
  return clearingCount > 0;
}

export function setClearingPairing(value: boolean): void {
  if (value) {
    clearingCount += 1;
  } else {
    clearingCount = Math.max(0, clearingCount - 1);
  }
}
