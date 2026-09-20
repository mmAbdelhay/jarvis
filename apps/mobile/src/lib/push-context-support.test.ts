// task-6-review.md fix round 1, Important 1 + Minors: the prefs facade must
// be truthful before the registration is built (no defaults masquerading
// as the real saved state), `waitForOpen` resolves on open and gives up
// after its timeout, and the once-per-id cap evicts in insertion order at
// 32. push-context-support.ts's own header explains why these live in a
// separate file from push-context.tsx (which can't be imported here at
// all — it pulls in `expo-router` at module scope).
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationsAdapter, PushPermission } from "./notifications";
import type { Prefs, PrefsStore } from "./prefs";
import { savePrefs } from "./prefs";
import {
  MAX_HANDLED_IDS,
  createPrefsFacade,
  recordHandledId,
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

// --- createPrefsFacade ----------------------------------------------------

describe("createPrefsFacade", () => {
  it("get() answers the seed synchronously — no load, no await needed", () => {
    const store = new FakeStore(undefined);
    const facade = createPrefsFacade(store, "en-US", {
      notifications: true,
      pushRegistered: false,
    });
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
    } satisfies Prefs);

    const facade = createPrefsFacade(store, "en-US", {
      notifications: false,
      pushRegistered: false,
    });
    await facade.set({ notifications: true });

    const written = JSON.parse((await store.read()) ?? "{}") as Prefs;
    expect(written).toEqual<Prefs>({
      language: "ar",
      speakReplies: false,
      notifications: true,
      pushRegistered: false,
      sidecarDesktopSite: true,
      sidecarZoom: {},
    });
    expect(facade.get()).toEqual<PushPrefs>({ notifications: true, pushRegistered: false });
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
      const facade = createPrefsFacade(store, "en-US", {
        notifications: true,
        pushRegistered: false,
      });

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
