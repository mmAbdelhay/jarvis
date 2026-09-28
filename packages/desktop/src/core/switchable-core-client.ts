// The CoreClient main.ts holds for the app's lifetime, over whichever core
// is live: the in-process one or jarvisd's (Task 23). Turning "Keep Jarvis
// running in the background" on switches it from the first to the second
// without a new window: every listener main.ts registered once — the
// renderer's pushes, the ViewReconciler's tab state and view requests, the
// attached DesktopHost — moves to the new client, and the tab listeners are
// handed the new client's state at once so the pages follow it.
//
// Stopping the client switched away from is the caller's business (the
// in-process core is shut down by daemon/mode.ts's turn-on).
//
// No electron here (core/no-electron.test.ts).
import type { PushSink } from "../broadcast.js";
import type { CoreClient, DesktopHost } from "./core-client.js";
import type { ViewRequest } from "./tab-host.js";
import type { WorkspaceState } from "@jarvis/core";

export type SwitchableCoreClient = CoreClient & {
  current(): CoreClient;
  /** Moves every listener and the attached host to `next`. */
  switchTo(next: CoreClient): void;
};

export function switchableCoreClient(
  initial: CoreClient,
  log: (line: string) => void,
): SwitchableCoreClient {
  let current = initial;
  let host: DesktopHost | undefined;
  let detachCurrent: (() => void) | undefined;
  const pushListeners = new Set<PushSink>();
  const changeListeners = new Set<(state: WorkspaceState) => void>();
  const viewListeners = new Set<(request: ViewRequest) => void>();

  function each<T>(listeners: Set<(value: T) => void>, value: T, what: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        log(`${what} listener failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  let unsubscribe: () => void = () => {};
  function subscribe(client: CoreClient): void {
    const offPush = client.onPush((channel, payload) => {
      for (const listener of [...pushListeners]) listener(channel, payload);
    });
    const offChange = client.workspace.onChange((state) =>
      each(changeListeners, state, "workspace"),
    );
    const offView = client.workspace.onViewRequest((request) =>
      each(viewListeners, request, "view request"),
    );
    unsubscribe = () => {
      offView();
      offChange();
      offPush();
    };
  }
  subscribe(initial);

  return {
    firstRun: initial.firstRun,
    hostConfig: () => current.hostConfig(),
    invoke: (channel, args) => current.invoke(channel, args),
    onPush(listener) {
      pushListeners.add(listener);
      return () => {
        pushListeners.delete(listener);
      };
    },
    broadcast: (channel, payload) => current.broadcast(channel, payload),
    workspace: {
      state: () => current.workspace.state(),
      onChange(listener) {
        changeListeners.add(listener);
        return () => {
          changeListeners.delete(listener);
        };
      },
      onViewRequest(listener) {
        viewListeners.add(listener);
        return () => {
          viewListeners.delete(listener);
        };
      },
      reportPage: (id, fact) => current.workspace.reportPage(id, fact),
      suspend: (id) => current.workspace.suspend(id),
      open: (...args) => current.workspace.open(...args),
    },
    favicons: {
      put: (...args) => current.favicons.put(...args),
      putMiss: (pageUrl) => current.favicons.putMiss(pageUrl),
    },
    attachHost(desktop) {
      detachCurrent?.();
      host = desktop;
      detachCurrent = current.attachHost(desktop);
      return () => {
        if (host !== desktop) return;
        host = undefined;
        detachCurrent?.();
        detachCurrent = undefined;
      };
    },
    voice: { start: () => current.voice.start(), stop: () => current.voice.stop() },
    dbgateCredentialFor: (port) => current.dbgateCredentialFor(port),
    startRemote: () => current.startRemote(),
    announceStartup: () => current.announceStartup(),
    stop: () => current.stop(),

    current: () => current,
    switchTo(next) {
      if (next === current) return;
      unsubscribe();
      detachCurrent?.();
      detachCurrent = undefined;
      current = next;
      subscribe(next);
      if (host !== undefined) detachCurrent = next.attachHost(host);
      each(changeListeners, next.workspace.state(), "workspace");
    },
  };
}
