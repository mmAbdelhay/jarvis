// The one door from the Electron host (main.ts) into the core.
//
// Phase 2 runs the core in two places: in-process, inside Electron main, and
// in `jarvisd` behind a local control socket. main.ts talks to both through
// this type and nothing else (main-core-seam.test.ts), so switching between
// them is a matter of which adapter is built — `inProcessCoreClient` below,
// or the socket adapter — and main.ts does not change.
//
// Everything that crosses is serialisable, and every stream is one ordered
// stream: pushes, tab changes and view requests arrive in the order the core
// produced them, which a socket adapter keeps by delivering its frames in
// order. The Workspace relies on that — a `load` request has to follow the
// state that created its tab's page.
//
// No electron here (core/no-electron.test.ts).
import type { FaviconStore } from "@jarvis/platform";
import type { PushSink } from "../broadcast.js";
import type { PushChannels } from "../channels.js";
import { DESKTOP_ORIGIN, type TableChannel } from "../dispatch.js";
import type { Core } from "./compose.js";
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
  /** Where the host's favicon fetches land — the store bookmarks read. */
  readonly favicons: Pick<FaviconStore, "put" | "putMiss">;

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
 * The core, in this process, behind CoreClient.
 *
 * Nothing is translated: a request reaches the dispatch table with the
 * caller's own argument array and DESKTOP_ORIGIN, synchronously — a handler
 * runs in the same tick the IPC call arrived, exactly as when main.ts
 * registered the table directly — and a push reaches every listener in the
 * order the core sent it.
 */
export function inProcessCoreClient(core: Core): CoreClient {
  const { tabs } = core;
  return {
    firstRun: core.firstRun,
    hostConfig: () => core.hostConfig(),

    invoke(channel, args) {
      // Own properties only: over a socket the channel is a string from
      // outside, and "constructor" must not find Object.prototype's.
      if (!Object.hasOwn(core.dispatch, channel)) {
        return Promise.reject(new Error(`No handler for ${channel}`));
      }
      try {
        return Promise.resolve(core.dispatch[channel](args, DESKTOP_ORIGIN));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    onPush: (listener) => core.onPush(listener),
    broadcast: (channel, payload) => core.broadcast.send(channel, payload),

    workspace: {
      state: () => tabs.state(),
      onChange: (listener) => tabs.onChange(listener),
      onViewRequest: (listener) => tabs.onViewRequest(listener),
      reportPage: (id, fact) => tabs.reportPage(id, fact),
      suspend: (id) => tabs.suspend(id),
      open: (project, input, kind, detail) => tabs.open(project, input, kind, detail),
    },
    favicons: {
      put: (pageUrl, bytes, type) => core.favicons.put(pageUrl, bytes, type),
      putMiss: (pageUrl) => core.favicons.putMiss(pageUrl),
    },

    attachHost: (host) => core.attachHost(host),

    voice: { start: () => core.voiceControl.start(), stop: () => core.voiceControl.stop() },
    dbgateCredentialFor: (port) => Promise.resolve(core.dbgateCredentialFor(port)),

    startRemote: () => core.startRemote(),
    announceStartup: () => core.announceStartup(),
    stop: () => core.stop(),
  };
}
