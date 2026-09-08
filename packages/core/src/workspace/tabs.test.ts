import { describe, expect, it } from "vitest";
import { TabStore } from "./tabs.js";

function store(): TabStore {
  let n = 0;
  return new TabStore({ nextId: () => `tab-${++n}` });
}

describe("TabStore", () => {
  it("starts empty with nothing active", () => {
    expect(store().snapshot()).toEqual({ tabs: [], activeTabId: undefined });
  });

  it("opens a tab and makes it active", () => {
    const tabs = store();
    const tab = tabs.open("acme", "https://example.com");

    expect(tab.id).toBe("tab-1");
    expect(tabs.snapshot()).toEqual({
      tabs: [
        {
          id: "tab-1",
          project: "acme",
          url: "https://example.com",
          kind: "web",
          title: "",
          loading: true,
          canGoBack: false,
          canGoForward: false,
          error: undefined,
          hasPlayingVideo: false,
          pageFullscreen: false,
          suspended: false,
        },
      ],
      activeTabId: "tab-1",
    });
  });

  // Drives the Picture-in-Picture button, which must not be offered on a
  // page with nothing to float. A tab starts with nothing playing: the
  // page has not even loaded yet.
  it("opens a tab with no video playing", () => {
    expect(store().open("acme", "https://example.com").hasPlayingVideo).toBe(false);
  });

  it("defaults a tab's kind to web", () => {
    const tabs = store();
    const tab = tabs.open("acme", "https://example.com");

    expect(tab.kind).toBe("web");
  });

  it("opens a tab with an explicit kind", () => {
    const tabs = store();
    const tab = tabs.open("acme", "http://127.0.0.1:9001", "editor");

    expect(tab.kind).toBe("editor");
  });

  it("keeps tabs in the order they were opened", () => {
    const tabs = store();
    tabs.open("a", "https://one.example");
    tabs.open("b", "https://two.example");

    expect(tabs.snapshot().tabs.map((tab) => tab.url)).toEqual([
      "https://one.example",
      "https://two.example",
    ]);
  });

  it("applies a patch to one tab only", () => {
    const tabs = store();
    tabs.open("a", "https://one.example");
    tabs.open("b", "https://two.example");

    tabs.update("tab-1", { title: "One", loading: false });

    expect(tabs.get("tab-1")?.title).toBe("One");
    expect(tabs.get("tab-1")?.loading).toBe(false);
    expect(tabs.get("tab-2")?.title).toBe("");
  });

  it("ignores a patch for an unknown tab rather than throwing", () => {
    const tabs = store();
    expect(() => tabs.update("no-such-tab", { title: "x" })).not.toThrow();
  });

  // Closing the active tab must leave *something* active, or the view goes
  // blank with tabs still on screen.
  it("activates the left neighbour when the active tab closes", () => {
    const tabs = store();
    tabs.open("a", "https://one.example");
    tabs.open("b", "https://two.example");
    tabs.open("c", "https://three.example");
    tabs.activate("tab-2");

    tabs.close("tab-2");

    expect(tabs.snapshot().activeTabId).toBe("tab-1");
  });

  it("activates the right neighbour when the first tab closes", () => {
    const tabs = store();
    tabs.open("a", "https://one.example");
    tabs.open("b", "https://two.example");
    tabs.activate("tab-1");

    tabs.close("tab-1");

    expect(tabs.snapshot().activeTabId).toBe("tab-2");
  });

  it("leaves nothing active when the last tab closes", () => {
    const tabs = store();
    tabs.open("a", "https://one.example");

    tabs.close("tab-1");

    expect(tabs.snapshot()).toEqual({ tabs: [], activeTabId: undefined });
  });

  it("does not change the active tab when an inactive one closes", () => {
    const tabs = store();
    tabs.open("a", "https://one.example");
    tabs.open("b", "https://two.example");

    tabs.close("tab-1");

    expect(tabs.snapshot().activeTabId).toBe("tab-2");
  });

  it("reports least-recently-active first", () => {
    const tabs = store();
    tabs.open("a", "https://one.example");
    tabs.open("b", "https://two.example");
    tabs.open("c", "https://three.example");
    tabs.activate("tab-1");

    expect(tabs.leastRecentlyActive()).toEqual(["tab-2", "tab-3", "tab-1"]);
  });

  it("drops a closed tab from the activity order", () => {
    const tabs = store();
    tabs.open("a", "https://one.example");
    tabs.open("b", "https://two.example");
    tabs.close("tab-1");

    expect(tabs.leastRecentlyActive()).toEqual(["tab-2"]);
  });

  it("notifies subscribers on open, update, activate and close", () => {
    const tabs = store();
    const seen: number[] = [];
    tabs.onChange((state) => seen.push(state.tabs.length));

    tabs.open("a", "https://one.example");
    tabs.update("tab-1", { title: "One" });
    tabs.open("b", "https://two.example");
    tabs.activate("tab-1");
    tabs.close("tab-1");

    expect(seen).toEqual([1, 1, 2, 2, 1]);
  });

  it("stops notifying after unsubscribe", () => {
    const tabs = store();
    let calls = 0;
    const off = tabs.onChange(() => calls++);
    tabs.open("a", "https://one.example");
    off();
    tabs.open("b", "https://two.example");

    expect(calls).toBe(1);
  });

  it("opens a tab unsuspended, and lets a patch suspend it", () => {
    const tabs = store();
    const tab = tabs.open("acme", "https://example.com");
    expect(tab.suspended).toBe(false);

    tabs.update(tab.id, { suspended: true });
    expect(tabs.snapshot().tabs[0]?.suspended).toBe(true);
  });

  // Same isolation rule ProviderStatusStore and ChangeTracker apply.
  it("keeps notifying the other subscribers when one throws", () => {
    const tabs = store();
    let reached = false;
    tabs.onChange(() => {
      throw new Error("boom");
    });
    tabs.onChange(() => {
      reached = true;
    });

    tabs.open("a", "https://one.example");

    expect(reached).toBe(true);
  });
});
