// CoreClient over jarvisd's control socket (daemon/control/client.ts).
//
// main.ts sees the same CoreClient it gets in-process; what differs is
// where each member goes:
//
//   - invoke: a `req` frame to the daemon's dispatch table (DESKTOP_ORIGIN
//     there, always). Nothing is queued while disconnected: a call then
//     rejects at once.
//   - The synchronous reads — firstRun, hostConfig(), workspace.state() —
//     come from a local cache, never a round trip: filled by the snapshot
//     every connect pulls (daemon:snapshot) and kept current by the
//     daemon's pushes (daemon:tabs, daemon:hostConfig). Tab state is
//     versioned, so a snapshot reply that is older than a push already
//     applied is ignored (see VersionedTabs).
//   - The DesktopHost the app attaches stays here. Its two synchronous
//     reads, isFocused and isAwake, are the core's to ask, so this side
//     samples them and reports each change (daemon:hostState); the hooks
//     the core calls arrive as pushes and are run against it.
//   - Every other push goes to onPush listeners, in the order it came.
//
// Ordering: one socket, one stream. A push the core emits while handling a
// request reaches onPush listeners before that request's invoke settles
// (daemon/binding.ts). A view request follows the tab state that made it.
//
// Reconnect: when the connection drops, calls in flight reject, and the
// adapter reconnects with backoff. Each connect is a full resync —
// snapshot, then the host re-attached — and nothing from before the drop is
// replayed. A daemon of another build answers restart-required: the adapter
// asks `restartDaemon` (the service manager) to restart it, at most
// MAX_DAEMON_RESTARTS times in DAEMON_RESTART_WINDOW_MS, then gives up and
// says so in its connection state.
//
// No electron here (core/no-electron.test.ts).
import type { RemoteStatus } from "@jarvis/remote";
import type { PushSink } from "../broadcast.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../messages.js";
import { openBridgeWebUrl } from "../open-external-guard.js";
import { type ControlClient, ControlRestartRequired } from "../daemon/control/client.js";
import {
  DAEMON_PUSHES,
  DAEMON_REQUESTS,
  type DaemonInfo,
  type DaemonSnapshot,
  type HostWindowState,
  isDaemonInfo,
  type SecurityAlert,
  type VersionedTabs,
} from "../daemon/protocol.js";
import { createRestartGuard, type RestartGuard } from "../daemon/restart-guard.js";
import type { CoreClient, DbGateCredential, DesktopHost, HostConfig } from "./core-client.js";
import type { ViewRequest } from "./tab-host.js";
import type { WorkspaceState } from "@jarvis/core";

export const RECONNECT_INITIAL_MS = 250;
export const RECONNECT_MAX_MS = 10_000;
/** How often the attached window's focus and visibility are sampled. */
export const HOST_STATE_POLL_MS = 500;
/** How long the first connect keeps trying — Task 23's socket wait. */
export const INITIAL_CONNECT_TIMEOUT_MS = 10_000;

export type ConnectionState =
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number; inMs: number }
  | { kind: "restarting" }
  | { kind: "failed"; error: string }
  | { kind: "stopped" };

export type SocketCoreClient = CoreClient & {
  /** The daemon's pid and start time (daemon:info), for Settings. */
  info(): Promise<DaemonInfo>;
  /** Asks the daemon to apply the file's `remote:` to its bridge again. */
  reapplyRemote(): Promise<void>;
  /** Writes daemon.enabled through the daemon core's config writer. */
  setDaemonEnabled(enabled: boolean): Promise<void>;
  connection(): ConnectionState;
  onConnectionChange(listener: (state: ConnectionState) => void): () => void;
};

export type SocketCoreClientDeps = {
  /** One authenticated control connection (connectControl, bound to this
   *  app's build and run directory). */
  connect(): Promise<ControlClient>;
  /** Restarts the daemon through the service manager, for restart-required.
   *  Without it, restart-required is a failure. */
  restartDaemon?(): Promise<void>;
  now(): number;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  log(line: string): void;
  restartGuard?: RestartGuard;
  initialTimeoutMs?: number;
  hostPollMs?: number;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class ConnectFailed extends Error {}

/**
 * Connects to jarvisd and resolves once the first snapshot is in, so every
 * synchronous read has an answer. Rejects if no connection is made within
 * `initialTimeoutMs`, or at once when the daemon needs a restart that can't
 * be done.
 */
export async function connectSocketCoreClient(
  deps: SocketCoreClientDeps,
): Promise<SocketCoreClient> {
  const guard = deps.restartGuard ?? createRestartGuard({ now: deps.now });
  const pollMs = deps.hostPollMs ?? HOST_STATE_POLL_MS;

  let connection: ControlClient | undefined;
  let state: ConnectionState = { kind: "connecting" };
  let stopped = false;
  let firstRun = false;
  let hostConfig: HostConfig = { allowPopups: false, suspendTabsAfterMs: 0 };
  /** What the app's pages were built with (ViewReconciler reads it once). */
  let startupSuspendTabsAfterMs = 0;
  let tabs: VersionedTabs | undefined;
  let host: DesktopHost | undefined;
  let hostPoll: unknown;
  let reported: HostWindowState | undefined;
  let wait: { timer: unknown; wake(): void } | undefined;

  const pushListeners = new Set<PushSink>();
  const changeListeners = new Set<(state: WorkspaceState) => void>();
  const viewListeners = new Set<(request: ViewRequest) => void>();
  const stateListeners = new Set<(state: ConnectionState) => void>();

  function each<T>(listeners: Set<(value: T) => void>, value: T, what: string): void {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        deps.log(`${what} listener failed: ${describe(error)}`);
      }
    }
  }

  function setState(next: ConnectionState): void {
    state = next;
    each(stateListeners, next, "connection");
  }

  function applyTabs(next: VersionedTabs): void {
    const current = tabs;
    if (
      current !== undefined &&
      current.instance === next.instance &&
      next.version <= current.version
    ) {
      return;
    }
    tabs = next;
    each(changeListeners, next.state, "workspace");
  }

  const hostState = (): HostWindowState | undefined =>
    host === undefined ? undefined : { focused: host.isFocused(), awake: host.isAwake() };

  function onPush(channel: string, payload: unknown): void {
    const p = payload as Record<string, unknown>;
    switch (channel) {
      case DAEMON_PUSHES.tabs:
        applyTabs(payload as VersionedTabs);
        return;
      case DAEMON_PUSHES.viewRequest:
        each(viewListeners, payload as ViewRequest, "view request");
        return;
      case DAEMON_PUSHES.hostConfig:
        hostConfig = payload as HostConfig;
        return;
      case DAEMON_PUSHES.requestFavicon:
        host?.requestFavicon(String(p.project), String(p.url));
        return;
      case DAEMON_PUSHES.sweepIdleViews:
        host?.sweepIdleViews();
        return;
      case DAEMON_PUSHES.openExternal: {
        const target = host;
        if (target === undefined) return;
        openBridgeWebUrl(String(p.url), {
          status: () => request("remote:status", []) as Promise<RemoteStatus>,
          open: (url) => target.openExternal(url),
          log: deps.log,
        }).catch((error: unknown) => deps.log(`open in browser failed: ${describe(error)}`));
        return;
      }
      case DAEMON_PUSHES.trashItem:
        host
          ?.trashItem(String(p.path))
          .catch((error: unknown) => deps.log(`move to trash failed: ${describe(error)}`));
        return;
      case DAEMON_PUSHES.restart:
        // Sent only to the app that asked. The daemon restarts itself for
        // the settings it reads; this app relaunches only if a setting it
        // alone reads, once, at startup, changed.
        if (hostConfig.suspendTabsAfterMs !== startupSuspendTabsAfterMs) host?.restart();
        return;
      case DAEMON_PUSHES.restarting:
        deps.log("the Jarvis daemon is restarting");
        setState({ kind: "restarting" });
        return;
      case DAEMON_PUSHES.restartManual:
        host?.showNotification(
          MESSAGES.daemonRestartManualTitle(PRIMARY_LANGUAGE),
          MESSAGES.daemonRestartManual(PRIMARY_LANGUAGE),
        );
        return;
      case DAEMON_PUSHES.alert: {
        const alert = payload as SecurityAlert;
        host?.showNotification(alert.title, alert.body);
        return;
      }
    }
    if (channel.startsWith("daemon:")) return;
    for (const listener of [...pushListeners]) {
      try {
        listener(channel, payload);
      } catch (error) {
        deps.log(`Push to ${channel} failed: ${describe(error)}`);
      }
    }
  }

  /** Fire-and-forget: a call whose answer nobody waits for. */
  function fire(channel: string, args: unknown[]): void {
    request(channel, args).catch((error: unknown) =>
      deps.log(`${channel} failed: ${describe(error)}`),
    );
  }

  function request(channel: string, args: readonly unknown[]): Promise<unknown> {
    if (connection === undefined) {
      return Promise.reject(new Error("The Jarvis daemon is not connected"));
    }
    return connection.invoke(channel, [...args]);
  }

  function reportHost(): void {
    const now = hostState();
    if (now === undefined || connection === undefined) return;
    if (reported?.focused === now.focused && reported.awake === now.awake) return;
    reported = now;
    fire(DAEMON_REQUESTS.hostState, [now]);
  }

  async function attachHostRemotely(): Promise<void> {
    const now = hostState();
    if (now === undefined) return;
    reported = now;
    await request(DAEMON_REQUESTS.attachHost, [now]);
  }

  async function establish(first: boolean): Promise<void> {
    const opened = await deps.connect();
    if (stopped) {
      opened.close();
      return;
    }
    // Pushes are taken from the first frame after welcome, before the
    // snapshot: a tab change in between is applied by version, and the
    // older snapshot reply then leaves it alone.
    const offPush = opened.onPush(onPush);
    opened.onClose(() => {
      offPush();
      if (connection !== opened) return;
      connection = undefined;
      if (!stopped) void reconnect();
    });
    let snapshot: DaemonSnapshot;
    try {
      snapshot = (await opened.invoke(DAEMON_REQUESTS.snapshot, [])) as DaemonSnapshot;
    } catch (error) {
      opened.close();
      throw error;
    }
    if (first) {
      firstRun = snapshot.firstRun;
      startupSuspendTabsAfterMs = snapshot.hostConfig.suspendTabsAfterMs;
    }
    hostConfig = snapshot.hostConfig;
    connection = opened;
    applyTabs(snapshot.tabs);
    try {
      await attachHostRemotely();
    } catch (error) {
      deps.log(`attaching the window to the daemon failed: ${describe(error)}`);
    }
    if (connection === opened) setState({ kind: "connected" });
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = deps.timers.setTimeout(() => {
        wait = undefined;
        resolve();
      }, ms);
      wait = { timer, wake: resolve };
    });
  }

  /** Tries until connected, `deadline` passes, or a restart can't be done.
   *  Throws the reason when it gives up. */
  async function connectLoop(first: boolean, deadline: number | undefined): Promise<void> {
    let attempt = 0;
    for (;;) {
      if (stopped) throw new ConnectFailed("The connection to the Jarvis daemon was stopped");
      try {
        await establish(first);
        return;
      } catch (error) {
        if (error instanceof ControlRestartRequired) {
          if (deps.restartDaemon === undefined) {
            const reason = "The Jarvis daemon runs a different build and must be restarted";
            setState({ kind: "failed", error: reason });
            throw new ConnectFailed(reason);
          }
          if (!guard.allow()) {
            const reason =
              "The Jarvis daemon still runs a different build after being restarted several times; it was not restarted again";
            deps.log(reason);
            setState({ kind: "failed", error: reason });
            throw new ConnectFailed(reason);
          }
          setState({ kind: "restarting" });
          deps.log("the Jarvis daemon runs a different build; restarting it");
          try {
            await deps.restartDaemon();
          } catch (restartError) {
            deps.log(`restarting the Jarvis daemon failed: ${describe(restartError)}`);
          }
        }
        if (deadline !== undefined && deps.now() >= deadline) throw error;
        const inMs = Math.min(RECONNECT_INITIAL_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt += 1;
        if (!first) setState({ kind: "reconnecting", attempt, inMs });
        await sleep(inMs);
      }
    }
  }

  async function reconnect(): Promise<void> {
    setState({ kind: "reconnecting", attempt: 0, inMs: 0 });
    try {
      await connectLoop(false, undefined);
    } catch {
      // The state already says why (failed or stopped).
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (wait !== undefined) {
      deps.timers.clearTimeout(wait.timer);
      wait.wake();
      wait = undefined;
    }
    if (hostPoll !== undefined) deps.timers.clearInterval(hostPoll);
    hostPoll = undefined;
    host = undefined;
    const open = connection;
    connection = undefined;
    open?.close();
    setState({ kind: "stopped" });
  }

  try {
    await connectLoop(true, deps.now() + (deps.initialTimeoutMs ?? INITIAL_CONNECT_TIMEOUT_MS));
  } catch (error) {
    stop();
    throw error;
  }

  const client: SocketCoreClient = {
    get firstRun() {
      return firstRun;
    },
    hostConfig: () => ({ ...hostConfig }),

    invoke: (channel, args) => request(channel, args),
    onPush(listener) {
      pushListeners.add(listener);
      return () => {
        pushListeners.delete(listener);
      };
    },
    broadcast: (channel, payload) => fire(DAEMON_REQUESTS.broadcast, [channel, payload]),

    workspace: {
      state: () => (tabs as VersionedTabs).state,
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
      reportPage: (id, fact) => fire(DAEMON_REQUESTS.reportPage, [id, fact]),
      suspend: (id) => fire(DAEMON_REQUESTS.suspend, [id]),
      open: (project, input, kind, detail) =>
        fire(DAEMON_REQUESTS.open, [project, input, kind ?? null, detail ?? null]),
    },
    favicons: {
      put: (pageUrl, base64, contentType) =>
        request(DAEMON_REQUESTS.faviconPut, [pageUrl, base64, contentType]).then(
          (outcome) => outcome as Awaited<ReturnType<CoreClient["favicons"]["put"]>>,
        ),
      putMiss: (pageUrl) =>
        request(DAEMON_REQUESTS.faviconMiss, [pageUrl]).then(
          (outcome) => outcome as Awaited<ReturnType<CoreClient["favicons"]["putMiss"]>>,
        ),
    },

    attachHost(desktop) {
      host = desktop;
      if (connection !== undefined) {
        attachHostRemotely().catch((error: unknown) =>
          deps.log(`attaching the window to the daemon failed: ${describe(error)}`),
        );
      }
      if (hostPoll !== undefined) deps.timers.clearInterval(hostPoll);
      hostPoll = deps.timers.setInterval(reportHost, pollMs);
      return () => {
        if (host !== desktop) return;
        host = undefined;
        reported = undefined;
        if (hostPoll !== undefined) deps.timers.clearInterval(hostPoll);
        hostPoll = undefined;
        if (connection !== undefined) fire(DAEMON_REQUESTS.detachHost, []);
      };
    },

    voice: {
      start: () => fire(DAEMON_REQUESTS.voiceStart, []),
      stop: () => fire(DAEMON_REQUESTS.voiceStop, []),
    },
    dbgateCredentialFor: (port) =>
      request(DAEMON_REQUESTS.dbgateCredential, [port]).then(
        (answer) => (answer ?? undefined) as DbGateCredential | undefined,
      ),

    // The daemon starts its own bridge at boot: it has to serve phones with
    // no app open at all.
    startRemote: () => {},
    announceStartup: () => request(DAEMON_REQUESTS.announceStartup, []).then(() => undefined),
    // This app's connection only. The daemon, its terminals and its agent
    // runs keep going — that is what it is for.
    stop,

    async info() {
      const answer = await request(DAEMON_REQUESTS.info, []);
      if (!isDaemonInfo(answer)) throw new Error("The Jarvis daemon answered daemon:info oddly");
      return answer;
    },
    reapplyRemote: () => request(DAEMON_REQUESTS.reapplyRemote, []).then(() => undefined),
    setDaemonEnabled: (enabled) =>
      request(DAEMON_REQUESTS.setDaemonEnabled, [enabled]).then(() => undefined),

    connection: () => state,
    onConnectionChange(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
  };
  return client;
}
