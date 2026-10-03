// The one door from the Electron host (main.ts) into the core.
//
// Phase 2 runs the core in two places: in-process, inside Electron main, and
// in `jarvisd` behind a local control socket. main.ts talks to both through
// this type and nothing else (main-core-seam.test.ts), so switching between
// them is a matter of which adapter is built — `inProcessCoreClient` below,
// or the socket adapter — and main.ts does not change.
//
// The contract: every argument and every result that crosses is a JSON
// value — plain objects, arrays, strings, finite numbers, booleans and null.
// No Uint8Array, Map, Date, class instance or function. Binary crosses as
// base64 text; the one binary payload today is a favicon (favicons.put),
// decoded and capped in the core (favicon-intake.ts). The in-process
// adapter's `roundTrip` mode puts every value through that rule, so a
// non-JSON value fails a test now rather than a socket later.
//
// Every stream is one ordered stream: pushes, tab changes and view requests
// arrive in the order the core produced them, which a socket adapter keeps
// by delivering its frames in order. The Workspace relies on that — a `load`
// request has to follow the state that created its tab's page.
//
// Synchronous reads. In-process these are live calls; a socket adapter
// cannot make a round trip inside them, so it must serve each from a local
// cache that pushes keep current:
//   - DesktopHost.isFocused / isAwake — the core reads these (the notifier's
//     every decision, the metrics tick), so the app side reports its window
//     state and the core side caches it;
//   - hostConfig().allowPopups — read on every popup; cached from the
//     handshake and refreshed when settings change;
//   - workspace.state() — the ViewReconciler reads it when it starts to
//     follow; mirrored from the handshake snapshot and workspace:update.
// firstRun and hostConfig().suspendTabsAfterMs are read once, at startup,
// so the handshake alone serves them.
//
// No electron here (core/no-electron.test.ts).
import type { PushSink } from "../broadcast.js";
import type { PushChannels } from "../channels.js";
import { DESKTOP_ORIGIN, type TableChannel } from "../dispatch.js";
import type { Core } from "./compose.js";
import type { FaviconIntake } from "./favicon-intake.js";
import type { DesktopHost } from "./host-link.js";
import type { TabReports, TabSource } from "./tab-host.js";

export type { DesktopHost };

/** The request channels the core answers: every invoke channel except the
 *  Electron-bound ones desktop-only.ts serves in the host itself. */
export type CoreChannel = TableChannel;

/** The settings the host's own Electron objects read. */
export type HostConfig = {
  /** Whether a hosted page may open a popup as a new tab. Read live, on
   *  every popup: Settings changes it without a restart. */
  allowPopups: boolean;
  /** How long a hosted page may sit hidden before the idle sweep reclaims
   *  it. 0 never suspends. Read once, when the window's pages are built. */
  suspendTabsAfterMs: number;
};

export type DbGateCredential = { login: string; password: string };

export type CoreClient = {
  /** Whether this launch created jarvis.yaml — the first-run setup screen. */
  readonly firstRun: boolean;
  hostConfig(): HostConfig;

  /** One request, answered by the core's dispatch table. The origin is
   *  always the desktop's: this door is the desktop app's own. */
  invoke(channel: CoreChannel, args: readonly unknown[]): Promise<unknown>;
  /** Every push for this app's renderer, in order — what the core sends to
   *  every client and what it sends to this one alone. */
  onPush(listener: PushSink): () => void;
  /** A push the host itself originates for every client — the hotkey
   *  notices. A push only this window cares about never needs the core. */
  broadcast<C extends keyof PushChannels>(channel: C, payload: PushChannels[C]): void;

  /** The Workspace's tab state, which the host's ViewReconciler follows
   *  and reports its pages' facts, idle suspensions and popups to. */
  readonly workspace: TabSource & TabReports;
  /** Where the host's favicon fetches land — the store bookmarks read. The
   *  icon crosses as base64; the core decodes it and refuses one over 256
   *  KiB decoded. */
  readonly favicons: FaviconIntake;

  /** Hands the core this app's window, pages and OS services. Returns the
   *  detach. */
  attachHost(host: DesktopHost): () => void;

  /** Push-to-talk: the hotkeys and the mic button drive the same pair. */
  readonly voice: { start(): void; stop(): void };
  /** DbGate's BASIC_AUTH answer for Electron's login challenge, when the
   *  port is one a running DbGate holds. */
  dbgateCredentialFor(port: number): Promise<DbGateCredential | undefined>;

  /** Starts the remote bridge's lifecycle. Fired and forgotten. */
  startRemote(): void;
  /** The greeting, the startup health line and the capacity report —
   *  once the window has loaded. */
  announceStartup(): Promise<void>;
  /** Releases what this client holds. In-process that is every child the
   *  core started. Idempotent. */
  stop(): void;
};

/**
 * A value as it would arrive over the socket: checked against the JSON-only
 * contract, then copied through JSON. Throws on anything JSON would change
 * or drop silently — a typed array, a Map, a Date, a class instance, a
 * function, a non-finite number, an undefined array slot.
 */
export function throughJson<T>(value: T, where: string): T {
  if (value === undefined) return value;
  assertJson(value, where);
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertJson(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path}: ${value} is not JSON`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (item === undefined) throw new TypeError(`${path}[${index}]: undefined in an array`);
      assertJson(item, `${path}[${index}]`);
    });
    return;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`${path}: a ${proto?.constructor?.name ?? "non-plain"} is not JSON`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) assertJson(item, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path}: a ${typeof value} is not JSON`);
}

export type InProcessOptions = {
  /** Puts every argument and result that crosses through throughJson, as a
   *  socket would. Tests only: it costs a copy per call. */
  roundTrip?: boolean;
};

/**
 * The core, in this process, behind CoreClient.
 *
 * Nothing is translated: a request reaches the dispatch table with the
 * caller's own argument array and DESKTOP_ORIGIN, synchronously — a handler
 * runs in the same tick the IPC call arrived, exactly as when main.ts
 * registered the table directly — and a push reaches every listener in the
 * order the core sent it.
 */
export function inProcessCoreClient(core: Core, options: InProcessOptions = {}): CoreClient {
  const { tabs } = core;
  const wire: <T>(value: T, where: string) => T = options.roundTrip
    ? throughJson
    : (value) => value;
  /** A promise's value through `wire`, and a rejection as a message only —
   *  what an error frame carries. */
  const settle = <T>(promise: Promise<T>, where: string): Promise<T> =>
    options.roundTrip
      ? promise.then(
          (value) => throughJson(value, where),
          (error: unknown) => {
            throw new Error(error instanceof Error ? error.message : String(error));
          },
        )
      : promise;

  return {
    firstRun: wire(core.firstRun, "firstRun"),
    hostConfig: () => wire(core.hostConfig(), "hostConfig"),

    invoke(channel, args) {
      // Own properties only: over a socket the channel is a string from
      // outside, and "constructor" must not find Object.prototype's.
      if (!Object.hasOwn(core.dispatch, channel)) {
        return Promise.reject(new Error(`No handler for ${channel}`));
      }
      try {
        const sent = wire(args, `${channel} args`);
        return settle(
          Promise.resolve(core.dispatch[channel](sent, DESKTOP_ORIGIN)),
          `${channel} result`,
        );
      } catch (error) {
        return Promise.reject(error);
      }
    },
    onPush: (listener) =>
      core.onPush((channel, payload) => listener(channel, wire(payload, `push ${channel}`))),
    broadcast: (channel, payload) =>
      core.broadcast.send(channel, wire(payload, `broadcast ${channel}`)),

    workspace: {
      state: () => wire(tabs.state(), "workspace.state"),
      onChange: (listener) => tabs.onChange((state) => listener(wire(state, "workspace change"))),
      onViewRequest: (listener) =>
        tabs.onViewRequest((request) => listener(wire(request, "view request"))),
      reportPage: (id, fact) => tabs.reportPage(id, wire(fact, "reportPage")),
      suspend: (id) => tabs.suspend(wire(id, "suspend")),
      open: (...args) => tabs.open(...wire(args, "open")),
    },
    favicons: {
      put: (...args) =>
        settle(core.favicons.put(...wire(args, "favicons.put")), "favicons.put result"),
      putMiss: (pageUrl) =>
        settle(core.favicons.putMiss(wire(pageUrl, "favicons.putMiss")), "favicons.putMiss result"),
    },

    attachHost: (host) =>
      core.attachHost({
        isFocused: () => wire(host.isFocused(), "isFocused"),
        isAwake: () => wire(host.isAwake(), "isAwake"),
        requestFavicon: (...args) => host.requestFavicon(...wire(args, "requestFavicon")),
        sweepIdleViews: () => host.sweepIdleViews(),
        destroyViews: () => host.destroyViews(),
        showNotification: (...args) => host.showNotification(...wire(args, "showNotification")),
        openExternal: (url) =>
          settle(host.openExternal(wire(url, "openExternal")), "openExternal result"),
        trashItem: (path) => settle(host.trashItem(wire(path, "trashItem")), "trashItem result"),
        restart: () => host.restart(),
      }),

    voice: { start: () => core.voiceControl.start(), stop: () => core.voiceControl.stop() },
    dbgateCredentialFor: (port) =>
      settle(
        Promise.resolve(core.dbgateCredentialFor(wire(port, "dbgateCredentialFor"))),
        "dbgateCredentialFor result",
      ),

    startRemote: () => core.startRemote(),
    announceStartup: () => settle(core.announceStartup(), "announceStartup"),
    stop: () => core.stop(),
  };
}
