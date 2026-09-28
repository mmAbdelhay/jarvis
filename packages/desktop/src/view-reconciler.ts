import type { Session } from "electron";
import type { TabId, WorkspaceState } from "@jarvis/core";
import type {
  DevToolsDock,
  HostedView,
  HostedViewEvent,
  Rect,
  ViewFactory,
} from "./browser-host.js";
import { hasView, type TabReports, type TabSource, type ViewRequest } from "./core/tab-host.js";

export type { TabReports, TabSource };

type Held = { view: HostedView; project: string };

/**
 * The Electron half of the Workspace: one WebContentsView per tab that
 * should have a page, and nothing else.
 *
 * The tab state is the core's (TabHost). This follows it: every snapshot
 * is diffed against the views it holds — a tab `hasView` wants and that
 * has none gets one at its URL; a view whose tab closed or was suspended
 * is destroyed. Applying the same snapshot twice does nothing, so it does
 * not matter how often, or how late, a snapshot arrives. A terminal, API
 * or Docker tab never gets a view.
 *
 * What only a window can decide lives here too: where pages sit (bounds),
 * which one is visible, DevTools, the idle clock, and the controls that act
 * on a page without changing tab state (back, forward, reload, picture in
 * picture). What a page does goes back to the core as a PageFact.
 */
export class ViewReconciler {
  readonly #createView: ViewFactory;
  readonly #tabs: TabReports;
  readonly #views = new Map<TabId, Held>();
  #state: WorkspaceState = { tabs: [], activeTabId: undefined };
  /** The next snapshot to apply, when one arrives while applying another —
   *  a fake or real view can report synchronously from loadURL. */
  #queued: WorkspaceState | undefined;
  #applying = false;
  #destroyed = false;
  #bounds: Rect | undefined;
  #devToolsBounds: Rect | undefined;
  #devToolsDock: DevToolsDock = "bottom";
  /** Tabs whose DevTools are open — kept so sweepIdle leaves them alone. An
   *  undocked DevTools window vanishing fifteen minutes after switching tabs
   *  would look like a crash. */
  readonly #devToolsOpen = new Set<TabId>();
  readonly #devToolsClosedListeners = new Set<(id: TabId) => void>();
  #visible = false;
  /** Set by hideAll — distinct from #visible, which means "leave the whole
   *  route". This means "nothing to show right now" while the route itself
   *  stays visible: the renderer's selected project has no open tab. The
   *  core's next "reveal" request clears it. */
  #suppressed = false;
  /** When each view stopped being the visible one, by #now(). Absent means
   *  "visible right now": #syncVisibility deletes the active tab's entry and
   *  stamps one for every other view it hides. */
  readonly #hiddenSince = new Map<TabId, number>();
  readonly #suspendAfterMs: number;
  readonly #now: () => number;
  /** Fetches `iconUrl` through `from` and caches it against `pageUrl`'s
   *  origin. Injected: this owns views, not storage or the network. */
  readonly #cacheFavicon: (pageUrl: string, iconUrl: string, from: Session) => Promise<void>;

  constructor(
    createView: ViewFactory,
    tabs: TabReports,
    options?: {
      cacheFavicon?(pageUrl: string, iconUrl: string, from: Session): Promise<void>;
      /** How long a page may sit hidden before sweepIdle reclaims its
       *  renderer. 0 — the default — never suspends anything. */
      suspendAfterMs?: number;
      now?(): number;
    },
  ) {
    this.#createView = createView;
    this.#tabs = tabs;
    this.#cacheFavicon = options?.cacheFavicon ?? (async () => undefined);
    this.#suspendAfterMs = options?.suspendAfterMs ?? 0;
    this.#now = options?.now ?? Date.now;
  }

  /** Applies `source`'s current state and follows every later change and
   *  request. Returns the unsubscribe. */
  follow(source: TabSource): () => void {
    const offChange = source.onChange((state) => this.apply(state));
    const offRequest = source.onViewRequest((request) => this.request(request));
    this.apply(source.state());
    return () => {
      offChange();
      offRequest();
    };
  }

  /** Makes the views match `state`. Idempotent. */
  apply(state: WorkspaceState): void {
    if (this.#destroyed) return;
    this.#queued = state;
    if (this.#applying) return;
    this.#applying = true;
    try {
      while (this.#queued !== undefined) {
        const next = this.#queued;
        this.#queued = undefined;
        this.#reconcile(next);
      }
    } finally {
      this.#applying = false;
    }
  }

  request(request: ViewRequest): void {
    if (this.#destroyed) return;
    switch (request.kind) {
      case "load":
        this.#views.get(request.id)?.view.loadURL(request.url);
        break;
      case "reveal":
        this.#suppressed = false;
        this.#syncVisibility();
        break;
    }
  }

  back(id: TabId): void {
    this.#views.get(id)?.view.goBack();
  }

  forward(id: TabId): void {
    this.#views.get(id)?.view.goForward();
  }

  reload(id: TabId): void {
    this.#views.get(id)?.view.reload();
  }

  /**
   * Floats this tab's playing video in Chromium's Picture-in-Picture
   * window. Whether the page has anything to float is already recorded on
   * the tab; a tab with no view (a terminal, one just closed) simply has
   * nothing to ask.
   */
  requestPictureInPicture(id: TabId): void {
    this.#views.get(id)?.view.requestPictureInPicture();
  }

  setBounds(bounds: Rect): void {
    this.#bounds = bounds;
    for (const { view } of this.#views.values()) view.setBounds(bounds);
  }

  /**
   * Opens or closes DevTools for one tab. The open/closed choice belongs to
   * the renderer, which is the side that knows whether it has laid out a
   * slot for them; this only routes it to the right view.
   */
  setDevTools(id: TabId, open: boolean): void {
    if (open) this.#devToolsOpen.add(id);
    else this.#devToolsOpen.delete(id);
    this.#views.get(id)?.view.setDevTools(open);
  }

  /** Which side DevTools dock to, or undocked. Applied to every view, same
   *  as the bounds: it is one choice, and a tab opened later must follow it. */
  setDevToolsDock(dock: DevToolsDock): void {
    this.#devToolsDock = dock;
    for (const { view } of this.#views.values()) view.setDevToolsDock(dock);
  }

  /** Told when a tab's DevTools close without the renderer asking — see
   *  HostedViewEvent's "devtoolsClosed". */
  onDevToolsClosed(listener: (id: TabId) => void): () => void {
    this.#devToolsClosedListeners.add(listener);
    return () => this.#devToolsClosedListeners.delete(listener);
  }

  /** Where the DevTools panel sits, measured by the renderer like every
   *  other rectangle. Applied to every view: only the active one is
   *  visible, and a tab switched back to must already be in the right place
   *  rather than jumping on its first frame. */
  setDevToolsBounds(bounds: Rect): void {
    this.#devToolsBounds = bounds;
    for (const { view } of this.#views.values()) view.setDevToolsBounds(bounds);
  }

  /**
   * A hosted view is a native overlay on the window, not a node in the
   * renderer's DOM: hiding the Workspace markup does nothing to it, and a
   * page left visible floats over the dashboard, the Changes view and every
   * overlay. Leaving the route must call this with false.
   */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.#syncVisibility();
  }

  /**
   * Hides every view without touching which tab is "active" — for the
   * renderer's project switch: a project with no open tab has nothing to
   * show, but the previously active tab (from a different project) must
   * stay remembered so switching back finds it exactly as it was. Cleared
   * by the core's next "reveal" (an open or an activate).
   */
  hideAll(): void {
    this.#suppressed = true;
    this.#syncVisibility();
  }

  /**
   * Reclaims the renderer behind every page that has sat hidden longer than
   * the configured idle, by asking the core to mark its tab suspended — the
   * view goes when that state comes back. The tab stays: its row, its URL
   * and its place in the strip are untouched, and activating it builds a
   * new view at the same address.
   *
   * Two tabs are never suspended. The active one, obviously. And one whose
   * page is playing video: reclaiming it stops the sound, and a tab left
   * playing on purpose is the last one anybody meant to reclaim.
   */
  sweepIdle(): void {
    if (this.#suspendAfterMs <= 0 || this.#destroyed) return;
    const now = this.#now();
    const { tabs, activeTabId } = this.#state;

    for (const tab of tabs) {
      if (tab.id === activeTabId) continue;
      if (tab.hasPlayingVideo) continue;
      if (this.#devToolsOpen.has(tab.id)) continue;
      if (!this.#views.has(tab.id)) continue;
      const since = this.#hiddenSince.get(tab.id);
      if (since === undefined || now - since < this.#suspendAfterMs) continue;
      this.#tabs.suspend(tab.id);
    }
  }

  /** Destroys every view and stops following: the window is going. */
  destroy(): void {
    this.#destroyed = true;
    for (const { view } of this.#views.values()) view.destroy();
    this.#views.clear();
    this.#hiddenSince.clear();
  }

  #reconcile(state: WorkspaceState): void {
    this.#state = state;
    const wanted = new Map(state.tabs.filter(hasView).map((tab) => [tab.id, tab]));

    for (const [id, { view }] of [...this.#views]) {
      if (wanted.has(id)) continue;
      view.destroy();
      this.#views.delete(id);
      this.#hiddenSince.delete(id);
      this.#devToolsOpen.delete(id);
    }

    for (const tab of wanted.values()) {
      if (this.#views.has(tab.id)) continue;
      // One page that cannot be built must not stop the rest of the pass —
      // the other pages and the visibility sync below. Logged rather than
      // thrown: this runs inside the tab state's change listener, which
      // would swallow it, and a tab with no page and nothing said about it
      // is a bug nobody can find. The next change retries it. The URL stays
      // out of the line: an OAuth callback carries its code in it.
      try {
        this.#attach(tab.id, tab.project, tab.kind, tab.url);
      } catch (error) {
        console.error(
          `workspace: could not build the page for tab ${tab.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.#syncVisibility();
  }

  /**
   * Builds a tab's view and wires it, at `url`.
   *
   * The partition is what makes a project's logins its own.
   * encodeURIComponent because a project name is user-supplied config and a
   * partition name with a slash or a space in it is not addressable.
   */
  #attach(id: TabId, project: string, kind: Parameters<ViewFactory>[1], url: string): void {
    const view = this.#createView(`persist:project-${encodeURIComponent(project)}`, kind);
    this.#views.set(id, { view, project });
    view.onEvent((event) => this.#onViewEvent(id, project, event));
    if (this.#bounds !== undefined) view.setBounds(this.#bounds);
    if (this.#devToolsBounds !== undefined) view.setDevToolsBounds(this.#devToolsBounds);
    view.setDevToolsDock(this.#devToolsDock);
    view.loadURL(url);
  }

  #onViewEvent(id: TabId, project: string, event: HostedViewEvent): void {
    switch (event.kind) {
      case "navigated":
        this.#tabs.reportPage(id, {
          kind: "navigated",
          url: event.url,
          canGoBack: event.canGoBack,
          canGoForward: event.canGoForward,
        });
        break;
      case "title":
        this.#tabs.reportPage(id, { kind: "title", title: event.title });
        break;
      case "loading":
        this.#tabs.reportPage(id, { kind: "loading", loading: event.loading });
        break;
      case "failed":
        this.#tabs.reportPage(id, { kind: "failed", detail: event.detail });
        break;
      case "fullscreen":
        this.#tabs.reportPage(id, { kind: "fullscreen", fullscreen: event.fullscreen });
        break;
      case "favicon":
        void this.#cacheFavicon(event.pageUrl, event.iconUrl, event.session);
        break;
      case "media":
        // "Something started" is not "a video is playing": Chromium fires
        // this for audio, and for a <video> that has not decoded a frame.
        // The page is the only thing that knows, so it is asked — and only
        // when something started, since on a stop there is by definition
        // nothing to find and the answer would race the page.
        if (!event.playing) {
          this.#tabs.reportPage(id, { kind: "video", playing: false });
          break;
        }
        void this.#views
          .get(id)
          ?.view.hasPlayingVideo()
          // The tab may have closed while the page was answering; the core
          // drops a fact about a tab it no longer has.
          .then((playing) => this.#tabs.reportPage(id, { kind: "video", playing }))
          .catch(() => undefined);
        break;
      case "devtoolsClosed":
        this.#devToolsOpen.delete(id);
        for (const listener of [...this.#devToolsClosedListeners]) listener(id);
        break;
      case "popup":
        // What target=_blank means in a browser. The scheme gate inside
        // open() still applies, so a page cannot use a popup to reach a
        // scheme the address bar would refuse.
        this.#tabs.open(project, event.url);
        break;
    }
  }

  #syncVisibility(): void {
    const activeId = this.#state.activeTabId;
    const now = this.#now();
    for (const [id, { view }] of this.#views) {
      const visible = this.#visible && !this.#suppressed && id === activeId;
      view.setVisible(visible);
      // The idle clock starts when a view stops being seen and is cleared the
      // moment it is seen again, so "hidden for fifteen minutes" means that
      // and not "opened fifteen minutes ago".
      if (visible) this.#hiddenSince.delete(id);
      else if (!this.#hiddenSince.has(id)) this.#hiddenSince.set(id, now);
    }
  }
}
