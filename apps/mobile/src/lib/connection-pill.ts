// The Dashboard header's connection pill (fix round, 2026-09-19 redesign):
// the pill's dot colour and text collapse `ConnectionStore`'s full
// `ClientState` (rpc-client.ts) down to the five states `Main.dc.html`
// calls for — connected/connecting/reconnecting/stale/offline — reusing
// the same `conn.*` message keys `banner-model.ts` and `settings-store.ts`
// already show elsewhere, so the pill never invents new copy for a state
// another screen already describes. Pulled out of `dashboard.tsx` so it is
// unit testable without a React Native renderer, the same split
// `banner-model.ts` uses for `ConnectionBanner.tsx`.

import type { ConnectionView } from "./connection-store";
import type { MessageKey } from "./i18n";

export type ConnectionPillTone = "success" | "warning" | "danger";

export type ConnectionPillModel = { key: MessageKey; tone: ConnectionPillTone };

/**
 * Every `ClientState` maps to one of the five pill states — `idle`,
 * `unpaired` and `incompatible` fold into "offline" (danger) rather than
 * growing a sixth pill state: the Dashboard is only ever reached once a
 * pairing exists (dashboard-entry.ts), so those states are transient at
 * worst here, and `ConnectionBanner` still shows their own, more specific
 * text underneath when they apply.
 */
export function connectionPillModel(view: ConnectionView): ConnectionPillModel {
  switch (view.state) {
    case "connecting":
    case "authenticating":
      return { key: "conn.connecting", tone: "warning" };
    case "reconnecting":
      return { key: "conn.reconnecting", tone: "warning" };
    case "open":
      return view.stale
        ? { key: "conn.stale", tone: "warning" }
        : { key: "conn.connected", tone: "success" };
    case "idle":
    case "closed":
    case "unpaired":
    case "incompatible":
      return { key: "conn.offline", tone: "danger" };
  }
}
