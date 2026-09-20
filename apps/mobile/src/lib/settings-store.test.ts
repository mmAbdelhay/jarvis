import { PUSH_UNREGISTER_CHANNEL } from "@jarvis/wire";
import { describe, expect, expectTypeOf, it } from "vitest";
import { createFakeClock } from "./clock";
import type { ConnectStoredOutcome } from "./connect-stored";
import { connectFromStoredPairing } from "./connect-stored";
import type { ConnectionStore, ConnectionView } from "./connection-store";
import { createConnectionStore } from "./connection-store";
import type { PairingRecord } from "./pairing-record";
import type { PrefsStore } from "./prefs";
import { PUSH_REGISTER_TIMEOUT_MS } from "./push-registration";
import type { PushRegistration, PushView } from "./push-registration";
import type {
  CallOptions,
  ClientState,
  Credential,
  Endpoint,
  RpcClient,
  RpcResult,
} from "./rpc-client";
import type { SecureStore } from "./secure-store";
import type { SettingsStoreDeps, SettingsView } from "./settings-store";
import { connectionStateKey, createSettingsStore } from "./settings-store";

type StateDetail = { closeCode?: number; lastFrameAt?: number; pinMismatch?: true };
type StateHandler = (state: ClientState, detail: StateDetail) => void;

/** A minimal fake `RpcClient`, mirroring connection-store.test.ts's fake:
 * state/lastFrameAt are controlled directly by the test, `connect`/
 * `disconnect` just record their calls, and nothing here ever opens a real
 * (or fake) socket. */
function createFakeClient(initial: { state?: ClientState } = {}) {
  let state: ClientState = initial.state ?? "open";
  let lastFrameAt: number | undefined;
  const handlers = new Set<StateHandler>();
  const connectCalls: { endpoint: Endpoint; credential: Credential }[] = [];
  const disconnectCalls: number[] = [];
  const calls: { channel: string; args: unknown[]; options?: CallOptions }[] = [];
  let scriptedCall: (
    channel: string,
    args: unknown[],
    options?: CallOptions,
  ) => Promise<RpcResult> = async () => ({ ok: false, error: { kind: "offline" } });

  const client: RpcClient = {
    connect: (endpoint, credential) => {
      connectCalls.push({ endpoint, credential });
    },
    disconnect: () => {
      disconnectCalls.push(1);
      state = "closed";
    },
    call: async (channel, args, options): Promise<RpcResult> => {
      calls.push({ channel, args, options });
      return scriptedCall(channel, args, options);
    },
    upload: async (): Promise<RpcResult> => ({ ok: false, error: { kind: "offline" } }),
    subscribe: () => ({ ok: true, value: undefined }),
    unsubscribe: () => {},
    onPush: () => () => {},
    onState: (handler: StateHandler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    state: () => state,
    capabilities: () => [],
    subscriptions: () => [],
    lastFrameAt: () => lastFrameAt,
    setAppActive: () => {},
  };

  return {
    client,
    connectCalls,
    disconnectCalls,
    calls,
    setScriptedCall(
      fn: (channel: string, args: unknown[], options?: CallOptions) => Promise<RpcResult>,
    ) {
      scriptedCall = fn;
    },
    setLastFrameAt(value: number | undefined) {
      lastFrameAt = value;
    },
    emit(next: ClientState, detail: StateDetail = {}) {
      state = next;
      for (const handler of [...handlers]) {
        handler(next, detail);
      }
    },
  };
}

const DEFAULT_PUSH_VIEW: PushView = { phase: "off", laptopEnabled: undefined, registered: false };

function createFakePushRegistration(initial: PushView = DEFAULT_PUSH_VIEW): Pick<
  PushRegistration,
  "get" | "subscribe" | "setEnabled"
> & {
  setEnabledCalls: boolean[];
  emit(view: PushView): void;
  listenerCount(): number;
} {
  let view = initial;
  const listeners = new Set<(view: PushView) => void>();
  const setEnabledCalls: boolean[] = [];
  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setEnabled: async (on: boolean) => {
      setEnabledCalls.push(on);
    },
    setEnabledCalls,
    emit(next: PushView) {
      view = next;
      for (const listener of [...listeners]) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

/** A fake `ConnectionStore` that counts live listeners directly (I5's own
 * test needs this — `createConnectionStore` doesn't expose a count), rather
 * than driving state through a fake `RpcClient`. */
function createCountingConnectionStore(): ConnectionStore & { listenerCount(): number } {
  const listeners = new Set<(view: ConnectionView) => void>();
  const view: ConnectionView = { state: "open", stale: false };
  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      listeners.clear();
    },
    isDisposed: () => false,
    listenerCount: () => listeners.size,
  };
}

function createFakePrefsStore(initial?: string): PrefsStore & { written: string[] } {
  let text = initial;
  const written: string[] = [];
  return {
    written,
    async read() {
      return text;
    },
    async write(next: string) {
      text = next;
      written.push(next);
    },
  };
}

const RECORD: PairingRecord = {
  deviceId: "d1234567890123456789012345678901",
  host: "192.168.1.5",
  port: 4317,
  fingerprint: `${"a".repeat(60)}beef`,
  laptopName: "Muhammad's MacBook",
  pairedAt: 1_000,
};

const RECORD_JSON = JSON.stringify({
  deviceId: RECORD.deviceId,
  host: RECORD.host,
  port: RECORD.port,
  fingerprint: RECORD.fingerprint,
  pairedAt: RECORD.pairedAt,
});

function baseDeps(overrides: Partial<SettingsStoreDeps> = {}): {
  deps: SettingsStoreDeps;
  fake: ReturnType<typeof createFakeClient>;
  clock: ReturnType<typeof createFakeClock>;
  connection: ConnectionStore;
  prefs: PrefsStore & { written: string[] };
  push: ReturnType<typeof createFakePushRegistration>;
  navigateCalls: number[];
  unpairCalls: number[];
  connectFromStoredCalls: number[];
  logs: string[];
} {
  const fake = createFakeClient();
  const clock = createFakeClock();
  const connection = createConnectionStore({
    client: fake.client,
    clock,
    // Matches connection-store.ts's own `onUnpaired` contract (Task 6 fix
    // round 2): reports whether it cleared the stored pairing. Not
    // exercised by any of this store's own tests, so a fixed "cleared" is
    // enough here.
    onUnpaired: async () => "cleared" as const,
  });
  const prefs = createFakePrefsStore();
  const push = createFakePushRegistration();
  const navigateCalls: number[] = [];
  const unpairCalls: number[] = [];
  const connectFromStoredCalls: number[] = [];
  const logs: string[] = [];

  const deps: SettingsStoreDeps = {
    prefs,
    localeTag: "en-US",
    loadRecord: async () => RECORD,
    connectFromStored: async (_shouldConnect: () => boolean): Promise<ConnectStoredOutcome> => {
      connectFromStoredCalls.push(1);
      return "connected";
    },
    connection,
    client: fake.client,
    clock,
    appVersion: "1.2.3",
    unpair: async () => {
      unpairCalls.push(1);
    },
    navigateToPair: () => {
      navigateCalls.push(1);
    },
    push,
    log: (line) => logs.push(line),
    ...overrides,
  };

  return {
    deps,
    fake,
    clock,
    connection,
    prefs,
    push,
    navigateCalls,
    unpairCalls,
    connectFromStoredCalls,
    logs,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("createSettingsStore: initial load", () => {
  it("language is undefined until prefs load (M4: no default-language flash)", () => {
    const { deps } = baseDeps({ localeTag: "ar-SA" });
    const store = createSettingsStore(deps);

    expect(store.get().language).toBeUndefined();
  });

  it("falls back to the device locale when no language pref is saved yet", async () => {
    const { deps } = baseDeps({ localeTag: "ar-SA" });
    const store = createSettingsStore(deps);
    await flush();

    expect(store.get().language).toBe("ar");
  });

  it("reads a saved language pref over the locale fallback", async () => {
    const prefs = createFakePrefsStore(JSON.stringify({ language: "en" }));
    const { deps } = baseDeps({ localeTag: "ar-SA", prefs });
    const store = createSettingsStore(deps);
    await flush();

    expect(store.get().language).toBe("en");
  });
});

describe("createSettingsStore: setLanguage", () => {
  it("persists the new language and sets restartRequired", async () => {
    const { deps, prefs } = baseDeps();
    const store = createSettingsStore(deps);
    await flush();

    expect(store.get().restartRequired).toBe(false);

    await store.setLanguage("ar");

    expect(store.get().language).toBe("ar");
    expect(store.get().restartRequired).toBe(true);
    expect(prefs.written).toEqual([
      JSON.stringify({
        language: "ar",
        speakReplies: true,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
      }),
    ]);
  });

  it("preserves the current speakReplies value (M8 Task 7, rule 17)", async () => {
    const { deps, prefs } = baseDeps({ localeTag: "ar-SA" });
    const store = createSettingsStore(deps);
    await flush();
    expect(store.get().language).toBe("ar");

    await store.setSpeakReplies(false);
    await store.setLanguage("en");

    expect(prefs.written).toEqual([
      JSON.stringify({
        language: "ar",
        speakReplies: false,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
      }),
      JSON.stringify({
        language: "en",
        speakReplies: false,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
      }),
    ]);
    expect(store.get().speakReplies).toBe(false);
  });
});

describe("createSettingsStore: setSpeakReplies (M8 Task 7, rule 17)", () => {
  it("writes the flag alongside the current language and updates the view", async () => {
    const { deps, prefs } = baseDeps({ localeTag: "en-US" });
    const store = createSettingsStore(deps);
    await flush();

    expect(store.get().speakReplies).toBe(true);

    await store.setSpeakReplies(false);

    expect(store.get().speakReplies).toBe(false);
    expect(prefs.written).toEqual([
      JSON.stringify({
        language: "en",
        speakReplies: false,
        notifications: false,
        pushRegistered: false,
        sidecarDesktopSite: true,
        sidecarZoom: {},
      }),
    ]);
  });

  it(
    "setLanguage after setSpeakReplies(false) writes speakReplies:false " +
      "[bite-proof: write {language} only; the flag resets to true]",
    async () => {
      const { deps, prefs } = baseDeps();
      const store = createSettingsStore(deps);
      await flush();

      await store.setSpeakReplies(false);
      prefs.written.length = 0;
      await store.setLanguage("ar");

      const written = JSON.parse(prefs.written[0] ?? "{}") as { speakReplies?: boolean };
      expect(written.speakReplies).toBe(false);
    },
  );

  it("a failed write keeps the previous view value", async () => {
    const { deps } = baseDeps();
    const prefs = createFakePrefsStore();
    prefs.write = async () => {
      throw new Error("disk full");
    };
    const store = createSettingsStore({ ...deps, prefs });
    await flush();

    await expect(store.setSpeakReplies(false)).rejects.toThrow("disk full");
    expect(store.get().speakReplies).toBe(true);
  });
});

describe("createSettingsStore: notifications (M10 Task 5, rule 10)", () => {
  it("the view's notifications mirrors deps.push.get() at construction", async () => {
    const { deps, push } = baseDeps();
    push.emit({ phase: "on", laptopEnabled: true, registered: true });
    const store = createSettingsStore(deps);
    await flush();

    expect(store.get().notifications).toEqual({
      phase: "on",
      laptopEnabled: true,
      registered: true,
    });
  });

  it("follows push.subscribe while subscribed, armed/disarmed with the first/last subscriber", async () => {
    const { deps, push } = baseDeps();
    const store = createSettingsStore(deps);
    await flush();

    expect(push.listenerCount()).toBe(0);
    const unsubscribe = store.subscribe(() => {});
    expect(push.listenerCount()).toBe(1);

    push.emit({ phase: "denied", laptopEnabled: undefined, registered: false });
    expect(store.get().notifications).toEqual({
      phase: "denied",
      laptopEnabled: undefined,
      registered: false,
    });

    unsubscribe();
    expect(push.listenerCount()).toBe(0);
  });

  it("setNotifications(on) forwards to push.setEnabled(on)", async () => {
    const { deps, push } = baseDeps();
    const store = createSettingsStore(deps);
    await flush();

    await store.setNotifications(true);
    await store.setNotifications(false);

    expect(push.setEnabledCalls).toEqual([true, false]);
  });

  it(
    "setLanguage never clobbers a notifications/pushRegistered value saved " +
      "outside this store (push-registration.ts's own prefs writes)",
    async () => {
      // Simulates push-registration.ts having already saved
      // notifications:true, pushRegistered:true to the same shared Prefs
      // blob before this store makes its own, unrelated write.
      const prefs = createFakePrefsStore(
        JSON.stringify({
          language: "en",
          speakReplies: true,
          notifications: true,
          pushRegistered: true,
        }),
      );
      const { deps } = baseDeps({ prefs });
      const store = createSettingsStore(deps);
      await flush();

      await store.setLanguage("ar");

      const written = JSON.parse(prefs.written[0] ?? "{}") as {
        notifications?: boolean;
        pushRegistered?: boolean;
      };
      expect(written.notifications).toBe(true);
      expect(written.pushRegistered).toBe(true);
    },
  );
});

describe("createSettingsStore: laptop projection (I4)", () => {
  it("shows a display-only laptop object and the fingerprint tail, never the full fingerprint", async () => {
    const { deps } = baseDeps();
    const store = createSettingsStore(deps);
    await flush();

    const view = store.get();
    expect(view.fingerprintTail).toBe("beef");
    expect(view.laptop).toEqual({
      host: RECORD.host,
      port: RECORD.port,
      laptopName: RECORD.laptopName,
      deviceId: RECORD.deviceId,
      pairedAt: RECORD.pairedAt,
    });
    // I4 bite-proof: the full fingerprint must never reach the view.
    expect(Object.hasOwn(view, "fingerprint")).toBe(false);
    expect(Object.hasOwn(view.laptop as object, "fingerprint")).toBe(false);
    expect(JSON.stringify(view)).not.toContain(RECORD.fingerprint);
  });

  it("[type-level] SettingsView and its laptop projection carry no fingerprint field", () => {
    expectTypeOf<SettingsView>().not.toHaveProperty("fingerprint");
    expectTypeOf<SettingsView["laptop"]>().exclude(undefined).not.toHaveProperty("fingerprint");
  });

  it("is undefined when there is no paired record", async () => {
    const { deps } = baseDeps({ loadRecord: async () => undefined });
    const store = createSettingsStore(deps);
    await flush();

    expect(store.get().fingerprintTail).toBeUndefined();
    expect(store.get().laptop).toBeUndefined();
  });
});

describe("createSettingsStore: unpair (I1)", () => {
  it("disconnects, clears the pairing, disconnects again, then navigates to /pair, in that order", async () => {
    const order: string[] = [];
    const fake = createFakeClient();
    const originalDisconnect = fake.client.disconnect;
    fake.client.disconnect = () => {
      order.push("disconnect");
      originalDisconnect();
    };
    const { deps } = baseDeps({
      client: fake.client,
      unpair: async () => {
        order.push("clear");
      },
      navigateToPair: () => {
        order.push("navigate");
      },
    });
    const store = createSettingsStore(deps);
    await flush();

    await store.unpair();

    // I-A: a second disconnect() after the clear resolves covers a connect
    // that slipped in some other way between the first disconnect and the
    // clear finishing.
    expect(order).toEqual(["disconnect", "clear", "disconnect", "navigate"]);
    expect(store.get().unpairError).toBe(false);
  });

  it(
    "fix round 1 (Minor): a throwing navigateToPair() never makes unpair() reject " +
      "[bite-proof: drop the try/catch around navigateToPair(); this rejects]",
    async () => {
      const { deps, logs } = baseDeps({
        navigateToPair: () => {
          throw new Error("router.replace failed");
        },
      });
      const store = createSettingsStore(deps);
      await flush();

      await expect(store.unpair()).resolves.toBeUndefined();
      expect(logs).toContain("settings-store: navigateToPair() threw after unpair");
    },
  );

  it(
    "fix round 1 (Minor): a throwing subscriber never makes unpair() reject " +
      "[bite-proof: call setView directly instead of safeSetView; this rejects]",
    async () => {
      const { deps, logs } = baseDeps();
      const store = createSettingsStore(deps);
      await flush();
      let notifyCount = 0;
      store.subscribe(() => {
        notifyCount += 1;
        // The first notification is `subscribe()`'s own immediate
        // computation, outside unpair() entirely — only the ones unpair()
        // itself triggers should throw.
        if (notifyCount > 1) throw new Error("a bad subscriber");
      });

      await expect(store.unpair()).resolves.toBeUndefined();
      expect(logs).toContain("settings-store: a subscriber threw while unpairing");
    },
  );

  it("sets unpairError and does not navigate when the keychain clear throws", async () => {
    const { deps, fake, navigateCalls } = baseDeps({
      unpair: async () => {
        throw new Error("keychain delete failed");
      },
    });
    const store = createSettingsStore(deps);
    await flush();

    await store.unpair();

    expect(store.get().unpairError).toBe(true);
    expect(navigateCalls).toEqual([]);
    // The client is still left disconnected — the safer state (I1).
    expect(fake.disconnectCalls).toHaveLength(1);
  });

  it("retrying unpair after a failure clears unpairError on success", async () => {
    let shouldFail = true;
    const { deps, navigateCalls } = baseDeps({
      unpair: async () => {
        if (shouldFail) throw new Error("keychain delete failed");
      },
    });
    const store = createSettingsStore(deps);
    await flush();

    await store.unpair();
    expect(store.get().unpairError).toBe(true);

    shouldFail = false;
    await store.unpair();

    expect(store.get().unpairError).toBe(false);
    expect(navigateCalls).toEqual([1]);
  });

  it(
    "R-M4 / T7 r2 Minor 1 bite-proof: unpairing resets in a finally even " +
      "when client.disconnect() throws, so unpair() resolves (never an " +
      "unhandled rejection) and a second unpair() call actually runs " +
      "[bite-proof: reset `unpairing` outside a whole-function finally " +
      "(e.g. only on deps.unpair()'s own catch) and it stays stuck true " +
      "forever, so the second unpair() below is refused at entry]",
    async () => {
      const { isClearingPairing } = await import("./pairing-guard");
      const fake = createFakeClient();
      let throwOnce = true;
      const originalDisconnect = fake.client.disconnect;
      fake.client.disconnect = () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("native disconnect failed");
        }
        originalDisconnect();
      };
      let clearCallCount = 0;
      const { deps, navigateCalls, logs } = baseDeps({
        client: fake.client,
        unpair: async () => {
          clearCallCount += 1;
        },
      });
      const store = createSettingsStore(deps);
      await flush();

      expect(isClearingPairing()).toBe(false);
      await expect(store.unpair()).resolves.toBeUndefined();
      expect(isClearingPairing()).toBe(false);
      expect(clearCallCount).toBe(1);
      expect(navigateCalls).toHaveLength(1);
      // Fix round 1 (Minor): the disconnect-threw log line is a fixed
      // string through the store's own `log` dep — never the raw error
      // object.
      expect(logs).toContain("settings-store: disconnect() threw before clearing the pairing");

      // A second call must actually run — not be silently refused by a
      // `unpairing` flag left stuck true by the first call's throwing
      // disconnect().
      await store.unpair();
      expect(clearCallCount).toBe(2);
      expect(navigateCalls).toHaveLength(2);
    },
  );

  it("calls remote:unregisterPush with whenNotOpen:'reject' before clearPairing (rule 10)", async () => {
    const order: string[] = [];
    const fake = createFakeClient();
    fake.setScriptedCall(async (channel) => {
      order.push(`call:${channel}`);
      return { ok: true, value: undefined };
    });
    const { deps } = baseDeps({
      client: fake.client,
      unpair: async () => {
        order.push("clear");
      },
    });
    const store = createSettingsStore(deps);
    await flush();

    await store.unpair();

    expect(order).toEqual([`call:${PUSH_UNREGISTER_CHANNEL}`, "clear"]);
    expect(fake.calls[0]).toEqual({
      channel: PUSH_UNREGISTER_CHANNEL,
      args: [],
      options: { whenNotOpen: "reject", timeoutMs: PUSH_REGISTER_TIMEOUT_MS },
    });
  });

  it(
    "a rejected (or offline-refused) unregister call does not stop the unpair " +
      "[bite-proof: await the result and throw]",
    async () => {
      const fake = createFakeClient();
      fake.setScriptedCall(async () => {
        throw new Error("socket dropped mid-call");
      });
      const { deps, navigateCalls } = baseDeps({ client: fake.client });
      const store = createSettingsStore(deps);
      await flush();

      await expect(store.unpair()).resolves.toBeUndefined();

      expect(navigateCalls).toEqual([1]);
      expect(store.get().unpairError).toBe(false);
    },
  );

  it("a second unpair() call while the first is still in flight is refused (entry guard)", async () => {
    let resolveClear: () => void = () => {};
    const clearing = new Promise<void>((resolve) => {
      resolveClear = resolve;
    });
    const clearCalls: number[] = [];
    const { deps, navigateCalls } = baseDeps({
      unpair: async () => {
        clearCalls.push(1);
        await clearing;
      },
    });
    const store = createSettingsStore(deps);
    await flush();

    const first = store.unpair();
    await flush();
    const second = store.unpair(); // still in flight — must not run a second time

    resolveClear();
    await first;
    await second;

    expect(clearCalls).toEqual([1]);
    expect(navigateCalls).toEqual([1]);
  });
});

describe("createSettingsStore: reconnect (I3, shared connect-stored path)", () => {
  it('calls the shared connectFromStored dep and clears any previous reconnectError on "connected"', async () => {
    const { deps, connectFromStoredCalls } = baseDeps();
    const store = createSettingsStore(deps);
    await flush();

    store.reconnect();
    await flush();

    expect(connectFromStoredCalls).toEqual([1]);
    expect(store.get().reconnectError).toBe(false);
  });

  it('navigates to /pair on an "unpaired" outcome', async () => {
    const { deps, navigateCalls } = baseDeps({
      connectFromStored: async () => "unpaired",
    });
    const store = createSettingsStore(deps);
    await flush();

    store.reconnect();
    await flush();

    expect(navigateCalls).toEqual([1]);
  });

  it('sets reconnectError on a "failed" outcome, without navigating', async () => {
    const { deps, navigateCalls } = baseDeps({
      connectFromStored: async () => "failed",
    });
    const store = createSettingsStore(deps);
    await flush();

    store.reconnect();
    await flush();

    expect(store.get().reconnectError).toBe(true);
    expect(navigateCalls).toEqual([]);
  });

  it(
    "R-M2 bite-proof: the shouldConnect passed to the shared connectFromStored " +
      "refuses while the automatic unpaired handler's clear is in flight " +
      "(isClearingPairing()), not only this store's own unpairing " +
      "[bite-proof: drop the isClearingPairing() check from the callback and " +
      "shouldConnect() reads true here]",
    async () => {
      const { setClearingPairing, isClearingPairing } = await import("./pairing-guard");
      let observedShouldConnect: (() => boolean) | undefined;
      const { deps } = baseDeps({
        connectFromStored: async (shouldConnect) => {
          observedShouldConnect = shouldConnect;
          return "connected";
        },
      });
      const store = createSettingsStore(deps);
      await flush();

      setClearingPairing(true);
      try {
        store.reconnect();
        await flush();

        expect(observedShouldConnect).toBeDefined();
        expect(observedShouldConnect?.()).toBe(false);
      } finally {
        setClearingPairing(false);
      }

      expect(isClearingPairing()).toBe(false);
    },
  );

  it("never lets a rejecting connectFromStored escape as an unhandled rejection", async () => {
    const { deps } = baseDeps({
      connectFromStored: async () => {
        throw new Error("keychain unavailable");
      },
    });
    const store = createSettingsStore(deps);
    await flush();

    expect(() => store.reconnect()).not.toThrow();
    await flush();

    expect(store.get().reconnectError).toBe(true);
  });

  it("disconnects before re-reading the stored pairing", async () => {
    const { deps, fake } = baseDeps();
    const store = createSettingsStore(deps);
    await flush();

    store.reconnect();

    expect(fake.disconnectCalls).toHaveLength(1);
  });

  it("M5: a reconnect in flight never connects after unpair() has already cleared the pairing", async () => {
    let resolveOutcome: (outcome: ConnectStoredOutcome) => void = () => {};
    const outcomePromise = new Promise<ConnectStoredOutcome>((resolve) => {
      resolveOutcome = resolve;
    });
    const { deps, navigateCalls } = baseDeps({
      connectFromStored: () => outcomePromise,
    });
    const store = createSettingsStore(deps);
    await flush();

    store.reconnect();
    await flush(); // reconnect's read is now pending on outcomePromise

    await store.unpair();
    expect(navigateCalls).toEqual([1]);

    // The stored pairing was cleared while the reconnect was still in
    // flight; when its read finally resolves "connected" (as if it had
    // read the record moments before the clear), the guard must still
    // suppress it.
    resolveOutcome("connected");
    await flush();

    expect(navigateCalls).toEqual([1]);
  });

  it(
    "I-A: the real connect-stored.ts shouldConnect guard stops a connect that would " +
      "otherwise slip in while unpair() clears the pairing during reconnect()'s load",
    async () => {
      // Wires the *real* connectFromStoredPairing, not a fake, so this
      // proves the actual guard inside connect-stored.ts — not just
      // settings-store's own post-await `unpairing` check (already covered
      // by the test above) — is what stops the connect.
      //
      // R-M4 (task-8-brief.md rule 1): `unpairing` now resets in a
      // `finally` as soon as `unpair()` itself finishes, rather than
      // staying stuck `true` for the rest of this store instance's life —
      // so this test parks `deps.unpair()` on its own controllable promise
      // and resolves the deferred keychain read *while `unpair()` is still
      // clearing*, which is what the test's own title describes and what
      // the shared `isClearingPairing()` flag (still `true` at that point)
      // is what actually stops the connect now.
      let resolveRecordRead: (value: string | undefined) => void = () => {};
      const recordRead = new Promise<string | undefined>((resolve) => {
        resolveRecordRead = resolve;
      });
      let resolveClear: () => void = () => {};
      const clearing = new Promise<void>((resolve) => {
        resolveClear = resolve;
      });
      const secureStore: SecureStore = {
        get: async (key) => {
          if (key === "jarvis.pairing") return recordRead;
          return "secret-token";
        },
        set: async () => {},
        delete: async () => {},
      };
      const fake = createFakeClient();
      const { deps, navigateCalls } = baseDeps({
        client: fake.client,
        connectFromStored: (shouldConnect) =>
          connectFromStoredPairing({ secureStore, client: fake.client, shouldConnect }),
        unpair: async () => {
          await clearing;
        },
      });
      const store = createSettingsStore(deps);
      await flush();

      store.reconnect(); // starts the real read; it's parked on `recordRead`
      await flush();

      const unpairPromise = store.unpair(); // unpairing = true, parked on `clearing`
      await flush();

      // The deferred keychain read now resolves with a *valid* record, as
      // if it had been read moments before the clear, while the clear is
      // still in flight — the guard, checked immediately before
      // `client.connect` inside connect-stored.ts, must still stop it.
      resolveRecordRead(RECORD_JSON);
      await flush();

      expect(fake.connectCalls).toEqual([]);

      resolveClear();
      await unpairPromise;
      expect(navigateCalls).toEqual([1]);
    },
  );

  it("clears a previous unpairError once a later reconnect actually succeeds", async () => {
    const { deps } = baseDeps({
      unpair: async () => {
        throw new Error("keychain delete failed");
      },
    });
    const store = createSettingsStore(deps);
    await flush();

    await store.unpair();
    expect(store.get().unpairError).toBe(true);

    store.reconnect();
    await flush();

    expect(store.get().unpairError).toBe(false);
  });
});

describe("createSettingsStore: bite-proof — no token or credential ever reaches the view (I2)", () => {
  it("[type-level] SettingsView has no token or credential field", () => {
    expectTypeOf<SettingsView>().not.toHaveProperty("token");
    expectTypeOf<SettingsView>().not.toHaveProperty("credential");
  });

  it("[runtime bite-proof] get() never exposes a credential or token key, before or after reconnect()", async () => {
    const { deps } = baseDeps();
    const store = createSettingsStore(deps);
    await flush();
    store.reconnect();
    await flush();

    const view = store.get() as Record<string, unknown>;
    expect(Object.hasOwn(view, "credential")).toBe(false);
    expect(Object.hasOwn(view, "token")).toBe(false);
  });
});

describe("createSettingsStore: lastFrameAgoMs ticker (M1, M2)", () => {
  it("computes lastFrameAgoMs immediately on the first subscriber (M2)", async () => {
    const { deps, fake } = baseDeps();
    fake.setLastFrameAt(0);
    const store = createSettingsStore(deps);
    await flush();

    expect(store.get().lastFrameAgoMs).toBeUndefined();

    const unsubscribe = store.subscribe(() => {});
    expect(store.get().lastFrameAgoMs).toBe(0);
    unsubscribe();
  });

  it("updates on a 1000ms timer from a fake clock while there is a subscriber", async () => {
    const { deps, fake, clock } = baseDeps();
    fake.setLastFrameAt(0);
    const store = createSettingsStore(deps);
    await flush();

    const views: number[] = [];
    const unsubscribe = store.subscribe((view) => {
      if (view.lastFrameAgoMs !== undefined) views.push(view.lastFrameAgoMs);
    });

    clock.advance(1_000);
    clock.advance(1_000);

    expect(views).toContain(1_000);
    expect(views).toContain(2_000);

    unsubscribe();
  });

  it("stops ticking once the last subscriber unsubscribes (M1)", async () => {
    const { deps, fake, clock } = baseDeps();
    fake.setLastFrameAt(0);
    const store = createSettingsStore(deps);
    await flush();

    const views: number[] = [];
    const unsubscribe = store.subscribe((view) => {
      if (view.lastFrameAgoMs !== undefined) views.push(view.lastFrameAgoMs);
    });
    clock.advance(1_000);
    const countAtUnsubscribe = views.length;
    unsubscribe();

    // Advance well past several more ticks — with no live subscriber, no
    // further notifications should have been produced. A second,
    // independent subscribe is used only to sample the current value
    // afterwards, not to observe ticks during the gap.
    clock.advance(5_000);
    const resubscribeViews: number[] = [];
    const unsubscribeAgain = store.subscribe((view) => {
      if (view.lastFrameAgoMs !== undefined) resubscribeViews.push(view.lastFrameAgoMs);
    });

    expect(views.length).toBe(countAtUnsubscribe);
    // The immediate M2 compute on the fresh subscribe reflects the full
    // elapsed gap (6000ms), proving no intermediate ticks fired while
    // unsubscribed (those would have produced 2000, 3000, 4000, 5000ms
    // notifications the first `views` array never received).
    expect(resubscribeViews).toEqual([6_000]);
    unsubscribeAgain();
  });

  it("is undefined when the client has never seen a frame", async () => {
    const { deps } = baseDeps();
    const store = createSettingsStore(deps);
    await flush();

    expect(store.get().lastFrameAgoMs).toBeUndefined();
  });
});

describe("createSettingsStore: connection listener lifetime (I5)", () => {
  it("subscribing and unsubscribing N times leaves 0 extra listeners on the connection store", async () => {
    const counting = createCountingConnectionStore();
    const { deps } = baseDeps({ connection: counting });
    const store = createSettingsStore(deps);
    await flush();

    expect(counting.listenerCount()).toBe(0);

    for (let i = 0; i < 5; i++) {
      const unsubscribe = store.subscribe(() => {});
      expect(counting.listenerCount()).toBe(1);
      unsubscribe();
      expect(counting.listenerCount()).toBe(0);
    }
  });

  it("mirrors the connection store's view while subscribed", async () => {
    const { deps, fake, connection } = baseDeps();
    const store = createSettingsStore(deps);
    await flush();

    const unsubscribe = store.subscribe(() => {});
    expect(store.get().connection).toEqual(connection.get());

    fake.emit("reconnecting");
    expect(store.get().connection.state).toBe("reconnecting");
    unsubscribe();
  });
});

describe("createSettingsStore: appVersion", () => {
  it("passes appVersion straight through", async () => {
    const { deps } = baseDeps({ appVersion: "9.9.9" });
    const store = createSettingsStore(deps);
    await flush();

    expect(store.get().appVersion).toBe("9.9.9");
  });
});

describe("connectionStateKey (I-B: rendering view.connection)", () => {
  it("maps every ClientState to a MessageKey — open+non-stale gets its own 'connected' key", () => {
    expect(connectionStateKey({ state: "open", stale: false })).toBe("settings.connected");
    expect(connectionStateKey({ state: "open", stale: true })).toBe("conn.stale");
    expect(connectionStateKey({ state: "connecting", stale: false })).toBe("conn.connecting");
    expect(connectionStateKey({ state: "authenticating", stale: false })).toBe("conn.connecting");
    expect(connectionStateKey({ state: "reconnecting", stale: false })).toBe("conn.reconnecting");
    expect(connectionStateKey({ state: "closed", stale: true })).toBe("conn.offline");
    expect(connectionStateKey({ state: "unpaired", stale: true })).toBe("conn.unpaired");
    expect(connectionStateKey({ state: "incompatible", stale: true })).toBe("conn.incompatible");
    expect(connectionStateKey({ state: "idle", stale: true })).toBe("conn.offline");
  });

  it("a latched pinMismatch takes priority over the per-state mapping", () => {
    expect(connectionStateKey({ state: "open", stale: false, pinMismatch: true })).toBe(
      "conn.pinMismatch",
    );
  });
});
