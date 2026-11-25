// @vitest-environment jsdom
//
// The pop-out page: a minimal second renderer that draws ONE terminal tab in
// a window of its own. What is under test is its contract with the host (what
// it asks for, what it hands back, what it must never call) and, as source,
// that it starts none of the main app's services.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "@jarvis/core";
import { plainTerminalState, type PopoutTerminalState } from "../src/popout-state.js";
import { startPopout } from "./popout.js";

const SPLIT: PopoutTerminalState = {
  shape: { direction: "row", first: { key: "t1" }, second: { key: "t1:p1" } },
  drafts: { "t1:p1": "git sta" },
  focused: "t1:p1",
};

function tab(overrides: Partial<WorkspaceTab> = {}): WorkspaceTab {
  return {
    id: "t1",
    project: "acme",
    url: "",
    kind: "terminal",
    title: "acme — Terminal",
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

/** The methods a pop-out may call. Anything else on the object throws: the
 *  page must never activate a tab, place a hosted view or show the Workspace. */
function strictApi(overrides: Record<string, unknown> = {}) {
  let handover: (tabId: string) => void = () => {};
  let focusPane: (paneKey: string) => void = () => {};
  let onWorkspace: (state: unknown) => void = () => {};
  const allowed = {
    popoutTabId: "t1",
    popoutReady: vi.fn(async () => ({ tabId: "t1", state: SPLIT })),
    popoutReportState: vi.fn(async () => undefined),
    popoutHandedOver: vi.fn(async () => undefined),
    popoutReturn: vi.fn(async () => true),
    workspaceSnapshot: vi.fn(async () => ({ tabs: [tab(), tab({ id: "t2" })], activeTabId: "t2" })),
    onWorkspace: vi.fn((cb: (state: unknown) => void) => {
      onWorkspace = cb;
    }),
    onPopoutHandover: vi.fn((cb: (tabId: string) => void) => {
      handover = cb;
      return () => {};
    }),
    onPopoutFocusPane: vi.fn((cb: (paneKey: string) => void) => {
      focusPane = cb;
      return () => {};
    }),
    ...overrides,
  };
  const api = new Proxy(allowed, {
    get(target, name) {
      if (name in target) return (target as Record<string | symbol, unknown>)[name];
      if (typeof name === "symbol" || name === "then") return undefined;
      throw new Error(`a pop-out called window.jarvis.${name}`);
    },
  });
  return {
    api: api as never,
    allowed,
    handover: (id: string) => handover(id),
    focusPane: (key: string) => focusPane(key),
    workspace: (state: unknown) => onWorkspace(state),
  };
}

function terminals() {
  let current: PopoutTerminalState = SPLIT;
  return {
    init: vi.fn(),
    render: vi.fn(),
    carry: vi.fn(() => current),
    stage: vi.fn(),
    focusLeaf: vi.fn(),
    set: (state: PopoutTerminalState) => {
      current = state;
    },
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("the pop-out page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks the host what it starts from, stages the carried layout, then draws only its own tab", async () => {
    const t = terminals();
    const h = strictApi();
    await startPopout(h.api, t);
    expect(t.init).toHaveBeenCalledTimes(1);
    expect(t.stage).toHaveBeenCalledWith("t1", SPLIT);
    expect(t.render).toHaveBeenCalledTimes(1);
    const [tabs, active, project] = t.render.mock.calls[0] ?? [];
    expect((tabs as WorkspaceTab[]).map((entry) => entry.id)).toEqual(["t1"]);
    expect(active).toBe("t1");
    expect(project).toBe("acme");
    // Staged before drawn: the pane is built from the carried layout.
    expect(t.stage.mock.invocationCallOrder[0]).toBeLessThan(
      t.render.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("stages nothing for a plain tab, and does nothing at all without a tab id or a host that knows it", async () => {
    const t = terminals();
    await startPopout(
      strictApi({
        popoutReady: vi.fn(async () => ({ tabId: "t1", state: plainTerminalState("t1") })),
      }).api,
      t,
    );
    expect(t.stage).not.toHaveBeenCalled();
    expect(t.render).toHaveBeenCalledTimes(1);

    const none = terminals();
    await startPopout(strictApi({ popoutTabId: undefined }).api, none);
    await startPopout(strictApi({ popoutReady: vi.fn(async () => undefined) }).api, none);
    await startPopout(strictApi({ popoutReady: vi.fn(async () => ({ tabId: "t9" })) }).api, none);
    expect(none.init).not.toHaveBeenCalled();
    expect(none.render).not.toHaveBeenCalled();
  });

  it("answers the host's request for its layout and drafts with what its panes hold now", async () => {
    const t = terminals();
    const h = strictApi();
    await startPopout(h.api, t);
    const now: PopoutTerminalState = { ...SPLIT, drafts: { t1: "ls -la" } };
    t.set(now);
    h.handover("t1");
    expect(h.allowed.popoutHandedOver).toHaveBeenCalledWith("t1", now);
    h.handover("t2");
    expect(h.allowed.popoutHandedOver).toHaveBeenCalledTimes(1);
  });

  it("reports a change of layout or drafts, once, and nothing while it is unchanged", async () => {
    const t = terminals();
    const h = strictApi();
    await startPopout(h.api, t);
    vi.advanceTimersByTime(5000);
    expect(h.allowed.popoutReportState).not.toHaveBeenCalled();
    t.set({ ...SPLIT, drafts: { t1: "x" } });
    vi.advanceTimersByTime(1000);
    expect(h.allowed.popoutReportState).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(h.allowed.popoutReportState).toHaveBeenCalledTimes(1);
  });

  it("reports one last time as the page goes away, so a reload keeps typed text", async () => {
    const t = terminals();
    const h = strictApi();
    await startPopout(h.api, t);
    t.set({ ...SPLIT, drafts: { t1: "unsent" } });
    window.dispatchEvent(new Event("pagehide"));
    expect(h.allowed.popoutReportState).toHaveBeenLastCalledWith({
      ...SPLIT,
      drafts: { t1: "unsent" },
    });
  });

  it("leaves no timer and no listener behind once the page has gone", async () => {
    const t = terminals();
    const h = strictApi();
    await startPopout(h.api, t);
    expect(vi.getTimerCount()).toBe(1);
    window.dispatchEvent(new Event("pagehide"));
    expect(vi.getTimerCount()).toBe(0);
    const before = h.allowed.popoutReportState.mock.calls.length;
    t.set({ ...SPLIT, drafts: { t1: "later" } });
    window.dispatchEvent(new Event("pagehide"));
    expect(h.allowed.popoutReportState.mock.calls.length).toBe(before);
  });

  it("focuses the pane the host names, and follows its tab's own updates", async () => {
    const t = terminals();
    const h = strictApi();
    await startPopout(h.api, t);
    h.focusPane("t1:p1");
    expect(t.focusLeaf).toHaveBeenCalledWith("t1:p1");
    h.workspace({ tabs: [tab({ customTitle: "Renamed" }), tab({ id: "t2" })], activeTabId: "t2" });
    expect(t.render).toHaveBeenCalledTimes(2);
    expect(
      ((t.render.mock.calls[1]?.[0] ?? []) as WorkspaceTab[]).map((entry) => entry.id),
    ).toEqual(["t1"]);
    // Its tab gone: nothing is drawn (the host is closing the window).
    h.workspace({ tabs: [tab({ id: "t2" })], activeTabId: "t2" });
    expect(t.render).toHaveBeenCalledTimes(2);
  });

  it("never calls what would move the main window's view: activate, bounds, visibility, hide", async () => {
    const t = terminals();
    const h = strictApi();
    await startPopout(h.api, t);
    h.workspace({ tabs: [tab()], activeTabId: "t1" });
    vi.advanceTimersByTime(3000);
    await flush();
    // strictApi throws on any call outside its allow list; reaching here is the proof.
    expect(true).toBe(true);
  });
});

describe("what the pop-out page may import and call", () => {
  const read = (name: string) => readFileSync(`packages/desktop/renderer/${name}`, "utf8");
  const importsOf = (source: string): string[] =>
    [...source.matchAll(/^(?:import|export)\s[^;]*?from\s+"\.\/([a-z-]+)\.js"/gm)].map(
      (m) => m[1] ?? "",
    );

  it("starts none of the main app's services: nothing reachable from it is the app, the Workspace, voice, prayer, the dashboard, the updater or the Office", () => {
    const seen = new Set<string>();
    const queue = ["popout"];
    while (queue.length > 0) {
      const name = queue.pop() as string;
      if (seen.has(name)) continue;
      seen.add(name);
      queue.push(...importsOf(read(`${name}.ts`)));
    }
    const banned = [
      "app",
      "workspace",
      "views",
      "office-view",
      "office-model",
      "prayer",
      "prayer-notify",
      "update-settings",
      "settings",
      "setup",
      "session-view",
      "remote-status",
      "keep-awake",
      "machine-switcher",
      "topbar-status",
      "topbar-fit",
      "reviews-view",
      "changes",
      "daemon-settings",
      "workspace-menu",
      "workspace-docker",
      "api",
      "api-editor",
      "providers",
      "usage-charts",
    ];
    expect([...seen].filter((name) => banned.includes(name))).toEqual([]);
    expect(seen.has("workspace-terminal")).toBe(true);
  });

  it("takes the terminal font zoom chords itself: they are a window listener, and the main window's is not this one's", () => {
    expect(read("popout.ts")).toMatch(/initFontKeys\(\)/);
  });

  it("never names the calls that act on the main window's view or tab state", () => {
    const source = read("popout.ts");
    for (const call of [
      "setWorkspaceVisible",
      "hideAllTabs",
      "setWorkspaceBounds",
      "activateTab",
      "openTab",
      "closeTab",
      "moveTab",
      "officeViewing",
    ]) {
      expect(source).not.toContain(call);
    }
  });

  it("is a page of its own with the same CSP as the main one, and nothing inline", () => {
    const main = read("index.html");
    const page = read("popout.html");
    const csp = (html: string) => /Content-Security-Policy"\s+content="([^"]*)"/.exec(html)?.[1];
    expect(csp(page)).toBeDefined();
    expect(csp(page)).toBe(csp(main));
    expect(page).toMatch(/<script type="module" src="\.\.\/dist\/renderer\/popout\.js"><\/script>/);
    expect(page.match(/<script/g)).toHaveLength(1);
    expect(page).not.toMatch(/\son[a-z]+=|javascript:|<style/i);
    expect(page).toMatch(/id="workspace-terminal"/);
  });
});
