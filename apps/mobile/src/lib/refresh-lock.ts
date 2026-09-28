// Native: one process owns the stored refresh token, so rotations need no
// cross-tab lock (refresh-lock.web.ts has the browser's).
import type { RefreshLock } from "./auth-session";

export const refreshLock: RefreshLock | undefined = undefined;
