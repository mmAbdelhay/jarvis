// task-6-review.md fix round 1, Important 1 + Minors: the prefs facade must
// be truthful before the registration is built (no defaults masquerading
// as the real saved state), `waitForOpen` resolves on open and gives up
// after its timeout, and the once-per-id cap evicts in insertion order at
// 32. push-context-support.ts's own header explains why these live in a
// separate file from push-context.tsx (which can't be imported here at
// all — it pulls in `expo-router` at module scope).
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  A_ID,
  B_ID,
  C_ID,
  type MachinesHarness,
  answer,
  deferred,
  machinesHarness,
  recordOf,
  requestsOn,
  settle,
} from "./fake-machines";
import type { MachineId } from "./machine-index";
import type { MachineScope, SwitchOutcome } from "./machine-sessions";
import { NOTIFICATION_NAV_WAIT_MS } from "./notification-tap";
import type { NotificationResponse, NotificationsAdapter, PushPermission } from "./notifications";
import type { Prefs, PrefsStore } from "./prefs";
import { savePrefs } from "./prefs";
import {
  COLD_START_TAP_WAIT_MS,
  MAX_HANDLED_IDS,
  NO_MACHINE_PUSH_FLAG,
  coldStartMachine,
  createPrefsFacade,
  gateTapRouter,
  handleNotificationTap,
  loadPushSeed,
  recordHandledId,
  tapMachine,
  waitForOpen,
} from "./push-context-support";
import type { PushPrefs } from "./push-registration";
import { createPushRegistration } from "./push-registration";
import type { ClientState, RpcClient, RpcResult } from "./rpc-client";

class FakeStore implements PrefsStore {
  private text: string | undefined;

  constructor(initial?: string) {
    this.text = initial;
  }

  read(): Promise<string | undefined> {
    return Promise.resolve(this.text);
  }

  write(text: string): Promise<void> {
    this.text = text;
    return Promise.resolve();
  }
}

function fakeFlag(initial = false) {
  let value = initial;
  const writes: boolean[] = [];
  return {
    writes,
    read: async () => value,
    write: async (next: boolean) => {
      writes.push(next);
      value = next;
    },
  };
}

// --- createPrefsFacade ----------------------------------------------------

describe("createPrefsFacade", () => {
  it("get() answers the seed synchronously — no load, no await needed", () => {
    const store = new FakeStore(undefined);
    const facade = createPrefsFacade(
      store,
      "en-US",
      { notifications: true, pushRegistered: false },
      fakeFlag(),
    );
    expect(facade.get()).toEqual<PushPrefs>({ notifications: true, pushRegistered: false });
  });

  it("set() re-reads the full Prefs first, so it never clobbers language/speakReplies", async () => {
    const store = new FakeStore();
    await savePrefs(store, {
      language: "ar",
      speakReplies: false,
      notifications: false,
      pushRegistered: false,
      sidecarDesktopSite: true,
      sidecarZoom: {},
      idleLockMinutes: 15,
      refreshTokenStored: false,
      keepSignedIn: false,
      machineFlags: {},
      machineLinks: [],
    } satisfies Prefs);

    const facade = createPrefsFacade(
      store,
      "en-US",
      { notifications: false, pushRegistered: false },
      fakeFlag(),
    );
    await facade.set({ notifications: true });

    const written = JSON.parse((await store.read()) ?? "{}") as Prefs;
    expect(written).toEqual<Prefs>({
      language: "ar",
      speakReplies: false,
      notifications: true,
      pushRegistered: false,
      sidecarDesktopSite: true,
      sidecarZoom: {},
      idleLockMinutes: 15,
      refreshTokenStored: false,
      keepSignedIn: false,
      machineFlags: {},
      machineLinks: [],
    });
    expect(facade.get()).toEqual<PushPrefs>({ notifications: true, pushRegistered: false });
  });

  it("pushRegistered goes to the machine's flag and never to the prefs file's top level", async () => {
    const store = new FakeStore(JSON.stringify({ pushRegistered: false, notifications: true }));
    const flag = fakeFlag();
    const facade = createPrefsFacade(
      store,
      "en-US",
      { notifications: true, pushRegistered: false },
      flag,
    );

    await facade.set({ pushRegistered: true });

    expect(flag.writes).toEqual([true]);
    expect((JSON.parse((await store.read()) ?? "{}") as Prefs).pushRegistered).toBe(false);
    expect(facade.get()).toEqual<PushPrefs>({ notifications: true, pushRegistered: true });
  });

  it("notifications is global: writing it leaves the machine's flag alone", async () => {
    const flag = fakeFlag(true);
    const facade = createPrefsFacade(
      new FakeStore(),
      "en-US",
      { notifications: true, pushRegistered: true },
      flag,
    );

    await facade.set({ notifications: false });

    expect(flag.writes).toEqual([]);
    expect(facade.get()).toEqual<PushPrefs>({ notifications: false, pushRegistered: true });
  });
});

describe("loadPushSeed", () => {
  it("notifications from the prefs file, pushRegistered from the machine's flag", async () => {
    const store = new FakeStore(JSON.stringify({ notifications: true, pushRegistered: false }));
    await expect(loadPushSeed(store, "en-US", fakeFlag(true))).resolves.toEqual<PushPrefs>({
      notifications: true,
      pushRegistered: true,
    });
  });

  it("a flag that cannot be read is false: the tree under this seed must still mount", async () => {
    const store = new FakeStore(JSON.stringify({ notifications: true }));
    const flag = {
      read: () => Promise.reject(new Error("machines: store is not open")),
      write: async () => {},
    };
    await expect(loadPushSeed(store, "en-US", flag)).resolves.toEqual<PushPrefs>({
      notifications: true,
      pushRegistered: false,
    });
  });

  it("the null scope's flag is false, and a write lands nowhere", async () => {
    await expect(NO_MACHINE_PUSH_FLAG.read()).resolves.toBe(false);
    await expect(NO_MACHINE_PUSH_FLAG.write(true)).resolves.toBeUndefined();
    await expect(NO_MACHINE_PUSH_FLAG.read()).resolves.toBe(false);
  });
});

// --- the bite-proof: the facade must be seeded with the real value -------

type StateHandler = (state: ClientState, detail: Record<string, unknown>) => void;

function createFakeClient(initial: ClientState = "closed") {
  let state: ClientState = initial;
  const handlers = new Set<StateHandler>();
  // How many times any subscribed handler was actually invoked with a
  // state — distinct from `onState` (the *subscribe* call) itself, which
  // `createPushRegistration` legitimately calls once at construction time
  // (push-registration.ts's own "registered once, for this controller's
  // whole lifetime" `onState` subscription). The bite-proof below cares
  // that this never *fires*, not that nothing ever subscribes.
  let firedCount = 0;
  const onStateSpy = vi.fn((handler: StateHandler) => {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  });

  const client: Pick<RpcClient, "call" | "onState" | "state"> = {
    call: async (): Promise<RpcResult> => ({ ok: false, error: { kind: "offline" } }),
    onState: onStateSpy,
    state: () => state,
  };

  return {
    client,
    onStateSpy,
    firedCount: () => firedCount,
    emitOpen() {
      state = "open";
      firedCount += 1;
      for (const handler of [...handlers]) handler("open", {});
    },
  };
}

function createFakeAdapter(): NotificationsAdapter {
  return {
    getPermission: vi.fn(async () => "undetermined" as PushPermission),
    requestPermission: vi.fn(async () => "granted" as PushPermission),
    isDevice: vi.fn(() => true),
    projectId: vi.fn(() => "proj-1"),
    ensureAndroidChannel: vi.fn(async () => {}),
    getExpoPushToken: vi.fn(async () => "ExponentPushToken[abc12345]"),
    onTokenChanged: vi.fn(() => () => {}),
    onResponse: vi.fn(() => () => {}),
    lastResponse: vi.fn(async () => undefined),
    setForegroundHandler: vi.fn(),
    platform: vi.fn(() => "ios" as const),
    setAutoServerRegistrationEnabled: vi.fn(async () => {}),
  };
}

describe("createPrefsFacade seeded into createPushRegistration (fix round 1, Important 1)", () => {
  it(
    "a fake PrefsStore with notifications:true -> the registration's first get().phase is " +
      '"on", with no onState ever fired [bite-proof: seed the facade with defaults instead of the loaded value]',
    () => {
      const store = new FakeStore();
      const { client, firedCount } = createFakeClient("closed");
      const facade = createPrefsFacade(
        store,
        "en-US",
        { notifications: true, pushRegistered: false },
        fakeFlag(),
      );

      const registration = createPushRegistration({
        client,
        adapter: createFakeAdapter(),
        prefs: facade,
        language: () => "en",
        channelName: () => "Jarvis",
        log: () => {},
      });

      // The phase is right the moment the registration is constructed —
      // nothing had to fire an "open" event first to correct it (the
      // registration's own construction-time `onState` *subscribe* call
      // is expected and harmless; what must never happen is that
      // subscription actually *firing*).
      expect(registration.get().phase).toBe("on");
      expect(firedCount()).toBe(0);
    },
  );
});

// --- waitForOpen -----------------------------------------------------------

describe("waitForOpen", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves true immediately when the client is already open", async () => {
    const { client } = createFakeClient("open");
    await expect(waitForOpen(client, 1_000)).resolves.toBe(true);
  });

  it('resolves true once the client reports "open", well before the timeout', async () => {
    const { client, emitOpen } = createFakeClient("closed");
    const promise = waitForOpen(client, 1_000);

    let settled: boolean | undefined;
    void promise.then((value) => {
      settled = value;
    });

    // Not open yet — advancing less than the timeout must not resolve it.
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBeUndefined();

    emitOpen();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });

  it("gives up and resolves false after waitMs when the client never opens", async () => {
    const { client } = createFakeClient("closed");
    const promise = waitForOpen(client, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(promise).resolves.toBe(false);
  });
});

// --- recordHandledId --------------------------------------------------------

describe("recordHandledId", () => {
  it("records a new id and returns true", () => {
    const handled = new Set<string>();
    expect(recordHandledId(handled, "a", 32)).toBe(true);
    expect(handled.has("a")).toBe(true);
  });

  it("an id already handled returns false and touches nothing else", () => {
    const handled = new Set<string>(["a", "b"]);
    expect(recordHandledId(handled, "a", 32)).toBe(false);
    expect(handled).toEqual(new Set(["a", "b"]));
  });

  it(
    "at capacity, evicts the single oldest (first-inserted) entry — insertion order " +
      "[bite-proof: evict an arbitrary entry instead of the oldest; this fails]",
    () => {
      const handled = new Set<string>();
      for (let i = 0; i < MAX_HANDLED_IDS; i++) {
        expect(recordHandledId(handled, `id-${i}`, MAX_HANDLED_IDS)).toBe(true);
      }
      expect(handled.size).toBe(MAX_HANDLED_IDS);
      expect(handled.has("id-0")).toBe(true);

      // One more over capacity: the oldest ("id-0") is evicted, the newest
      // is present, and every id in between survives untouched.
      expect(recordHandledId(handled, "id-new", MAX_HANDLED_IDS)).toBe(true);
      expect(handled.size).toBe(MAX_HANDLED_IDS);
      expect(handled.has("id-0")).toBe(false);
      expect(handled.has("id-1")).toBe(true);
      expect(handled.has("id-new")).toBe(true);
    },
  );

  it("evicts in strict FIFO order across several consecutive overflows", () => {
    const handled = new Set<string>();
    for (let i = 0; i < MAX_HANDLED_IDS + 5; i++) {
      recordHandledId(handled, `id-${i}`, MAX_HANDLED_IDS);
    }
    expect(handled.size).toBe(MAX_HANDLED_IDS);
    for (let i = 0; i < 5; i++) {
      expect(handled.has(`id-${i}`)).toBe(false);
    }
    for (let i = 5; i < MAX_HANDLED_IDS + 5; i++) {
      expect(handled.has(`id-${i}`)).toBe(true);
    }
  });
});

// --- the tap -----------------------------------------------------------------

const deviceOf = (id: MachineId): string => recordOf(id).deviceId;
const NOT_HELD = "d".repeat(32);

const ROWS = [
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

function tapHarness(h: MachinesHarness) {
  const notices: string[] = [];
  const handledIds = new Set<string>();
  const deps = {
    sessions: h.sessions,
    findByDeviceId: (deviceId: string) => h.store.findByDeviceId(deviceId),
    router: gateTapRouter(h.gate, h.sessions, (route) => h.routes.push(route)),
    handledIds,
    waitForOpen: (client: Parameters<typeof waitForOpen>[0]) =>
      waitForOpen(client, NOTIFICATION_NAV_WAIT_MS),
    notice: () => notices.push("gone"),
  };
  return { deps, notices, handledIds };
}

function sessionTap(id: string, device?: string): NotificationResponse {
  return {
    id,
    data: { kind: "session-done", sessionId: "s1", ...(device === undefined ? {} : { device }) },
  };
}

function listRequests(h: MachinesHarness, id: MachineId) {
  return requestsOn(h.socketOf(id), "sessions:list");
}

describe("tapMachine", () => {
  const find = vi.fn(async (deviceId: string) => (deviceId === "held" ? B_ID : undefined));

  it("no device: the active machine, with nothing looked up", async () => {
    find.mockClear();
    await expect(tapMachine({ kind: "reply" }, find)).resolves.toEqual({ kind: "active" });
    expect(find).not.toHaveBeenCalled();
  });

  it("a device a machine has: that machine", async () => {
    await expect(tapMachine({ kind: "reply", device: "held" }, find)).resolves.toEqual({
      kind: "machine",
      id: B_ID,
    });
  });

  it("a device no machine has: gone", async () => {
    await expect(tapMachine({ kind: "reply", device: "other" }, find)).resolves.toEqual({
      kind: "gone",
    });
  });
});

describe("handleNotificationTap", () => {
  it("a tap for the active machine: no switch, and the route is planned on it", async () => {
    const h = machinesHarness();
    await h.start();
    await h.unlockCurrent();
    h.events.length = 0;
    const { deps } = tapHarness(h);

    const tap = handleNotificationTap(deps, sessionTap("t1", deviceOf(A_ID)));
    await settle();
    answer(h.socketOf(A_ID), "sessions:list", ROWS);
    await tap;

    expect(h.events).toEqual([]);
    expect(h.routes).toEqual(["/session/s1"]);
  });

  it("a tap for another machine: the switch runs first, and sessions:list goes to the new client", async () => {
    const h = machinesHarness();
    await h.start();
    await h.unlockCurrent();
    h.events.length = 0;
    const { deps } = tapHarness(h);

    const tap = handleNotificationTap(deps, sessionTap("t1", deviceOf(B_ID)));
    await settle();

    expect(h.events).toContain(`publish ${B_ID}`);
    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.routes).toEqual([]);

    await h.unlockCurrent("2");
    await settle();
    expect(listRequests(h, B_ID)).toHaveLength(1);
    expect(listRequests(h, A_ID)).toEqual([]);
    answer(h.socketOf(B_ID), "sessions:list", ROWS);
    await tap;

    expect(h.routes).toEqual(["/session/s1"]);
  });

  it("waits on the client read after the switch, not the one on screen before it", async () => {
    const h = machinesHarness();
    const a = await h.start();
    const { deps } = tapHarness(h);
    const waited: unknown[] = [];

    await handleNotificationTap(
      {
        ...deps,
        waitForOpen: async (client) => {
          waited.push(client);
          return false;
        },
      },
      sessionTap("t1", deviceOf(B_ID)),
    );

    expect(waited).toEqual([h.sessions.current().client]);
    expect(waited[0]).not.toBe(a.client);
  });

  it("a tap for a device no machine has: one notice, no switch, no route", async () => {
    const h = machinesHarness();
    await h.start();
    await h.unlockCurrent();
    h.events.length = 0;
    const { deps, notices } = tapHarness(h);

    await handleNotificationTap(deps, sessionTap("t1", NOT_HELD));

    expect(notices).toEqual(["gone"]);
    expect(h.events).toEqual([]);
    expect(h.routes).toEqual([]);
    expect(listRequests(h, A_ID)).toEqual([]);
  });

  it("a store that cannot answer is not a machine gone: no notice, no switch, no route", async () => {
    const h = machinesHarness();
    await h.start();
    await h.unlockCurrent();
    h.events.length = 0;
    const { deps, notices } = tapHarness(h);

    await handleNotificationTap(
      { ...deps, findByDeviceId: () => Promise.reject(new Error("keychain read failed")) },
      sessionTap("t1", deviceOf(B_ID)),
    );

    expect(notices).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.routes).toEqual([]);
  });

  it("a tap with no device: today's flow, on the active machine", async () => {
    const h = machinesHarness();
    await h.start();
    await h.unlockCurrent();
    h.events.length = 0;
    const { deps, notices } = tapHarness(h);
    const find = vi.fn(async () => undefined);

    const tap = handleNotificationTap({ ...deps, findByDeviceId: find }, sessionTap("t1"));
    await settle();
    answer(h.socketOf(A_ID), "sessions:list", ROWS);
    await tap;

    expect(find).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
    expect(h.events).toEqual([]);
    expect(h.routes).toEqual(["/session/s1"]);
  });

  it("a malformed device is an invalid tap: nothing happens, and its id is not spent", async () => {
    const h = machinesHarness();
    await h.start();
    h.events.length = 0;
    const { deps, notices, handledIds } = tapHarness(h);

    await handleNotificationTap(deps, sessionTap("t1", "not-a-device"));

    expect(handledIds.size).toBe(0);
    expect(notices).toEqual([]);
    expect(h.events).toEqual([]);
  });

  it("the same response id twice is handled once, across a scope change", async () => {
    const h = machinesHarness();
    await h.start();
    const { deps } = tapHarness(h);
    const find = vi.fn((deviceId: string) => h.store.findByDeviceId(deviceId));
    const waited = vi.fn(async () => false);
    const tapDeps = { ...deps, findByDeviceId: find, waitForOpen: waited };
    const response = sessionTap("t1", deviceOf(B_ID));

    await handleNotificationTap(tapDeps, response);
    expect(h.sessions.current().id).toBe(B_ID);
    await h.sessions.switchTo(C_ID);
    h.events.length = 0;

    await handleNotificationTap(tapDeps, response);

    expect(find).toHaveBeenCalledTimes(1);
    expect(waited).toHaveBeenCalledTimes(1);
    expect(h.events).toEqual([]);
    expect(h.sessions.current().id).toBe(C_ID);
  });

  it("superseded by a later switch stops the tap with no route and no wait", async () => {
    const h = machinesHarness();
    await h.start();
    const { deps } = tapHarness(h);
    const waited = vi.fn(async () => true);
    // The user's own switch lands the moment the tap's has begun.
    let later: Promise<SwitchOutcome> | undefined;
    const sessions = {
      current: h.sessions.current,
      switchTo(id: MachineId): Promise<SwitchOutcome> {
        const run = h.sessions.switchTo(id);
        later = h.sessions.switchTo(C_ID);
        return run;
      },
    };

    await handleNotificationTap(
      { ...deps, sessions, waitForOpen: waited },
      sessionTap("t1", deviceOf(B_ID)),
    );
    expect(await later).toBe("switched");

    expect(h.sessions.current().id).toBe(C_ID);
    expect(waited).not.toHaveBeenCalled();
    expect(h.routes).toEqual([]);
  });

  it.each<SwitchOutcome>(["superseded", "unknown"])(
    "a switch answering %s stops before any wait, call or route",
    async (outcome) => {
      const h = machinesHarness();
      await h.start();
      const { deps } = tapHarness(h);
      const waited = vi.fn(async () => true);
      const sessions = { current: h.sessions.current, switchTo: async () => outcome };

      await handleNotificationTap(
        { ...deps, sessions, waitForOpen: waited },
        sessionTap("t1", deviceOf(B_ID)),
      );

      expect(waited).not.toHaveBeenCalled();
      expect(h.routes).toEqual([]);
    },
  );

  it("a switch while the list was on its way: no route for the machine left", async () => {
    const h = machinesHarness();
    await h.start();
    const { deps } = tapHarness(h);
    const left = {
      call: async () => {
        await h.sessions.switchTo(B_ID);
        return { ok: true as const, value: ROWS };
      },
    };
    const sessions = {
      current: () =>
        h.sessions.current().id === A_ID
          ? ({ ...h.sessions.current(), client: left } as unknown as MachineScope)
          : h.sessions.current(),
      switchTo: h.sessions.switchTo,
    };
    const routes: string[] = [];

    await handleNotificationTap(
      {
        ...deps,
        sessions,
        router: { push: (route) => routes.push(route) },
        waitForOpen: async () => true,
      },
      sessionTap("t1"),
    );

    expect(routes).toEqual([]);
  });

  it("a machine that does not open in time gets no route, as today's wait", async () => {
    const h = machinesHarness();
    await h.start();
    const { deps } = tapHarness(h);

    await handleNotificationTap(
      { ...deps, waitForOpen: async () => false },
      sessionTap("t1", deviceOf(B_ID)),
    );

    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.routes).toEqual([]);
  });
});

describe("a route held in the gate", () => {
  /** B's tap, down to its route waiting in the gate, with no navigator up. */
  async function routeWaitingFromB(
    h: MachinesHarness,
    deps: ReturnType<typeof tapHarness>["deps"],
  ): Promise<void> {
    h.gate.setMounted(false);
    const tap = handleNotificationTap(deps, sessionTap("t1", deviceOf(B_ID)));
    await settle();
    await h.unlockCurrent("2");
    await settle();
    answer(h.socketOf(B_ID), "sessions:list", ROWS);
    await tap;
    expect(h.routes).toEqual([]);
  }

  it("goes when its machine's tree mounts", async () => {
    const h = machinesHarness();
    await h.start();
    const { deps } = tapHarness(h);
    await routeWaitingFromB(h, deps);

    h.gate.setMounted(true);
    h.gate.flush();

    expect(h.routes).toEqual(["/session/s1"]);
  });

  it("tap 1 to B, tap 2 to C: B's route never goes on C's tree, and C's own does", async () => {
    const h = machinesHarness();
    await h.start();
    const { deps } = tapHarness(h);
    await routeWaitingFromB(h, deps);

    const second: NotificationResponse = {
      id: "t2",
      data: { kind: "session-done", sessionId: "s2", device: deviceOf(C_ID) },
    };
    const tap2 = handleNotificationTap(deps, second);
    await settle();
    expect(h.sessions.current().id).toBe(C_ID);

    // C's tree mounts while tap 2 still waits for C to open: B's route is
    // still the one in the gate.
    h.gate.setMounted(true);
    h.gate.flush();
    expect(h.routes).toEqual([]);

    await h.unlockCurrent("3");
    await settle();
    answer(h.socketOf(C_ID), "sessions:list", [{ ...ROWS[0], id: "s2" }]);
    await tap2;

    expect(h.routes).toEqual(["/session/s2"]);
  });

  it("a plain switch away drops it too", async () => {
    const h = machinesHarness();
    await h.start();
    const { deps } = tapHarness(h);
    await routeWaitingFromB(h, deps);

    await h.sessions.switchTo(A_ID);
    h.gate.setMounted(true);
    h.gate.flush();

    expect(h.routes).toEqual([]);
  });
});

describe("coldStartMachine", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function opened(active?: MachineId): Promise<MachinesHarness> {
    const h = machinesHarness(active === undefined ? {} : { active });
    await h.store.open();
    return h;
  }

  function preferredFor(
    h: MachinesHarness,
    lastResponse: () => Promise<NotificationResponse | undefined>,
  ): Promise<MachineId | undefined> {
    return coldStartMachine({
      lastResponse,
      findByDeviceId: (deviceId) => h.store.findByDeviceId(deviceId),
    });
  }

  it("is 500 ms", () => {
    expect(COLD_START_TAP_WAIT_MS).toBe(500);
  });

  it("a cold-start tap's machine connects, and the last active one never does", async () => {
    const h = await opened(A_ID);
    const response = sessionTap("t1", deviceOf(B_ID));

    const preferred = await preferredFor(h, async () => response);
    expect(preferred).toBe(B_ID);
    await h.sessions.start(preferred);

    expect(h.sessions.current().id).toBe(B_ID);
    expect(h.events).toContain(`connect ${B_ID}`);
    expect(h.events).not.toContain(`connect ${A_ID}`);
    expect(h.built).not.toContain(A_ID);
    expect(h.socketsOf(A_ID)).toEqual([]);
    expect(h.device.prompts).toBe(0);
  });

  it("the host's later handling of that same tap finds the switch already made", async () => {
    const h = await opened(A_ID);
    const response = sessionTap("t1", deviceOf(B_ID));
    await h.sessions.start(await preferredFor(h, async () => response));
    h.events.length = 0;
    const { deps } = tapHarness(h);

    const tap = handleNotificationTap(deps, response);
    await settle();

    expect(h.events).toEqual([]);
    await h.unlockCurrent();
    await settle();
    answer(h.socketOf(B_ID), "sessions:list", ROWS);
    await tap;
    expect(h.routes).toEqual(["/session/s1"]);
  });

  it("lastResponse throwing still starts the last active machine", async () => {
    const h = await opened(A_ID);
    const preferred = await preferredFor(h, () => {
      throw new Error("no native module");
    });
    expect(preferred).toBeUndefined();

    await h.sessions.start(preferred);
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it("lastResponse rejecting still starts the last active machine", async () => {
    const h = await opened(A_ID);
    const preferred = await preferredFor(h, () => Promise.reject(new Error("native failure")));
    expect(preferred).toBeUndefined();

    await h.sessions.start(preferred);
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it("lastResponse taking over 500 ms still starts the last active machine", async () => {
    const h = await opened(A_ID);
    const late = deferred<NotificationResponse | undefined>();
    vi.useFakeTimers();
    let answered = false;
    let preferred: MachineId | undefined = A_ID;
    void preferredFor(h, () => late.promise).then((value) => {
      answered = true;
      preferred = value;
    });

    await vi.advanceTimersByTimeAsync(COLD_START_TAP_WAIT_MS - 1);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(answered).toBe(true);
    expect(preferred).toBeUndefined();

    // Its answer, after all, changes nothing.
    late.resolve(sessionTap("t1", deviceOf(B_ID)));
    await vi.advanceTimersByTimeAsync(0);
    expect(preferred).toBeUndefined();
    vi.useRealTimers();

    await h.sessions.start(preferred);
    expect(h.sessions.current().id).toBe(A_ID);
  });

  it.each<[string, NotificationResponse | undefined]>([
    ["no tap at all", undefined],
    ["a tap with no device", sessionTap("t1")],
    ["a tap for a device no machine has", sessionTap("t1", NOT_HELD)],
    ["a malformed device", sessionTap("t1", "not-a-device")],
    ["data that does not parse", { id: "t1", data: { url: "x" } }],
  ])("%s: no preference", async (_name, response) => {
    const h = await opened(A_ID);
    await expect(preferredFor(h, async () => response)).resolves.toBeUndefined();
  });

  it("a store that cannot answer: no preference", async () => {
    await expect(
      coldStartMachine({
        lastResponse: async () => sessionTap("t1", deviceOf(B_ID)),
        findByDeviceId: () => Promise.reject(new Error("machines: store is not open")),
      }),
    ).resolves.toBeUndefined();
  });
});
