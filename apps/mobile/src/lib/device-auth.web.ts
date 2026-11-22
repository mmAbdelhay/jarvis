// The browser build's device-owner gate (Task 13), in place of
// expo-local-authentication: no OS prompt exists, so the gate is the
// owner's "Keep me signed in on this browser" setting (prefs,
// web-device-auth.ts has the logic). Same export as device-auth.ts, so
// the root layout wires it unchanged; the prompt text is unused here.
import type { DeviceAuth } from "./auth-session";
import { keepSignedInFor } from "./machine-view";
import { IN_MACHINE_VIEW } from "./machine-view-env";
import { loadPrefs } from "./prefs";
import { filePrefsStore } from "./prefs-file";
import { createWebDeviceAuth } from "./web-device-auth";

export function createDeviceAuth(_prompt: () => string): DeviceAuth {
  // A Jarvis window (machine view) always keeps its sign-in; anywhere else
  // the owner's own choice, unchanged.
  return createWebDeviceAuth(async () =>
    keepSignedInFor(
      IN_MACHINE_VIEW,
      (await loadPrefs(filePrefsStore, Intl.DateTimeFormat().resolvedOptions().locale))
        .keepSignedIn,
    ),
  );
}
