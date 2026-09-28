import {
  TabStore,
  normalizeInput,
  type TabId,
  type TabKind,
  type WorkspaceState,
  type WorkspaceTab,
} from "@jarvis/core";

/**
 * The core's half of the Workspace: which tabs exist, their order, the
 * active one, and what each page last told us about itself. Pure — no
 * window, no Chromium — so the headless daemon runs exactly this, and a
 * phone that opens a terminal changes the same state the desktop's tab
 * strip draws from.
 *
 * The pages themselves are the host's business. The Electron host runs a
 * ViewReconciler (view-reconciler.ts) that follows this state and keeps one
 * WebContentsView per tab `hasView` says should have one. What crosses back
 * is small and serialisable on purpose, so the same seam can later run over
 * the daemon's control socket:
 *   - down: every change as a full WorkspaceState (onChange, which is also
 *     what becomes `workspace:update`), plus the two ViewRequests below;
 *   - up: `reportPage` (what a page did), `suspend` (the idle sweep) and
 *     `open` (a page's popup).
 */

/** Each tab with a hosted page is its own Chromium renderer process — eight
 *  is already about a gigabyte of resident memory. The cap is what stops a
 *  popup loop, or a long day of opening tabs, from taking the machine down
 *  with it. Counted over tabs `hasView` says hold a page. */
export const MAX_TABS = 8;

/** The kinds the renderer draws itself: a terminal's xterm, the API client
 *  and the Docker panel. They never get a hosted page. */
const VIEWLESS_KINDS: ReadonlySet<TabKind> = new Set(["terminal", "api", "docker"]);

/** The tab-strip label for every kind but "web", which wears the page's own
 *  title. */
const HOSTED_APP_LABELS: Record<Exclude<TabKind, "web">, string> = {
  editor: "Editor",
  database: "Database",
  terminal: "Terminal",
  api: "API",
  cluster: "Cluster",
  docker: "Docker",
  chat: "Chat",
};

/** Whether this tab should have a live hosted page behind it right now: a
 *  page kind that has not been suspended. The one rule the reconciler and
 *  the cap below both read, so they cannot disagree about it. */
export function hasView(tab: WorkspaceTab): boolean {
  return !VIEWLESS_KINDS.has(tab.kind) && !tab.suspended;
}

/**
 * What the core asks of the host's views beyond "match this state".
 *   - load: navigate this tab's existing page. Not derivable from state —
 *     entering the URL a page is already at must still load it again.
 *   - reveal: a tab was opened or activated, so a hideAll in force (the
 *     renderer's selected project had no tab to show) is over. Not
 *     derivable either: activating the tab that is already active changes
 *     no state at all.
 */
export type ViewRequest = { kind: "load"; id: TabId; url: string } | { kind: "reveal" };

/** What a hosted page did, as far as tab state cares. */
export type PageFact =
  | { kind: "navigated"; url: string; canGoBack: boolean; canGoForward: boolean }
  | { kind: "title"; title: string }
  | { kind: "loading"; loading: boolean }
  | { kind: "failed"; detail: string }
  /** The page's answer to "is a video genuinely playing?" */
  | { kind: "video"; playing: boolean }
  | { kind: "fullscreen"; fullscreen: boolean };

/** What a host's pages tell the tab state. Every call is small and
 *  serialisable, so it can cross the daemon's control socket; in-process it
 *  is the TabHost itself, through CoreClient.workspace. */
export type TabReports = Pick<TabHost, "open" | "suspend" | "reportPage">;

/** What a host's pages follow. */
export type TabSource = Pick<TabHost, "state" | "onChange" | "onViewRequest">;

type PendingResult = { redirectPrefix: string; resolve(url: string): void };

export class TabHost {
  readonly #store: TabStore;
  readonly #maxTabs: number;
  readonly #resumeUrl: (tab: WorkspaceTab) => Promise<string | undefined>;
  readonly #viewRequestListeners = new Set<(request: ViewRequest) => void>();
  /** openForResult's tabs still waiting for their redirect. */
  readonly #pending = new Map<TabId, PendingResult>();
  /** Suspended tabs whose resume is in flight — activated twice before the
   *  sidecar answered must still resume once. */
  readonly #resuming = new Set<TabId>();

  constructor(options?: {
    maxTabs?: number;
    store?: TabStore;
    /** Where a suspended tab should be rebuilt, asked at activation. Only
     *  the core's own handlers can answer for a hosted app, whose sidecar
     *  may have been stopped underneath it and come back on a different
     *  port; undefined means "reuse the URL the tab was suspended holding". */
    resumeUrl?(tab: WorkspaceTab): Promise<string | undefined>;
  }) {
    this.#store = options?.store ?? new TabStore();
    this.#maxTabs = options?.maxTabs ?? MAX_TABS;
    this.#resumeUrl = options?.resumeUrl ?? (async () => undefined);
  }

  state(): WorkspaceState {
    return this.#store.snapshot();
  }

  onChange(listener: (state: WorkspaceState) => void): () => void {
    return this.#store.onChange(listener);
  }

  onViewRequest(listener: (request: ViewRequest) => void): () => void {
    this.#viewRequestListeners.add(listener);
    return () => {
      this.#viewRequestListeners.delete(listener);
    };
  }

  open(project: string, input: string, kind: TabKind = "web", detail?: string): void {
    const target = normalizeInput(input);
    if (target.kind === "rejected") return;

    this.#evictIfFull();

    const tab = this.#store.open(project, target.url, kind);
    if (kind !== "web") {
      // A hosted app's own document.title tracks whatever file, panel or
      // table has focus inside it; the tab strip would be unreadable if that
      // leaked through, so this label is fixed once, here, and reportPage's
      // "title" case never overwrites it for a tab of this kind.
      // `detail` names which one, for the kinds that can have more than one
      // per project (an editor rooted at a configured sub-folder). It rides
      // in the title so the tab strip is readable, and stays on the tab so
      // the renderer can match on it.
      this.#label(tab.id, project, kind, detail);
    }
    // After the tab is in state, never before: over the daemon's socket the
    // two are separate frames, and a reveal ahead of the new tab would show
    // the previously active page for a frame.
    this.#request({ kind: "reveal" });
  }

  /**
   * Opens a terminal tab: a tab in the same store as every other, with no
   * hosted page behind it. Its pty lives in the core and its screen is drawn
   * by each client's own xterm.
   *
   * `detail` names a terminal Jarvis opened for a purpose of its own rather
   * than because the user asked for a shell — the AWS login tab, and
   * nothing else today (see LOGIN_TERMINAL_DETAIL). It rides in the title
   * so the tab strip says which terminal this is, and stays on the tab so
   * the renderer can tell it apart from an ordinary one.
   *
   * Returns the new tab's id: the caller keys the shell it is about to start
   * by it.
   */
  openTerminal(project: string, detail?: string): TabId {
    return this.#openViewless(project, "terminal", detail);
  }

  /** An API tab: no hosted page, a surface the renderer draws, requests
   *  issued from the core. */
  openApi(project: string): TabId {
    return this.#openViewless(project, "api");
  }

  /** A docker tab: no hosted page, Docker commands issued from the core. */
  openDocker(project: string): TabId {
    return this.#openViewless(project, "docker");
  }

  /**
   * Opens a tab and resolves with the first URL it navigates to that starts
   * with `redirectPrefix` — the OAuth2 authorization-code dance, where the
   * provider sends the user back to a callback carrying `?code=`.
   *
   * The app already has a browser, so this is where that flow belongs;
   * sending the user to their system browser to copy a code back by hand
   * would be the worse product. The tab closes itself the moment the redirect
   * is reported, which is also what stops the callback URL — which carries
   * the code — from being loaded any further.
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
      const tab = this.#store.open(project, target.url, "web");
      this.#pending.set(tab.id, { redirectPrefix, resolve });
      this.#store.update(tab.id, { title: `${project} — Authorize` });
      this.#request({ kind: "reveal" });
    });
  }

  /** Points a tab's existing page somewhere else. A tab with no live page —
   *  a terminal, a suspended tab, one just closed — has nothing to point. */
  navigate(id: TabId, input: string): void {
    const tab = this.#store.get(id);
    if (tab === undefined || !hasView(tab)) return;
    const target = normalizeInput(input);
    if (target.kind === "rejected") return;
    this.#store.update(id, { url: target.url, loading: true, error: undefined });
    this.#request({ kind: "load", id, url: target.url });
  }

  activate(id: TabId): void {
    this.#store.activate(id);
    this.#request({ kind: "reveal" });
    // A tab whose page was reclaimed gets a new one, at the address it was
    // suspended holding — except a hosted app, whose sidecar may have been
    // stopped underneath it and come back on a different port. Only the
    // core's handlers can answer that, which is what resumeUrl is for.
    const tab = this.#store.get(id);
    if (tab?.suspended === true) void this.#resume(tab);
  }

  close(id: TabId): void {
    // An authorization tab closed by hand never settles, exactly as before:
    // the caller's own timeout owns that outcome.
    this.#pending.delete(id);
    this.#store.close(id);
  }

  rename(id: TabId, title: string): void {
    this.#store.rename(id, title);
  }

  move(id: TabId, targetId: TabId, after: boolean): void {
    this.#store.move(id, targetId, after);
  }

  /**
   * Marks a tab's page as reclaimed — the host's idle sweep decided it had
   * sat hidden long enough (ViewReconciler.sweepIdle). The tab stays: its
   * row, URL and place in the strip are untouched, and activating it
   * rebuilds the page at the same address.
   *
   * The host's sweep already skips the active tab and one playing video,
   * but it asks from its own copy of the state. Over the daemon's socket
   * the user can switch to a tab while its suspend is in flight, and
   * suspending the page they are looking at would destroy it under them —
   * so the core, which holds the current state, refuses both again here.
   */
  suspend(id: TabId): void {
    const tab = this.#store.get(id);
    if (tab === undefined || !hasView(tab)) return;
    if (id === this.#store.snapshot().activeTabId || tab.hasPlayingVideo) return;
    this.#store.update(id, {
      suspended: true,
      // A suspended tab can go nowhere: there is no session history left to
      // walk. Claiming otherwise leaves two dead buttons in the toolbar
      // until the page is rebuilt.
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
  }

  /** What a tab's page did. A fact about a tab that has since closed is
   *  dropped — the page may have been answering while it went. */
  reportPage(id: TabId, fact: PageFact): void {
    const tab = this.#store.get(id);
    if (tab === undefined) return;
    switch (fact.kind) {
      case "navigated":
        this.#store.update(id, {
          url: fact.url,
          canGoBack: fact.canGoBack,
          canGoForward: fact.canGoForward,
          error: undefined,
          // The old page's video left with the old page. A flag carried
          // over would offer to float something that no longer exists.
          hasPlayingVideo: false,
          // Same for full screen: Chromium drops it on navigation without
          // firing leave-html-full-screen, and a stuck flag would leave the
          // window with no chrome and no way to get it back.
          pageFullscreen: false,
        });
        this.#settleIfRedirected(id, fact.url);
        break;
      case "title":
        // A hosted app's title is fixed at open() and never follows the
        // page's own document.title — see the comment there.
        if (tab.kind === "web") this.#store.update(id, { title: fact.title });
        break;
      case "loading":
        this.#store.update(id, { loading: fact.loading });
        break;
      case "failed":
        this.#store.update(id, { loading: false, error: fact.detail });
        break;
      case "video":
        this.#store.update(id, { hasPlayingVideo: fact.playing });
        break;
      case "fullscreen":
        // Chromium has already given the page full screen inside its view.
        // All that is left is the layout: the renderer reads this flag,
        // drops its own chrome and remeasures the slot as the whole window.
        this.#store.update(id, { pageFullscreen: fact.fullscreen });
        break;
    }
  }

  #settleIfRedirected(id: TabId, url: string): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    // An empty prefix means "any redirect that carries a code or an error",
    // which is the honest default when the config named no callback URL of
    // its own.
    const matches =
      pending.redirectPrefix === ""
        ? url.includes("code=") || url.includes("error=")
        : url.startsWith(pending.redirectPrefix);
    if (!matches) return;
    this.close(id);
    pending.resolve(url);
  }

  /**
   * A tab with no hosted page behind it. There is no URL to normalise and
   * nothing to load; the renderer draws the surface itself.
   */
  #openViewless(project: string, kind: "terminal" | "api" | "docker", detail?: string): TabId {
    this.#evictIfFull();
    const tab = this.#store.open(project, "", kind);
    this.#label(tab.id, project, kind, detail);
    this.#request({ kind: "reveal" });
    return tab.id;
  }

  #label(id: TabId, project: string, kind: Exclude<TabKind, "web">, detail?: string): void {
    const label = HOSTED_APP_LABELS[kind];
    this.#store.update(id, {
      title: detail === undefined ? `${project} — ${label}` : `${project} — ${label} · ${detail}`,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  /**
   * Rebuilds a suspended tab. Nothing else here awaits, so activate() fires
   * this and returns — the tab is already active, and the page arrives when
   * it arrives, exactly as it does on a first open.
   */
  async #resume(tab: WorkspaceTab): Promise<void> {
    if (this.#resuming.has(tab.id)) return;
    this.#resuming.add(tab.id);
    let url = tab.url;
    try {
      url = (await this.#resumeUrl(tab)) ?? tab.url;
    } catch {
      // A sidecar that refuses to restart is no reason to leave the user
      // with a tab that does nothing when clicked. The stored URL is the
      // honest fallback, and the page's own failed load then says so.
    } finally {
      this.#resuming.delete(tab.id);
    }
    // Closed while the sidecar was starting, or already resumed.
    if (this.#store.get(tab.id)?.suspended !== true) return;

    this.#evictIfFull();
    this.#store.update(tab.id, { suspended: false, url, loading: true, error: undefined });
  }

  #evictIfFull(): void {
    for (;;) {
      const { tabs } = this.#store.snapshot();
      const paged = new Set(tabs.filter(hasView).map((tab) => tab.id));
      if (paged.size < this.#maxTabs) return;
      // Only a tab that actually holds a page. The cap exists to bound
      // Chromium renderer processes, and a terminal tab is not one — closing
      // it here would drop the tab without reaping the shell behind it,
      // since only the close handler kills a shell. It would also fail to
      // free anything, so the loop would go on to evict every terminal
      // before reaching a page.
      const oldest = this.#store.leastRecentlyActive().find((id) => paged.has(id));
      if (oldest === undefined) return;
      this.close(oldest);
    }
  }

  #request(request: ViewRequest): void {
    for (const listener of [...this.#viewRequestListeners]) {
      try {
        listener(request);
      } catch (error) {
        // Same rule as TabStore's own listeners: one host's failure to
        // follow a request must not undo the tab change that caused it.
        // Logged, though: a page that never loads with nothing said about
        // it is a bug nobody can find.
        console.error(
          `workspace: a host failed to follow a ${request.kind} request: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
