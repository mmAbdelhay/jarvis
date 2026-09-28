// The browser build's tab-to-tab auth signal (follow-up N2), pure. One tab
// switching "Keep me signed in" off, or logging out, tells the others so
// they lock too (auth-session.ts). The message is only its kind: never a
// token, never anything secret.
//
// BroadcastChannel("jarvis-auth") when the browser has it; otherwise a
// `storage` event on one localStorage key whose value is a counter plus the
// kind (a write another tab makes fires the event here, never in the
// writing tab itself).
import type { AuthBroadcast, AuthChannel } from "./auth-session";

export const AUTH_CHANNEL_NAME = "jarvis-auth";
export const AUTH_SIGNAL_KEY = "jarvis.auth.signal";

export type BroadcastChannelLike = {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
};

export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

export type StorageEventLike = { key: string | null; newValue: string | null };

export type WebAuthChannelEnv = {
  createBroadcastChannel?: (name: string) => BroadcastChannelLike;
  storage?: StorageLike;
  onStorage?: (listener: (event: StorageEventLike) => void) => () => void;
};

/** Accepts exactly the two known messages; anything else is dropped. */
export function parseAuthBroadcast(value: unknown): AuthBroadcast | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const t = (value as { t?: unknown }).t;
  if (t === "storage-off" || t === "logout") return { t };
  return undefined;
}

const SIGNAL_PATTERN = /^(\d{1,15}) (storage-off|logout)$/;

export function createWebAuthChannel(env: WebAuthChannelEnv): AuthChannel | undefined {
  if (env.createBroadcastChannel !== undefined) {
    const channel = env.createBroadcastChannel(AUTH_CHANNEL_NAME);
    return {
      post(message) {
        channel.postMessage({ t: message.t });
      },
      subscribe(handler) {
        const listener = (event: { data: unknown }): void => {
          const message = parseAuthBroadcast(event.data);
          if (message !== undefined) handler(message);
        };
        channel.addEventListener("message", listener);
        return () => channel.removeEventListener("message", listener);
      },
    };
  }
  const { storage, onStorage } = env;
  if (storage === undefined || onStorage === undefined) return undefined;
  return {
    post(message) {
      try {
        const last = Number(SIGNAL_PATTERN.exec(storage.getItem(AUTH_SIGNAL_KEY) ?? "")?.[1] ?? 0);
        storage.setItem(AUTH_SIGNAL_KEY, `${(last + 1) % 1e15} ${message.t}`);
      } catch {
        // Storage unavailable: the other tabs lock on their next refusal instead.
      }
    },
    subscribe(handler) {
      return onStorage((event) => {
        if (event.key !== AUTH_SIGNAL_KEY || event.newValue === null) return;
        const kind = SIGNAL_PATTERN.exec(event.newValue)?.[2];
        const message = parseAuthBroadcast({ t: kind });
        if (message !== undefined) handler(message);
      });
    },
  };
}
