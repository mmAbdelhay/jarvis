// The one seam `_layout.tsx` and `app/pair.tsx` wire once (M11, rulings.md
// 1): dispatches a `Transport.open` call to the pinned native transport or
// the system-trust one, purely on `trust.kind` — a pairing whose link had
// no `name` pins natively (unchanged since M6); one with a `name` dials it
// through the OS trust store instead. Neither route is ever asked to
// second-guess the other's decision.

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
