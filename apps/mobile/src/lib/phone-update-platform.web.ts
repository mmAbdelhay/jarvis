// Web deps for the phone updater: the browser build can check for a newer
// release but never downloads or installs (canInstall is false off
// Android), so no native-only module is imported here.
import { AppState } from "react-native";
import { installedVersion } from "./app-version";
import type { PhoneUpdateDeps } from "./phone-update-store";

async function* noChunks(): AsyncIterable<Uint8Array> {
  yield* [];
  throw new Error("unsupported");
}

export function createPhoneUpdateDeps(): PhoneUpdateDeps {
  return {
    platform: "web",
    current: installedVersion(),
    fetch: (url, init) => globalThis.fetch(url, init),
    download: () => Promise.reject(new Error("unsupported")),
    readChunks: noChunks,
    fileExists: () => false,
    deleteFile: () => {},
    listCache: () => [],
    cacheDir: "",
    openInstaller: () => Promise.reject(new Error("unsupported")),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    onForeground(fn) {
      const subscription = AppState.addEventListener("change", (next) => {
        if (next === "active") fn();
      });
      return () => subscription.remove();
    },
    log: (token) => console.log(`[phone-update] ${token}`),
  };
}
