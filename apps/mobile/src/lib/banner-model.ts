// Pure decision logic for the connection banner (Task 5, behaviour rule 5):
// which message key to show, and whether the one-tap "Pair again" button
// shows alongside it. Pulled out of `ConnectionBanner.tsx` so it is unit
// testable without a React Native renderer — the `.tsx` stays layout.

import type { ConnectionView } from "./connection-store";
import type { MessageKey } from "./i18n";

export type BannerModel = { key: MessageKey; pairAgain: boolean };

/**
 * `undefined` means the banner renders nothing — the same "open and not
 * stale" case `ConnectionBanner.tsx` always had. `pairAgain` is true only
 * for the latched pin-mismatch warning (rulings.md 2): that is the one
 * state where re-pairing from a tap, rather than a trip to Settings, makes
 * sense — every other state either resolves on its own (reconnecting,
 * stale) or already offers its own way forward (offline's retry tap,
 * unpaired's automatic route to /pair).
 */
export function bannerModel(view: ConnectionView): BannerModel | undefined {
  if (view.pinMismatch) {
    return { key: "conn.pinMismatch", pairAgain: true };
  }
  switch (view.state) {
    case "idle":
      return undefined;
    case "connecting":
    case "authenticating":
      return { key: "conn.connecting", pairAgain: false };
    case "reconnecting":
      return { key: "conn.reconnecting", pairAgain: false };
    case "closed":
      return { key: "conn.offline", pairAgain: false };
    case "unpaired":
      return { key: "conn.unpaired", pairAgain: false };
    case "incompatible":
      return { key: "conn.incompatible", pairAgain: false };
    case "open":
      return view.stale ? { key: "conn.stale", pairAgain: false } : undefined;
  }
}
