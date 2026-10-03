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
//   - openExternal: forwarded to an attached app, which opens only the
//     bridge's own web client (open-external-guard.ts). With none it rejects;
//   - trashItem: forwarded to the one app whose request is running — the
//     sidebar that asked — never to every app, which would each try to
//     trash the same path. With no such app it rejects. The app's answer
//     does not travel back: the sidebar re-lists either way, and a file
//     still there says what a result would have;
//   - restart (Settings' Restart) restarts the daemon, since the settings it
//     applies live here. Under a service manager every client is told
//     `daemon:restarting` and the daemon exits DAEMON_EXIT.restart, to be
//     started again; the apps reconnect. With none (a foreground `jarvisd
//     run`, or Windows) it can't come back on its own, so the app that
//     asked is told to have the user restart jarvisd. Either way, only that
//     app — never every attached one — gets `daemon:restart`, which it
//     answers by relaunching itself if an app-only setting changed.
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
  /** Sends to one control client. */
  pushTo(connectionId: number, channel: string, payload: unknown): void;
  /** The connection whose request is running now, if the core is inside
   *  one — who asked for a restart. */
  initiator(): number | undefined;
  /** Stops the daemon with the restart exit code; undefined when no
   *  service manager would start it again. */
  restartDaemon?: () => void;
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
    trashItem(path) {
      const asker = deps.initiator();
      if (asker === undefined || !attached.has(asker)) {
        return Promise.reject(new Error("No desktop app asked to move a file to the trash"));
      }
      deps.pushTo(asker, DAEMON_PUSHES.trashItem, { path });
      return Promise.resolve();
    },
    restart() {
      const asker = deps.initiator();
      if (asker !== undefined) deps.pushTo(asker, DAEMON_PUSHES.restart, null);
      if (deps.restartDaemon === undefined) {
        deps.log(
          "restart asked for, but no service manager runs jarvisd: restart jarvisd manually",
        );
        if (asker !== undefined) deps.pushTo(asker, DAEMON_PUSHES.restartManual, null);
        return;
      }
      deps.log("restarting jarvisd");
      deps.push(DAEMON_PUSHES.restarting, null);
      deps.restartDaemon();
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
