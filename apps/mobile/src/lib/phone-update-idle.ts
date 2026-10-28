// A phone-update store that reports a fixed view and never checks: for
// tests and previews, apart from the platform's real store.
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
