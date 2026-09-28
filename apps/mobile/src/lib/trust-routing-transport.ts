// The one seam `_layout.tsx` and `app/pair.tsx` wire once (M11, rulings.md
// 1): dispatches a `Transport.open` call to the pinned native transport or
// the system-trust one, purely on `trust.kind` — a pairing whose link had
// no `name` pins natively (unchanged since M6); one with a `name` dials it
// through the OS trust store instead. Neither route is ever asked to
// second-guess the other's decision.

import type { ClientPlatform } from "./client-platform";
import type { Transport } from "./transport";

export function createTrustRoutingTransport(routes: {
  pin: Transport;
  system: Transport;
}): Transport {
  return {
    open(url, trust, onEvent) {
      const target = trust.kind === "system" ? routes.system : routes.pin;
      return target.open(url, trust, onEvent);
    },
  };
}

/**
 * The app's one transport (Task 13). The browser build always dials
 * through the system transport — a browser WebSocket only trusts the OS
 * store and has no pinning module — so on web even a pin-trust open goes
 * there, where system-transport.ts refuses it (an IP literal is never a
 * system-trust target). Native routes by trust kind, unchanged.
 */
export function createAppTransport(
  platform: ClientPlatform,
  routes: { pin: Transport; system: Transport },
): Transport {
  if (platform === "web") return routes.system;
  return createTrustRoutingTransport(routes);
}
