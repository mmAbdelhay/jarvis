import type { TabId, TabKind, TabPatch, WorkspaceState, WorkspaceTab } from "./types.js";

/**
 * The tab model, pure. Which tabs exist, which is active, and what each one
 * currently shows — no Chromium, no processes. BrowserHost (desktop) is the
 * only thing that owns real views, and it drives this store rather than
 * keeping a second copy of the same state.
 *
 * Activity order is tracked here rather than in the host because eviction
 * ("close the tab nobody has looked at in longest") is a decision about tab
 * state, and keeping it beside the tabs means it cannot drift out of sync
 * with them the way a parallel list in the host would.
 */
export class TabStore {
  readonly #tabs: WorkspaceTab[] = [];
  /** Least recently active first. Every id in #tabs appears exactly once. */
  readonly #activity: TabId[] = [];
  readonly #listeners = new Set<(state: WorkspaceState) => void>();
  readonly #nextId: () => string;
  #counter = 0;

  constructor(options?: { nextId?: () => string }) {
    this.#nextId = options?.nextId ?? (() => `tab-${++this.#counter}`);
  }

  snapshot(): WorkspaceState {
    return {
      tabs: this.#tabs.map((tab) => ({ ...tab })),
      activeTabId: this.#activity.at(-1),
    };
  }

  get(id: TabId): WorkspaceTab | undefined {
    const tab = this.#tabs.find((candidate) => candidate.id === id);
    return tab === undefined ? undefined : { ...tab };
  }

  open(project: string, url: string, kind: TabKind = "web"): WorkspaceTab {
    const tab: WorkspaceTab = {
      id: this.#nextId(),
      project,
      url,
      kind,
      title: "",
      loading: true,
      canGoBack: false,
      canGoForward: false,
      error: undefined,
      hasPlayingVideo: false,
      pageFullscreen: false,
      suspended: false,
    };
    this.#tabs.push(tab);
    this.#activity.push(tab.id);
    this.#emit();
    return { ...tab };
  }

  close(id: TabId): void {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    if (index === -1) return;

    // The neighbour that inherits focus is chosen before the splice, while
    // the positions still mean something: left first, because that is the
    // tab the user was on before opening this one.
    const wasActive = this.#activity.at(-1) === id;
    const left = this.#tabs[index - 1]?.id;
    const right = this.#tabs[index + 1]?.id;

    this.#tabs.splice(index, 1);
    const activityIndex = this.#activity.indexOf(id);
    if (activityIndex !== -1) this.#activity.splice(activityIndex, 1);

    if (wasActive) {
      const heir = left ?? right;
      if (heir !== undefined) this.#promote(heir);
    }
    this.#emit();
  }

  activate(id: TabId): void {
    if (!this.#tabs.some((tab) => tab.id === id)) return;
    this.#promote(id);
    this.#emit();
  }

  update(id: TabId, patch: TabPatch): void {
    const index = this.#tabs.findIndex((tab) => tab.id === id);
    const tab = this.#tabs[index];
    if (tab === undefined) return;
    this.#tabs[index] = { ...tab, ...patch };
    this.#emit();
  }

  leastRecentlyActive(): TabId[] {
    return [...this.#activity];
  }

  onChange(listener: (state: WorkspaceState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  #promote(id: TabId): void {
    const index = this.#activity.indexOf(id);
    if (index !== -1) this.#activity.splice(index, 1);
    this.#activity.push(id);
  }

  #emit(): void {
    const state = this.snapshot();
    // Iterate a copy, and isolate each listener: the renderer push, the
    // host and (later) the brain all subscribe here, and one throwing
    // subscriber must not starve the others.
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch {
        // Deliberately swallowed; see above.
      }
    }
  }
}
