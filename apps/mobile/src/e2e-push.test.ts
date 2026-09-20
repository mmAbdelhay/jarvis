// M10 Task 7's phone-side end-to-end scenario, in the style of
// e2e-voice.test.ts/workspace.e2e.test.ts: the real `createRpcClient` and
// `createPushRegistration` over a `FakeTransport`, a fake `NotificationsAdapter`
// and an in-memory `PrefsStore` — only the native-adjacent edge (the
// notifications adapter itself: permission prompts, the Expo token, tap
// events) is faked.
//
// `push-context.tsx` (the real `PushProvider`) cannot be imported under this
// repo's Node-environment Vitest config — it pulls in `expo-router` at
// module scope and fails to load at all (see push-context-support.ts's own
// header, and push-context-support.test.ts, which already tests its pure
// pieces the same way). This file drives those same real, exported pieces —
// `createPushRegistration`, `createPrefsFacade`, `waitForOpen`,
// `recordHandledId`, `planNavigation`, `parseSessionList` — composed the
// same way `PushProvider`'s own `handle()` composes them, over a real
// `RpcClient` end to end.
//
import {
  encodeMessage,
  PROTOCOL_VERSION,
  PUSH_REGISTER_CHANNEL,
  PUSH_UNREGISTER_CHANNEL,
} from "@jarvis/wire";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "./lib/clock";
import type { FakeSocket } from "./lib/fake-transport";
import { createFakeTransport } from "./lib/fake-transport";
import { NOTIFICATION_NAV_WAIT_MS } from "./lib/notification-tap";
import type {
  NotificationResponse,
  NotificationsAdapter,
  PushPermission,
} from "./lib/notifications";
import type { Prefs, PrefsStore } from "./lib/prefs";
import { createPrefsFacade, handleNotificationTap, waitForOpen } from "./lib/push-context-support";
import { createPushRegistration, type PushRegistrationDeps } from "./lib/push-registration";
import type { Credential, Endpoint } from "./lib/rpc-client";
import { createRpcClient } from "./lib/rpc-client";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const CLIENT_STRING = "jarvis-mobile/1.0.0/ios";
const EXPO_TOKEN = `ExponentPushToken[${"z".repeat(20)}]`;
const LOCALE_TAG = "en-US";

type Frame = { t: string; id?: number; ch?: string; a?: unknown[]; add?: unknown[] };

function frames(socket: FakeSocket): Frame[] {
  return socket.sent.map((text) => JSON.parse(text) as Frame);
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

function reqsFor(socket: FakeSocket, ch: string): Frame[] {
  return frames(socket).filter((f) => f.t === "req" && f.ch === ch);
}

function answer(socket: FakeSocket, ch: string, value: unknown, at = -1): void {
  const matches = reqsFor(socket, ch);
  const req = at === -1 ? matches.at(-1) : matches[at];
  if (req === undefined) throw new Error(`no req for ${ch}`);
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "res", id: req.id as number, v: value }),
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

// --- an in-memory PrefsStore, the same shape push-context-support.test.ts's
// own FakeStore uses, wired through the real createPrefsFacade so this test
// exercises the real load/save round trip rather than a hand-rolled cache.
class InMemoryPrefsStore implements PrefsStore {
  private text: string | undefined;
  read(): Promise<string | undefined> {
    return Promise.resolve(this.text);
  }
  write(text: string): Promise<void> {
    this.text = text;
    return Promise.resolve();
  }
  raw(): string | undefined {
    return this.text;
  }
}

function createFakeAdapter(): NotificationsAdapter & {
  responseListeners: Set<(response: NotificationResponse) => void>;
} {
  const responseListeners = new Set<(response: NotificationResponse) => void>();
  return {
    getPermission: vi.fn(async () => "undetermined" as PushPermission),
    requestPermission: vi.fn(async () => "granted" as PushPermission),
    isDevice: vi.fn(() => true),
    projectId: vi.fn(() => "proj-1"),
    ensureAndroidChannel: vi.fn(async () => {}),
    getExpoPushToken: vi.fn(async () => EXPO_TOKEN),
    onTokenChanged: vi.fn(() => () => {}),
    onResponse: vi.fn((cb: (response: NotificationResponse) => void) => {
      responseListeners.add(cb);
      return () => responseListeners.delete(cb);
    }),
    lastResponse: vi.fn(async () => undefined),
    setForegroundHandler: vi.fn(),
    platform: vi.fn(() => "ios" as const),
    setAutoServerRegistrationEnabled: vi.fn(async () => {}),
    responseListeners,
  };
}

describe("push scenario over the real client and controller", () => {
  it(
    "stays off until the switch is on, registers, re-registers across a reconnect, " +
      "navigates a tap only after validating it against the live session list, " +
      "and unregisters on the switch going off — without ever logging either token",
    async () => {
      const transport = createFakeTransport();
      const clock = createFakeClock();
      const logs: string[] = [];
      const adapter = createFakeAdapter();
      const prefsStore = new InMemoryPrefsStore();
      const router: { pushed: string[] } = { pushed: [] };

      const client = createRpcClient({
        transport,
        clock,
        random: () => 0.5,
        client: CLIENT_STRING,
        log: (line) => logs.push(line),
      });

      const prefs: PushRegistrationDeps["prefs"] = createPrefsFacade(prefsStore, LOCALE_TAG, {
        notifications: false,
        pushRegistered: false,
      });
      const registration = createPushRegistration({
        client,
        adapter,
        prefs,
        language: () => "en",
        channelName: () => "Jarvis",
        log: (line) => logs.push(line),
      });

      // --- 1. Fresh prefs: construction is a no-op, and "open" alone never
      // registers anything while notifications are off. ---
      expect(adapter.requestPermission).not.toHaveBeenCalled();
      expect(adapter.getExpoPushToken).not.toHaveBeenCalled();

      // Minor: whenNotOpen:"reject" — a register call made before the
      // socket has ever been open is refused immediately, never queued for
      // a later connect. push-registration.ts's own register() never even
      // reaches client.call while closed (it short-circuits first), so
      // this proves the wire primitive it would rely on doesn't queue
      // either — the "no remote:registerPush frame yet" check right after
      // welcome, below, confirms nothing from this call survived to be
      // sent late.
      const closedResult = await client.call(
        PUSH_REGISTER_CHANNEL,
        [{ token: EXPO_TOKEN, platform: "ios", language: "en" }],
        { whenNotOpen: "reject" },
      );
      expect(closedResult).toEqual({ ok: false, error: { kind: "offline" } });

      client.connect(ENDPOINT, CREDENTIAL);
      let socket = latestSocket(transport);
      socket.emit({ kind: "open" });
      expect(frames(socket)[0]).toMatchObject({
        t: "hello",
        v: PROTOCOL_VERSION,
        deviceId: CREDENTIAL.deviceId,
        token: CREDENTIAL.token,
      });
      socket.emit({
        kind: "message",
        text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: [] }),
      });
      expect(client.state()).toBe("open");
      await flush();
      expect(reqsFor(socket, PUSH_REGISTER_CHANNEL)).toEqual([]);
      expect(adapter.requestPermission).not.toHaveBeenCalled();
      expect(adapter.getExpoPushToken).not.toHaveBeenCalled();

      // --- 2. setNotifications(true) (settings-store.ts's own setNotifications
      // is a pure `deps.push.setEnabled(on)` passthrough — confirmed by
      // reading its source; calling setEnabled directly here exercises the
      // exact same path without pulling in the rest of createSettingsStore's
      // pairing/connection-store machinery, which this scenario never
      // touches). ---
      const enabling = registration.setEnabled(true);
      await flush();
      expect(adapter.requestPermission).toHaveBeenCalledTimes(1);
      expect(adapter.getExpoPushToken).toHaveBeenCalledTimes(1);
      const registerReq1 = reqsFor(socket, PUSH_REGISTER_CHANNEL).at(-1);
      expect(registerReq1).toBeDefined();
      expect(registerReq1?.a).toEqual([{ token: EXPO_TOKEN, platform: "ios", language: "en" }]);
      answer(socket, PUSH_REGISTER_CHANNEL, { registered: true, laptopEnabled: true });
      await enabling;
      await flush();
      expect(registration.get()).toMatchObject({
        phase: "on",
        registered: true,
        laptopEnabled: true,
      });
      expect(reqsFor(socket, PUSH_REGISTER_CHANNEL)).toHaveLength(1);

      // --- 3. Socket drop (1006); reconnect -> after welcome, the register
      // req appears again, exactly once, and nothing else precedes it (no
      // screen ever subscribes to anything in this isolated scenario, so
      // "before any screen subscription" holds trivially here — proven for
      // real by e2e.test.ts's own reconnect step, which shows the client's
      // own re-subscription frame landing right after welcome too). ---
      socket.emit({ kind: "close", code: 1006, reason: "drop" });
      clock.advance(1000);
      socket = latestSocket(transport);
      socket.emit({ kind: "open" });
      socket.emit({
        kind: "message",
        text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: [] }),
      });
      await flush();
      const registerReq2 = reqsFor(socket, PUSH_REGISTER_CHANNEL).at(-1);
      expect(registerReq2).toBeDefined();
      answer(socket, PUSH_REGISTER_CHANNEL, { registered: true, laptopEnabled: true });
      await flush();
      expect(reqsFor(socket, PUSH_REGISTER_CHANNEL)).toHaveLength(1);
      expect(registration.get()).toMatchObject({ phase: "on", registered: true });

      // --- 4. A tapped notification: waits for "open" (already open here),
      // fetches sessions:list, plans a route only from the validated
      // response, and hands it to a recording router. Mirrors
      // push-context.tsx's PushProvider.handle(), reusing the same exported
      // building blocks as the provider. ---
      const handledIds = new Set<string>();
      const handleTap = (response: NotificationResponse) =>
        handleNotificationTap(
          {
            client,
            router: { push: (route) => router.pushed.push(route) },
            handledIds,
            waitForOpen: (tapClient) => waitForOpen(tapClient, NOTIFICATION_NAV_WAIT_MS),
          },
          response,
        );

      const rows = [
        {
          id: "s1",
          project: null,
          projectPath: "/p",
          agentId: "a",
          state: "running",
          summary: "x",
          startedAt: 0,
          lastActivityAt: 0,
        },
      ];

      const p1 = handleTap({ id: "n1", data: { kind: "session-done", sessionId: "s1" } });
      await flush();
      answer(socket, "sessions:list", rows);
      await p1;
      expect(router.pushed).toEqual(["/session/s1"]);

      // The same id again: recordHandledId refuses it — no second
      // sessions:list call, no second navigation.
      const sessionsListCountBefore = reqsFor(socket, "sessions:list").length;
      await handleTap({ id: "n1", data: { kind: "session-done", sessionId: "s1" } });
      await flush();
      expect(reqsFor(socket, "sessions:list")).toHaveLength(sessionsListCountBefore);
      expect(router.pushed).toEqual(["/session/s1"]);

      // A session id the laptop's list does not contain: no navigation.
      const p2 = handleTap({ id: "n2", data: { kind: "session-done", sessionId: "s9" } });
      await flush();
      answer(socket, "sessions:list", rows);
      await p2;
      expect(router.pushed).toEqual(["/session/s1"]);

      // [bite-proof: navigate before validating] Data that fails
      // parsePushData (no `kind` at all) never reaches the wire.
      const sessionsListCountFinal = reqsFor(socket, "sessions:list").length;
      await handleTap({ id: "n3", data: { url: "jarvis://session/s1" } });
      await flush();
      expect(reqsFor(socket, "sessions:list")).toHaveLength(sessionsListCountFinal);
      expect(router.pushed).toEqual(["/session/s1"]);

      // --- 5. setNotifications(false) -> unregister; prefs pushRegistered:false. ---
      const disabling = registration.setEnabled(false);
      await flush();
      const unregisterReq = reqsFor(socket, PUSH_UNREGISTER_CHANNEL).at(-1);
      expect(unregisterReq).toBeDefined();
      answer(socket, PUSH_UNREGISTER_CHANNEL, undefined);
      await disabling;
      await flush();
      expect(registration.get()).toMatchObject({ phase: "off", registered: false });
      const savedRaw = prefsStore.raw();
      expect(savedRaw).toBeDefined();
      const saved = JSON.parse(savedRaw ?? "{}") as Prefs;
      expect(saved.pushRegistered).toBe(false);

      // --- 6. Neither the credential token nor the push token ever appears
      // in a log line, across the whole scenario. ---
      const joined = logs.join("\n");
      expect(joined).not.toContain(CREDENTIAL.token);
      expect(joined).not.toContain(EXPO_TOKEN);

      registration.dispose();
    },
  );
});
