import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "./clock";
import type { ConnectionView } from "./connection-store";
import { createConnectionStore } from "./connection-store";
import type { ClientState, RpcClient, RpcResult } from "./rpc-client";

type StateDetail = { closeCode?: number; lastFrameAt?: number; pinMismatch?: true };
type StateHandler = (state: ClientState, detail: StateDetail) => void;

/** A minimal fake `RpcClient`: state, subscriptions and lastFrameAt are all
 * controlled directly by the test, and `onState` notifications are driven
 * by calling `emit` — nothing here ever opens a real (or fake) socket. */
function createFakeClient(initial: { state?: ClientState; subscriptions?: unknown[] } = {}) {
  let state: ClientState = initial.state ?? "idle";
  let subscriptions = initial.subscriptions ?? [];
  let lastFrameAt: number | undefined;
  const handlers = new Set<StateHandler>();
  const connectCalls: unknown[] = [];
  const disconnectCalls: number[] = [];

  const client: RpcClient = {
    connect: (...args) => {
      connectCalls.push(args);
    },
    disconnect: () => {
      disconnectCalls.push(1);
    },
    call: async (): Promise<RpcResult> => ({ ok: false, error: { kind: "offline" } }),
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
    subscriptions: () => subscriptions as never,
    lastFrameAt: () => lastFrameAt,
    setAppActive: () => {},
  };

  return {
    client,
    connectCalls,
    disconnectCalls,
    setLastFrameAt(value: number | undefined) {
      lastFrameAt = value;
    },
    setSubscriptions(subs: unknown[]) {
      subscriptions = subs;
    },
    /** Drives `onState` the way the real RpcClient does: updates the fake's
     * own `state()` first, then notifies every registered handler. */
    emit(next: ClientState, detail: StateDetail = {}) {
      state = next;
      for (const handler of [...handlers]) {
        handler(next, detail);
      }
    },
    handlerCount: () => handlers.size,
  };
}

describe("createConnectionStore: staleness", () => {
  it("is not stale when open with a recent frame", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    fake.setSubscriptions(["metrics:update"]);
    fake.setLastFrameAt(clock.now());
    fake.emit("open");

    expect(store.get()).toMatchObject({ state: "open", stale: false });
    store.dispose();
  });

  it("becomes stale when open, a subscription exists, and 10001ms pass with no frame", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    fake.setSubscriptions(["metrics:update"]);
    fake.setLastFrameAt(clock.now());
    fake.emit("open");
    expect(store.get().stale).toBe(false);

    clock.advance(10_001);
    expect(store.get().stale).toBe(true);
    store.dispose();
  });

  it("stays not stale when open with no subscriptions even after a long silence", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    fake.setSubscriptions([]);
    fake.setLastFrameAt(clock.now());
    fake.emit("open");

    clock.advance(20_000);
    expect(store.get().stale).toBe(false);
    store.dispose();
  });

  it("is stale while reconnecting", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    fake.emit("reconnecting");
    expect(store.get()).toMatchObject({ state: "reconnecting", stale: true });
    store.dispose();
  });

  it("re-evaluates on the 1000ms timer while open, notifying subscribers", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });
    const views: ConnectionView[] = [];
    store.subscribe((view) => views.push(view));

    fake.setSubscriptions(["metrics:update"]);
    fake.setLastFrameAt(clock.now());
    fake.emit("open");
    views.length = 0;

    // No new state event — only the clock moves past the stale threshold.
    clock.advance(11_000);

    expect(store.get().stale).toBe(true);
    expect(views.some((v) => v.stale)).toBe(true);
    store.dispose();
  });

  it("stops the 1000ms timer once no longer open (no more stale flips without a state change)", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    fake.setSubscriptions(["metrics:update"]);
    fake.setLastFrameAt(clock.now());
    fake.emit("open");
    fake.emit("reconnecting");

    const before = store.get();
    clock.advance(50_000);
    // Nothing throws, nothing changes without a new event/timer from a dead state.
    expect(store.get()).toEqual(before);
    store.dispose();
  });
});

describe("createConnectionStore: pinMismatch latch", () => {
  it("latches pinMismatch across subsequent connecting/authenticating states until open", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    fake.emit("reconnecting", { pinMismatch: true });
    expect(store.get().pinMismatch).toBe(true);

    // The real RpcClient only sets pinMismatch on that one "reconnecting"
    // notification — every later detail omits it. The store must keep
    // showing it anyway (N5's latch requirement).
    fake.emit("connecting", {});
    expect(store.get().pinMismatch).toBe(true);

    fake.emit("authenticating", {});
    expect(store.get().pinMismatch).toBe(true);

    fake.emit("open", {});
    expect(store.get().pinMismatch).toBeUndefined();
    store.dispose();
  });

  it(
    "N1: also clears the latch on 'closed', not only 'open' " +
      "[bite-proof: drop the closed branch and this fails]",
    () => {
      const fake = createFakeClient();
      const clock = createFakeClock();
      const store = createConnectionStore({
        client: fake.client,
        clock,
        onUnpaired: async () => "cleared" as const,
      });

      fake.emit("reconnecting", { pinMismatch: true });
      expect(store.get().pinMismatch).toBe(true);

      fake.emit("closed", {});
      expect(store.get().pinMismatch).toBeUndefined();
      store.dispose();
    },
  );

  it(
    "N1: also clears the latch on 'unpaired', not only 'open' " +
      "[bite-proof: drop the unpaired branch and this fails]",
    () => {
      const fake = createFakeClient();
      const clock = createFakeClock();
      const store = createConnectionStore({
        client: fake.client,
        clock,
        onUnpaired: async () => "cleared" as const,
      });

      fake.emit("reconnecting", { pinMismatch: true });
      expect(store.get().pinMismatch).toBe(true);

      fake.emit("unpaired", { closeCode: 4410 });
      expect(store.get().pinMismatch).toBeUndefined();
      store.dispose();
    },
  );

  it("Minor 4: dispose() unsubscribes from the client's onState (no dangling handler)", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    fake.emit("reconnecting", { pinMismatch: true });
    expect(store.get().pinMismatch).toBe(true);

    store.dispose();
    // After dispose, the store's onState subscription is gone — further
    // emits (if the fake still held a reference) must not reach it. Since
    // dispose() unsubscribes, this is really asserting the unsubscribe
    // function was called.
    expect(fake.handlerCount()).toBe(0);
  });
});

describe("createConnectionStore: Minor 1 (dedup notify)", () => {
  it("does not notify subscribers on a 1000ms tick when nothing changed", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    // No subscriptions => never stale while open, so every tick recomputes
    // the exact same view.
    fake.setSubscriptions([]);
    fake.emit("open");

    let notifyCount = 0;
    store.subscribe(() => {
      notifyCount += 1;
    });

    clock.advance(5_000); // five ticks of the 1000ms re-check timer
    expect(notifyCount).toBe(0);
    store.dispose();
  });

  it("still notifies once the computed view actually changes", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    fake.setSubscriptions(["metrics:update"]);
    fake.setLastFrameAt(clock.now());
    fake.emit("open");

    let notifyCount = 0;
    store.subscribe(() => {
      notifyCount += 1;
    });

    // Ticks land every 1000ms starting from t=0 (when "open" was emitted);
    // the tick that first sees > 10000ms of silence fires at t=11000, so
    // advancing to 11001 is what actually lets that tick run and notice.
    clock.advance(11_001);
    expect(notifyCount).toBeGreaterThan(0);
    expect(store.get().stale).toBe(true);
    store.dispose();
  });
});

describe("createConnectionStore: Minor 3 (isDisposed)", () => {
  it("isDisposed() is false until dispose() is called, then true", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    expect(store.isDisposed()).toBe(false);
    store.dispose();
    expect(store.isDisposed()).toBe(true);
  });
});

describe("createConnectionStore: onUnpaired (bite-proof)", () => {
  it("calls onUnpaired exactly once even if the unpaired state repeats", async () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const onUnpaired = vi.fn(async () => "cleared" as const);
    const store = createConnectionStore({ client: fake.client, clock, onUnpaired });

    fake.emit("unpaired", { closeCode: 4401 });
    fake.emit("unpaired", { closeCode: 4401 });
    fake.emit("unpaired", { closeCode: 4401 });

    // onUnpaired is queued asynchronously (not called synchronously inside
    // the onState handler) — let the microtask queue drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(onUnpaired).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("calls onUnpaired again for a second, later unpaired episode", async () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const onUnpaired = vi.fn(async () => "cleared" as const);
    const store = createConnectionStore({ client: fake.client, clock, onUnpaired });

    fake.emit("unpaired", { closeCode: 4401 });
    await Promise.resolve();
    fake.emit("connecting", {});
    fake.emit("unpaired", { closeCode: 4401 });
    await Promise.resolve();

    expect(onUnpaired).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it(
    "a 'clearFailed' outcome resets the guard immediately, without needing any state " +
      "transition in between (bite-proof)",
    async () => {
      // Unlike the "second, later episode" test above (which goes through
      // a "connecting" transition that would reset the guard on its own
      // regardless of `outcome`), this repeats "unpaired" with *no*
      // transition in between — the only thing that can reset the guard
      // here is the `outcome === "clearFailed"` branch itself.
      const fake = createFakeClient();
      const clock = createFakeClock();
      const onUnpaired = vi.fn(async () => "clearFailed" as const);
      const store = createConnectionStore({ client: fake.client, clock, onUnpaired });

      fake.emit("unpaired", { closeCode: 4401 });
      await Promise.resolve();
      await Promise.resolve();
      expect(onUnpaired).toHaveBeenCalledTimes(1);

      // Still "unpaired" — no transition away and back.
      fake.emit("unpaired", { closeCode: 4401 });
      await Promise.resolve();
      await Promise.resolve();

      expect(onUnpaired).toHaveBeenCalledTimes(2);
      store.dispose();
    },
  );

  it("I2: a rejecting onUnpaired does not escape the store as an unhandled rejection", async () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const onUnpaired = vi.fn(async () => {
      throw new Error("clearPairing failed");
    });
    const store = createConnectionStore({ client: fake.client, clock, onUnpaired });

    fake.emit("unpaired", { closeCode: 4401 });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // If the store's own `.catch` were missing, vitest would report this
    // test's file as failing with an unhandled rejection even though every
    // assertion below passes — the test only proves anything with that
    // guard removed (verified by hand: I2's fix round 1 report).
    expect(onUnpaired).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("never calls client.connect/disconnect synchronously from the onState reaction", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    fake.emit("unpaired", { closeCode: 4401 });

    expect(fake.connectCalls).toHaveLength(0);
    expect(fake.disconnectCalls).toHaveLength(0);
    store.dispose();
  });
});

describe("createConnectionStore: subscribe/get", () => {
  it("get() reflects the initial client state before any event", () => {
    const fake = createFakeClient({ state: "closed" });
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });

    expect(store.get()).toMatchObject({ state: "closed", stale: true });
    store.dispose();
  });

  it("subscribe returns an unsubscribe function that stops further notifications", () => {
    const fake = createFakeClient();
    const clock = createFakeClock();
    const store = createConnectionStore({
      client: fake.client,
      clock,
      onUnpaired: async () => "cleared" as const,
    });
    const views: ConnectionView[] = [];
    const unsubscribe = store.subscribe((view) => views.push(view));

    fake.emit("connecting");
    unsubscribe();
    fake.emit("reconnecting");

    expect(views).toHaveLength(1);
    expect(views[0]?.state).toBe("connecting");
    store.dispose();
  });
});
