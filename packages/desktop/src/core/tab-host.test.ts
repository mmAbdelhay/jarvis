import { describe, expect, it } from "vitest";
import type { WorkspaceState, WorkspaceTab } from "@jarvis/core";
import { MAX_TABS, TabHost, hasView, type ViewRequest } from "./tab-host.js";

// TabHost is the core's half of the Workspace: tab state, and nothing that
// needs a window. Every test here runs with no view factory at all, which
// is the point — the daemon runs exactly this.

function tab(overrides: Partial<WorkspaceTab>): WorkspaceTab {
  return {
    id: "t",
    project: "acme",
    url: "https://example.com",
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

function recording(host: TabHost): { states: WorkspaceState[]; requests: ViewRequest[] } {
  const states: WorkspaceState[] = [];
  const requests: ViewRequest[] = [];
  host.onChange((state) => states.push(state));
  host.onViewRequest((request) => requests.push(request));
  return { states, requests };
}

describe("hasView", () => {
  it("is true for a page or hosted app that is not suspended", () => {
    for (const kind of ["web", "editor", "database", "cluster", "chat"] as const) {
      expect(hasView(tab({ kind })), kind).toBe(true);
    }
  });

  it("is false for the renderer-drawn kinds and for a suspended tab", () => {
    for (const kind of ["terminal", "api", "docker"] as const) {
      expect(hasView(tab({ kind })), kind).toBe(false);
    }
    expect(hasView(tab({ suspended: true }))).toBe(false);
  });
});

describe("TabHost", () => {
  it("opens a web tab at the normalised URL and makes it active", () => {
    const host = new TabHost();
    host.open("acme", "github.com");
    const { tabs, activeTabId } = host.state();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ project: "acme", url: "https://github.com", kind: "web" });
    expect(activeTabId).toBe(tabs[0]?.id);
  });

  it("refuses a rejected scheme and changes nothing", () => {
    const host = new TabHost();
    const { states, requests } = recording(host);
    host.open("acme", "javascript:alert(1)");
    expect(host.state().tabs).toEqual([]);
    expect(states).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("titles a hosted app by project and detail, and keeps the detail on the tab", () => {
    const host = new TabHost();
    host.open("acme", "http://127.0.0.1:8000", "editor", "web");
    expect(host.state().tabs[0]).toMatchObject({ title: "acme — Editor · web", detail: "web" });
  });

  it("opens a terminal with no URL, titled for its project, and returns its id", () => {
    const host = new TabHost();
    const id = host.openTerminal("acme");
    expect(host.state().tabs).toEqual([
      expect.objectContaining({ id, kind: "terminal", url: "", title: "acme — Terminal" }),
    ]);
    expect(host.state().activeTabId).toBe(id);
  });

  it("emits every change as a full snapshot", () => {
    const host = new TabHost();
    const { states } = recording(host);
    const id = host.openTerminal("acme");
    expect(states.at(-1)?.tabs.map((t) => t.id)).toEqual([id]);
    host.close(id);
    expect(states.at(-1)).toEqual({ tabs: [], activeTabId: undefined });
  });

  it("asks for a reveal on open, terminal open and activate", () => {
    const host = new TabHost();
    const { requests } = recording(host);
    host.open("acme", "github.com");
    const id = host.openTerminal("acme");
    host.activate(id);
    expect(requests).toEqual([{ kind: "reveal" }, { kind: "reveal" }, { kind: "reveal" }]);
  });

  describe("navigate", () => {
    it("records the new URL as loading and asks the view to load it", () => {
      const host = new TabHost();
      host.open("acme", "github.com");
      const id = host.state().tabs[0]!.id;
      host.reportPage(id, { kind: "failed", detail: "boom" });
      const { requests } = recording(host);
      host.navigate(id, "example.com");
      expect(host.state().tabs[0]).toMatchObject({
        url: "https://example.com",
        loading: true,
        error: undefined,
      });
      expect(requests).toEqual([{ kind: "load", id, url: "https://example.com" }]);
    });

    it("ignores a terminal tab, a suspended tab and an unknown id", () => {
      const host = new TabHost();
      const terminal = host.openTerminal("acme");
      host.open("acme", "github.com");
      const web = host.state().tabs[1]!.id;
      host.openTerminal("acme");
      host.suspend(web);
      const { states, requests } = recording(host);
      host.navigate(terminal, "example.com");
      host.navigate(web, "example.com");
      host.navigate("nope", "example.com");
      expect(states).toEqual([]);
      expect(requests).toEqual([]);
    });
  });

  describe("reportPage", () => {
    it("applies a navigation, clearing the error, video and full-screen flags", () => {
      const host = new TabHost();
      host.open("acme", "github.com");
      const id = host.state().tabs[0]!.id;
      host.reportPage(id, { kind: "failed", detail: "boom" });
      host.reportPage(id, { kind: "video", playing: true });
      host.reportPage(id, { kind: "fullscreen", fullscreen: true });
      host.reportPage(id, {
        kind: "navigated",
        url: "https://github.com/login",
        canGoBack: true,
        canGoForward: false,
      });
      expect(host.state().tabs[0]).toMatchObject({
        url: "https://github.com/login",
        canGoBack: true,
        error: undefined,
        hasPlayingVideo: false,
        pageFullscreen: false,
        loading: false,
      });
    });

    it("takes a page title for a web tab only", () => {
      const host = new TabHost();
      host.open("acme", "github.com");
      host.open("acme", "http://127.0.0.1:1", "database");
      const [web, db] = host.state().tabs.map((t) => t.id);
      host.reportPage(web!, { kind: "title", title: "GitHub" });
      host.reportPage(db!, { kind: "title", title: "DbGate - query 1" });
      expect(host.state().tabs.map((t) => t.title)).toEqual(["GitHub", "acme — Database"]);
    });

    it("tracks loading and a video starting or stopping", () => {
      const host = new TabHost();
      host.open("acme", "github.com");
      const id = host.state().tabs[0]!.id;
      host.reportPage(id, { kind: "loading", loading: false });
      host.reportPage(id, { kind: "video", playing: true });
      expect(host.state().tabs[0]).toMatchObject({ loading: false, hasPlayingVideo: true });
    });

    it("ignores a fact about a tab that has closed", () => {
      const host = new TabHost();
      host.open("acme", "github.com");
      const id = host.state().tabs[0]!.id;
      host.close(id);
      const { states } = recording(host);
      host.reportPage(id, { kind: "video", playing: true });
      expect(states).toEqual([]);
    });
  });

  describe("the view cap", () => {
    it("closes the least recently active page past the cap", () => {
      const host = new TabHost({ maxTabs: 2 });
      host.open("acme", "a.com");
      host.open("acme", "b.com");
      host.open("acme", "c.com");
      expect(host.state().tabs.map((t) => t.url)).toEqual(["https://b.com", "https://c.com"]);
    });

    it("never closes a terminal to make room, and does not count one", () => {
      const host = new TabHost({ maxTabs: 1 });
      const terminal = host.openTerminal("acme");
      host.open("acme", "a.com");
      host.open("acme", "b.com");
      expect(host.state().tabs.map((t) => t.id)).toContain(terminal);
      expect(
        host
          .state()
          .tabs.filter(hasView)
          .map((t) => t.url),
      ).toEqual(["https://b.com"]);
    });

    it("does not count a suspended tab", () => {
      const host = new TabHost({ maxTabs: 2 });
      host.open("acme", "a.com");
      const first = host.state().tabs[0]!.id;
      host.open("acme", "b.com");
      host.suspend(first);
      host.open("acme", "c.com");
      expect(host.state().tabs).toHaveLength(3);
    });

    it("defaults to eight", () => {
      expect(MAX_TABS).toBe(8);
    });
  });

  describe("suspend and resume", () => {
    it("marks a tab suspended with no history and no load in flight", () => {
      const host = new TabHost();
      host.open("acme", "a.com");
      const id = host.state().tabs[0]!.id;
      host.reportPage(id, {
        kind: "navigated",
        url: "https://a.com/x",
        canGoBack: true,
        canGoForward: true,
      });
      host.suspend(id);
      expect(host.state().tabs[0]).toMatchObject({
        suspended: true,
        loading: false,
        canGoBack: false,
        canGoForward: false,
      });
    });

    it("never suspends a terminal", () => {
      const host = new TabHost();
      const id = host.openTerminal("acme");
      host.suspend(id);
      expect(host.state().tabs[0]?.suspended).toBe(false);
    });

    it("resumes at the URL resumeUrl answers when the tab is activated", async () => {
      const host = new TabHost({ resumeUrl: async () => "http://127.0.0.1:9999/" });
      host.open("acme", "http://127.0.0.1:8000", "editor");
      const id = host.state().tabs[0]!.id;
      host.openTerminal("acme");
      host.suspend(id);
      host.activate(id);
      await Promise.resolve();
      await Promise.resolve();
      expect(host.state().tabs[0]).toMatchObject({
        suspended: false,
        url: "http://127.0.0.1:9999/",
        loading: true,
      });
    });
  });

  describe("openForResult", () => {
    it("resolves with the matching redirect and closes its tab", async () => {
      const host = new TabHost();
      const result = host.openForResult("acme", "https://auth.example.com/authorize", "http://cb/");
      const id = host.state().tabs[0]!.id;
      expect(host.state().tabs[0]).toMatchObject({ title: "acme — Authorize", kind: "web" });
      host.reportPage(id, {
        kind: "navigated",
        url: "https://auth.example.com/login",
        canGoBack: false,
        canGoForward: false,
      });
      expect(host.state().tabs).toHaveLength(1);
      host.reportPage(id, {
        kind: "navigated",
        url: "http://cb/?code=1",
        canGoBack: true,
        canGoForward: false,
      });
      await expect(result).resolves.toBe("http://cb/?code=1");
      expect(host.state().tabs).toEqual([]);
    });

    it("rejects anything that is not a URL", async () => {
      const host = new TabHost();
      await expect(host.openForResult("acme", "not a url")).rejects.toThrow();
      expect(host.state().tabs).toEqual([]);
    });
  });

  it("renames and reorders through the store", () => {
    const host = new TabHost();
    const a = host.openTerminal("acme");
    const b = host.openTerminal("acme");
    host.rename(a, "  mine ");
    host.move(b, a, false);
    expect(host.state().tabs.map((t) => [t.id, t.customTitle])).toEqual([
      [b, undefined],
      [a, "mine"],
    ]);
  });
});
