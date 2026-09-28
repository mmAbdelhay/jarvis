// The daemon's own control channels: what the desktop app's socket adapter
// (core/socket-core-client.ts) and jarvisd (daemon/binding.ts) say to each
// other beyond the dispatch table.
//
// Every one is reachable only over the control socket — the bridge never
// sees them — and every one is prefixed `daemon:` (or is `security:alert`),
// a prefix no invoke or push channel in channels.ts uses (protocol.test.ts),
// so the daemon routes by name without ever mistaking one for the other.
//
// No electron here (core/no-electron.test.ts).
import type { HostConfig } from "../core/core-client.js";
import type { ViewRequest } from "../core/tab-host.js";
import type { WorkspaceState } from "@jarvis/core";

/** Requests from the app to the daemon. */
export const DAEMON_REQUESTS = {
  /** Everything a freshly connected app needs before it reads anything:
   *  firstRun, hostConfig and the tab state. Answers DaemonSnapshot. */
  snapshot: "daemon:snapshot",
  /** This connection is a desktop app with a window: it takes the core's
   *  host hooks, and the queued security alerts are flushed to it. Args:
   *  [HostWindowState]. */
  attachHost: "daemon:attachHost",
  detachHost: "daemon:detachHost",
  /** The attached window's focus/visibility changed. Args: [HostWindowState]. */
  hostState: "daemon:hostState",
  reportPage: "daemon:reportPage",
  suspend: "daemon:suspend",
  open: "daemon:open",
  faviconPut: "daemon:faviconPut",
  faviconMiss: "daemon:faviconMiss",
  voiceStart: "daemon:voiceStart",
  voiceStop: "daemon:voiceStop",
  dbgateCredential: "daemon:dbgateCredential",
  announceStartup: "daemon:announceStartup",
  /** A push the app itself originates for every client (the hotkey notices). */
  broadcast: "daemon:broadcast",
  /** Which daemon this is, for Settings' status line. Answers DaemonInfo. */
  info: "daemon:info",
  /** Applies the file's `remote:` to the bridge again: sent after the app's
   *  in-process core has stopped and let go of the bridge's ports (Task 23's
   *  switch to the daemon). */
  reapplyRemote: "daemon:reapplyRemote",
  /** Writes daemon.enabled through the daemon core's own serialized config
   *  writer (Settings' background toggle). Args: [boolean]. */
  setDaemonEnabled: "daemon:setDaemonEnabled",
  /** Graceful stop — the Windows stop path, where there is no service
   *  manager to send a signal. Answered before the stop begins. */
  stop: "daemon:stop",
} as const;

/** Pushes from the daemon that are for the socket adapter, not the renderer. */
export const DAEMON_PUSHES = {
  /** The tab state, whole, after every change. Payload: VersionedTabs. */
  tabs: "daemon:tabs",
  viewRequest: "daemon:viewRequest",
  hostConfig: "daemon:hostConfig",
  requestFavicon: "daemon:requestFavicon",
  sweepIdleViews: "daemon:sweepIdleViews",
  openExternal: "daemon:openExternal",
  /** To the one app whose request asked for a restart: relaunch yourself if
   *  a setting only the app reads (hostConfig().suspendTabsAfterMs) changed. */
  restart: "daemon:restart",
  /** To every client: the daemon is restarting on purpose (exit
   *  DAEMON_EXIT.restart); the service manager brings it back and the
   *  adapter reconnects. */
  restarting: "daemon:restarting",
  /** To the app that asked: no service manager runs this daemon, so it
   *  can't restart itself — the user has to restart jarvisd. */
  restartManual: "daemon:restartManual",
  /** notifyDesktop in daemon mode: the app shows it as an OS notification.
   *  Payload: SecurityAlert. */
  alert: "security:alert",
} as const;

/** The only pushes the app may originate through daemon:broadcast. */
export const HOST_BROADCAST_CHANNELS: ReadonlySet<string> = new Set(["turn:new", "voice:hotkeys"]);

export type HostWindowState = { focused: boolean; awake: boolean };

/** Tab state stamped with the daemon run that produced it and a counter
 *  that grows with every change, so the adapter can tell a stale snapshot
 *  reply from a newer push — and a restarted daemon (new `instance`) from
 *  an old one. */
export type VersionedTabs = { instance: string; version: number; state: WorkspaceState };

export type DaemonSnapshot = {
  firstRun: boolean;
  hostConfig: HostConfig;
  tabs: VersionedTabs;
};

/** The running daemon: its pid and when it started (epoch ms). */
export type DaemonInfo = { pid: number; startedAt: number };

export function isDaemonInfo(value: unknown): value is DaemonInfo {
  if (typeof value !== "object" || value === null) return false;
  const { pid, startedAt } = value as Record<string, unknown>;
  return (
    typeof pid === "number" &&
    Number.isInteger(pid) &&
    pid > 0 &&
    typeof startedAt === "number" &&
    Number.isFinite(startedAt)
  );
}

export type SecurityAlert = { title: string; body: string; at: number };

export type ViewRequestPush = ViewRequest;

export function isHostWindowState(value: unknown): value is HostWindowState {
  if (typeof value !== "object" || value === null) return false;
  const { focused, awake } = value as Record<string, unknown>;
  return typeof focused === "boolean" && typeof awake === "boolean";
}
