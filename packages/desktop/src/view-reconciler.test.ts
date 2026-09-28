import type { Session } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import {
  isDevToolsDock,
  type DevToolsDock,
  type HostedView,
  type HostedViewEvent,
  type Rect,
  type ViewFactory,
} from "./browser-host.js";
import { TabHost, type PageFact } from "./core/tab-host.js";
import { ViewReconciler, type TabReports } from "./view-reconciler.js";

class FakeView implements HostedView {
  devToolsOpen = false;
  devToolsBounds: Rect | undefined;
  devToolsDock: DevToolsDock | undefined;
  setDevToolsDock(dock: DevToolsDock): void {
    this.devToolsDock = dock;
  }
  loaded: string[] = [];
  bounds: Rect | undefined;
  visible = false;
  destroyed = false;
  wentBack = 0;
  wentForward = 0;
  reloaded = 0;
  #listeners: ((event: HostedViewEvent) => void)[] = [];

  loadURL(url: string): void {
    this.loaded.push(url);
  }
  setBounds(bounds: Rect): void {
    this.bounds = bounds;
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
  goBack(): void {
    this.wentBack += 1;
  }
  goForward(): void {
    this.wentForward += 1;
  }
  reload(): void {
    this.reloaded += 1;
  }
  destroy(): void {
    this.destroyed = true;
  }
  setDevTools(open: boolean): void {
    this.devToolsOpen = open;
  }
  setDevToolsBounds(bounds: Rect): void {
    this.devToolsBounds = bounds;
  }
  /** What the page will answer when asked whether a video is playing. */
  videoPlaying = false;
  probes = 0;
  pipRequests = 0;
  hasPlayingVideo(): Promise<boolean> {
    this.probes += 1;
    return Promise.resolve(this.videoPlaying);
  }
  requestPictureInPicture(): void {
    this.pipRequests += 1;
  }
  onEvent(listener: (event: HostedViewEvent) => void): void {
    this.#listeners.push(listener);
  }
  emit(event: HostedViewEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

/**
 * The desktop's Workspace as main.ts wires it: the core's TabHost with a
 * ViewReconciler following it. The suites further down are BrowserHost's
 * own, from before the split, run unchanged against this pair — that is
 * the "no behaviour change" check.
 */
function composeWorkspace(
  createView: ViewFactory,
  options?: {
    maxTabs?: number;
    suspendAfterMs?: number;
    now?(): number;
    resumeUrl?(tab: WorkspaceTab): Promise<string | undefined>;
    cacheFavicon?(pageUrl: string, iconUrl: string, from: Session): Promise<void>;
  },
) {
  const tabs = new TabHost({
    ...(options?.maxTabs === undefined ? {} : { maxTabs: options.maxTabs }),
    ...(options?.resumeUrl === undefined ? {} : { resumeUrl: options.resumeUrl }),
  });
  const views = new ViewReconciler(createView, tabs, {
    ...(options?.suspendAfterMs === undefined ? {} : { suspendAfterMs: options.suspendAfterMs }),
    ...(options?.now === undefined ? {} : { now: options.now }),
    ...(options?.cacheFavicon === undefined ? {} : { cacheFavicon: options.cacheFavicon }),
  });
  views.follow(tabs);
  return {
    state: () => tabs.state(),
    onChange: (listener: (state: WorkspaceState) => void) => tabs.onChange(listener),
    open: (...args: Parameters<TabHost["open"]>) => tabs.open(...args),
    openTerminal: (project: string, detail?: string) => tabs.openTerminal(project, detail),
    openApi: (project: string) => tabs.openApi(project),
    openDocker: (project: string) => tabs.openDocker(project),
    openForResult: (project: string, url: string, prefix?: string) =>
      tabs.openForResult(project, url, prefix),
    navigate: (id: string, input: string) => tabs.navigate(id, input),
    activate: (id: string) => tabs.activate(id),
    close: (id: string) => tabs.close(id),
    rename: (id: string, title: string) => tabs.rename(id, title),
    move: (id: string, target: string, after: boolean) => tabs.move(id, target, after),
    back: (id: string) => views.back(id),
    forward: (id: string) => views.forward(id),
    reload: (id: string) => views.reload(id),
    requestPictureInPicture: (id: string) => views.requestPictureInPicture(id),
    setBounds: (bounds: Rect) => views.setBounds(bounds),
    setDevTools: (id: string, open: boolean) => views.setDevTools(id, open),
    setDevToolsDock: (dock: DevToolsDock) => views.setDevToolsDock(dock),
    setDevToolsBounds: (bounds: Rect) => views.setDevToolsBounds(bounds),
    onDevToolsClosed: (listener: (id: string) => void) => views.onDevToolsClosed(listener),
    setVisible: (visible: boolean) => views.setVisible(visible),
    hideAll: () => views.hideAll(),
    sweepIdle: () => views.sweepIdle(),
    destroy: () => views.destroy(),
  };
}

type ComposedWorkspace = ReturnType<typeof composeWorkspace>;

// ---------------------------------------------------------------------------
// ViewReconciler alone, driven by hand-written snapshots — what it will see
// when the tab state lives in the daemon and arrives as workspace:update.

function tab(id: string, overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id,
    project: "acme",
    url: `https://${id}.example/`,
    kind: "web",
    title: "",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    error: undefined,
    hasPlayingVideo: false,
    pageFullscreen: false,
    suspended: false,
    ...overrides,
  };
}

function snapshot(tabs: WorkspaceTab[], activeTabId = tabs.at(-1)?.id): WorkspaceState {
  return { tabs, activeTabId };
}

type Reported =
  | { call: "open"; args: unknown[] }
  | { call: "suspend"; id: string }
  | { call: "reportPage"; id: string; fact: PageFact };

function recordingReports(): { reports: TabReports; calls: Reported[] } {
  const calls: Reported[] = [];
  return {
    calls,
    reports: {
      open: (...args) => {
        calls.push({ call: "open", args });
      },
      suspend: (id) => {
        calls.push({ call: "suspend", id });
      },
      reportPage: (id, fact) => {
        calls.push({ call: "reportPage", id, fact });
      },
    },
  };
}

describe("ViewReconciler against a snapshot sequence", () => {
  let created: { tabKind: string; partition: string; view: FakeView }[];
  let calls: Reported[];
  let reconciler: ViewReconciler;
  let now: number;

  const viewOf = (url: string): FakeView | undefined =>
    created.find((entry) => entry.view.loaded[0] === url)?.view;

  beforeEach(() => {
    created = [];
    now = 0;
    const recorded = recordingReports();
    calls = recorded.calls;
    reconciler = new ViewReconciler(
      (partition, tabKind) => {
        const view = new FakeView();
        created.push({ tabKind, partition, view });
        return view;
      },
      recorded.reports,
      { suspendAfterMs: 1000, now: () => now },
    );
    reconciler.setVisible(true);
  });

  it("diffs each snapshot against the views it holds", () => {
    const a = tab("a");
    const b = tab("b", { project: "shop" });
    const t = tab("t", { kind: "terminal", url: "" });

    reconciler.apply(snapshot([a]));
    expect(created.map((entry) => entry.view.loaded)).toEqual([["https://a.example/"]]);

    reconciler.apply(snapshot([a, b]));
    expect(created).toHaveLength(2);
    expect(created[1]?.partition).toBe("persist:project-shop");
    expect(viewOf("https://a.example/")?.visible).toBe(false);
    expect(viewOf("https://b.example/")?.visible).toBe(true);

    reconciler.apply(snapshot([b]));
    expect(viewOf("https://a.example/")?.destroyed).toBe(true);
    expect(viewOf("https://b.example/")?.destroyed).toBe(false);

    reconciler.apply(snapshot([b, t]));
    expect(created).toHaveLength(2);
    expect(viewOf("https://b.example/")?.visible).toBe(false);

    reconciler.apply(snapshot([{ ...b, suspended: true }, t]));
    expect(viewOf("https://b.example/")?.destroyed).toBe(true);

    reconciler.apply(snapshot([{ ...b, url: "https://b.example/resumed" }, t], "b"));
    expect(created).toHaveLength(3);
    expect(created[2]?.view.loaded).toEqual(["https://b.example/resumed"]);
    expect(created[2]?.view.visible).toBe(true);
  });

  it("is idempotent: the same snapshot twice creates, destroys and loads nothing more", () => {
    const state = snapshot([tab("a"), tab("b"), tab("t", { kind: "terminal", url: "" })]);
    reconciler.apply(state);
    reconciler.apply(state);
    reconciler.apply(structuredClone(state));

    expect(created).toHaveLength(2);
    expect(created.every((entry) => entry.view.loaded.length === 1)).toBe(true);
    expect(created.some((entry) => entry.view.destroyed)).toBe(false);
  });

  it("does not reload a page whose URL changed in state — the page moved itself", () => {
    reconciler.apply(snapshot([tab("a")]));
    reconciler.apply(snapshot([tab("a", { url: "https://a.example/next" })]));
    expect(created[0]?.view.loaded).toEqual(["https://a.example/"]);
  });

  it("never gives a terminal, API or Docker tab a view", () => {
    reconciler.apply(
      snapshot([
        tab("t", { kind: "terminal", url: "" }),
        tab("p", { kind: "api", url: "" }),
        tab("d", { kind: "docker", url: "" }),
      ]),
    );
    expect(created).toEqual([]);
  });

  it("gives every hosted-app kind a view, telling the factory which kind", () => {
    reconciler.apply(
      snapshot([
        tab("e", { kind: "editor" }),
        tab("db", { kind: "database" }),
        tab("c", { kind: "cluster" }),
        tab("ch", { kind: "chat" }),
      ]),
    );
    expect(created.map((entry) => entry.tabKind)).toEqual([
      "editor",
      "database",
      "cluster",
      "chat",
    ]);
  });

  it("loads on request, into that tab's view only", () => {
    reconciler.apply(snapshot([tab("a"), tab("b")]));
    reconciler.request({ kind: "load", id: "a", url: "https://a.example/again" });
    reconciler.request({ kind: "load", id: "gone", url: "https://x.example/" });
    expect(created[0]?.view.loaded).toEqual(["https://a.example/", "https://a.example/again"]);
    expect(created[1]?.view.loaded).toEqual(["https://b.example/"]);
  });

  it("stays hidden after hideAll until a reveal, even with no state change", () => {
    const state = snapshot([tab("a")]);
    reconciler.apply(state);
    reconciler.hideAll();
    reconciler.apply(state);
    expect(created[0]?.view.visible).toBe(false);
    reconciler.request({ kind: "reveal" });
    expect(created[0]?.view.visible).toBe(true);
  });

  it("reports what a page did as facts, and a popup as an open in the same project", () => {
    reconciler.apply(snapshot([tab("a", { project: "shop" })]));
    const view = created[0]!.view;
    view.emit({
      kind: "navigated",
      url: "https://a.example/x",
      canGoBack: true,
      canGoForward: false,
    });
    view.emit({ kind: "title", title: "A" });
    view.emit({ kind: "loading", loading: false });
    view.emit({ kind: "failed", detail: "boom" });
    view.emit({ kind: "fullscreen", fullscreen: true });
    view.emit({ kind: "media", playing: false });
    view.emit({ kind: "popup", url: "https://popup.example/" });
    expect(calls).toEqual([
      {
        call: "reportPage",
        id: "a",
        fact: {
          kind: "navigated",
          url: "https://a.example/x",
          canGoBack: true,
          canGoForward: false,
        },
      },
      { call: "reportPage", id: "a", fact: { kind: "title", title: "A" } },
      { call: "reportPage", id: "a", fact: { kind: "loading", loading: false } },
      { call: "reportPage", id: "a", fact: { kind: "failed", detail: "boom" } },
      { call: "reportPage", id: "a", fact: { kind: "fullscreen", fullscreen: true } },
      { call: "reportPage", id: "a", fact: { kind: "video", playing: false } },
      { call: "open", args: ["shop", "https://popup.example/"] },
    ]);
  });

  it("asks the core to suspend an idle page, and destroys it only when state says so", () => {
    reconciler.apply(snapshot([tab("a"), tab("b")]));
    now = 5000;
    reconciler.sweepIdle();
    expect(calls).toEqual([{ call: "suspend", id: "a" }]);
    expect(created[0]?.view.destroyed).toBe(false);

    reconciler.apply(snapshot([tab("a", { suspended: true }), tab("b")]));
    expect(created[0]?.view.destroyed).toBe(true);
  });

  it("logs a page it could not build and still builds and shows the rest", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const views: FakeView[] = [];
      const failing = new ViewReconciler((partition) => {
        if (partition === "persist:project-broken") throw new Error("no renderer");
        const view = new FakeView();
        views.push(view);
        return view;
      }, recordingReports().reports);
      failing.setVisible(true);
      failing.apply(snapshot([tab("x", { project: "broken" }), tab("b")]));
      expect(views.map((view) => view.loaded)).toEqual([["https://b.example/"]]);
      expect(views[0]?.visible).toBe(true);
      expect(errors).toHaveBeenCalledTimes(1);
      const line = String(errors.mock.calls[0]?.[0]);
      expect(line).toContain("tab x");
      expect(line).toContain("no renderer");
      // The URL can carry a token (an OAuth callback), so it stays out.
      expect(line).not.toContain("x.example");
    } finally {
      errors.mockRestore();
    }
  });

  it("creates nothing once destroyed", () => {
    reconciler.apply(snapshot([tab("a")]));
    reconciler.destroy();
    reconciler.apply(snapshot([tab("a"), tab("b")]));
    expect(created).toHaveLength(1);
    expect(created[0]?.view.destroyed).toBe(true);
  });

  it("follows a TabHost: its current state first, then every change and request", () => {
    const tabs = new TabHost();
    tabs.open("acme", "one.example");
    const unfollow = reconciler.follow(tabs);
    expect(created.map((entry) => entry.view.loaded)).toEqual([["https://one.example"]]);

    const id = tabs.state().tabs[0]!.id;
    tabs.navigate(id, "two.example");
    expect(created[0]?.view.loaded).toEqual(["https://one.example", "https://two.example"]);

    unfollow();
    tabs.open("acme", "three.example");
    expect(created).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// BrowserHost's behaviour, from before the split, against the composed pair.

describe("Workspace", () => {
  let views: FakeView[];
  let partitions: string[];
  let kinds: string[];
  let host: ComposedWorkspace;

  beforeEach(() => {
    views = [];
    partitions = [];
    kinds = [];
    host = composeWorkspace((partition, kind) => {
      partitions.push(partition);
      kinds.push(kind);
      const view = new FakeView();
      views.push(view);
      return view;
    });
  });

  it("opens a tab, creates a view and loads the normalised URL", () => {
    host.open("acme", "github.com");

    expect(views).toHaveLength(1);
    expect(views[0]?.loaded).toEqual(["https://github.com"]);
    expect(host.state().tabs[0]?.url).toBe("https://github.com");
    expect(kinds).toEqual(["web"]);
  });

  it("passes hosted-app kind to the view factory for shortcut scoping", () => {
    host.open("acme", "http://127.0.0.1:8000", "editor");
    expect(kinds).toEqual(["editor"]);
  });

  // The reason this browser exists rather than a link to Chrome: each
  // project keeps its own cookies, so the same site can be logged in as a
  // different account per project.
  it("gives each project its own persistent partition", () => {
    host.open("acme", "github.com");
    host.open("storefront", "github.com");

    expect(partitions).toEqual(["persist:project-acme", "persist:project-storefront"]);
  });

  it("reuses one partition for two tabs of the same project", () => {
    host.open("acme", "github.com");
    host.open("acme", "example.com");

    expect(partitions).toEqual(["persist:project-acme", "persist:project-acme"]);
  });

  it("escapes a project name that is not partition-safe", () => {
    host.open("my project/v2", "github.com");

    expect(partitions[0]).toBe(`persist:project-${encodeURIComponent("my project/v2")}`);
  });

  it("refuses to open a rejected scheme and creates no view", () => {
    host.open("acme", "file:///etc/passwd");

    expect(views).toHaveLength(0);
    expect(host.state().tabs).toEqual([]);
  });

  it("turns prose into a search rather than refusing it", () => {
    host.open("acme", "how to rebase");

    expect(views[0]?.loaded[0]).toContain("duckduckgo.com/?q=how%20to%20rebase");
  });

  it("navigates an existing tab without creating another view", () => {
    host.open("acme", "github.com");
    const id = host.state().tabs[0]?.id ?? "";

    host.navigate(id, "example.com");

    expect(views).toHaveLength(1);
    expect(views[0]?.loaded).toEqual(["https://github.com", "https://example.com"]);
  });

  it("ignores navigation for an unknown tab", () => {
    expect(() => host.navigate("no-such-tab", "example.com")).not.toThrow();
  });

  it("records the page's own title", () => {
    host.open("acme", "github.com");
    views[0]?.emit({ kind: "title", title: "GitHub" });

    expect(host.state().tabs[0]?.title).toBe("GitHub");
  });

  it("records a redirect the page performed itself", () => {
    host.open("acme", "github.com");
    views[0]?.emit({
      kind: "navigated",
      url: "https://github.com/login",
      canGoBack: true,
      canGoForward: false,
    });

    const tab = host.state().tabs[0];
    expect(tab?.url).toBe("https://github.com/login");
    expect(tab?.canGoBack).toBe(true);
  });

  it("clears a previous error once a navigation succeeds", () => {
    host.open("acme", "github.com");
    views[0]?.emit({ kind: "failed", detail: "ERR_NAME_NOT_RESOLVED" });
    expect(host.state().tabs[0]?.error).toBe("ERR_NAME_NOT_RESOLVED");

    views[0]?.emit({
      kind: "navigated",
      url: "https://github.com",
      canGoBack: false,
      canGoForward: false,
    });

    expect(host.state().tabs[0]?.error).toBeUndefined();
  });

  it("tracks loading state", () => {
    host.open("acme", "github.com");
    expect(host.state().tabs[0]?.loading).toBe(true);

    views[0]?.emit({ kind: "loading", loading: false });

    expect(host.state().tabs[0]?.loading).toBe(false);
  });

  // target=_blank. A browser opens a tab; denying it silently makes links
  // look broken.
  it("opens a popup as a new tab in the same project", () => {
    host.open("acme", "github.com");
    views[0]?.emit({ kind: "popup", url: "https://example.com/help" });

    const state = host.state();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1]?.project).toBe("acme");
    expect(views[1]?.loaded).toEqual(["https://example.com/help"]);
  });

  it("refuses a popup with a non-web scheme", () => {
    host.open("acme", "github.com");
    views[0]?.emit({ kind: "popup", url: "file:///etc/passwd" });

    expect(host.state().tabs).toHaveLength(1);
  });

  // One dock side for every tab, as in Chrome: a tab opened after the
  // choice must not come up docked somewhere else.
  it("applies the DevTools dock side to every view, including later ones", () => {
    host.open("acme", "one.example");
    host.setDevToolsDock("right");
    host.open("acme", "two.example");

    expect(views.map((view) => view.devToolsDock)).toEqual(["right", "right"]);
  });

  // An undocked DevTools window closed by the user is DevTools closing
  // without the renderer asking — which only the renderer can undo on its
  // side, so it has to hear which tab.
  it("reports DevTools that closed on their own, by tab", () => {
    const closed: string[] = [];
    host.onDevToolsClosed((id) => closed.push(id));
    host.open("acme", "one.example");
    const id = host.state().tabs[0]?.id ?? "";

    views[0]?.emit({ kind: "devtoolsClosed" });

    expect(closed).toEqual([id]);
  });

  it("recognises the four dock sides and nothing else", () => {
    for (const dock of ["undocked", "left", "bottom", "right"])
      expect(isDevToolsDock(dock)).toBe(true);
    for (const other of ["top", "", undefined, 3]) expect(isDevToolsDock(other)).toBe(false);
  });

  it("shows only the active tab's view", () => {
    host.open("acme", "one.example");
    host.open("acme", "two.example");
    host.setVisible(true);

    expect(views[0]?.visible).toBe(false);
    expect(views[1]?.visible).toBe(true);
  });

  // The renderer switches its selected project without necessarily
  // switching which tab is "active" (a project with no open tabs has
  // nothing to activate) — hideAll is how it clears the page area without
  // that meaning "leave the route", which setVisible(false) would.
  it("hides every view without changing which tab is active", () => {
    host.open("acme", "one.example");
    host.setVisible(true);

    host.hideAll();

    expect(views[0]?.visible).toBe(false);
    expect(host.state().activeTabId).toBe(host.state().tabs[0]?.id);
  });

  // hideAll's suppression must not outlive its purpose: the moment the
  // renderer activates a real tab again (switching to a project that does
  // have one open), that tab's view has to actually reappear.
  it("clears the suppression when a tab is activated again", () => {
    host.open("acme", "one.example");
    const id = host.state().tabs[0]?.id ?? "";
    host.setVisible(true);
    host.hideAll();

    host.activate(id);

    expect(views[0]?.visible).toBe(true);
  });

  it("clears the suppression when a new tab is opened", () => {
    host.open("acme", "one.example");
    host.setVisible(true);
    host.hideAll();

    host.open("acme", "two.example");

    expect(views[1]?.visible).toBe(true);
  });

  it("hides every view when the route is left", () => {
    host.open("acme", "one.example");
    host.setVisible(true);
    host.setVisible(false);

    expect(views[0]?.visible).toBe(false);
  });

  // The trap this whole design has to survive: a hosted view is a native
  // overlay, not a DOM node, so leaving the route must actively hide it or
  // the page floats over the dashboard.
  it("keeps every view hidden while the route is not visible", () => {
    host.open("acme", "one.example");
    host.setVisible(false);
    host.open("acme", "two.example");

    expect(views[1]?.visible).toBe(false);
  });

  it("applies the current bounds to a view opened later", () => {
    host.setBounds({ x: 10, y: 20, width: 800, height: 600 });
    host.open("acme", "one.example");

    expect(views[0]?.bounds).toEqual({ x: 10, y: 20, width: 800, height: 600 });
  });

  it("applies new bounds to every existing view", () => {
    host.open("acme", "one.example");
    host.open("acme", "two.example");

    host.setBounds({ x: 0, y: 40, width: 1000, height: 700 });

    expect(views[0]?.bounds).toEqual({ x: 0, y: 40, width: 1000, height: 700 });
    expect(views[1]?.bounds).toEqual({ x: 0, y: 40, width: 1000, height: 700 });
  });

  it("destroys the view when its tab closes", () => {
    host.open("acme", "one.example");
    const id = host.state().tabs[0]?.id ?? "";

    host.close(id);

    expect(views[0]?.destroyed).toBe(true);
    expect(host.state().tabs).toEqual([]);
  });

  it("shows the heir's view after the active tab closes", () => {
    host.open("acme", "one.example");
    host.open("acme", "two.example");
    host.setVisible(true);
    const second = host.state().tabs[1]?.id ?? "";

    host.close(second);

    expect(views[0]?.visible).toBe(true);
  });

  it("forwards back, forward and reload to the right view", () => {
    host.open("acme", "one.example");
    host.open("acme", "two.example");
    const first = host.state().tabs[0]?.id ?? "";

    host.back(first);
    host.forward(first);
    host.reload(first);

    expect(views[0]?.wentBack).toBe(1);
    expect(views[0]?.wentForward).toBe(1);
    expect(views[0]?.reloaded).toBe(1);
    expect(views[1]?.wentBack).toBe(0);
  });

  // Each tab is a Chromium renderer process. Eight of them is already a
  // gigabyte; unbounded, a stray popup loop would take the machine down.
  it("evicts the least recently active tab past the cap", () => {
    const capped = composeWorkspace(
      () => {
        const view = new FakeView();
        views.push(view);
        return view;
      },
      { maxTabs: 2 },
    );

    capped.open("p", "one.example");
    capped.open("p", "two.example");
    capped.open("p", "three.example");

    expect(capped.state().tabs.map((tab) => tab.url)).toEqual([
      "https://two.example",
      "https://three.example",
    ]);
    expect(views[0]?.destroyed).toBe(true);
  });

  it("destroys every view on destroy()", () => {
    host.open("acme", "one.example");
    host.open("acme", "two.example");

    host.destroy();

    expect(views.every((view) => view.destroyed)).toBe(true);
  });

  it("notifies subscribers when tab state changes", () => {
    const seen: number[] = [];
    host.onChange((state) => seen.push(state.tabs.length));

    host.open("acme", "one.example");
    views[0]?.emit({ kind: "title", title: "One" });

    expect(seen).toEqual([1, 1]);
  });

  it("defaults an opened tab's kind to web", () => {
    host.open("acme", "one.example");

    expect(host.state().tabs[0]?.kind).toBe("web");
  });

  it("opens a tab with an explicit kind", () => {
    host.open("acme", "http://127.0.0.1:9001", "editor");

    expect(host.state().tabs[0]?.kind).toBe("editor");
  });

  // code-server's own document.title changes with whatever file or panel
  // has focus inside it; the tab strip would be unreadable if that leaked
  // through, so an editor tab gets a stable label the project name alone
  // decides, set once at open and never touched again.
  it("gives an editor tab a stable title naming its project", () => {
    host.open("acme", "http://127.0.0.1:9001", "editor");

    expect(host.state().tabs[0]?.title).toBe("acme — Editor");
  });

  // Two editor tabs in one project are two different folders of it, and the
  // tab strip is the only place that difference is visible.
  it("names the editor root in the title, and remembers it on the tab", () => {
    host.open("acme", "http://127.0.0.1:9001", "editor", "portal-vue");

    expect(host.state().tabs[0]?.title).toBe("acme — Editor · portal-vue");
    expect(host.state().tabs[0]?.detail).toBe("portal-vue");
  });

  it("leaves the title alone when no detail is given", () => {
    host.open("acme", "http://127.0.0.1:9001", "editor");

    expect(host.state().tabs[0]?.detail).toBeUndefined();
  });

  it("ignores page-title-updated for an editor tab titled by its root", () => {
    host.open("acme", "http://127.0.0.1:9001", "editor", "portal-vue");

    views[0]?.emit({ kind: "title", title: "Welcome - code-server" });

    expect(host.state().tabs[0]?.title).toBe("acme — Editor · portal-vue");
  });

  it("ignores page-title-updated for an editor tab", () => {
    host.open("acme", "http://127.0.0.1:9001", "editor");

    views[0]?.emit({ kind: "title", title: "Welcome - code-server" });

    expect(host.state().tabs[0]?.title).toBe("acme — Editor");
  });

  it("gives a cluster tab a stable title naming its project", () => {
    host.open("platform", "http://127.0.0.1:5000/c/ctx-a", "cluster");

    expect(host.state().tabs[0]?.title).toBe("platform — Cluster");
  });

  it("names the cluster in the title, and remembers it on the tab", () => {
    host.open("platform", "http://127.0.0.1:5000/c/ctx-a", "cluster", "dev");

    expect(host.state().tabs[0]?.title).toBe("platform — Cluster · dev");
    expect(host.state().tabs[0]?.detail).toBe("dev");
  });

  // Slack and Teams both rewrite document.title with the active channel
  // and an unread count — "(3) general | acme | Slack" — which is
  // exactly the churn a hosted app's fixed label exists to keep out of the
  // tab strip.
  it("names the chat in the title, and never lets the page overwrite it", () => {
    host.open("acme", "https://acme.slack.com/", "chat", "Acme");

    views[0]?.emit({ kind: "title", title: "(3) general | acme | Slack" });

    expect(host.state().tabs[0]?.title).toBe("acme — Chat · Acme");
    expect(host.state().tabs[0]?.detail).toBe("Acme");
  });

  it("still applies page-title-updated for an ordinary web tab", () => {
    host.open("acme", "one.example");

    views[0]?.emit({ kind: "title", title: "One" });

    expect(host.state().tabs[0]?.title).toBe("One");
  });

  // DbGate retitles itself with whatever table or query tab has focus, so
  // a database tab needs the same fixed label an editor tab gets.
  it("gives a database tab a stable title naming its project", () => {
    host.open("acme", "http://127.0.0.1:51234", "database");

    expect(host.state().tabs[0]?.title).toBe("acme — Database");
  });

  it("ignores page-title-updated for a database tab", () => {
    host.open("acme", "http://127.0.0.1:51234", "database");

    views[0]?.emit({ kind: "title", title: "orders — DbGate" });

    expect(host.state().tabs[0]?.title).toBe("acme — Database");
  });
});

// The personal browser is a project key with no directory behind it (see
// personal.ts). To the host it is simply a project: nothing here knows the
// difference, and these pin that.
// A Chromium renderer is 80-150 MB and MAX_TABS only fires when a ninth tab
// is opened, so eight tabs opened across a morning were held all day for the
// one being read. These cover what reclaims the other seven, and — far more
// important — what brings them back.
describe("Workspace idle suspension", () => {
  let views: FakeView[];
  let now: number;

  const hostWith = (options: {
    suspendAfterMs?: number;
    resumeUrl?: (tab: WorkspaceTab) => Promise<string | undefined>;
  }): ComposedWorkspace => {
    views = [];
    return composeWorkspace(
      () => {
        const view = new FakeView();
        views.push(view);
        return view;
      },
      { suspendAfterMs: 1000, now: () => now, ...options },
    );
  };

  beforeEach(() => {
    now = 0;
  });

  // Reclaiming the tab destroys its DevTools with it — an undocked DevTools
  // window vanishing a quarter of an hour after switching tabs.
  it("never suspends a tab whose DevTools are open, until they close", () => {
    const host = hostWith({});
    host.setVisible(true);
    host.open("p", "https://one.example");
    const first = host.state().tabs[0]?.id ?? "";
    host.setDevTools(first, true);
    host.open("p", "https://two.example");

    now = 5000;
    host.sweepIdle();
    expect(views[0]?.destroyed).toBe(false);

    views[0]?.emit({ kind: "devtoolsClosed" });
    host.sweepIdle();
    expect(views[0]?.destroyed).toBe(true);
  });

  it("suspends a hidden tab once it has been idle, and never the active one", () => {
    const host = hostWith({});
    host.setVisible(true);
    host.open("p", "https://one.example");
    host.open("p", "https://two.example");

    now = 5000;
    host.sweepIdle();

    expect(views[0]?.destroyed).toBe(true);
    expect(views[1]?.destroyed).toBe(false);

    const tabs = host.state().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.suspended).toBe(true);
    expect(tabs[0]?.url).toBe("https://one.example");
    expect(tabs[1]?.suspended).toBe(false);
  });

  // The tab you left playing on purpose is the last one you meant to reclaim,
  // and suspending it stops the sound.
  it("does not suspend a tab that is playing video", async () => {
    const host = hostWith({});
    host.setVisible(true);
    host.open("p", "https://video.example");
    host.open("p", "https://other.example");

    // Chromium's media event only prompts the question; the page answers it.
    views[0]!.videoPlaying = true;
    views[0]?.emit({ kind: "media", playing: true });
    await Promise.resolve();
    await Promise.resolve();
    expect(host.state().tabs[0]?.hasPlayingVideo).toBe(true);

    now = 5000;
    host.sweepIdle();

    expect(views[0]?.destroyed).toBe(false);
    expect(host.state().tabs[0]?.suspended).toBe(false);
  });

  it("suspends nothing when suspendAfterMs is 0", () => {
    const host = hostWith({ suspendAfterMs: 0 });
    host.setVisible(true);
    host.open("p", "https://one.example");
    host.open("p", "https://two.example");

    now = 10_000_000;
    host.sweepIdle();

    expect(views[0]?.destroyed).toBe(false);
  });

  // The idle clock is "hidden for this long", not "opened this long ago".
  it("restarts the clock when a tab is looked at again", () => {
    const host = hostWith({});
    host.setVisible(true);
    host.open("p", "https://one.example");
    host.open("p", "https://two.example");
    const first = host.state().tabs[0]!.id;

    now = 900;
    host.activate(first); // one is visible again, two starts its clock
    now = 1500;
    host.sweepIdle();

    expect(views[0]?.destroyed).toBe(false);
    expect(views[1]?.destroyed).toBe(false);
  });

  it("rebuilds the view at the same URL when a suspended tab is activated", async () => {
    const host = hostWith({});
    host.setVisible(true);
    host.open("p", "https://one.example");
    host.open("p", "https://two.example");
    const first = host.state().tabs[0]!.id;

    now = 5000;
    host.sweepIdle();
    host.activate(first);
    await Promise.resolve();
    await Promise.resolve();

    expect(views).toHaveLength(3);
    expect(views[2]?.loaded).toEqual(["https://one.example"]);
    expect(views[2]?.visible).toBe(true);
    expect(host.state().tabs[0]?.suspended).toBe(false);
  });

  // The failure this exists to prevent: a code-server stopped underneath a
  // suspended tab comes back on a different free port, and reloading the
  // stored URL would land on nothing.
  it("asks resumeUrl for a hosted app's URL, since its sidecar may have moved", async () => {
    const host = hostWith({
      resumeUrl: async (tab) =>
        tab.kind === "editor" ? "http://127.0.0.1:9999/?folder=%2Fp" : undefined,
    });
    host.setVisible(true);
    host.open("p", "http://127.0.0.1:1111/?folder=%2Fp", "editor");
    host.open("p", "https://other.example");
    const editor = host.state().tabs[0]!.id;

    now = 5000;
    host.sweepIdle();
    host.activate(editor);
    await Promise.resolve();
    await Promise.resolve();

    expect(views[2]?.loaded).toEqual(["http://127.0.0.1:9999/?folder=%2Fp"]);
    expect(host.state().tabs[0]?.url).toBe("http://127.0.0.1:9999/?folder=%2Fp");
  });

  // A sidecar that refuses to restart must not leave a tab that does nothing
  // when clicked.
  it("falls back to the stored URL when resumeUrl fails", async () => {
    const host = hostWith({
      resumeUrl: async () => {
        throw new Error("code-server did not become ready");
      },
    });
    host.setVisible(true);
    host.open("p", "http://127.0.0.1:1111/?folder=%2Fp", "editor");
    host.open("p", "https://other.example");
    const editor = host.state().tabs[0]!.id;

    now = 5000;
    host.sweepIdle();
    host.activate(editor);
    await Promise.resolve();
    await Promise.resolve();

    expect(views[2]?.loaded).toEqual(["http://127.0.0.1:1111/?folder=%2Fp"]);
    expect(host.state().tabs[0]?.suspended).toBe(false);
  });

  // Two clicks while a slow sidecar starts must not leave a leaked view
  // floating over the window with nothing tracking it.
  it("builds one view when a suspended tab is activated twice in a row", async () => {
    const host = hostWith({ resumeUrl: async () => undefined });
    host.setVisible(true);
    host.open("p", "https://one.example");
    host.open("p", "https://two.example");
    const first = host.state().tabs[0]!.id;

    now = 5000;
    host.sweepIdle();
    host.activate(first);
    host.activate(first);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(views).toHaveLength(3);
  });

  it("builds nothing for a tab closed while its sidecar was starting", async () => {
    const host = hostWith({ resumeUrl: async () => undefined });
    host.setVisible(true);
    host.open("p", "https://one.example");
    host.open("p", "https://two.example");
    const first = host.state().tabs[0]!.id;

    now = 5000;
    host.sweepIdle();
    host.activate(first);
    host.close(first);
    await Promise.resolve();
    await Promise.resolve();

    expect(views).toHaveLength(2);
    expect(host.state().tabs).toHaveLength(1);
  });

  // A suspended tab holds no renderer, so it is not what the cap is for and
  // evicting it would free nothing while closing a tab the user still has.
  it("leaves suspended tabs out of the view cap", () => {
    views = [];
    const host = composeWorkspace(
      () => {
        const view = new FakeView();
        views.push(view);
        return view;
      },
      { suspendAfterMs: 1000, now: () => now, maxTabs: 2 },
    );
    host.setVisible(true);
    host.open("p", "https://one.example");
    host.open("p", "https://two.example");

    now = 5000;
    host.sweepIdle(); // one is suspended; only two holds a view
    host.open("p", "https://three.example");

    // Three tabs, two views: the suspended one was not closed to make room.
    expect(host.state().tabs).toHaveLength(3);
    expect(host.state().tabs[0]?.suspended).toBe(true);
  });
});

describe("Workspace and the personal pseudo-project", () => {
  let views: FakeView[];
  let partitions: string[];

  const hostWith = (maxTabs: number): ComposedWorkspace => {
    views = [];
    partitions = [];
    return composeWorkspace(
      (partition) => {
        partitions.push(partition);
        const view = new FakeView();
        views.push(view);
        return view;
      },
      { maxTabs },
    );
  };

  // A personal browser holds the user's own signed-in accounts. Its jar is
  // its own so that a page opened by a work project cannot ride them — and
  // it falls out of the existing per-project rule rather than being a
  // special case.
  it("gives it a cookie jar of its own, shared with no project", () => {
    const host = hostWith(8);
    host.open("__personal__", "youtube.com");
    host.open("acme", "youtube.com");

    expect(partitions).toEqual(["persist:project-__personal__", "persist:project-acme"]);
  });

  // The tab cap bounds Chromium renderer processes, and a personal tab is
  // one. Exempting it would let a long personal session defeat the cap, so
  // it evicts on the same least-recently-active rule as everything else.
  it("counts its tabs against the tab cap like any other", () => {
    const host = hostWith(2);
    host.open("__personal__", "one.com");
    host.open("acme", "two.com");
    host.open("acme", "three.com");

    expect(host.state().tabs.map((t) => t.project)).toEqual(["acme", "acme"]);
    expect(views[0]?.destroyed).toBe(true);
  });
});

// The "play popup": Chromium's own Picture-in-Picture window, which floats
// above every application. The host's job is to know which tabs may offer
// it and to route the request; the window itself is Chromium's.
describe("Workspace picture-in-picture", () => {
  let views: FakeView[];
  let host: ComposedWorkspace;

  beforeEach(() => {
    views = [];
    host = composeWorkspace(() => {
      const view = new FakeView();
      views.push(view);
      return view;
    });
  });

  // Chromium's media-started-playing fires for audio too, and for a <video>
  // that has not decoded a frame. The button must not appear for either, so
  // the event is only a prompt to ask the page — the page's answer decides.
  it("asks the page whether a video is really playing before flagging the tab", async () => {
    host.open("acme", "example.com");
    const view = views[0];
    if (view === undefined) throw new Error("no view");
    view.videoPlaying = true;

    view.emit({ kind: "media", playing: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(view.probes).toBe(1);
    expect(host.state().tabs[0]?.hasPlayingVideo).toBe(true);
  });

  // The renderer draws its chrome from this flag, so it is the whole of
  // Jarvis's side of full screen: Chromium owns the page, we own the layout.
  it("records a page taking full screen, and giving it back", () => {
    host.open("acme", "example.com");
    const view = views[0];
    if (view === undefined) throw new Error("no view");

    view.emit({ kind: "fullscreen", fullscreen: true });
    expect(host.state().tabs[0]?.pageFullscreen).toBe(true);

    view.emit({ kind: "fullscreen", fullscreen: false });
    expect(host.state().tabs[0]?.pageFullscreen).toBe(false);
  });

  it("leaves the flag off when the page says it is only audio", async () => {
    host.open("acme", "example.com");
    const view = views[0];
    if (view === undefined) throw new Error("no view");
    view.videoPlaying = false;

    view.emit({ kind: "media", playing: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(host.state().tabs[0]?.hasPlayingVideo).toBe(false);
  });

  // Nothing is playing, so there is nothing to ask about — and asking would
  // race the page into saying "yes" about media it has just stopped.
  it("clears the flag without asking the page when media stops", async () => {
    host.open("acme", "example.com");
    const view = views[0];
    if (view === undefined) throw new Error("no view");
    view.videoPlaying = true;
    view.emit({ kind: "media", playing: true });
    await Promise.resolve();
    await Promise.resolve();

    view.emit({ kind: "media", playing: false });

    expect(view.probes).toBe(1);
    expect(host.state().tabs[0]?.hasPlayingVideo).toBe(false);
  });

  // A page that navigates away takes its video with it; a flag left set
  // would leave the button offering to float a page that is gone.
  it("clears the flag on navigation", async () => {
    host.open("acme", "example.com");
    const view = views[0];
    if (view === undefined) throw new Error("no view");
    view.videoPlaying = true;
    view.emit({ kind: "media", playing: true });
    await Promise.resolve();
    await Promise.resolve();

    view.emit({
      kind: "navigated",
      url: "https://example.com/next",
      canGoBack: true,
      canGoForward: false,
    });

    expect(host.state().tabs[0]?.hasPlayingVideo).toBe(false);
  });

  it("routes a picture-in-picture request to that tab's view alone", () => {
    host.open("acme", "example.com");
    host.open("acme", "other.com");
    const first = host.state().tabs[0];
    if (first === undefined) throw new Error("no tab");

    host.requestPictureInPicture(first.id);

    expect(views[0]?.pipRequests).toBe(1);
    expect(views[1]?.pipRequests).toBe(0);
  });

  // A terminal or API tab has no view at all; so does a tab id that was
  // closed a moment ago. Neither may throw out of an IPC handler.
  it("ignores a request for a tab with no view", () => {
    expect(() => host.requestPictureInPicture("tab-does-not-exist")).not.toThrow();
  });
});

describe("Workspace favicons", () => {
  let views: FakeView[];
  let cached: { pageUrl: string; iconUrl: string; session: Session }[];
  let host: ComposedWorkspace;

  beforeEach(() => {
    views = [];
    cached = [];
    host = composeWorkspace(
      () => {
        const view = new FakeView();
        views.push(view);
        return view;
      },
      {
        cacheFavicon: async (pageUrl, iconUrl, from) => {
          cached.push({ pageUrl, iconUrl, session: from });
        },
      },
    );
  });

  it("caches the favicon Chromium resolved, through that view's own session", () => {
    const fakeSession = { id: "a.test-session" } as unknown as Session;
    host.open("acme", "https://a.test/page");

    views[0]?.emit({
      kind: "favicon",
      pageUrl: "https://a.test/page",
      iconUrl: "https://a.test/icon.png",
      session: fakeSession,
    });

    expect(cached).toEqual([
      { pageUrl: "https://a.test/page", iconUrl: "https://a.test/icon.png", session: fakeSession },
    ]);
  });
});

describe("Workspace terminal tabs", () => {
  let views: FakeView[];
  let host: ComposedWorkspace;

  beforeEach(() => {
    views = [];
    host = composeWorkspace(() => {
      const view = new FakeView();
      views.push(view);
      return view;
    });
    host.setVisible(true);
  });

  it("opens a terminal tab with no hosted view behind it", () => {
    host.openTerminal("acme");

    expect(host.state().tabs).toHaveLength(1);
    expect(host.state().tabs[0]?.kind).toBe("terminal");
    expect(views).toHaveLength(0);
  });

  it("gives a terminal tab a stable title naming its project", () => {
    host.openTerminal("acme");

    expect(host.state().tabs[0]?.title).toBe("acme — Terminal");
  });

  // The AWS login tab is the one terminal Jarvis opens for a purpose of its
  // own. The mark stays on the tab because the renderer draws that terminal
  // without blocks — one command, run once — and it rides in the title so
  // the tab strip says which terminal this is.
  it("marks and names a terminal opened for a purpose of Jarvis's own", () => {
    host.openTerminal("acme", "AWS login");

    expect(host.state().tabs[0]?.detail).toBe("AWS login");
    expect(host.state().tabs[0]?.title).toBe("acme — Terminal · AWS login");
  });

  it("makes the new terminal the active tab", () => {
    host.openTerminal("acme");

    expect(host.state().activeTabId).toBe(host.state().tabs[0]?.id);
  });

  // The terminal is drawn in the renderer's own DOM, so every hosted page
  // has to get out of the way — otherwise a native view floats over it.
  it("hides every hosted page while a terminal tab is active", () => {
    host.open("acme", "https://github.com");
    expect(views[0]?.visible).toBe(true);

    host.openTerminal("acme");

    expect(views[0]?.visible).toBe(false);
  });

  it("shows the page again when a web tab is reactivated", () => {
    host.open("acme", "https://github.com");
    const webTabId = host.state().tabs[0]!.id;
    host.openTerminal("acme");

    host.activate(webTabId);

    expect(views[0]?.visible).toBe(true);
  });

  it("closes a terminal tab without touching any view", () => {
    host.open("acme", "https://github.com");
    host.openTerminal("acme");
    const terminalId = host.state().tabs[1]!.id;

    host.close(terminalId);

    expect(host.state().tabs).toHaveLength(1);
    expect(views[0]?.destroyed).toBe(false);
  });

  // Eviction exists to cap Chromium renderer processes. A terminal tab is
  // not one, and closing it here would drop its tab without reaping the
  // shell behind it — main only kills a shell on the close handler.
  it("never evicts a terminal tab to make room for a page", () => {
    const small = composeWorkspace(
      () => {
        const view = new FakeView();
        views.push(view);
        return view;
      },
      { maxTabs: 2 },
    );
    small.openTerminal("acme");
    small.open("acme", "https://one.test");
    small.open("acme", "https://two.test");

    small.open("acme", "https://three.test");

    const kinds = small.state().tabs.map((tab) => tab.kind);
    expect(kinds).toContain("terminal");
    expect(kinds.filter((kind) => kind === "web")).toHaveLength(2);
  });

  it("opens an api tab with no hosted view, titled for its project", () => {
    host.openApi("acme");

    expect(host.state().tabs[0]?.kind).toBe("api");
    expect(host.state().tabs[0]?.title).toBe("acme — API");
    expect(views).toHaveLength(0);
  });

  it("hides every hosted page while an api tab is active", () => {
    host.open("acme", "https://github.com");
    host.openApi("acme");

    expect(views[0]?.visible).toBe(false);
  });

  it("labels a docker tab Docker", () => {
    host.openDocker("acme");

    const opened = host.state().tabs.filter((tab) => tab.kind === "docker");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.project).toBe("acme");
    expect(opened[0]?.title).toBe("acme — Docker");
  });

  it("opens a docker tab without a hosted view", () => {
    host.openDocker("acme");

    expect(host.state().tabs[0]?.url).toBe("");
    expect(views).toHaveLength(0);
  });

  // The OAuth2 authorization-code dance: the provider sends the user back to
  // a callback carrying ?code=, and the app already has a browser to catch it.
  it("resolves with the redirect that carries the code, and closes the tab", async () => {
    const pending = host.openForResult("acme", "https://auth.test/authorize", "https://cb.test/");
    expect(host.state().tabs).toHaveLength(1);

    views[0]?.emit({
      kind: "navigated",
      url: "https://auth.test/login",
      canGoBack: false,
      canGoForward: false,
    });
    views[0]?.emit({
      kind: "navigated",
      url: "https://cb.test/?code=abc",
      canGoBack: true,
      canGoForward: false,
    });

    await expect(pending).resolves.toBe("https://cb.test/?code=abc");
    expect(host.state().tabs).toHaveLength(0);
    expect(views[0]?.destroyed).toBe(true);
  });

  it("waits for a redirect that matches, not merely any navigation", async () => {
    let settled = false;
    void host.openForResult("acme", "https://auth.test/a", "https://cb.test/").then(() => {
      settled = true;
    });

    views[0]?.emit({
      kind: "navigated",
      url: "https://auth.test/consent",
      canGoBack: false,
      canGoForward: false,
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(host.state().tabs).toHaveLength(1);
  });

  // With no callback URL configured, any redirect carrying a code or an
  // error is the answer — the honest default rather than waiting forever.
  it("accepts any code-bearing redirect when no prefix was given", async () => {
    const pending = host.openForResult("acme", "https://auth.test/a");

    views[0]?.emit({
      kind: "navigated",
      url: "http://localhost:9/cb?code=xyz",
      canGoBack: false,
      canGoForward: false,
    });

    await expect(pending).resolves.toContain("code=xyz");
  });

  it("rejects a URL that is not one", async () => {
    await expect(host.openForResult("acme", "not a url")).rejects.toThrow();
  });

  it("ignores navigation controls aimed at a terminal tab", () => {
    host.openTerminal("acme");
    const id = host.state().tabs[0]!.id;

    host.back(id);
    host.forward(id);
    host.reload(id);
    host.navigate(id, "https://github.com");

    expect(host.state().tabs[0]?.url).toBe("");
  });
});
