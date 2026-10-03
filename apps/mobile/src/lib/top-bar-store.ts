// The WideShell sidebar's one data source: the latest metrics, the waiting-
// session count and the account capacity, shared by every shell (the tabs
// shell's and Settings') through one store per RpcClient. It listens to the
// same pushes the Dashboard does and re-reads only `sessions:list` (the
// sessions push fires on change only) — never `projects:list`. Values stay
// cached after the last reader leaves, so a top bar mounted later (Settings)
// shows the last metrics at once instead of `--%`.

import type { SystemMetrics } from "@jarvis/core";
import { parseMetrics, parseSessions } from "./dashboard-store";
import { type CapacityCard, parseProviderCapacity } from "./home-capacity";
import type { RpcClient } from "./rpc-client";
import { waitingCountOf } from "./wide-shell-model";

export type TopBarView = {
  metrics?: SystemMetrics;
  waitingCount: number;
  capacity: CapacityCard[];
};

export type TopBarStore = {
  get(): TopBarView;
  /** Adds a reader. The first one subscribes; the last release drops the
   *  subscriptions (the cached view stays). */
  subscribe(listener: (view: TopBarView) => void): () => void;
};

export function createTopBarStore(deps: { client: RpcClient }): TopBarStore {
  const listeners = new Set<(view: TopBarView) => void>();
  let view: TopBarView = { waitingCount: 0, capacity: [] };
  let teardown: (() => void) | undefined;
  // A sessions:list answer that started before the latest push is stale.
  let sessionsVersion = 0;

  function setView(patch: Partial<TopBarView>): void {
    view = { ...view, ...patch };
    for (const listener of [...listeners]) listener(view);
  }

  async function refreshSessions(): Promise<void> {
    const started = sessionsVersion;
    const result = await deps.client.call("sessions:list", []);
    if (!result.ok || started !== sessionsVersion || teardown === undefined) return;
    setView({ waitingCount: waitingCountOf(parseSessions(result.value)) });
  }

  function start(): () => void {
    const offMetrics = deps.client.onPush("metrics:update", (payload) => {
      const metrics = parseMetrics(payload);
      if (metrics !== undefined) setView({ metrics });
    });
    const offSessions = deps.client.onPush("sessions:update", (payload) => {
      sessionsVersion += 1;
      setView({ waitingCount: waitingCountOf(parseSessions(payload)) });
    });
    const offProviders = deps.client.onPush("providers:update", (payload) => {
      setView({ capacity: parseProviderCapacity(payload) });
    });
    deps.client.subscribe("metrics:update");
    deps.client.subscribe("sessions:update");
    deps.client.subscribe("providers:update");
    const offState = deps.client.onState((state) => {
      if (state === "open") void refreshSessions();
    });
    return () => {
      deps.client.unsubscribe("metrics:update");
      deps.client.unsubscribe("sessions:update");
      deps.client.unsubscribe("providers:update");
      offProviders();
      offMetrics();
      offSessions();
      offState();
    };
  }

  return {
    get: () => view,
    subscribe(listener) {
      listeners.add(listener);
      if (teardown === undefined) {
        teardown = start();
        void refreshSessions();
      }
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0 && teardown !== undefined) {
          const stop = teardown;
          teardown = undefined;
          stop();
        }
      };
    },
  };
}

const stores = new WeakMap<RpcClient, TopBarStore>();

/** The one top-bar store for `client` (the app has exactly one client). */
export function topBarStoreFor(client: RpcClient): TopBarStore {
  let store = stores.get(client);
  if (store === undefined) {
    store = createTopBarStore({ client });
    stores.set(client, store);
  }
  return store;
}
