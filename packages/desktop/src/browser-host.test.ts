import { beforeEach, describe, expect, it } from "vitest";
import { BrowserHost, type HostedView, type HostedViewEvent, type Rect } from "./browser-host.js";

class FakeView implements HostedView {
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
  onEvent(listener: (event: HostedViewEvent) => void): void {
    this.#listeners.push(listener);
  }
  emit(event: HostedViewEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}

describe("BrowserHost", () => {
  let views: FakeView[];
  let partitions: string[];
  let host: BrowserHost;

  beforeEach(() => {
    views = [];
    partitions = [];
    host = new BrowserHost((partition) => {
      partitions.push(partition);
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

  it("shows only the active tab's view", () => {
    host.open("acme", "one.example");
    host.open("acme", "two.example");
    host.setVisible(true);

    expect(views[0]?.visible).toBe(false);
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
    const capped = new BrowserHost(
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
});
