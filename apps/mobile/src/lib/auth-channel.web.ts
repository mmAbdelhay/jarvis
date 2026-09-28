// The browser build: keep-signed-in off and logout reach every other tab
// (web-auth-channel.ts has the logic).
import type { AuthChannel } from "./auth-session";
import { createWebAuthChannel } from "./web-auth-channel";

function localStorageOrUndefined(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

const storage = localStorageOrUndefined();

export const authChannel: AuthChannel | undefined = createWebAuthChannel({
  createBroadcastChannel:
    typeof BroadcastChannel === "function" ? (name) => new BroadcastChannel(name) : undefined,
  storage,
  onStorage:
    typeof window === "undefined"
      ? undefined
      : (listener) => {
          const handle = (event: StorageEvent) => listener(event);
          window.addEventListener("storage", handle);
          return () => window.removeEventListener("storage", handle);
        },
});
