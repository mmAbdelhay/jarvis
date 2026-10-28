// Native deps for the phone updater (phone-update-store.ts). Untested
// glue: the store's logic is unit-tested with fakes. The web build gets
// phone-update-platform.web.ts instead, which imports none of these
// native-only modules. expo-intent-launcher is Android-only, so it is
// loaded lazily inside openInstaller (never reached on iOS: canInstall).
import { DownloadTask, Directory, File, Paths } from "expo-file-system";
import { AppState, Platform } from "react-native";
import { installedVersion } from "./app-version";
import { HASH_CHUNK_BYTES } from "./phone-update";
import type { PhoneUpdateDeps } from "./phone-update-store";

// Declared locally, as native-recording-files.ts does.
declare function require(id: string): unknown;

type IntentLauncher = {
  startActivityAsync(
    action: string,
    params: { data: string; type: string; flags: number },
  ): Promise<unknown>;
};

const APK_MIME = "application/vnd.android.package-archive";
/** Intent.FLAG_GRANT_READ_URI_PERMISSION */
const GRANT_READ_URI = 1;

async function* readChunks(path: string): AsyncIterable<Uint8Array> {
  const file = new File(path);
  const size = file.size;
  const handle = file.open();
  try {
    let read = 0;
    while (read < size) {
      const bytes = handle.readBytes(Math.min(HASH_CHUNK_BYTES, size - read));
      if (bytes.length === 0) throw new Error("short read");
      read += bytes.length;
      yield bytes;
      // Let the UI render between chunks of a long hash.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    handle.close();
  }
}

export function createPhoneUpdateDeps(): PhoneUpdateDeps {
  return {
    platform: Platform.OS,
    current: installedVersion(),
    fetch: (url, init) => globalThis.fetch(url, init),
    async download(url, dest, onProgress) {
      const task = new DownloadTask(url, new File(dest), {
        onProgress: ({ bytesWritten, totalBytes }) => onProgress(bytesWritten, totalBytes),
      });
      const file = await task.downloadAsync();
      if (file === null) throw new Error("paused");
    },
    readChunks,
    fileExists(path) {
      try {
        return new File(path).exists;
      } catch {
        return false;
      }
    },
    deleteFile(path) {
      try {
        const file = new File(path);
        if (file.exists) file.delete();
      } catch {
        // deleteFile never throws.
      }
    },
    listCache() {
      try {
        return new Directory(Paths.cache).list().map((entry) => entry.name);
      } catch {
        return [];
      }
    },
    cacheDir: Paths.cache.uri,
    async openInstaller(path) {
      const launcher = require("expo-intent-launcher") as IntentLauncher;
      await launcher.startActivityAsync("android.intent.action.VIEW", {
        data: new File(path).contentUri,
        type: APK_MIME,
        flags: GRANT_READ_URI,
      });
    },
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
