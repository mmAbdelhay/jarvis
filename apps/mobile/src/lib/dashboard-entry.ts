// Extracted from `app/_layout.tsx` (Task 6 fix round 1, Important #1): a
// `_layout.tsx` React component can't be unit tested directly, so the pure
// decision it needs — given the outcome of reading the stored pairing when
// the route reaches /dashboard, should the app connect the shared
// `RpcClient` or route to /pair — lives here instead, mirroring
// pair-flow.ts's `phaseAfterCheck` (fail closed: anything other than a
// successful read that actually found a record routes to /pair).
//
// Before this fix, a `loadPairing` failure (a keychain read throwing) or an
// absent record at /dashboard only logged and returned, leaving the client
// `idle` — an empty Dashboard, no banner (bannerKey("idle") is undefined),
// and no way forward for the user.

export type LoadPairingCheck = { ok: true; found: boolean } | { ok: false };

export function dashboardEntryAction(check: LoadPairingCheck): "connect" | "routeToPair" {
  if (!check.ok) return "routeToPair";
  return check.found ? "connect" : "routeToPair";
}
