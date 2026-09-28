import type { PushSink } from "../broadcast.js";

/**
 * What the core asks of the desktop app that shows it: the window's own
 * state, its hosted pages, and the handful of things only a GUI process can
 * do (an OS notification, the system browser, relaunching the app).
 *
 * The desktop app attaches one through CoreClient.attachHost once its window
 * exists. In-process these are plain calls; over the daemon's control socket
 * each becomes a frame — which is why every argument is serialisable, and why
 * the two synchronous reads are state the app can report as well as answer.
 */
export type DesktopHost = {
  /** notify.ts holds back a phone push the user is already looking at. */
  isFocused(): boolean;
  /** On screen: visible and not minimised. wiring.ts's awake gate. */
  isAwake(): boolean;
  /** Fetches a site's /favicon.ico through its project's own session
   *  partition — for a bookmark never opened in Jarvis. */
  requestFavicon(project: string, url: string): void;
  /** Asks the app's pages to give back the ones that sat hidden too long —
   *  each answers with a TabHost.suspend. Run on the core's sweep tick,
   *  before the sidecar reapers read which tabs still need their sidecar. */
  sweepIdleViews(): void;
  /** Destroys every hosted page: each is a live Chromium process. Run in
   *  the core's shutdown, in the slot the old BrowserHost.destroy held. */
  destroyViews(): void;
  /** An OS notification — a global login lockout or a reused refresh token. */
  showNotification(title: string, body: string): void;
  /** The system browser — remote:openWebClient. */
  openExternal(url: string): Promise<void>;
  /** Settings' Restart button: relaunch the app. */
  restart(): void;
};

/**
 * The core's end of the host seam.
 *
 * `host` is what the core's own code calls, and it is always safe to call:
 * with no app attached — a headless daemon, or the moment before the window
 * exists — the window reads answer "not focused, not awake" (what a hidden
 * window answered before), page work has nothing to act on, and what only an
 * app could do is refused or logged rather than lost silently.
 *
 * Pushes meant for the attached app's own renderer — every `broadcast.send`
 * and `broadcast.local` — leave through `toClients`, in the order they were
 * sent, to every `onPush` listener.
 */
export type HostLink = {
  readonly host: DesktopHost;
  /** Makes `desktop` the host. Returns its detach, which is a no-op once
   *  another host has been attached since. */
  attach(desktop: DesktopHost): () => void;
  /** The broadcaster's renderer sink. */
  readonly toClients: PushSink;
  onPush(listener: PushSink): () => void;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHostLink(): HostLink {
  let attached: DesktopHost | undefined;
  const listeners = new Set<PushSink>();

  const host: DesktopHost = {
    isFocused: () => attached?.isFocused() ?? false,
    isAwake: () => attached?.isAwake() ?? false,
    requestFavicon: (project, url) => attached?.requestFavicon(project, url),
    sweepIdleViews: () => attached?.sweepIdleViews(),
    destroyViews: () => attached?.destroyViews(),
    showNotification: (title, body) => {
      if (attached !== undefined) {
        attached.showNotification(title, body);
        return;
      }
      // The title only: it names the event, and the body is for the user.
      console.error(`desktop notification not shown, no app attached: ${title}`);
    },
    openExternal: (url) =>
      attached === undefined
        ? Promise.reject(new Error("No desktop app is attached to open a browser"))
        : attached.openExternal(url),
    restart: () => {
      if (attached !== undefined) {
        attached.restart();
        return;
      }
      console.error("restart not done: no desktop app is attached");
    },
  };

  return {
    host,
    attach(desktop) {
      attached = desktop;
      return () => {
        if (attached === desktop) attached = undefined;
      };
    },
    toClients(channel, payload) {
      // Copied: a listener may remove itself from inside its own call. Each
      // is guarded on its own, the same rule as the broadcaster's sinks.
      for (const listener of [...listeners]) {
        try {
          listener(channel, payload);
        } catch (error) {
          console.error(`Push to ${channel} failed: ${describe(error)}`);
        }
      }
    },
    onPush(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
