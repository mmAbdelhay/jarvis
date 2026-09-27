// The browser build: every tab's rotations take turns through the Web
// Locks API (web-refresh-lock.ts has the logic).
import type { RefreshLock } from "./auth-session";
import { createWebRefreshLock } from "./web-refresh-lock";

export const refreshLock: RefreshLock | undefined = createWebRefreshLock(
  typeof navigator !== "undefined" && navigator.locks !== undefined ? navigator.locks : undefined,
);
