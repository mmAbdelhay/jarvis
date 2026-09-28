// The DesktopHost jarvisd attaches to its own core.
//
// In-process the host is the app's window. In the daemon there is no
// window: there may be one desktop app connected over the control socket,
// several, or none. This host answers the core from what the connected apps
// report and forwards to them what only an app can do:
//
//   - isFocused / isAwake: true when any attached app says so, from the
//     state each reports (daemon:attachHost / daemon:hostState) — the core
//     reads these synchronously, so they are cached here, never a round trip;
//   - requestFavicon, sweepIdleViews: a push to the apps, when one is there;
//   - destroyViews: nothing. The daemon's pages are the app's views, and an
//     app tears its own down when its window closes (main.ts). Stopping the
//     daemon must not reach into a window that outlives it;
//   - showNotification (notifyDesktop): a `security:alert` push. With no app
//     attached it is queued — at most MAX_QUEUED_ALERTS, the oldest dropped —
//     and flushed, in order, to the next app that attaches. The event itself
//     is already in the bridge's audit log (locked-out / refresh-reuse); the
//     daemon log gets the title only, never the body;
//   - openExternal, restart: forwarded to an attached app. With none, they
//     are unavailable: openExternal rejects, restart is logged as not done.
//
// No electron here (core/no-electron.test.ts).
import type { DesktopHost } from "../core/host-link.js";
import { DAEMON_PUSHES, type HostWindowState, type SecurityAlert } from "./protocol.js";

export const MAX_QUEUED_ALERTS = 20;

export type DaemonHost = {
  /** What the core is given as its DesktopHost. */
  readonly host: DesktopHost;
  /** Connection `id` is a desktop app; queued alerts are flushed to it. */
  attach(id: number, state: HostWindowState): void;
  report(id: number, state: HostWindowState): void;
  detach(id: number): void;
  /** How many apps are attached now. */
  readonly attachedCount: number;
  /** Alerts waiting for an app, oldest first (tests and status). */
  queuedAlerts(): readonly SecurityAlert[];
};

export function createDaemonHost(deps: {
  /** Sends to every connected control client, in call order. */
  push(channel: string, payload: unknown): void;
  log(line: string): void;
  now(): number;
}): DaemonHost {
  const attached = new Map<number, HostWindowState>();
  const queue: SecurityAlert[] = [];
  const anyApp = (read: (state: HostWindowState) => boolean): boolean => {
    for (const state of attached.values()) if (read(state)) return true;
    return false;
  };

  const host: DesktopHost = {
    isFocused: () => anyApp((state) => state.focused),
    isAwake: () => anyApp((state) => state.awake),
    requestFavicon(project, url) {
      if (attached.size > 0) deps.push(DAEMON_PUSHES.requestFavicon, { project, url });
    },
    sweepIdleViews() {
      if (attached.size > 0) deps.push(DAEMON_PUSHES.sweepIdleViews, null);
    },
    destroyViews() {},
    showNotification(title, body) {
      const alert: SecurityAlert = { title, body, at: deps.now() };
      if (attached.size > 0) {
        deps.push(DAEMON_PUSHES.alert, alert);
        return;
      }
      queue.push(alert);
      if (queue.length > MAX_QUEUED_ALERTS) queue.shift();
      // The title only: it names the event, and the body is for the user.
      deps.log(`security alert queued for the next app, none attached: ${title}`);
    },
    openExternal(url) {
      if (attached.size === 0) {
        return Promise.reject(new Error("No desktop app is connected to open a browser"));
      }
      deps.push(DAEMON_PUSHES.openExternal, { url });
      return Promise.resolve();
    },
    restart() {
      if (attached.size === 0) {
        deps.log("restart not done: no desktop app is connected");
        return;
      }
      deps.push(DAEMON_PUSHES.restart, null);
    },
  };

  return {
    host,
    attach(id, state) {
      attached.set(id, { ...state });
      for (const alert of queue.splice(0)) deps.push(DAEMON_PUSHES.alert, alert);
    },
    report(id, state) {
      if (attached.has(id)) attached.set(id, { ...state });
    },
    detach(id) {
      attached.delete(id);
    },
    get attachedCount() {
      return attached.size;
    },
    queuedAlerts: () => [...queue],
  };
}
