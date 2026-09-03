import type { Session } from "electron";
import {
  TabStore,
  isSafeHref,
  normalizeInput,
  type TabId,
  type TabKind,
  type WorkspaceState,
} from "@jarvis/core";

export type Rect = { x: number; y: number; width: number; height: number };

/** What a hosted page tells the host about itself. Deliberately small: the
 *  five facts the tab strip and address bar draw, plus the popup request. */
export type HostedViewEvent =
  | { kind: "navigated"; url: string; canGoBack: boolean; canGoForward: boolean }
  | { kind: "title"; title: string }
  | { kind: "loading"; loading: boolean }
  | { kind: "failed"; detail: string }
  | { kind: "popup"; url: string }
  /** Chromium noticed media start or stop in this page. Only a prompt to
   *  ask the page what it actually has — it fires for audio as readily as
   *  for video. See BrowserHost's "media" case. */
  | { kind: "media"; playing: boolean }
  /** Chromium resolved this page's real favicon — including a site that
   *  declares it in HTML rather than serving /favicon.ico. `session` is
   *  the view's own, carried on the event because BrowserHost otherwise has
   *  no route to it: HostedView deliberately exposes no WebContents. */
  | { kind: "favicon"; pageUrl: string; iconUrl: string; session: Session };

/**
 * One page's worth of browser, as this host needs it. Electron is behind
 * this interface (see createElectronViewFactory) so the whole tab lifecycle
 * — partitions, eviction, visibility, the store updates — is testable in
 * plain Vitest with no window and no Chromium.
 */
export type HostedView = {
  loadURL(url: string): void;
  setBounds(bounds: Rect): void;
  setVisible(visible: boolean): void;
  goBack(): void;
  goForward(): void;
  reload(): void;
  destroy(): void;
  onEvent(listener: (event: HostedViewEvent) => void): void;
  /** Opens or closes this page's DevTools. They are rendered into a second
   *  view the host positions itself, rather than a detached window, so that
   *  they can be sized as part of the layout. */
  setDevTools(open: boolean): void;
  /** Where the DevTools view sits, in window pixels — measured by the
   *  renderer exactly as the page slot is. */
  setDevToolsBounds(bounds: Rect): void;
  /** Asks the page whether it has a <video> element that is genuinely
   *  playing — decoding frames, not merely present or merely audible.
   *  Answered by the page, because nothing outside it can tell. */
  hasPlayingVideo(): Promise<boolean>;
  /** Puts the page's playing video into Chromium's own Picture-in-Picture
   *  window: a small always-on-top window outside the app entirely, which
   *  is what makes the video survive switching tabs, routes and apps. */
  requestPictureInPicture(): void;
};

export type ViewFactory = (partition: string) => HostedView;

/** Each tab is its own Chromium renderer process — eight is already about a
 *  gigabyte of resident memory. The cap is what stops a popup loop, or a
 *  long day of opening tabs, from taking the machine down with it. */
export const MAX_TABS = 8;

/** The tab-strip label for each hosted app, keyed by its TabKind. A "web"
 *  tab has no entry: it wears the page's own title. */
const HOSTED_APP_LABELS: Record<Exclude<TabKind, "web">, string> = {
  editor: "Editor",
  database: "Database",
  terminal: "Terminal",
  api: "API",
  cluster: "Cluster",
  docker: "Docker",
  chat: "Chat",
};

export class BrowserHost {
  readonly #createView: ViewFactory;
  readonly #store: TabStore;
  readonly #views = new Map<TabId, HostedView>();
  readonly #maxTabs: number;
  #bounds: Rect | undefined;
  #devToolsBounds: Rect | undefined;
  #visible = false;
  /** Set by hideAll — distinct from #visible, which means "leave the whole
   *  route". This means "nothing to show right now" while the route itself
   *  stays visible: the renderer's selected project has no open tab. */
  #suppressed = false;

  /** Fetches `iconUrl` through `from` and caches it against `pageUrl`'s
   *  origin. Injected rather than imported: browser-host owns views, not
   *  storage or the network — see the "favicon" case below. Defaulted to a
   *  no-op so every other test in this file can go on constructing a host
   *  without knowing this dep exists. */
  readonly #cacheFavicon: (pageUrl: string, iconUrl: string, from: Session) => Promise<void>;

  constructor(
    createView: ViewFactory,
    options?: {
      maxTabs?: number;
      store?: TabStore;
      cacheFavicon?(pageUrl: string, iconUrl: string, from: Session): Promise<void>;
    },
  ) {
    this.#createView = createView;
    this.#store = options?.store ?? new TabStore();
    this.#maxTabs = options?.maxTabs ?? MAX_TABS;
    this.#cacheFavicon = options?.cacheFavicon ?? (async () => undefined);
  }

  state(): WorkspaceState {
    return this.#store.snapshot();
  }

  onChange(listener: (state: WorkspaceState) => void): () => void {
    return this.#store.onChange(listener);
  }

  open(project: string, input: string, kind: TabKind = "web", detail?: string): void {
    const target = normalizeInput(input);
    if (target.kind === "rejected") return;

    this.#evictIfFull();
    this.#suppressed = false;

    const tab = this.#store.open(project, target.url, kind);
    if (kind !== "web") {
      // A hosted app's own document.title tracks whatever file, panel or
      // table has focus inside it; the tab strip would be unreadable if that
      // leaked through, so this label is fixed once, here, and #onViewEvent's
      // "title" case never overwrites it for a tab of this kind.
      // `detail` names which one, for the kinds that can have more than one
      // per project (an editor rooted at a configured sub-folder). It rides
      // in the title so the tab strip is readable, and stays on the tab so
      // the renderer can match on it.
      const label = HOSTED_APP_LABELS[kind];
      this.#store.update(tab.id, {
        title: detail === undefined ? `${project} — ${label}` : `${project} — ${label} · ${detail}`,
        ...(detail === undefined ? {} : { detail }),
      });
    }
    // The partition is what makes a project's logins its own.
    // encodeURIComponent because a project name is user-supplied config and
    // a partition name with a slash or a space in it is not addressable.
    const view = this.#createView(`persist:project-${encodeURIComponent(project)}`);
    this.#views.set(tab.id, view);

    view.onEvent((event) => this.#onViewEvent(tab.id, project, event));
    if (this.#bounds !== undefined) view.setBounds(this.#bounds);
    if (this.#devToolsBounds !== undefined) view.setDevToolsBounds(this.#devToolsBounds);
    view.loadURL(target.url);
    this.#syncVisibility();
  }

  /**
   * Opens a terminal tab: a tab in the same store as every other, with no
   * hosted view behind it. Its pty lives in the main process and its screen
   * is drawn by the renderer's own xterm instance.
   */
  openTerminal(project: string): TabId {
    return this.#openViewless(project, "terminal");
  }

  /**
   * Opens an API tab. Same shape as a terminal: no hosted page, a surface
   * the renderer draws, and requests issued from the main process.
   */
  openApi(project: string): TabId {
    return this.#openViewless(project, "api");
  }

  /**
   * Opens a docker tab. Same shape as terminal and api: no hosted page, a
   * surface the renderer draws, and Docker commands issued from the main
   * process.
   */
  openDocker(project: string): TabId {
    return this.#openViewless(project, "docker");
  }

  /**
   * A tab with no hosted view behind it. There is no URL to normalise and
   * nothing to load; the renderer draws the surface itself.
   *
   * #syncVisibility iterates over views alone, so activating a tab that has
   * none hides every hosted page as a consequence — which is exactly what
   * has to happen, since a native view would otherwise float over the
   * renderer's own DOM.
   *
   * Returns the new tab's id: main needs it to key whatever it is about to
   * start for this tab.
   */
  #openViewless(project: string, kind: "terminal" | "api" | "docker"): TabId {
    this.#evictIfFull();
    this.#suppressed = false;
    const tab = this.#store.open(project, "", kind);
    this.#store.update(tab.id, { title: `${project} — ${HOSTED_APP_LABELS[kind]}` });
    this.#syncVisibility();
    return tab.id;
  }

  /**
   * Opens a tab and resolves with the first URL it navigates to that starts
   * with `redirectPrefix` — the OAuth2 authorization-code dance, where the
   * provider sends the user back to a callback carrying `?code=`.
   *
   * The app already has a browser, so this is where that flow belongs;
   * sending the user to their system browser to copy a code back by hand
   * would be the worse product. The tab closes itself the moment the redirect
   * arrives, which is also what stops the callback URL — which carries the
   * code — from being loaded at all.
   */
  openForResult(project: string, url: string, redirectPrefix = ""): Promise<string> {
    return new Promise((resolve, reject) => {
      const target = normalizeInput(url);
      // Only a real URL. normalizeInput turns anything else into a web
      // search, which for an authorization endpoint means silently sending
      // the user's client id to a search engine instead of to their provider.
      if (target.kind !== "url") {
        reject(new Error("Not a valid authorization URL"));
        return;
      }

      this.#evictIfFull();
      this.#suppressed = false;
      const tab = this.#store.open(project, target.url, "web");
      this.#store.update(tab.id, { title: `${project} — Authorize` });

      const view = this.#createView(`persist:project-${encodeURIComponent(project)}`);
      this.#views.set(tab.id, view);

      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        this.close(tab.id);
        outcome();
      };

      view.onEvent((event) => {
        this.#onViewEvent(tab.id, project, event);
        if (event.kind !== "navigated") return;
        // An empty prefix means "any redirect that carries a code or an
        // error", which is the honest default when the config named no
        // callback URL of its own.
        const matches =
          redirectPrefix === ""
            ? event.url.includes("code=") || event.url.includes("error=")
            : event.url.startsWith(redirectPrefix);
        if (matches) finish(() => resolve(event.url));
      });

      if (this.#bounds !== undefined) view.setBounds(this.#bounds);
      view.loadURL(target.url);
      this.#syncVisibility();
    });
  }

  navigate(id: TabId, input: string): void {
    const view = this.#views.get(id);
    if (view === undefined) return;
    const target = normalizeInput(input);
    if (target.kind === "rejected") return;
    this.#store.update(id, { url: target.url, loading: true, error: undefined });
    view.loadURL(target.url);
  }

  activate(id: TabId): void {
    this.#store.activate(id);
    this.#suppressed = false;
    this.#syncVisibility();
  }

  close(id: TabId): void {
    this.#views.get(id)?.destroy();
    this.#views.delete(id);
    this.#store.close(id);
    this.#syncVisibility();
  }

  back(id: TabId): void {
    this.#views.get(id)?.goBack();
  }

  forward(id: TabId): void {
    this.#views.get(id)?.goForward();
  }

  reload(id: TabId): void {
    this.#views.get(id)?.reload();
  }

  /**
   * Floats this tab's playing video in Chromium's Picture-in-Picture
   * window. Routed rather than decided here: whether the page has anything
   * to float is already recorded on the tab, and a tab with no view (a
   * terminal, an API tab, one just closed) simply has nothing to ask.
   */
  requestPictureInPicture(id: TabId): void {
    this.#views.get(id)?.requestPictureInPicture();
  }

  setBounds(bounds: Rect): void {
    this.#bounds = bounds;
    for (const view of this.#views.values()) view.setBounds(bounds);
  }

  /**
   * Opens or closes DevTools for one tab. The open/closed choice belongs to
   * the renderer, which is the side that knows whether it has laid out a
   * slot for them; this only routes it to the right view.
   */
  setDevTools(id: TabId, open: boolean): void {
    this.#views.get(id)?.setDevTools(open);
  }

  /** Where the DevTools panel sits, measured by the renderer like every
   *  other rectangle. Applied to every view, same as setBounds: only the
   *  active one is visible, and a tab switched back to must already be in
   *  the right place rather than jumping on its first frame. */
  setDevToolsBounds(bounds: Rect): void {
    this.#devToolsBounds = bounds;
    for (const view of this.#views.values()) view.setDevToolsBounds(bounds);
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
   * by the next open() or activate(), which is how the renderer actually
   * reveals something again.
   */
  hideAll(): void {
    this.#suppressed = true;
    this.#syncVisibility();
  }

  destroy(): void {
    for (const view of this.#views.values()) view.destroy();
    this.#views.clear();
  }

  #onViewEvent(id: TabId, project: string, event: HostedViewEvent): void {
    switch (event.kind) {
      case "navigated":
        this.#store.update(id, {
          url: event.url,
          canGoBack: event.canGoBack,
          canGoForward: event.canGoForward,
          error: undefined,
          // The old page's video left with the old page. A flag carried
          // over would offer to float something that no longer exists.
          hasPlayingVideo: false,
        });
        break;
      case "title":
        // A hosted app's title is fixed at open() and never follows the
        // page's own document.title — see the comment there.
        if (this.#store.get(id)?.kind === "web") this.#store.update(id, { title: event.title });
        break;
      case "favicon":
        void this.#cacheFavicon(event.pageUrl, event.iconUrl, event.session);
        break;
      case "loading":
        this.#store.update(id, { loading: event.loading });
        break;
      case "failed":
        this.#store.update(id, { loading: false, error: event.detail });
        break;
      case "media":
        // "Something started" is not "a video is playing": Chromium fires
        // this for audio, and for a <video> that has not decoded a frame.
        // The page is the only thing that knows, so it is asked — and only
        // when something started, since on a stop there is by definition
        // nothing to find and the answer would race the page.
        if (!event.playing) {
          this.#store.update(id, { hasPlayingVideo: false });
          break;
        }
        void this.#views
          .get(id)
          ?.hasPlayingVideo()
          .then((playing) => {
            // The tab may have closed while the page was answering.
            if (this.#store.get(id) !== undefined) {
              this.#store.update(id, { hasPlayingVideo: playing });
            }
          })
          .catch(() => undefined);
        break;
      case "popup":
        // What target=_blank means in a browser. The scheme gate inside
        // open() still applies, so a page cannot use a popup to reach a
        // scheme the address bar would refuse.
        this.open(project, event.url);
        break;
    }
  }

  #evictIfFull(): void {
    while (this.#views.size >= this.#maxTabs) {
      // Only a tab that actually holds a view. The cap exists to bound
      // Chromium renderer processes, and a terminal tab is not one — closing
      // it here would drop the tab without reaping the shell behind it,
      // since main only kills a shell on its own close handler. It would
      // also fail to free anything, so the loop would go on to evict every
      // terminal before reaching a page.
      const oldest = this.#store.leastRecentlyActive().find((id) => this.#views.has(id));
      if (oldest === undefined) return;
      this.#views.get(oldest)?.destroy();
      this.#views.delete(oldest);
      this.#store.close(oldest);
    }
  }

  #syncVisibility(): void {
    const activeId = this.#store.snapshot().activeTabId;
    for (const [id, view] of this.#views) {
      view.setVisible(this.#visible && !this.#suppressed && id === activeId);
    }
  }
}

export type NavigationFacts = { canGoBack(): boolean; canGoForward(): boolean };

/** The slice of Electron's WebContents this module uses. Narrow on purpose:
 *  it is what makes the event mapping testable without a window. */
export type WebContentsLike = {
  on(event: string, listener: (...args: never[]) => void): unknown;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "deny" }): void;
  /** The page's current URL — what a resolved favicon is cached against. */
  getURL(): string;
  /** This view's own session, so a favicon fetch goes through the same
   *  cookies as the page it belongs to (see cacheFavicon's caller). */
  session: Session;
};

/** Chromium's ERR_ABORTED — emitted for an ordinary superseded or cancelled
 *  load, not a failure the user should see. */
const ERR_ABORTED = -3;

/**
 * Chromium events to HostedViewEvent. All the judgement lives here — which
 * failures are real, which frames count, when the history flags are read —
 * so it is a pure function over an emitter rather than something only a
 * running window could exercise. electron-view.ts wires it to the real
 * WebContents.
 */
export function bridgeEvents(
  contents: WebContentsLike,
  navigation: NavigationFacts,
  emit: (event: HostedViewEvent) => void,
): void {
  const navigated = (url: string): void => {
    emit({
      kind: "navigated",
      url,
      canGoBack: navigation.canGoBack(),
      canGoForward: navigation.canGoForward(),
    });
  };

  const on = (event: string, listener: (...args: never[]) => void): void => {
    contents.on(event, listener);
  };

  on("page-title-updated", ((_event: unknown, title: string) => {
    emit({ kind: "title", title });
  }) as (...args: never[]) => void);

  // Chromium has already resolved the page's real icon by the time this
  // fires — including sites that declare it in HTML rather than serving
  // /favicon.ico — so this is both the most accurate source and free.
  // icons can be empty (a page with no favicon at all); [0] is Chromium's
  // own preferred candidate. The Array.isArray guard is not paranoia about
  // Chromium: this is an untyped IPC payload, and `[0]` on a *string*
  // silently yields one character — an "icon url" of "h" that fails to
  // fetch and records a week-long miss against the origin, suppressing the
  // real icon for that whole week.
  on("page-favicon-updated", ((_event: unknown, icons: unknown) => {
    if (!Array.isArray(icons)) return;
    const iconUrl: unknown = icons[0];
    if (typeof iconUrl !== "string" || iconUrl === "") return;
    emit({ kind: "favicon", pageUrl: contents.getURL(), iconUrl, session: contents.session });
  }) as (...args: never[]) => void);

  on("media-started-playing", (() => {
    emit({ kind: "media", playing: true });
  }) as (...args: never[]) => void);

  // media-paused covers ending as well as pausing: Chromium fires it when
  // playback stops for any reason.
  on("media-paused", (() => {
    emit({ kind: "media", playing: false });
  }) as (...args: never[]) => void);

  on("did-start-loading", (() => {
    emit({ kind: "loading", loading: true });
  }) as (...args: never[]) => void);

  on("did-stop-loading", (() => {
    emit({ kind: "loading", loading: false });
  }) as (...args: never[]) => void);

  on("did-navigate", ((_event: unknown, url: string) => {
    navigated(url);
  }) as (...args: never[]) => void);

  on("did-navigate-in-page", ((_event: unknown, url: string, isMainFrame: boolean) => {
    if (isMainFrame) navigated(url);
  }) as (...args: never[]) => void);

  on("did-fail-load", ((
    _event: unknown,
    errorCode: number,
    errorDescription: string,
    _validatedURL: string,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    emit({ kind: "failed", detail: errorDescription });
  }) as (...args: never[]) => void);

  // The third way a non-web scheme could be reached: not the address bar,
  // not BrowserHost.open, but the page navigating itself. isSafeHref is the
  // shared vocabulary; the explicit https? test is the decision, because
  // isSafeHref deliberately accepts relative and in-page links, which are
  // legitimate in a document but are not what arrives here.
  on("will-navigate", ((event: { preventDefault(): void }, url: string) => {
    const target = url.trim();
    if (isSafeHref(target) && /^https?:/i.test(target)) return;
    event.preventDefault();
  }) as (...args: never[]) => void);

  contents.setWindowOpenHandler(({ url }) => {
    emit({ kind: "popup", url });
    return { action: "deny" };
  });
}

/**
 * The user agent a hosted page should see: Electron's own, minus the
 * `Electron/<version>` product token.
 *
 * Hosted pages are ordinary web apps, and several of them sniff that token
 * to decide they are running as *their* desktop build rather than in a
 * browser. Headlamp is the one that broke: its frontend treats a UA
 * containing "Electron" as proof it is the Headlamp desktop app and sends
 * every API request to a hardcoded `http://localhost:4466` instead of the
 * origin it was served from. Jarvis starts headlamp-server on a free port,
 * so nothing answers there, the fetch throws, and the page reports the
 * cluster as "Unreachable" even though the server behind the tab is healthy.
 *
 * Dropping the token is honest — this is Chromium, and every other product
 * token stays — and it is the same trick Electron's own docs suggest for
 * embedding third-party sites.
 */
export function hostedUserAgent(electronUserAgent: string): string {
  return electronUserAgent.replace(/\s*Electron\/\S+/, "");
}
