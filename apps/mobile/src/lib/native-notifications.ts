// The real `expo-notifications` adapter (M10 Task 5, rule 9) — the same
// "loader + pure builder" split native-speaker.ts uses for `expo-speech`:
// `createNativeNotificationsAdapter` (below, native-only, not unit tested —
// global constraint) loads the four native modules this adapter needs with
// `require` inside functions, and hands them to `buildNotificationsAdapter`,
// which IS unit-tested (native-notifications.test.ts) against a fake
// `NativeModules` bundle.
//
// Security review item: every native module load happens inside a
// function, never at module top level, so a static `import` of this file
// (e.g. from push-registration.ts's type-only usage) never reaches a
// native module during a Vitest run.
import type { NotificationResponse, NotificationsAdapter, PushPermission } from "./notifications";
import { ANDROID_CHANNEL_ID } from "./push-registration";

// Declared locally, not imported from `@types/node` — see
// native-transport.ts's identical declaration and its comment.
declare function require(id: string): unknown;

export { ANDROID_CHANNEL_ID };

export type PermissionResponse = {
  status: "undetermined" | "granted" | "denied";
  granted: boolean;
  canAskAgain: boolean;
};

export type NativeNotificationResponse = {
  notification: {
    request: {
      identifier: string;
      content: { data: unknown };
    };
  };
};

export type NotificationsModule = {
  getPermissionsAsync(): Promise<PermissionResponse>;
  requestPermissionsAsync(): Promise<PermissionResponse>;
  setNotificationChannelAsync(
    id: string,
    channel: { name: string; importance: number },
  ): Promise<unknown>;
  getExpoPushTokenAsync(options: { projectId: string }): Promise<{ data: string }>;
  setAutoServerRegistrationEnabledAsync(enabled: boolean): Promise<void>;
  addPushTokenListener(listener: (event: { data: string }) => void): { remove(): void };
  addNotificationResponseReceivedListener(
    listener: (response: NativeNotificationResponse) => void,
  ): { remove(): void };
  // Optional: the security-review bite-proof (test: "a fake module missing
  // getLastNotificationResponseAsync answers undefined rather than
  // throwing") guards against an older native build that doesn't export
  // this function at all.
  getLastNotificationResponseAsync?(): Promise<NativeNotificationResponse | null | undefined>;
  setNotificationHandler(handler: {
    handleNotification: () => Promise<{
      shouldShowBanner: boolean;
      shouldShowList: boolean;
      shouldPlaySound: boolean;
      shouldSetBadge: boolean;
    }>;
  }): void;
  AndroidImportance: { DEFAULT: number };
};

export type DeviceModule = { isDevice: boolean };
export type ConstantsModule = { expoConfig?: { extra?: { eas?: { projectId?: string } } } };
export type PlatformModule = { OS: string };

export type NativeModules = {
  Notifications: NotificationsModule;
  Device: DeviceModule;
  Constants: ConstantsModule;
  Platform: PlatformModule;
};

function loadNativeModules(): NativeModules {
  return {
    Notifications: require("expo-notifications") as NotificationsModule,
    Device: require("expo-device") as DeviceModule,
    Constants: (require("expo-constants") as { default: ConstantsModule }).default,
    Platform: (require("react-native") as { Platform: PlatformModule }).Platform,
  };
}

/** Rule 9's mapping table: an `undetermined` status always answers
 * `undetermined` regardless of `granted`/`canAskAgain`; otherwise `granted`
 * wins, then `canAskAgain` decides `denied` vs `blocked`. */
function mapPermission(response: PermissionResponse): PushPermission {
  if (response.status === "undetermined") return "undetermined";
  if (response.granted) return "granted";
  return response.canAskAgain ? "denied" : "blocked";
}

function getProjectId(modules: NativeModules): string | undefined {
  return modules.Constants.expoConfig?.extra?.eas?.projectId;
}

function mapResponse(response: NativeNotificationResponse): NotificationResponse {
  return {
    id: response.notification.request.identifier,
    data: response.notification.request.content.data,
  };
}

/** Builds the `NotificationsAdapter` over an already-obtained
 * `NativeModules` bundle — see the file header for why this is separate
 * from `createNativeNotificationsAdapter`. */
export function buildNotificationsAdapter(getModules: () => NativeModules): NotificationsAdapter {
  return {
    async getPermission(): Promise<PushPermission> {
      const { Notifications } = getModules();
      return mapPermission(await Notifications.getPermissionsAsync());
    },

    async requestPermission(): Promise<PushPermission> {
      const { Notifications } = getModules();
      return mapPermission(await Notifications.requestPermissionsAsync());
    },

    isDevice(): boolean {
      return getModules().Device.isDevice;
    },

    projectId(): string | undefined {
      return getProjectId(getModules());
    },

    async ensureAndroidChannel(name: string): Promise<void> {
      const { Notifications } = getModules();
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
        name,
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    },

    async getExpoPushToken(projectId: string): Promise<string> {
      const { Notifications } = getModules();
      const result = await Notifications.getExpoPushTokenAsync({ projectId });
      return result.data;
    },

    async setAutoServerRegistrationEnabled(enabled: boolean): Promise<void> {
      const { Notifications } = getModules();
      await Notifications.setAutoServerRegistrationEnabledAsync(enabled);
    },

    // The native event carries the raw APNs/FCM device token. Keep only the
    // last raw value in this adapter closure: expo-notifications emits this
    // event again from every getExpoPushTokenAsync call, so an unchanged
    // value is not a rotation. The raw token never crosses this boundary.
    onTokenChanged(cb: () => void): () => void {
      const { Notifications } = getModules();
      let lastRawDeviceToken: string | undefined;
      const subscription = Notifications.addPushTokenListener((event) => {
        if (event.data === lastRawDeviceToken) return;
        lastRawDeviceToken = event.data;
        cb();
      });
      return () => subscription.remove();
    },

    onResponse(cb: (response: NotificationResponse) => void): () => void {
      const { Notifications } = getModules();
      const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
        cb(mapResponse(response));
      });
      return () => subscription.remove();
    },

    async lastResponse(): Promise<NotificationResponse | undefined> {
      const { Notifications } = getModules();
      if (typeof Notifications.getLastNotificationResponseAsync !== "function") {
        return undefined;
      }
      const response = await Notifications.getLastNotificationResponseAsync();
      if (response === null || response === undefined) return undefined;
      return mapResponse(response);
    },

    setForegroundHandler(): void {
      const { Notifications } = getModules();
      // Foreground presentation only — this is the phone's own OS
      // notification tray while the app is in the foreground, never a
      // sound the app plays itself (no ruling in this SDD folder pins the
      // exact fields; this mirrors Expo's documented default of showing
      // the banner without sound or a badge count, since this app has no
      // unread-count concept).
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
      });
    },

    platform(): "ios" | "android" {
      return getModules().Platform.OS === "ios" ? "ios" : "android";
    },
  };
}

export function createNativeNotificationsAdapter(): NotificationsAdapter {
  return buildNotificationsAdapter(loadNativeModules);
}
