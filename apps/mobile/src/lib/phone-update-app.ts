// The seam where the app root gets its phone-update store. `_layout.tsx`
// calls `createAppPhoneUpdateStore()` once: the real store, with the
// platform's deps (phone-update-platform.ts, or .web.ts in the browser).
import { createPhoneUpdateDeps } from "./phone-update-platform";
import { createPhoneUpdateStore } from "./phone-update-store";
import type { PhoneUpdateStore } from "./phone-update-types";

export function createAppPhoneUpdateStore(): PhoneUpdateStore {
  return createPhoneUpdateStore(createPhoneUpdateDeps());
}
