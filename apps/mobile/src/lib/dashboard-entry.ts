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

/**
 * D3: whether a route change should connect the shared client from the
 * stored pairing. Once at launch, on whatever route the app (or a browser
 * reload) started on — /unlock after a lock, a bookmarked /voice — and
 * again whenever the route reaches /dashboard (right after /pair saves a
 * fresh pairing). Never from /pair itself: that screen runs its own flow,
 * and a missing pairing would only route it back to itself. Calling
 * `connect()` twice is harmless (rpc-client.ts rule 8), so the rule only
 * has to never miss a launch.
 */
export function shouldConnectOnRoute(pathname: string, launchHandled: boolean): boolean {
  if (pathname === "/pair") return false;
  return pathname === "/dashboard" || !launchHandled;
}
