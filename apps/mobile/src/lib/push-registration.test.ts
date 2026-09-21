// task-5-brief.md, "Tests: push-registration.test.ts" — fake adapter, fake
// client with a scripted `call`, in-memory prefs.
import { PUSH_REGISTER_CHANNEL, PUSH_UNREGISTER_CHANNEL } from "@jarvis/wire";
import { describe, expect, test, vi } from "vitest";
import type { NotificationResponse, NotificationsAdapter, PushPermission } from "./notifications";
import {
  ANDROID_CHANNEL_ID,
  PUSH_REGISTER_TIMEOUT_MS,
  type PushPrefs,
  type PushRegistrationDeps,
  createPushRegistration,
} from "./push-registration";
import type { CallOptions, ClientState, RpcClient, RpcResult } from "./rpc-client";

type StateHandler = (state: ClientState, detail: Record<string, unknown>) => void;

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

type ScriptedCall = (channel: string, args: unknown[], options?: CallOptions) => Promise<RpcResult>;

function createFakeClient(initial: ClientState = "closed") {
  let state: ClientState = initial;
  const handlers = new Set<StateHandler>();
  const calls: { channel: string; args: unknown[]; options?: CallOptions }[] = [];
  let scripted: ScriptedCall = async () => ({ ok: false, error: { kind: "offline" } });

  const client: Pick<RpcClient, "call" | "onState" | "state"> = {
    call: async (channel, args, options) => {
      calls.push({ channel, args, options });
      return scripted(channel, args, options);
    },
    onState: (handler: StateHandler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    state: () => state,
  };

  return {
    client,
    calls,
    setScripted(fn: ScriptedCall) {
      scripted = fn;
    },
    setState(next: ClientState) {
      state = next;
    },
    emitOpen(detail: Record<string, unknown> = {}) {
      state = "open";
      for (const handler of [...handlers]) handler("open", detail);
    },
  };
}

function createFakeAdapter(overrides: Partial<NotificationsAdapter> = {}): NotificationsAdapter & {
  tokenListeners: Set<() => void>;
  emitToken(token: string): void;
} {
  const tokenListeners = new Set<() => void>();
  return {
    getPermission: vi.fn(async () => "undetermined" as PushPermission),
    requestPermission: vi.fn(async () => "granted" as PushPermission),
    isDevice: vi.fn(() => true),
    projectId: vi.fn(() => "proj-1"),
    ensureAndroidChannel: vi.fn(async () => {}),
    getExpoPushToken: vi.fn(async () => "ExponentPushToken[abc12345]"),
    onTokenChanged: vi.fn((cb: () => void) => {
      tokenListeners.add(cb);
      return () => tokenListeners.delete(cb);
    }),
    onResponse: vi.fn((_cb: (response: NotificationResponse) => void) => () => {}),
    lastResponse: vi.fn(async () => undefined),
    setForegroundHandler: vi.fn(),
    platform: vi.fn(() => "ios" as const),
    setAutoServerRegistrationEnabled: vi.fn(async () => {}),
    tokenListeners,
    emitToken(_token: string) {
      for (const cb of [...tokenListeners]) cb();
    },
    ...overrides,
  };
}

function createFakePrefs(initial: PushPrefs = { notifications: false, pushRegistered: false }) {
  let prefs = { ...initial };
  const sets: Partial<PushPrefs>[] = [];
  return {
    prefs: {
      get: () => prefs,
      set: async (patch: Partial<PushPrefs>) => {
        sets.push(patch);
        prefs = { ...prefs, ...patch };
      },
    },
    sets,
    current: () => prefs,
  };
}

function baseDeps(overrides: Partial<PushRegistrationDeps> = {}): {
  deps: PushRegistrationDeps;
  fakeClient: ReturnType<typeof createFakeClient>;
  fakeAdapter: ReturnType<typeof createFakeAdapter>;
  fakePrefs: ReturnType<typeof createFakePrefs>;
  logs: string[];
} {
  const fakeClient = createFakeClient();
  const fakeAdapter = createFakeAdapter();
  const fakePrefs = createFakePrefs();
  const logs: string[] = [];

  const deps: PushRegistrationDeps = {
    client: fakeClient.client,
    adapter: fakeAdapter,
    prefs: fakePrefs.prefs,
    language: () => "en",
    channelName: () => "Jarvis",
    log: (line) => logs.push(line),
    ...overrides,
  };

  return { deps, fakeClient, fakeAdapter, fakePrefs, logs };
}

describe("createPushRegistration: construction", () => {
  test(
    "nothing is called at construction " + "[bite-proof: register at construction and this fails]",
    () => {
      const { deps, fakeClient, fakeAdapter } = baseDeps();
      createPushRegistration(deps);

      expect(fakeClient.calls).toEqual([]);
      expect(fakeAdapter.requestPermission).not.toHaveBeenCalled();
      expect(fakeAdapter.getExpoPushToken).not.toHaveBeenCalled();
    },
  );
});

describe("createPushRegistration: setEnabled(true)", () => {
  test(
    "unavailable on a simulator/emulator (!isDevice) — requestPermission never called " +
      "[bite-proof: request anyway]",
    async () => {
      const { deps, fakeAdapter, fakePrefs } = baseDeps({});
      fakeAdapter.isDevice = vi.fn(() => false);
      const reg = createPushRegistration(deps);

      await reg.setEnabled(true);

      expect(reg.get().phase).toBe("unavailable");
      expect(fakeAdapter.requestPermission).not.toHaveBeenCalled();
      expect(fakePrefs.current().notifications).toBe(false);
    },
  );

  test("unavailable when projectId() is undefined", async () => {
    const { deps, fakeAdapter } = baseDeps();
    fakeAdapter.projectId = vi.fn(() => undefined);
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(reg.get().phase).toBe("unavailable");
  });

  test("denied permission -> phase denied, prefs false, no token fetch", async () => {
    const { deps, fakeAdapter, fakePrefs } = baseDeps();
    fakeAdapter.requestPermission = vi.fn(async (): Promise<PushPermission> => "denied");
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(reg.get().phase).toBe("denied");
    expect(fakePrefs.current().notifications).toBe(false);
    expect(fakeAdapter.getExpoPushToken).not.toHaveBeenCalled();
  });

  test("blocked permission -> phase blocked", async () => {
    const { deps, fakeAdapter } = baseDeps();
    fakeAdapter.requestPermission = vi.fn(async (): Promise<PushPermission> => "blocked");
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(reg.get().phase).toBe("blocked");
  });

  test("granted while open: fetches the token, registers, and reflects the result", async () => {
    const { deps, fakeClient, fakePrefs } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(fakeClient.calls).toHaveLength(1);
    expect(fakeClient.calls[0]).toEqual({
      channel: PUSH_REGISTER_CHANNEL,
      args: [{ token: "ExponentPushToken[abc12345]", platform: "ios", language: "en" }],
      options: { whenNotOpen: "reject", timeoutMs: PUSH_REGISTER_TIMEOUT_MS },
    });
    expect(reg.get()).toMatchObject({ phase: "on", laptopEnabled: false, registered: true });
    expect(fakePrefs.current()).toEqual({ notifications: true, pushRegistered: true });
  });

  test("turning notifications off while registration is pending does not resurrect registration", async () => {
    const { deps, fakeClient, fakePrefs } = baseDeps();
    fakeClient.setState("open");
    let resolveRegister: ((result: RpcResult) => void) | undefined;
    fakeClient.setScripted(async (channel) => {
      if (channel === PUSH_REGISTER_CHANNEL) {
        return new Promise<RpcResult>((resolve) => {
          resolveRegister = resolve;
        });
      }
      return { ok: true, value: undefined };
    });
    const reg = createPushRegistration(deps);

    const registerPromise = reg.setEnabled(true);
    await flush();
    expect(resolveRegister).toBeDefined();

    const disablePromise = reg.setEnabled(false);
    await flush();
    resolveRegister?.({ ok: true, value: { registered: true, laptopEnabled: false } });
    await Promise.all([registerPromise, disablePromise]);

    expect(reg.get().phase).toBe("off");
    expect(fakePrefs.current().pushRegistered).toBe(false);
    expect(
      fakeClient.calls.filter(({ channel }) => channel === PUSH_UNREGISTER_CHANNEL),
    ).toHaveLength(1);
  });

  test("turning notifications off while the registered:true prefs write is pending keeps the switch off", async () => {
    // Final re-review R1: the window after the RPC resolved but inside
    // `prefs.set({ pushRegistered: true })` — disable() lands there.
    let prefs = { notifications: false, pushRegistered: false };
    let releaseSet: (() => void) | undefined;
    const deferredPrefs = {
      get: () => prefs,
      set: async (patch: Partial<typeof prefs>) => {
        if (patch.pushRegistered === true) {
          await new Promise<void>((resolve) => {
            releaseSet = resolve;
          });
        }
        prefs = { ...prefs, ...patch };
      },
    };
    const { deps, fakeClient } = baseDeps({ prefs: deferredPrefs });
    fakeClient.setState("open");
    fakeClient.setScripted(async (channel) =>
      channel === PUSH_REGISTER_CHANNEL
        ? { ok: true, value: { registered: true, laptopEnabled: false } }
        : { ok: true, value: undefined },
    );
    const reg = createPushRegistration(deps);

    const enablePromise = reg.setEnabled(true);
    await flush();
    expect(releaseSet).toBeDefined();

    const disablePromise = reg.setEnabled(false);
    await flush();
    releaseSet?.();
    await Promise.all([enablePromise, disablePromise]);

    expect(reg.get().phase).toBe("off");
    expect(prefs.notifications).toBe(false);
  });

  test(
    "granted while closed: no call is sent; a later open sends it " +
      "[bite-proof: register on a timer — the test advances no clock and asserts " +
      "the call happened only after open]",
    async () => {
      const { deps, fakeClient } = baseDeps();
      fakeClient.setState("closed");
      const reg = createPushRegistration(deps);

      await reg.setEnabled(true);

      expect(fakeClient.calls).toEqual([]);
      expect(reg.get().phase).toBe("on");
      expect(reg.get().registered).toBe(false);

      fakeClient.setScripted(async () => ({
        ok: true,
        value: { registered: true, laptopEnabled: true },
      }));
      fakeClient.emitOpen();
      await flush();

      expect(fakeClient.calls).toHaveLength(1);
      expect(fakeClient.calls[0]?.channel).toBe(PUSH_REGISTER_CHANNEL);
      expect(reg.get()).toMatchObject({ phase: "on", registered: true, laptopEnabled: true });
    },
  );

  test("registered:false -> phase error with the server text and language", async () => {
    const { deps, fakeClient } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: false, text: "Push is off on the laptop.", language: "en" },
    }));
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(reg.get()).toMatchObject({
      phase: "error",
      serverText: "Push is off on the laptop.",
      language: "en",
    });
  });

  test("ok:false result -> phase on, registered:false, and a second open retries", async () => {
    const { deps, fakeClient } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({ ok: false, error: { kind: "offline" } }));
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(reg.get().phase).toBe("on");
    expect(reg.get().registered).toBe(false);
    expect(fakeClient.calls).toHaveLength(1);

    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    fakeClient.emitOpen();
    await flush();

    expect(fakeClient.calls).toHaveLength(2);
    expect(reg.get().registered).toBe(true);
  });

  test("an unparsable register result -> phase on, registered:false", async () => {
    const { deps, fakeClient } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({ ok: true, value: { nonsense: true } }));
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(reg.get().phase).toBe("on");
    expect(reg.get().registered).toBe(false);
  });

  test("Android: ensureAndroidChannel is called with the given channel name", async () => {
    const { deps, fakeAdapter } = baseDeps({ channelName: () => "Jarvis notifications" });
    fakeAdapter.platform = vi.fn((): "android" | "ios" => "android");
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(fakeAdapter.ensureAndroidChannel).toHaveBeenCalledWith("Jarvis notifications");
  });

  test("iOS: ensureAndroidChannel is never called", async () => {
    const { deps, fakeAdapter } = baseDeps();
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(fakeAdapter.ensureAndroidChannel).not.toHaveBeenCalled();
  });

  test("a getExpoPushToken throw -> unavailable, prefs false, logs only the error's kind", async () => {
    const { deps, fakeAdapter, fakePrefs, logs } = baseDeps();
    fakeAdapter.getExpoPushToken = vi.fn(async () => {
      throw new TypeError("some very specific secret-shaped message");
    });
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);

    expect(reg.get().phase).toBe("unavailable");
    expect(fakePrefs.current().notifications).toBe(false);
    const joined = logs.join("\n");
    expect(joined).toContain("TypeError");
    expect(joined).not.toContain("secret-shaped message");
    // Free-signing plan, work item 2: this is the sideloaded-iOS signature
    // the Settings screen keys its note off.
    expect(reg.get().tokenFetchFailed).toBe(true);
  });

  test("tokenFetchFailed clears on the next attempt and stays off after a successful fetch", async () => {
    const { deps, fakeClient, fakeAdapter } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: true },
    }));
    let throwOnce = true;
    fakeAdapter.getExpoPushToken = vi.fn(async () => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error("stripped entitlement");
      }
      return "ExponentPushToken[abc12345]";
    });
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);
    expect(reg.get().tokenFetchFailed).toBe(true);

    await reg.setEnabled(true);
    expect(reg.get().tokenFetchFailed).toBeUndefined();
    expect(reg.get()).toMatchObject({ phase: "on", registered: true });
  });
});

describe("createPushRegistration: restart resume (fix round 1, I3 ruling)", () => {
  test(
    "fresh controller, prefs.notifications already true: the first open re-fetches a " +
      "token via getPermission (non-prompting) and registers — requestPermission is " +
      "never called [bite-proof: call requestPermission instead of getPermission]",
    async () => {
      const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps();
      await fakePrefs.prefs.set({ notifications: true, pushRegistered: true });
      fakeAdapter.getPermission = vi.fn(async (): Promise<PushPermission> => "granted");
      fakeClient.setScripted(async () => ({
        ok: true,
        value: { registered: true, laptopEnabled: true },
      }));
      const reg = createPushRegistration(deps);

      fakeClient.emitOpen();
      await flush();

      expect(fakeAdapter.getPermission).toHaveBeenCalledTimes(1);
      expect(fakeAdapter.requestPermission).not.toHaveBeenCalled();
      expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledWith("proj-1");
      expect(fakeClient.calls).toHaveLength(1);
      expect(fakeClient.calls[0]).toEqual({
        channel: PUSH_REGISTER_CHANNEL,
        args: [{ token: "ExponentPushToken[abc12345]", platform: "ios", language: "en" }],
        options: { whenNotOpen: "reject", timeoutMs: PUSH_REGISTER_TIMEOUT_MS },
      });
      expect(reg.get()).toMatchObject({ phase: "on", registered: true, laptopEnabled: true });
    },
  );

  test("permission no longer granted -> unavailable, prefs notifications:false, no token fetch", async () => {
    const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps();
    await fakePrefs.prefs.set({ notifications: true, pushRegistered: true });
    fakeAdapter.getPermission = vi.fn(async (): Promise<PushPermission> => "denied");
    const reg = createPushRegistration(deps);

    fakeClient.emitOpen();
    await flush();

    expect(fakeAdapter.getExpoPushToken).not.toHaveBeenCalled();
    expect(fakeClient.calls).toEqual([]);
    expect(reg.get().phase).toBe("unavailable");
    expect(fakePrefs.current().notifications).toBe(false);
  });

  test("granted but !isDevice() -> unavailable, no token fetch", async () => {
    const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps();
    await fakePrefs.prefs.set({ notifications: true, pushRegistered: true });
    fakeAdapter.getPermission = vi.fn(async (): Promise<PushPermission> => "granted");
    fakeAdapter.isDevice = vi.fn(() => false);
    const reg = createPushRegistration(deps);

    fakeClient.emitOpen();
    await flush();

    expect(fakeAdapter.getExpoPushToken).not.toHaveBeenCalled();
    expect(reg.get().phase).toBe("unavailable");
    expect(fakePrefs.current().notifications).toBe(false);
  });

  test("a getExpoPushToken throw during restart resume keeps consent and logs only the error's kind", async () => {
    const { deps, fakeClient, fakeAdapter, fakePrefs, logs } = baseDeps();
    await fakePrefs.prefs.set({ notifications: true, pushRegistered: true });
    fakeAdapter.getPermission = vi.fn(async (): Promise<PushPermission> => "granted");
    fakeAdapter.getExpoPushToken = vi.fn(async () => {
      throw new TypeError("resume fetch failed");
    });
    const reg = createPushRegistration(deps);

    fakeClient.emitOpen();
    await flush();

    expect(reg.get()).toMatchObject({ phase: "on", registered: false });
    expect(fakePrefs.current().notifications).toBe(true);
    expect(logs.join("\n")).toContain("TypeError");
  });

  test("turning notifications off during restart token fetch prevents registration", async () => {
    const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps();
    await fakePrefs.prefs.set({ notifications: true, pushRegistered: true });
    fakeAdapter.getPermission = vi.fn(async (): Promise<PushPermission> => "granted");
    let resolveToken: ((token: string) => void) | undefined;
    fakeAdapter.getExpoPushToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const reg = createPushRegistration(deps);

    fakeClient.emitOpen();
    await flush();
    await reg.setEnabled(false);
    resolveToken?.("ExponentPushToken[late]");
    await flush();

    expect(fakeClient.calls.some((call) => call.channel === "remote:registerPush")).toBe(false);
  });

  test("while off, a rotated token does not register or fetch an Expo token", async () => {
    const { deps, fakeClient, fakeAdapter } = baseDeps();
    fakeClient.setState("open");
    const reg = createPushRegistration(deps);

    fakeAdapter.emitToken("raw-rotation-token");
    await flush();

    expect(fakeAdapter.getExpoPushToken).not.toHaveBeenCalled();
    expect(fakeClient.calls).toEqual([]);
    expect(reg.get()).toMatchObject({ phase: "off", registered: false });
  });

  test("once a token has been fetched, a later open is the ordinary register() retry, not another resume", async () => {
    const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps();
    await fakePrefs.prefs.set({ notifications: true, pushRegistered: true });
    fakeAdapter.getPermission = vi.fn(async (): Promise<PushPermission> => "granted");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    createPushRegistration(deps);

    fakeClient.emitOpen();
    await flush();
    expect(fakeAdapter.getPermission).toHaveBeenCalledTimes(1);

    fakeClient.emitOpen();
    await flush();

    // getPermission (the non-prompting resume path) is never called again
    // once a token is already held — every later open is the ordinary
    // register() retry.
    expect(fakeAdapter.getPermission).toHaveBeenCalledTimes(1);
    expect(fakeClient.calls).toHaveLength(2);
  });
});

describe("createPushRegistration: background/foreground (M12 Task 5)", () => {
  test(
    "an open with resumed:true triggers no remote:registerPush call, and no permission prompt " +
      "[bite-proof: ignore the detail; a second call appears]",
    async () => {
      const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps();
      // Same shape as the restart-resume gap above (notifications already
      // on, no token yet in this instance) — the one case where ignoring
      // `resumed` would otherwise call getPermission()/register() for the
      // first time.
      await fakePrefs.prefs.set({ notifications: true, pushRegistered: true });
      createPushRegistration(deps);

      fakeClient.emitOpen({ resumed: true });
      await flush();

      expect(fakeClient.calls).toEqual([]);
      expect(fakeAdapter.getPermission).not.toHaveBeenCalled();
      expect(fakeAdapter.requestPermission).not.toHaveBeenCalled();
    },
  );

  test("an open with resumed:true does not re-register once already registered", async () => {
    const { deps, fakeClient } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: true },
    }));
    const reg = createPushRegistration(deps);
    await reg.setEnabled(true);
    expect(fakeClient.calls).toHaveLength(1);

    fakeClient.emitOpen({ resumed: true });
    await flush();

    expect(fakeClient.calls).toHaveLength(1);
  });

  test("an ordinary open (no resumed detail) after a resumed one still registers normally", async () => {
    const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps();
    await fakePrefs.prefs.set({ notifications: true, pushRegistered: true });
    fakeAdapter.getPermission = vi.fn(async (): Promise<PushPermission> => "granted");
    createPushRegistration(deps);

    fakeClient.emitOpen({ resumed: true });
    await flush();
    expect(fakeClient.calls).toEqual([]);

    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: true },
    }));
    fakeClient.emitOpen();
    await flush();

    expect(fakeClient.calls).toHaveLength(1);
  });
});

describe("createPushRegistration: setEnabled(true) re-entrancy (fix round 1, Minor)", () => {
  test("two concurrent setEnabled(true) calls run the permission/token flow only once", async () => {
    const { deps, fakeAdapter, fakeClient } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    const reg = createPushRegistration(deps);

    const first = reg.setEnabled(true);
    const second = reg.setEnabled(true);
    await Promise.all([first, second]);

    expect(fakeAdapter.requestPermission).toHaveBeenCalledTimes(1);
    expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(1);
    expect(fakeClient.calls).toHaveLength(1);
    expect(reg.get()).toMatchObject({ phase: "on", registered: true });
  });

  test("a later, separate setEnabled(true) call after the first finished runs again normally", async () => {
    const { deps, fakeAdapter } = baseDeps();
    const reg = createPushRegistration(deps);

    await reg.setEnabled(true);
    await reg.setEnabled(true);

    expect(fakeAdapter.requestPermission).toHaveBeenCalledTimes(2);
  });
});

describe("createPushRegistration: stale view fields are cleared (fix round 1, Minor)", () => {
  test("ok:false after a previous error clears serverText/language/laptopEnabled", async () => {
    const { deps, fakeClient } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: false, text: "laptop says no", language: "en" },
    }));
    const reg = createPushRegistration(deps);
    await reg.setEnabled(true);
    expect(reg.get()).toMatchObject({
      phase: "error",
      serverText: "laptop says no",
      language: "en",
    });

    fakeClient.setScripted(async () => ({ ok: false, error: { kind: "offline" } }));
    fakeClient.emitOpen();
    await flush();

    expect(reg.get().serverText).toBeUndefined();
    expect(reg.get().language).toBeUndefined();
    expect(reg.get().laptopEnabled).toBeUndefined();
  });

  test("setEnabled(false) clears a previous success's laptopEnabled", async () => {
    const { deps, fakeClient } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: true },
    }));
    const reg = createPushRegistration(deps);
    await reg.setEnabled(true);
    expect(reg.get().laptopEnabled).toBe(true);

    fakeClient.setScripted(async () => ({ ok: true, value: undefined }));
    await reg.setEnabled(false);

    expect(reg.get()).toMatchObject({
      phase: "off",
      serverText: undefined,
      language: undefined,
      laptopEnabled: undefined,
    });
  });
});

describe("createPushRegistration: setEnabled(false)", () => {
  test("while open: sends the unregister call and clears pushRegistered", async () => {
    const { deps, fakeClient, fakePrefs } = baseDeps({});
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({ ok: true, value: undefined }));
    const reg = createPushRegistration(deps);
    fakePrefs.prefs.set({ notifications: true, pushRegistered: true });

    await reg.setEnabled(false);

    expect(reg.get().phase).toBe("off");
    expect(fakeClient.calls).toHaveLength(1);
    expect(fakeClient.calls[0]).toEqual({
      channel: PUSH_UNREGISTER_CHANNEL,
      args: [],
      options: { whenNotOpen: "reject" },
    });
    expect(fakePrefs.current().pushRegistered).toBe(false);
  });

  test("while closed: the call happens on the next open", async () => {
    const { deps, fakeClient, fakePrefs } = baseDeps({});
    fakeClient.setState("closed");
    const reg = createPushRegistration(deps);
    await fakePrefs.prefs.set({ notifications: true, pushRegistered: true });

    await reg.setEnabled(false);

    expect(fakeClient.calls).toEqual([]);
    expect(reg.get().phase).toBe("off");

    fakeClient.setScripted(async () => ({ ok: true, value: undefined }));
    fakeClient.emitOpen();
    await flush();

    expect(fakeClient.calls).toHaveLength(1);
    expect(fakeClient.calls[0]?.channel).toBe(PUSH_UNREGISTER_CHANNEL);
    expect(fakePrefs.current().pushRegistered).toBe(false);
  });

  // M12 Task 12 minor: tells expo-notifications to stop posting this
  // device's token to Expo's server on its own — otherwise the library
  // keeps doing that in the background regardless of this controller's own
  // state.
  test("calls the adapter's setAutoServerRegistrationEnabled(false)", async () => {
    const { deps, fakeClient, fakeAdapter } = baseDeps({});
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({ ok: true, value: undefined }));
    const reg = createPushRegistration(deps);

    await reg.setEnabled(false);

    expect(fakeAdapter.setAutoServerRegistrationEnabled).toHaveBeenCalledWith(false);
  });

  // M12 Task 12 minor: a native setAutoServerRegistrationEnabled failure is
  // logged and does not block the laptop-facing unregister call that
  // actually matters — disable() must not itself throw.
  test("a throwing setAutoServerRegistrationEnabled still unregisters and never throws", async () => {
    const { deps, fakeClient, fakeAdapter, logs } = baseDeps({});
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({ ok: true, value: undefined }));
    fakeAdapter.setAutoServerRegistrationEnabled = vi.fn(async () => {
      throw new TypeError("native call failed");
    });
    const reg = createPushRegistration(deps);

    await expect(reg.setEnabled(false)).resolves.toBeUndefined();

    expect(fakeClient.calls).toHaveLength(1);
    expect(fakeClient.calls[0]?.channel).toBe(PUSH_UNREGISTER_CHANNEL);
    expect(logs.join("\n")).toContain("setAutoServerRegistrationEnabled failed kind=TypeError");
  });

  // M12 Task 12 minor: rule 7 says the token lives in this closure only —
  // disable() must clear it, not just stop using it, so a stale token
  // cannot outlive the "off" state. Observed here the way resumeAfterRestart
  // itself distinguishes "no token yet" from "ordinary retry" (the onState
  // handler's own `token === undefined` branch): with prefs.notifications
  // turned back on by some path other than this controller's own enable()
  // (a second screen, a fresh app session sharing the same prefs — the same
  // "restart gap" resumeAfterRestart's doc comment describes), a cleared
  // token takes the resumeAfterRestart path — re-checking permission and
  // re-fetching — instead of calling register() straight away with
  // whatever was left over from before disable().
  test(
    "clears the closure-held token, so notifications turning back on re-fetches instead of reusing the stale one " +
      "[bite-proof: drop `token = undefined` in disable()]",
    async () => {
      const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps({});
      fakeClient.setState("open");
      fakeClient.setScripted(async () => ({
        ok: true,
        value: { registered: true, laptopEnabled: false },
      }));
      fakeAdapter.getPermission = vi.fn(async () => "granted" as PushPermission);
      const reg = createPushRegistration(deps);
      await reg.setEnabled(true);
      expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(1);

      await reg.setEnabled(false);

      await fakePrefs.prefs.set({ notifications: true, pushRegistered: false });
      fakeClient.emitOpen();
      await flush();

      expect(fakeAdapter.getPermission).toHaveBeenCalledTimes(1);
      expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(2);
    },
  );
});

describe("createPushRegistration: dispose mid-flight", () => {
  // M12 Task 12 minor: dispose() during enable()'s own token fetch — once
  // the fetch resolves, a disposed controller must never make its first
  // RPC call after the fact.
  test("dispose() while enable()'s token fetch is still pending: the fetch's own resolution never registers", async () => {
    const { deps, fakeClient, fakeAdapter } = baseDeps({});
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    let resolveToken: ((token: string) => void) | undefined;
    fakeAdapter.getExpoPushToken = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveToken = resolve;
        }),
    );
    const reg = createPushRegistration(deps);

    const enablePromise = reg.setEnabled(true);
    await flush();
    expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(1);
    expect(fakeClient.calls).toEqual([]); // fetch is still pending; no register call yet

    reg.dispose();
    resolveToken?.("ExponentPushToken[after-dispose]");
    await enablePromise;
    await flush();

    expect(fakeClient.calls).toEqual([]);
  });
});

describe("createPushRegistration: token rotation (rule 6)", () => {
  test("a fetch that synchronously re-emits the same token event fetches and registers once [bite-proof: drop in-flight guard]", async () => {
    const { deps, fakeClient, fakeAdapter } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    let emitDuringFetch = false;
    fakeAdapter.getExpoPushToken = vi.fn(async () => {
      if (emitDuringFetch) fakeAdapter.emitToken("raw-device-token");
      return "ExponentPushToken[abc12345]";
    });
    const reg = createPushRegistration(deps);
    await reg.setEnabled(true);
    emitDuringFetch = true;
    fakeAdapter.emitToken("raw-device-token");
    await flush();

    expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(2);
    expect(fakeClient.calls).toHaveLength(2);
  });

  test("a genuinely new device token after a consented fetch re-fetches and registers once", async () => {
    const { deps, fakeClient, fakeAdapter } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    const reg = createPushRegistration(deps);
    await reg.setEnabled(true);
    fakeAdapter.emitToken("new-raw-device-token");
    await flush();

    expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(2);
    expect(fakeClient.calls).toHaveLength(2);
  });

  test("a rotation before the first open does not fetch until the open permission re-check", async () => {
    const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps();
    await fakePrefs.prefs.set({ notifications: true, pushRegistered: false });
    fakeAdapter.getPermission = vi.fn(async (): Promise<PushPermission> => "granted");
    const reg = createPushRegistration(deps);

    fakeAdapter.emitToken("raw-device-token");
    await flush();
    expect(fakeAdapter.getExpoPushToken).not.toHaveBeenCalled();
    expect(fakeClient.calls).toEqual([]);

    fakeClient.emitOpen();
    await flush();
    expect(fakeAdapter.getPermission).toHaveBeenCalledTimes(1);
    expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(1);
    expect(reg.get().phase).toBe("on");
  });

  test("while on and open, a rotated token sends a second register with the new token", async () => {
    const { deps, fakeClient, fakeAdapter } = baseDeps();
    fakeAdapter.getExpoPushToken = vi.fn(async () => "ExponentPushToken[rotated999]");
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    const reg = createPushRegistration(deps);
    await reg.setEnabled(true);
    expect(fakeClient.calls).toHaveLength(1);

    fakeAdapter.emitToken("ExponentPushToken[rotated999]");
    await flush();

    expect(fakeClient.calls).toHaveLength(2);
    expect(fakeClient.calls[1]?.args).toEqual([
      { token: "ExponentPushToken[rotated999]", platform: "ios", language: "en" },
    ]);
  });

  test("while off, a rotated token does not register", async () => {
    const { deps, fakeClient, fakeAdapter } = baseDeps();
    fakeClient.setState("open");
    const reg = createPushRegistration(deps);
    void reg; // notifications defaults false: never enabled in this test

    fakeAdapter.emitToken("ExponentPushToken[rotated999]");
    await flush();

    expect(fakeClient.calls).toEqual([]);
  });

  // M12 Task 12 minor: a rotation's own fetch throwing must leave the
  // existing (still-valid, already-registered) token and view exactly as
  // they were — there is no new token to register with, and the old
  // registration is still good.
  test("a rotation fetch that throws keeps the current registration exactly as it was, and logs which step failed", async () => {
    const { deps, fakeClient, fakeAdapter, logs } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: true },
    }));
    const reg = createPushRegistration(deps);
    await reg.setEnabled(true);
    const viewBefore = reg.get();
    const callsBefore = fakeClient.calls.length;

    fakeAdapter.getExpoPushToken = vi.fn(async () => {
      throw new TypeError("rotation fetch failed");
    });
    fakeAdapter.emitToken("raw-rotation-token");
    await flush();

    expect(reg.get()).toEqual(viewBefore);
    expect(fakeClient.calls).toHaveLength(callsBefore); // no register attempt at all
    expect(logs.join("\n")).toContain("push: token rotation fetch failed kind=TypeError");
  });

  // M12 Task 12 minor: a *register* failure during rotation — the token
  // did rotate, but the RPC call itself threw (never an ok:false result,
  // which register() already turns into an ordinary view update) — is a
  // different step than the fetch, and the log line must say so rather
  // than reusing "token fetch failed" for every rotation failure
  // regardless of where it happened.
  test("a rotation register() that throws logs a distinct 'register failed' line, not 'fetch failed'", async () => {
    const { deps, fakeClient, fakeAdapter, logs } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: true },
    }));
    const reg = createPushRegistration(deps);
    await reg.setEnabled(true);

    fakeAdapter.getExpoPushToken = vi.fn(async () => "ExponentPushToken[rotated999]");
    fakeClient.setScripted(async () => {
      throw new Error("socket died mid-call");
    });
    fakeAdapter.emitToken("raw-rotation-token");
    await flush();

    const joined = logs.join("\n");
    expect(joined).toContain("push: token rotation register failed kind=Error");
    expect(joined).not.toContain("token rotation fetch failed");
  });

  // M12 Task 12 minor [bite-proof: tokenFetchInFlight as a boolean instead
  // of a counter]: enable()'s first-ever fetch and resumeAfterRestart()'s
  // can genuinely overlap (both start whenever their own precondition
  // holds, neither waits on the other). With a boolean, whichever of the
  // two finishes first clears the flag even though the other is still in
  // flight, so a genuine rotation slips past the rule-6 guard and starts a
  // third, unordered fetch. A counter keeps the guard up until every
  // outstanding fetch this closure started has settled.
  test(
    "two overlapping first-ever fetches (resumeAfterRestart + enable) keep the rotation guard up " +
      "until BOTH finish, so a rotation mid-overlap does not start a third fetch",
    async () => {
      const { deps, fakeClient, fakeAdapter, fakePrefs } = baseDeps();
      fakeClient.setState("closed");
      await fakePrefs.prefs.set({ notifications: true, pushRegistered: false });
      fakeAdapter.getPermission = vi.fn(async () => "granted" as PushPermission);
      fakeClient.setScripted(async () => ({
        ok: true,
        value: { registered: true, laptopEnabled: false },
      }));

      let resolveSlow: ((token: string) => void) | undefined;
      let calls = 0;
      fakeAdapter.getExpoPushToken = vi.fn(() => {
        calls += 1;
        if (calls === 1) {
          // resumeAfterRestart's own fetch: held open under test control.
          return new Promise<string>((resolve) => {
            resolveSlow = resolve;
          });
        }
        // enable()'s own fetch: resolves immediately.
        return Promise.resolve("ExponentPushToken[fast]");
      });

      const reg = createPushRegistration(deps);
      void reg;

      // Triggers resumeAfterRestart() (token is still undefined) — fetch
      // #1 starts and is held open.
      fakeClient.emitOpen();
      await flush();
      expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(1);
      expect(resolveSlow).toBeDefined();

      // A concurrent, independent trigger of enable()'s own fetch — #2,
      // which resolves right away and assigns `token`.
      await reg.setEnabled(true);
      expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(2);

      // Fetch #1 (resumeAfterRestart's) is still pending. A genuine device
      // rotation arrives now, with `token` already defined (by fetch #2)
      // and — the property under test — the guard still up because fetch
      // #1 has not settled yet.
      fakeAdapter.emitToken("real-rotation-raw");
      await flush();

      expect(fakeAdapter.getExpoPushToken).toHaveBeenCalledTimes(2);

      resolveSlow?.("ExponentPushToken[slow]");
      await flush();
    },
  );
});

describe("createPushRegistration: the token never leaks", () => {
  test("the concatenated log and JSON.stringify(get()) never contain the token", async () => {
    const { deps, fakeClient, fakeAdapter, logs } = baseDeps();
    fakeClient.setState("open");
    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    const reg = createPushRegistration(deps);
    await reg.setEnabled(true);

    fakeAdapter.emitToken("ExponentPushToken[rotated999]");
    await flush();

    const dump = `${logs.join("\n")}\n${JSON.stringify(reg.get())}`;
    expect(dump).not.toContain("ExponentPushToken[abc12345]");
    expect(dump).not.toContain("ExponentPushToken[rotated999]");
  });
});

describe("createPushRegistration: dispose", () => {
  test("unsubscribes from onState and onTokenChanged", async () => {
    const { deps, fakeClient, fakeAdapter } = baseDeps();
    const reg = createPushRegistration(deps);
    reg.dispose();

    fakeClient.setScripted(async () => ({
      ok: true,
      value: { registered: true, laptopEnabled: false },
    }));
    fakeClient.emitOpen();
    fakeAdapter.emitToken("ExponentPushToken[after-dispose]");
    await flush();

    expect(fakeClient.calls).toEqual([]);
  });
});

// ANDROID_CHANNEL_ID is exercised indirectly through native-notifications.test.ts
// too; this just proves push-registration.ts is where it's actually defined.
test("ANDROID_CHANNEL_ID is 'jarvis'", () => {
  expect(ANDROID_CHANNEL_ID).toBe("jarvis");
});
