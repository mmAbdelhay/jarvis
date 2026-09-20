// Tests `buildNotificationsAdapter` — the pure-loader builder that maps
// `expo-notifications`' own shapes onto `NotificationsAdapter`
// (notifications.ts), the same pattern native-speaker.test.ts uses for
// `buildSpeaker`. No `require("expo-notifications")` here: the loader
// hands in a fake `NativeModules` bundle instead.
import { describe, expect, test, vi } from "vitest";
import {
  ANDROID_CHANNEL_ID,
  buildNotificationsAdapter,
  type NativeModules,
  type NativeNotificationResponse,
  type PermissionResponse,
} from "./native-notifications";

function permission(
  status: "undetermined" | "granted" | "denied",
  granted: boolean,
  canAskAgain: boolean,
): PermissionResponse {
  return { status, granted, canAskAgain };
}

function createFakeModules(overrides: Partial<NativeModules["Notifications"]> = {}): NativeModules {
  return {
    Notifications: {
      getPermissionsAsync: vi.fn(async () => permission("undetermined", false, true)),
      requestPermissionsAsync: vi.fn(async () => permission("undetermined", false, true)),
      setNotificationChannelAsync: vi.fn(async () => {}),
      getExpoPushTokenAsync: vi.fn(async () => ({ data: "ExponentPushToken[abc12345]" })),
      setAutoServerRegistrationEnabledAsync: vi.fn(async () => {}),
      addPushTokenListener: vi.fn(() => ({ remove: vi.fn() })),
      addNotificationResponseReceivedListener: vi.fn(() => ({ remove: vi.fn() })),
      getLastNotificationResponseAsync: vi.fn(async () => null),
      setNotificationHandler: vi.fn(),
      AndroidImportance: { DEFAULT: 3 },
      ...overrides,
    },
    Device: { isDevice: true },
    Constants: { expoConfig: { extra: { eas: { projectId: "proj-1" } } } },
    Platform: { OS: "ios" },
  };
}

describe("buildNotificationsAdapter: permission mapping (rule 9)", () => {
  test.each([
    [
      "undetermined status always answers undetermined",
      "undetermined",
      false,
      true,
      "undetermined",
    ],
    ["undetermined status even when granted is true", "undetermined", true, true, "undetermined"],
    ["granted -> granted", "granted", true, true, "granted"],
    ["!granted && canAskAgain -> denied", "denied", false, true, "denied"],
    ["!granted && !canAskAgain -> blocked", "denied", false, false, "blocked"],
  ] as const)("%s", async (_label, status, granted, canAskAgain, expected) => {
    const modules = createFakeModules({
      getPermissionsAsync: vi.fn(async () => permission(status, granted, canAskAgain)),
      requestPermissionsAsync: vi.fn(async () => permission(status, granted, canAskAgain)),
    });
    const adapter = buildNotificationsAdapter(() => modules);

    await expect(adapter.getPermission()).resolves.toBe(expected);
    await expect(adapter.requestPermission()).resolves.toBe(expected);
  });
});

describe("buildNotificationsAdapter: token", () => {
  test("getExpoPushToken reads .data off getExpoPushTokenAsync's result", async () => {
    const modules = createFakeModules({
      getExpoPushTokenAsync: vi.fn(async (options: { projectId: string }) => {
        expect(options).toEqual({ projectId: "proj-1" });
        return { data: "ExponentPushToken[xyz98765]" };
      }),
    });
    const adapter = buildNotificationsAdapter(() => modules);

    await expect(adapter.getExpoPushToken("proj-1")).resolves.toBe("ExponentPushToken[xyz98765]");
  });

  test("onTokenChanged deduplicates raw device tokens and never fetches an Expo token [bite-proof: drop the dedupe]", async () => {
    const remove = vi.fn();
    let rotationCb: ((event: { data: string }) => void) | undefined;
    const getExpoPushTokenAsync = vi.fn(async () => ({ data: "ExponentPushToken[unexpected]" }));
    const modules = createFakeModules({
      getExpoPushTokenAsync,
      addPushTokenListener: vi.fn((cb: (event: { data: string }) => void) => {
        rotationCb = cb;
        return { remove };
      }),
    });
    const adapter = buildNotificationsAdapter(() => modules);

    let rotations = 0;
    const unsubscribe = adapter.onTokenChanged(() => {
      rotations += 1;
    });
    expect(rotationCb).toBeDefined();

    // The native event itself is never passed to this callback — only the
    rotationCb?.({ data: "raw-device-token" });
    rotationCb?.({ data: "raw-device-token" });
    rotationCb?.({ data: "new-raw-device-token" });

    expect(getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(rotations).toBe(2);

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("onTokenChanged ignores repeated raw device tokens", async () => {
    let rotationCb: ((event: { data: string }) => void) | undefined;
    const getExpoPushTokenAsync = vi.fn(async () => ({ data: "unexpected" }));
    const modules = createFakeModules({
      getExpoPushTokenAsync,
      addPushTokenListener: vi.fn((cb: (event: { data: string }) => void) => {
        rotationCb = cb;
        return { remove: vi.fn() };
      }),
    });
    const adapter = buildNotificationsAdapter(() => modules);

    let rotations = 0;
    adapter.onTokenChanged(() => {
      rotations += 1;
    });
    rotationCb?.({ data: "rotated" });
    rotationCb?.({ data: "rotated" });

    expect(getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(rotations).toBe(1);
  });

  test("onTokenChanged signals a new raw device token even when projectId() is unavailable", async () => {
    let rotationCb: ((event: { data: string }) => void) | undefined;
    const getExpoPushTokenAsync = vi.fn(async () => ({ data: "ExponentPushToken[should-not]" }));
    const modules = createFakeModules({
      getExpoPushTokenAsync,
      addPushTokenListener: vi.fn((cb: (event: { data: string }) => void) => {
        rotationCb = cb;
        return { remove: vi.fn() };
      }),
    });
    modules.Constants = {};
    const adapter = buildNotificationsAdapter(() => modules);

    let rotations = 0;
    adapter.onTokenChanged(() => {
      rotations += 1;
    });
    rotationCb?.({ data: "rotated" });

    expect(getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(rotations).toBe(1);
  });
});

describe("buildNotificationsAdapter: android channel", () => {
  test("ensureAndroidChannel calls setNotificationChannelAsync with ANDROID_CHANNEL_ID and DEFAULT importance", async () => {
    const setNotificationChannelAsync = vi.fn(async () => {});
    const modules = createFakeModules({ setNotificationChannelAsync });
    const adapter = buildNotificationsAdapter(() => modules);

    await adapter.ensureAndroidChannel("Jarvis");

    expect(setNotificationChannelAsync).toHaveBeenCalledWith(ANDROID_CHANNEL_ID, {
      name: "Jarvis",
      importance: 3,
    });
  });
});

describe("buildNotificationsAdapter: onResponse", () => {
  test("maps the notification's identifier and content.data", () => {
    const native: NativeNotificationResponse = {
      notification: {
        request: {
          identifier: "notif-1",
          content: { data: { kind: "session-done", sessionId: "s1" } },
        },
      },
    };
    const modules = createFakeModules({
      addNotificationResponseReceivedListener: vi.fn(
        (cb: (response: NativeNotificationResponse) => void) => {
          cb(native);
          return { remove: vi.fn() };
        },
      ),
    });
    const adapter = buildNotificationsAdapter(() => modules);

    let seen: { id: string; data: unknown } | undefined;
    adapter.onResponse((response) => {
      seen = response;
    });

    expect(seen).toEqual({ id: "notif-1", data: { kind: "session-done", sessionId: "s1" } });
  });
});

describe("buildNotificationsAdapter: lastResponse", () => {
  test("maps a real response", async () => {
    const modules = createFakeModules({
      getLastNotificationResponseAsync: vi.fn(async () => ({
        notification: {
          request: { identifier: "notif-2", data: undefined, content: { data: { kind: "reply" } } },
        },
      })),
    });
    const adapter = buildNotificationsAdapter(() => modules);

    await expect(adapter.lastResponse()).resolves.toEqual({
      id: "notif-2",
      data: { kind: "reply" },
    });
  });

  test("null answers undefined", async () => {
    const modules = createFakeModules({
      getLastNotificationResponseAsync: vi.fn(async () => null),
    });
    const adapter = buildNotificationsAdapter(() => modules);

    await expect(adapter.lastResponse()).resolves.toBeUndefined();
  });

  test(
    "a fake module missing getLastNotificationResponseAsync answers undefined " +
      "rather than throwing",
    async () => {
      // Simulates an older native module build that doesn't export this
      // function at all — not merely one that returns null.
      const modules = createFakeModules({ getLastNotificationResponseAsync: undefined });
      const adapter = buildNotificationsAdapter(() => modules);

      await expect(adapter.lastResponse()).resolves.toBeUndefined();
    },
  );
});

describe("buildNotificationsAdapter: device / project / platform", () => {
  test("isDevice reads Device.isDevice", () => {
    const modules = createFakeModules();
    modules.Device.isDevice = false;
    const adapter = buildNotificationsAdapter(() => modules);
    expect(adapter.isDevice()).toBe(false);
  });

  test("projectId reads Constants.expoConfig.extra.eas.projectId, undefined when absent", () => {
    const withId = createFakeModules();
    expect(buildNotificationsAdapter(() => withId).projectId()).toBe("proj-1");

    const without = createFakeModules();
    without.Constants = {};
    expect(buildNotificationsAdapter(() => without).projectId()).toBeUndefined();
  });

  test("platform maps Platform.OS, defaulting to android for anything but ios", () => {
    const ios = createFakeModules();
    ios.Platform = { OS: "ios" };
    expect(buildNotificationsAdapter(() => ios).platform()).toBe("ios");

    const android = createFakeModules();
    android.Platform = { OS: "android" };
    expect(buildNotificationsAdapter(() => android).platform()).toBe("android");
  });
});

describe("buildNotificationsAdapter: setForegroundHandler", () => {
  test("calls Notifications.setNotificationHandler once", () => {
    const setNotificationHandler = vi.fn();
    const modules = createFakeModules({ setNotificationHandler });
    const adapter = buildNotificationsAdapter(() => modules);

    adapter.setForegroundHandler();

    expect(setNotificationHandler).toHaveBeenCalledTimes(1);
  });
});
