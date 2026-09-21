// The impure edge of provisioning-expiry.ts (free-signing plan, work
// item 3) — same loader discipline as native-notifications.ts: native
// modules are `require`d inside functions, never at module top level, so
// importing this file from a test never touches a native module. All
// notification work goes through the NotificationsAdapter (rule 11's
// guard: `expo-notifications` itself is only ever loaded by
// native-notifications.ts). Not unit tested (global constraint: native
// loaders aren't); the logic it drives lives, tested, in
// provisioning-expiry.ts.
import type { Language } from "./i18n";
import { t } from "./i18n";
import { createNativeNotificationsAdapter } from "./native-notifications";
import type { ExpiryWarningState } from "./provisioning-expiry";
import { armExpiryWarning, loadProvisioningExpiry } from "./provisioning-expiry";

declare function require(id: string): unknown;

type LegacyFileSystem = {
  bundleDirectory: string | null;
  readAsStringAsync(uri: string, options: { encoding: "base64" }): Promise<string>;
};

/** Reads a file out of the app bundle as base64; `undefined` when the
 * file does not exist (App Store builds and simulators have no
 * embedded.mobileprovision) or the platform has no bundle directory. */
async function readBundleFileBase64(name: string): Promise<string | undefined> {
  try {
    // The legacy expo-file-system API: the SDK 54+ class API has no
    // bundle-directory handle, the legacy one still does.
    const fs = require("expo-file-system/legacy") as LegacyFileSystem;
    const dir = fs.bundleDirectory;
    if (dir === null || dir === undefined) return undefined;
    return await fs.readAsStringAsync(dir + name, { encoding: "base64" });
  } catch {
    return undefined;
  }
}

// One pass per app launch: the Dashboard calls this from every focus, the
// cache makes all but the first a no-op. The profile cannot change while
// the app is running — a refresh reinstalls the bundle.
let armed: Promise<ExpiryWarningState> | undefined;

export function armNativeExpiryWarning(language: Language): Promise<ExpiryWarningState> {
  if (armed !== undefined) return armed;
  armed = (async (): Promise<ExpiryWarningState> => {
    const adapter = createNativeNotificationsAdapter();
    return armExpiryWarning({
      now: () => new Date(),
      loadExpiry: () =>
        loadProvisioningExpiry({ platform: adapter.platform(), readBundleFileBase64 }),
      getPermission: () => adapter.getPermission(),
      scheduleLocal: (input) => adapter.scheduleLocal(input),
      cancelScheduledLocal: (identifier) => adapter.cancelScheduledLocal(identifier),
      strings: {
        title: t(language, "expiry.notification.title"),
        body: t(language, "expiry.notification.body"),
      },
    });
  })();
  return armed;
}
