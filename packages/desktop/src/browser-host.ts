import { TabStore, normalizeInput, type TabId, type WorkspaceState } from "@jarvis/core";

export type Rect = { x: number; y: number; width: number; height: number };

/** What a hosted page tells the host about itself. Deliberately small: the
 *  five facts the tab strip and address bar draw, plus the popup request. */
export type HostedViewEvent =
  | { kind: "navigated"; url: string; canGoBack: boolean; canGoForward: boolean }
  | { kind: "title"; title: string }
  | { kind: "loading"; loading: boolean }
  | { kind: "failed"; detail: string }
  | { kind: "popup"; url: string };

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
};

export type ViewFactory = (partition: string) => HostedView;

/** Each tab is its own Chromium renderer process — eight is already about a
 *  gigabyte of resident memory. The cap is what stops a popup loop, or a
 *  long day of opening tabs, from taking the machine down with it. */
export const MAX_TABS = 8;

export class BrowserHost {
  readonly #createView: ViewFactory;
  readonly #store: TabStore;
  readonly #views = new Map<TabId, HostedView>();
  readonly #maxTabs: number;
  #bounds: Rect | undefined;
  #visible = false;

  constructor(createView: ViewFactory, options?: { maxTabs?: number; store?: TabStore }) {
    this.#createView = createView;
    this.#store = options?.store ?? new TabStore();
    this.#maxTabs = options?.maxTabs ?? MAX_TABS;
  }

  state(): WorkspaceState {
    return this.#store.snapshot();
  }

  onChange(listener: (state: WorkspaceState) => void): () => void {
    return this.#store.onChange(listener);
  }

  open(project: string, input: string): void {
    const target = normalizeInput(input);
    if (target.kind === "rejected") return;

    this.#evictIfFull();

    const tab = this.#store.open(project, target.url);
    // The partition is what makes a project's logins its own.
    // encodeURIComponent because a project name is user-supplied config and
    // a partition name with a slash or a space in it is not addressable.
    const view = this.#createView(`persist:project-${encodeURIComponent(project)}`);
    this.#views.set(tab.id, view);

    view.onEvent((event) => this.#onViewEvent(tab.id, project, event));
    if (this.#bounds !== undefined) view.setBounds(this.#bounds);
    view.loadURL(target.url);
    this.#syncVisibility();
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

  setBounds(bounds: Rect): void {
    this.#bounds = bounds;
    for (const view of this.#views.values()) view.setBounds(bounds);
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
        });
        break;
      case "title":
        this.#store.update(id, { title: event.title });
        break;
      case "loading":
        this.#store.update(id, { loading: event.loading });
        break;
      case "failed":
        this.#store.update(id, { loading: false, error: event.detail });
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
      const oldest = this.#store.leastRecentlyActive()[0];
      if (oldest === undefined) return;
      this.#views.get(oldest)?.destroy();
      this.#views.delete(oldest);
      this.#store.close(oldest);
    }
  }

  #syncVisibility(): void {
    const activeId = this.#store.snapshot().activeTabId;
    for (const [id, view] of this.#views) {
      view.setVisible(this.#visible && id === activeId);
    }
  }
}
