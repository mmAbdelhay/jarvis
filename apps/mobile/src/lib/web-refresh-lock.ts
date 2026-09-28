// The browser build's cross-tab refresh lock (final review I2), pure. Tabs
// on one origin share the stored refresh token, and the laptop treats a
// replayed old token as theft, so rotations take turns through the Web
// Locks API: auth-session.ts re-reads the stored token inside the lock.
//
// Without `navigator.locks` (it needs a secure context, which the client
// always has, and is in every browser that has WebAuthn), tasks run
// unlocked: the re-read inside still covers a tab that rotates after
// another has finished, which is the common case; only two rotations
// within one round-trip could still collide.
import type { RefreshLock } from "./auth-session";

export const REFRESH_LOCK_NAME = "jarvis-refresh";

/** The one `LockManager` method used here. */
export type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

export function createWebRefreshLock(locks: LockManagerLike | undefined): RefreshLock {
  if (locks === undefined) return (task) => task();
  return (task) => locks.request(REFRESH_LOCK_NAME, task);
}
