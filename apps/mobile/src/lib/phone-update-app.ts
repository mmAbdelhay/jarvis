// The seam where the app root gets its phone-update store. `_layout.tsx`
// calls `createAppPhoneUpdateStore()` once; until the real store
// (phone-update-store.ts) is wired in here, it is a store that never
// checks: idle, version "0.0.0", nothing to install.
import type { PhoneUpdateStore, PhoneUpdateView } from "./phone-update-types";

/** A store that reports `view` and does nothing. */
export function createIdlePhoneUpdateStore(view: PhoneUpdateView): PhoneUpdateStore {
  return {
    get: () => view,
    subscribe: () => () => {},
    check: async () => {},
    update: async () => {},
    start: () => {},
    stop: () => {},
  };
}

export function createAppPhoneUpdateStore(): PhoneUpdateStore {
  return createIdlePhoneUpdateStore({
    state: { kind: "idle" },
    current: "0.0.0",
    canInstall: false,
  });
}
