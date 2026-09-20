import type { SubTarget } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import type { DashboardView } from "./dashboard-store";
import { createDashboardStore } from "./dashboard-store";
import type { ClientState, RpcClient, RpcResult } from "./rpc-client";

type StateHandler = (state: ClientState, detail: { closeCode?: number }) => void;
type PushHandler = (payload: unknown, dropped: number | undefined) => void;

/** A minimal fake `RpcClient`: `call` resolves from a queue the test fills
 * in, `subscribe`/`unsubscribe` just record what was asked for, and pushes
 * are driven directly via `push(channel, payload)` — no fake transport, no
 * real network, per the app's testing rules. */
function createFakeClient() {
  const subscribeCalls: SubTarget[] = [];
  const unsubscribeCalls: SubTarget[] = [];
  const callLog: { channel: string; args: unknown[] }[] = [];
  const pushHandlers = new Map<string, Set<PushHandler>>();
  const stateHandlers = new Set<StateHandler>();
  let state: ClientState = "open";
  const callResults: RpcResult[] = [];
  // Calls made once `callResults` is empty stay pending until resolved
  // explicitly via `resolvePending` — this is what lets a test resolve two
  // in-flight `projects:list` calls out of order (Minor 2).
  const pendingCalls: ((result: RpcResult) => void)[] = [];

  const client: RpcClient = {
    connect: () => {},
    disconnect: () => {},
    call: (channel, args) => {
      callLog.push({ channel, args });
      const queued = callResults.shift();
      if (queued !== undefined) {
        return Promise.resolve(queued);
      }
      return new Promise((resolve) => {
        pendingCalls.push(resolve);
      });
    },
    upload: async () => ({ ok: false, error: { kind: "offline" } }),
    subscribe: (target) => {
      subscribeCalls.push(target);
      return { ok: true, value: undefined };
    },
    unsubscribe: (target) => {
      unsubscribeCalls.push(target);
    },
    onPush: (channel, handler) => {
      let set = pushHandlers.get(channel);
      if (set === undefined) {
        set = new Set();
        pushHandlers.set(channel, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    onState: (handler) => {
      stateHandlers.add(handler);
      return () => {
        stateHandlers.delete(handler);
      };
    },
    state: () => state,
    capabilities: () => [],
    subscriptions: () => [],
    lastFrameAt: () => undefined,
    setAppActive: () => {},
  };

  return {
    client,
    subscribeCalls,
    unsubscribeCalls,
    callLog,
    queueResult(result: RpcResult) {
      callResults.push(result);
    },
    push(channel: string, payload: unknown) {
      for (const handler of pushHandlers.get(channel) ?? []) {
        handler(payload, undefined);
      }
    },
    setState(next: ClientState) {
      state = next;
      for (const handler of [...stateHandlers]) {
        handler(next, {});
      }
    },
    pushHandlerCount(channel: string) {
      return pushHandlers.get(channel)?.size ?? 0;
    },
    pendingCallCount() {
      return pendingCalls.length;
    },
    /** Resolves the call at `index` (in call order) — used to make an
     * earlier call's response arrive *after* a later one's, on purpose. */
    resolvePending(index: number, result: RpcResult) {
      const resolve = pendingCalls[index];
      if (resolve === undefined) throw new Error(`no pending call at index ${index}`);
      resolve(result);
    },
  };
}

// M12 Task 8: dashboard-store.ts's `parseSessions` now derives its narrow
// `SessionSummary` (id/project/state/summary) from session-parse.ts's
// shared `parseSession`, which parses a full `Session` — the real
// `sessions:list`/`sessions:update` wire payload (packages/desktop/src/
// ipc.ts sends `Session[]`), so `agentId`/`projectPath`/`startedAt` are
// required on every input fixture even though the store's own output
// never carries them.
function sessionPayload(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: "s1",
    project: "acme",
    projectPath: "/repos/acme",
    agentId: "claude-main",
    state: "running",
    summary: "fixing tests",
    startedAt: 1,
    lastActivityAt: 1,
    ...overrides,
  };
}

const METRICS_PAYLOAD = {
  cpuPercent: 12,
  memoryUsedBytes: 1024,
  memoryTotalBytes: 2048,
  diskUsedBytes: 4096,
  diskTotalBytes: 8192,
  networkDownMbps: 1.5,
  networkUpMbps: 0.5,
  uptimeSeconds: 100,
};

describe("createDashboardStore: focus/blur", () => {
  it("focus subscribes both channels and calls projects:list and sessions:list; both answers fill the view", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [{ name: "acme", path: "/repos/acme" }] });
    fake.queueResult({
      ok: true,
      value: [sessionPayload()],
    });
    const store = createDashboardStore({ client: fake.client });

    store.focus();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.subscribeCalls).toEqual(["metrics:update", "sessions:update"]);
    expect(fake.callLog).toEqual([
      { channel: "projects:list", args: [] },
      { channel: "sessions:list", args: [] },
    ]);
    expect(store.get().projects).toEqual([{ name: "acme", path: "/repos/acme" }]);
    expect(store.get().sessions).toEqual([
      { id: "s1", project: "acme", state: "running", summary: "fixing tests", startedAt: 1 },
    ]);
    expect(store.get().loading).toBe(false);
  });

  it("a metrics:update push replaces metrics", () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    const store = createDashboardStore({ client: fake.client });
    store.focus();

    fake.push("metrics:update", METRICS_PAYLOAD);

    expect(store.get().metrics).toEqual(METRICS_PAYLOAD);
  });

  it("a sessions:update push replaces sessions", () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    const store = createDashboardStore({ client: fake.client });
    store.focus();

    fake.push("sessions:update", [sessionPayload()]);
    expect(store.get().sessions).toEqual([
      { id: "s1", project: "acme", state: "running", summary: "fixing tests", startedAt: 1 },
    ]);

    fake.push("sessions:update", []);
    expect(store.get().sessions).toEqual([]);
  });

  it("blur unsubscribes both channels", () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    const store = createDashboardStore({ client: fake.client });

    store.focus();
    store.blur();

    expect(fake.unsubscribeCalls).toEqual(["metrics:update", "sessions:update"]);
    expect(fake.pushHandlerCount("metrics:update")).toBe(0);
    expect(fake.pushHandlerCount("sessions:update")).toBe(0);
  });

  it("an err result populates error with the server text unchanged", async () => {
    const fake = createFakeClient();
    fake.queueResult({
      ok: false,
      error: { kind: "remote", code: "internal", text: "القرص ممتلئ", language: "ar" },
    });
    fake.queueResult({ ok: true, value: [] }); // sessions:list, unaffected
    const store = createDashboardStore({ client: fake.client });

    store.focus();
    await Promise.resolve();
    await Promise.resolve();

    const view: DashboardView = store.get();
    expect(view.error).toEqual({
      kind: "remote",
      code: "internal",
      text: "القرص ممتلئ",
      language: "ar",
    });
    expect(view.loading).toBe(false);
  });

  it("a reconnect (state back to open) triggers refresh, calling projects:list and sessions:list again", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] }); // focus(): projects:list
    fake.queueResult({ ok: true, value: [] }); // focus(): sessions:list
    fake.queueResult({ ok: true, value: [{ name: "acme" }] }); // reconnect: projects:list
    fake.queueResult({ ok: true, value: [] }); // reconnect: sessions:list
    const store = createDashboardStore({ client: fake.client });

    store.focus();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.callLog).toHaveLength(2);

    fake.setState("reconnecting");
    fake.setState("open");
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.callLog).toHaveLength(4);
    expect(fake.callLog[2]).toEqual({ channel: "projects:list", args: [] });
    expect(fake.callLog[3]).toEqual({ channel: "sessions:list", args: [] });
    expect(store.get().projects).toEqual([{ name: "acme" }]);
  });

  it("Minor 2: a stale refresh response does not overwrite a newer one's (generation counter)", async () => {
    const fake = createFakeClient();
    const store = createDashboardStore({ client: fake.client });

    // focus() starts refresh #1's two calls (projects:list, sessions:list);
    // nothing queued, so both stay pending.
    store.focus();
    await Promise.resolve();
    expect(fake.pendingCallCount()).toBe(2);

    // A second, later refresh() starts two more calls — also left pending.
    void store.refresh();
    await Promise.resolve();
    expect(fake.pendingCallCount()).toBe(4);

    // Resolve out of order: the *newer* refresh's calls (index 2, 3) answer
    // first...
    fake.resolvePending(2, { ok: true, value: [{ name: "second" }] });
    fake.resolvePending(3, { ok: true, value: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().projects).toEqual([{ name: "second" }]);

    // ...then the older, now-stale refresh's calls (index 0, 1) answer
    // late. Without the generation guard this would clobber "second" back
    // to "first".
    fake.resolvePending(0, { ok: true, value: [{ name: "first" }] });
    fake.resolvePending(1, { ok: true, value: [] });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().projects).toEqual([{ name: "second" }]);
  });

  it("a sessions:update push wins over a stale sessions:list answer [bite-proof: read sessionsVersion instead of bumping it in the push handler; the stale answer overwrites]", async () => {
    const fake = createFakeClient();
    const store = createDashboardStore({ client: fake.client });

    // focus() starts refresh #1's two calls; leave both pending so
    // sessions:list is still in flight when the push arrives.
    store.focus();
    await Promise.resolve();
    expect(fake.pendingCallCount()).toBe(2);

    fake.push("sessions:update", [sessionPayload({ id: "from-push", summary: "pushed" })]);
    expect(store.get().sessions).toEqual([
      { id: "from-push", project: "acme", state: "running", summary: "pushed", startedAt: 1 },
    ]);

    // The older sessions:list answer arrives after — it must not clobber
    // the push's rows.
    fake.resolvePending(0, { ok: true, value: [] }); // projects:list
    fake.resolvePending(1, {
      ok: true,
      value: [sessionPayload({ id: "from-list", summary: "stale" })],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(store.get().sessions).toEqual([
      { id: "from-push", project: "acme", state: "running", summary: "pushed", startedAt: 1 },
    ]);
  });
});

describe("createDashboardStore: subscribe/get", () => {
  it("get() returns the initial empty view", () => {
    const fake = createFakeClient();
    const store = createDashboardStore({ client: fake.client });
    expect(store.get()).toEqual({ projects: [], sessions: [], loading: false });
  });

  it("subscribe notifies listeners on every view change", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: [] });
    fake.queueResult({ ok: true, value: [] });
    const store = createDashboardStore({ client: fake.client });
    const views: DashboardView[] = [];
    store.subscribe((view) => views.push(view));

    store.focus();
    await Promise.resolve();
    await Promise.resolve();

    expect(views.length).toBeGreaterThan(0);
    expect(views.at(-1)?.loading).toBe(false);
  });
});

describe("createDashboardStore: openTerminal (Dashboard Terminal tile)", () => {
  it("calls terminal:open with [project] and resolves to the new tab id", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: { ok: true, value: "tab-7" } });
    const store = createDashboardStore({ client: fake.client });

    const outcome = await store.openTerminal("acme");

    expect(fake.callLog).toContainEqual({ channel: "terminal:open", args: ["acme"] });
    expect(outcome).toEqual({ ok: true, tabId: "tab-7" });
  });

  it("resolves to the server's own text for an unknown project", async () => {
    const fake = createFakeClient();
    fake.queueResult({
      ok: true,
      value: { ok: false, text: "Unknown project.", language: "en" },
    });
    const store = createDashboardStore({ client: fake.client });

    expect(await store.openTerminal("nope")).toEqual({ ok: false, text: "Unknown project." });
  });

  it("never touches the dashboard view — it is the screen's own busy/error state", async () => {
    const fake = createFakeClient();
    fake.queueResult({ ok: true, value: { ok: true, value: "tab-7" } });
    const store = createDashboardStore({ client: fake.client });
    const before = store.get();

    await store.openTerminal("acme");

    expect(store.get()).toBe(before);
  });
});
