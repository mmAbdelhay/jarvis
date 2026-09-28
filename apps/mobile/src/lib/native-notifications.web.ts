// The browser build's notifications adapter (Task 13): a no-op. Push is a
// native-app feature (Expo push tokens); in the browser `isDevice()` is
// false, which push-registration.ts already treats as "never register",
// and permission reads as "denied" so nothing ever prompts.
import type { NotificationsAdapter } from "./notifications";

export function createNativeNotificationsAdapter(): NotificationsAdapter {
  return {
    getPermission: async () => "denied",
    requestPermission: async () => "denied",
    isDevice: () => false,
    projectId: () => undefined,
    ensureAndroidChannel: async () => {},
    getExpoPushToken: async () => {
      throw new Error("push is not available in the browser");
    },
    setAutoServerRegistrationEnabled: async () => {},
    onTokenChanged: () => () => {},
    onResponse: () => () => {},
    lastResponse: async () => undefined,
    setForegroundHandler: () => {},
    platform: () => "android",
  };
}
