import type { SubTarget } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createDashboardStore } from "./dashboard-store";
import type { ClientState, RpcClient } from "./rpc-client";
import { topBarStoreFor } from "./top-bar-store";

type PushHandler = (payload: unknown, dropped: number | undefined) => void;

function createFakeClient() {
  const subscribeCalls: SubTarget[] = [];
  const unsubscribeCalls: SubTarget[] = [];
  const callLog: string[] = [];
  const pushHandlers = new Map<string, Set<PushHandler>>();
  const stateHandlers = new Set<(state: ClientState, detail: { closeCode?: number }) => void>();
  const client: RpcClient = {
    connect: () => {},
    disconnect: () => {},
    call: async (channel) => {
      callLog.push(channel);
      return { ok: true, value: [] };
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
      const set = pushHandlers.get(channel) ?? new Set<PushHandler>();
      pushHandlers.set(channel, set);
      set.add(handler);
      return () => {
        set.delete(handler);
      };
    },
    onState: (handler) => {
      stateHandlers.add(handler);
      return () => {
        stateHandlers.delete(handler);
      };
    },
    state: () => "open",
    capabilities: () => [],
    subscriptions: () => [],
    lastFrameAt: () => undefined,
    setAppActive: () => {},
    unlock: () => {},
    lock: () => {},
  };
  return {
    client,
    subscribeCalls,
    unsubscribeCalls,
    callLog,
    push(channel: string, payload: unknown) {
      for (const handler of pushHandlers.get(channel) ?? []) handler(payload, undefined);
    },
    setState(next: ClientState) {
      for (const handler of [...stateHandlers]) handler(next, {});
    },
  };
}

const METRICS = {
  cpuPercent: 10,
  memoryUsedBytes: 1,
  memoryTotalBytes: 2,
  diskUsedBytes: 1,
  diskTotalBytes: 4,
  networkDownMbps: 1,
  networkUpMbps: 1,
  uptimeSeconds: 5,
};

const SESSION = {
  id: "s1",
  project: "p",
  projectPath: "/p",
  agentId: "claude",
  state: "running",
  summary: "x",
  startedAt: 1,
  lastActivityAt: 1,
};

describe("topBarStoreFor", () => {
  it("is one store per client", () => {
    const fake = createFakeClient();
    expect(topBarStoreFor(fake.client)).toBe(topBarStoreFor(fake.client));
    expect(topBarStoreFor(createFakeClient().client)).not.toBe(topBarStoreFor(fake.client));
  });

  it("two top bars and the dashboard: no projects:list from the top bar, one metrics subscription", () => {
    const fake = createFakeClient();
    const store = topBarStoreFor(fake.client);
    const releaseA = store.subscribe(() => {});
    const releaseB = store.subscribe(() => {});
    const dashboard = createDashboardStore({ client: fake.client });
    dashboard.focus();

    const topBarMetricSubs = fake.subscribeCalls.filter((target) => target === "metrics:update");
    // One from the shared top-bar store, one from the dashboard (ref-counted by the client).
    expect(topBarMetricSubs).toHaveLength(2);
    expect(fake.callLog.filter((channel) => channel === "projects:list")).toHaveLength(1);
    expect(fake.callLog.filter((channel) => channel === "sessions:list")).toHaveLength(2);

    dashboard.blur();
    releaseA();
    expect(fake.unsubscribeCalls.filter((t) => t === "metrics:update")).toHaveLength(1);
    releaseB();
    expect(fake.unsubscribeCalls.filter((t) => t === "metrics:update")).toHaveLength(2);
  });

  it("subscribes once however many top bars read it", () => {
    const fake = createFakeClient();
    const store = topBarStoreFor(fake.client);
    store.subscribe(() => {});
    store.subscribe(() => {});
    expect(fake.subscribeCalls).toEqual(["metrics:update", "sessions:update"]);
    expect(fake.callLog).toEqual(["sessions:list"]);
  });

  it("re-reads only sessions:list on reconnect", () => {
    const fake = createFakeClient();
    topBarStoreFor(fake.client).subscribe(() => {});
    fake.setState("open");
    expect(fake.callLog).toEqual(["sessions:list", "sessions:list"]);
  });

  it("gives a second consumer the cached metrics synchronously", () => {
    const fake = createFakeClient();
    const store = topBarStoreFor(fake.client);
    const release = store.subscribe(() => {});
    fake.push("metrics:update", METRICS);
    fake.push("sessions:update", [SESSION, { ...SESSION, id: "s2", state: "done" }]);
    release();
    // Settings opening later reads the last values straight away.
    expect(store.get().metrics?.cpuPercent).toBe(10);
    expect(store.get().runningCount).toBe(1);
  });

  it("notifies listeners on pushes", () => {
    const fake = createFakeClient();
    const store = topBarStoreFor(fake.client);
    const seen: number[] = [];
    store.subscribe((view) => seen.push(view.metrics?.cpuPercent ?? -1));
    fake.push("metrics:update", METRICS);
    expect(seen).toEqual([10]);
  });
});
