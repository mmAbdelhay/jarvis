import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  ELECTRON_BOUND_CHANNELS,
  isAllowedPlanLinkUrl,
  registerDesktopOnly,
  type DesktopOnlyDeps,
} from "./desktop-only.js";
import { CHANNEL_POLICY } from "./remote-policy.js";

describe("desktop-only registrations", () => {
  it("registers exactly the Electron-bound channels", () => {
    const handle = vi.fn();
    registerDesktopOnly({ ...fakeDesktopDeps(), handle });
    expect(new Set(handle.mock.calls.map(([channel]) => channel))).toEqual(
      new Set(ELECTRON_BOUND_CHANNELS),
    );
  });

  it("never registers a channel the policy allows remotely", () => {
    for (const channel of ELECTRON_BOUND_CHANNELS) {
      expect(CHANNEL_POLICY[channel]).toBe("desktop-only");
    }
  });

  // Task 23: the background service's channels are the host's own.
  it("routes the background channels to the host, refusing a non-boolean toggle", async () => {
    const deps = fakeDesktopDeps();
    const handle = vi.fn();
    registerDesktopOnly({ ...deps, handle });
    const listener = (channel: string) =>
      handle.mock.calls.find(([c]) => c === channel)![1] as (
        event: unknown,
        ...args: unknown[]
      ) => Promise<unknown>;

    expect(await listener("background:status")({})).toEqual({
      enabled: false,
      inApp: true,
      state: { kind: "off" },
    });
    expect(await listener("background:setEnabled")({}, "yes")).toEqual({
      ok: false,
      reason: "failed",
      detail: "enabled must be true or false",
    });
    expect(deps.background.setEnabled).not.toHaveBeenCalled();
    await listener("background:setEnabled")({}, true);
    expect(deps.background.setEnabled).toHaveBeenCalledWith(true);
    await listener("background:restart")({});
    await listener("background:stopNow")({});
    expect(deps.background.restart).toHaveBeenCalledOnce();
    expect(deps.background.stopNow).toHaveBeenCalledOnce();
  });

  it("keeps the background channels desktop-only and out of every core", () => {
    for (const channel of [
      "background:status",
      "background:setEnabled",
      "background:restart",
      "background:stopNow",
    ] as const) {
      expect(CHANNEL_POLICY[channel]).toBe("desktop-only");
      expect(ELECTRON_BOUND_CHANNELS).toContain(channel);
    }
  });

  it("dialog:pickFiles returns [] on cancel and the paths otherwise", async () => {
    const handle = vi.fn();
    const dialog = {
      showOpenDialog: vi.fn(async (..._args: unknown[]) => ({
        canceled: true,
        filePaths: ["/a"],
      })),
    };
    registerDesktopOnly({ ...fakeDesktopDeps(), handle, dialog });
    const listener = handle.mock.calls.find(([c]) => c === "dialog:pickFiles")![1];
    expect(await listener({}, { multiple: true })).toEqual([]);
    expect(dialog.showOpenDialog.mock.calls[0]![1]).toEqual({
      properties: ["openFile", "multiSelections"],
    });
  });

  // The page controls moved here from the dispatch table when the tab state
  // moved into the core (Task 18): they act on a view, which only the
  // Electron host has.
  describe("hosted-page controls", () => {
    function listenerFor(deps: DesktopOnlyDeps, channel: string) {
      const handle = vi.fn();
      registerDesktopOnly({ ...deps, handle });
      return handle.mock.calls.find(([c]) => c === channel)![1] as (
        event: unknown,
        ...args: unknown[]
      ) => unknown;
    }

    it("routes back, forward, reload and picture-in-picture by tab id, dropping a non-string id", () => {
      const deps = fakeDesktopDeps();
      for (const [channel, method] of [
        ["workspace:back", "back"],
        ["workspace:forward", "forward"],
        ["workspace:reload", "reload"],
        ["workspace:pip", "requestPictureInPicture"],
      ] as const) {
        const listener = listenerFor(deps, channel);
        listener({}, 7);
        listener({}, "tab-1");
        expect(deps.views[method], channel).toHaveBeenCalledTimes(1);
        expect(deps.views[method], channel).toHaveBeenCalledWith("tab-1");
      }
    });

    it("workspace:devtools requires a string tab and a boolean flag", () => {
      const deps = fakeDesktopDeps();
      const listener = listenerFor(deps, "workspace:devtools");
      listener({}, "t1", "yes");
      listener({}, "t1", true);
      expect(deps.views.setDevTools).toHaveBeenCalledTimes(1);
      expect(deps.views.setDevTools).toHaveBeenCalledWith("t1", true);
    });

    it("workspace:devtoolsDock takes only a real dock side", () => {
      const deps = fakeDesktopDeps();
      const listener = listenerFor(deps, "workspace:devtoolsDock");
      listener({}, "sideways");
      listener({}, "left");
      expect(deps.views.setDevToolsDock).toHaveBeenCalledTimes(1);
      expect(deps.views.setDevToolsDock).toHaveBeenCalledWith("left");
    });

    it("workspace:visible reads only the literal true, and hideAll hides", () => {
      const deps = fakeDesktopDeps();
      listenerFor(deps, "workspace:visible")({}, "true");
      listenerFor(deps, "workspace:visible")({}, true);
      listenerFor(deps, "workspace:hideAll")({});
      expect(deps.views.setVisible).toHaveBeenNthCalledWith(1, false);
      expect(deps.views.setVisible).toHaveBeenNthCalledWith(2, true);
      expect(deps.views.hideAll).toHaveBeenCalledTimes(1);
    });
  });

  // Bug 2: workspace:tabMenu pops the chip's native Rename/Reload/Close
  // menu — see tab-menu.test.ts for the template itself; this covers the
  // handler's own argument validation and wiring.
  describe("workspace:tabMenu", () => {
    function tabMenuListener(deps: ReturnType<typeof fakeDesktopDeps>) {
      const handle = vi.fn();
      registerDesktopOnly({ ...deps, handle });
      return handle.mock.calls.find(([c]) => c === "workspace:tabMenu")![1] as (
        event: unknown,
        ...args: unknown[]
      ) => unknown;
    }

    it.each([
      ["a non-string tabId", [42, 10, 10]],
      ["a non-finite x", ["tab-1", Number.NaN, 10]],
      ["a non-finite y", ["tab-1", 10, Number.POSITIVE_INFINITY]],
      ["a missing y", ["tab-1", 10]],
    ])("does nothing for %s", (_name, args) => {
      const buildMenu = vi.fn();
      const listener = tabMenuListener({ ...fakeDesktopDeps(), buildMenu });

      listener({}, ...args);

      expect(buildMenu).not.toHaveBeenCalled();
    });

    it("pops the menu at the given point, over this window", () => {
      const popup = vi.fn();
      const buildMenu = vi.fn(() => ({ popup }));
      const deps = fakeDesktopDeps();
      const listener = tabMenuListener({ ...deps, buildMenu });

      listener({}, "tab-1", 42, 24);

      expect(popup).toHaveBeenCalledWith({ window: deps.window, x: 42, y: 24 });
    });

    it("rounds fractional coordinates — Menu.popup requires integers, but clientX/Y are fractional under zoom", () => {
      const popup = vi.fn();
      const buildMenu = vi.fn(() => ({ popup }));
      const deps = fakeDesktopDeps();
      const listener = tabMenuListener({ ...deps, buildMenu });

      listener({}, "tab-1", 42.6, 24.2);

      expect(popup).toHaveBeenCalledWith({ window: deps.window, x: 43, y: 24 });
    });

    it("runs Reload and Close in main directly, for this tab's id, and Plans back to the renderer", () => {
      const reloadTab = vi.fn();
      const closeTab = vi.fn();
      const startTabRename = vi.fn();
      const startTabPlans = vi.fn();
      let template: MenuItemConstructorOptions[] = [];
      const buildMenu = vi.fn((built: MenuItemConstructorOptions[]) => {
        template = built;
        return { popup: vi.fn() };
      });
      const listener = tabMenuListener({
        ...fakeDesktopDeps(),
        buildMenu,
        reloadTab,
        closeTab,
        startTabRename,
        startTabPlans,
      });

      listener({}, "tab-1", 42, 24);
      const [rename, reload, close, plans] = template;
      (rename?.click as (() => void) | undefined)?.();
      (reload?.click as (() => void) | undefined)?.();
      (close?.click as (() => void) | undefined)?.();
      (plans?.click as (() => void) | undefined)?.();

      expect(startTabRename).toHaveBeenCalledWith("tab-1");
      expect(reloadTab).toHaveBeenCalledWith("tab-1");
      expect(closeTab).toHaveBeenCalledWith("tab-1");
      expect(startTabPlans).toHaveBeenCalledWith("tab-1");
    });

    // Task 8 fix round 1: a non-terminal tab (web, editor, api, …) has no
    // plan panel of its own — the item is left off its menu rather than
    // offered as an action that does nothing.
    it("omits Plans for a tab isTerminalTab says is not a terminal", () => {
      let template: MenuItemConstructorOptions[] = [];
      const buildMenu = vi.fn((built: MenuItemConstructorOptions[]) => {
        template = built;
        return { popup: vi.fn() };
      });
      const isTerminalTab = vi.fn(() => false);
      const listener = tabMenuListener({ ...fakeDesktopDeps(), buildMenu, isTerminalTab });

      listener({}, "tab-1", 42, 24);

      expect(isTerminalTab).toHaveBeenCalledWith("tab-1");
      expect(template.map((item) => item.label)).not.toContain("Plans");
    });

    it("keeps Plans for a tab isTerminalTab says is a terminal", () => {
      let template: MenuItemConstructorOptions[] = [];
      const buildMenu = vi.fn((built: MenuItemConstructorOptions[]) => {
        template = built;
        return { popup: vi.fn() };
      });
      const isTerminalTab = vi.fn(() => true);
      const listener = tabMenuListener({ ...fakeDesktopDeps(), buildMenu, isTerminalTab });

      listener({}, "tab-1", 42, 24);

      expect(template.map((item) => item.label)).toContain("Plans");
    });
  });

  // Task 8 (controller ruling): main's webContents deny every
  // target=_blank outright, so this channel is a plan link's only route to
  // the OS browser — and the one place that route is gated.
  describe("plans:openLink", () => {
    function openLinkListener(deps: ReturnType<typeof fakeDesktopDeps>) {
      const handle = vi.fn();
      registerDesktopOnly({ ...deps, handle });
      return handle.mock.calls.find(([c]) => c === "plans:openLink")![1] as (
        event: unknown,
        ...args: unknown[]
      ) => unknown;
    }

    it("opens an allowed URL in the OS browser", () => {
      const openExternal = vi.fn(async () => {});
      const listener = openLinkListener({ ...fakeDesktopDeps(), shell: { openExternal } });

      listener({}, "https://example.com/docs");

      expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
    });

    // Task 8 fix round 1: a rejected openExternal (e.g. no handler
    // registered for the scheme on this OS) must not become an unhandled
    // promise rejection — logged, same as every other main-process failure.
    it("catches and logs a rejected openExternal, never throwing", async () => {
      const logged: unknown[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      const openExternal = vi.fn(async () => {
        throw new Error("no handler registered");
      });
      const listener = openLinkListener({ ...fakeDesktopDeps(), shell: { openExternal } });

      expect(() => listener({}, "https://example.com/docs")).not.toThrow();
      await Promise.resolve().then(() => Promise.resolve());

      expect(logged.length).toBe(1);
      expect(String(logged[0])).toContain("no handler registered");
      spy.mockRestore();
    });

    it.each([
      ["a non-string url", 42],
      ["a javascript: url", "javascript:alert(1)"],
      ["a data: url", "data:text/html,hi"],
      ["a bare path", "/etc/hosts"],
      ["an unparsable string", "not a url"],
      ["a url over 2048 characters", `https://example.com/${"a".repeat(2048)}`],
    ])("never opens %s", (_name, arg) => {
      const openExternal = vi.fn(async () => {});
      const listener = openLinkListener({ ...fakeDesktopDeps(), shell: { openExternal } });

      listener({}, arg);

      expect(openExternal).not.toHaveBeenCalled();
    });
  });
});

describe("isAllowedPlanLinkUrl", () => {
  it("accepts http, https and mailto", () => {
    expect(isAllowedPlanLinkUrl("http://example.com")).toBe(true);
    expect(isAllowedPlanLinkUrl("https://example.com/x?y=1")).toBe(true);
    expect(isAllowedPlanLinkUrl("mailto:a@example.com")).toBe(true);
  });

  it("rejects any other scheme, an unparsable string, and an over-length url", () => {
    expect(isAllowedPlanLinkUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedPlanLinkUrl("data:text/html,hi")).toBe(false);
    expect(isAllowedPlanLinkUrl("ftp://example.com")).toBe(false);
    expect(isAllowedPlanLinkUrl("/etc/hosts")).toBe(false);
    expect(isAllowedPlanLinkUrl("not a url")).toBe(false);
    expect(isAllowedPlanLinkUrl(`https://example.com/${"a".repeat(2048)}`)).toBe(false);
  });
});

function fakeDesktopDeps(): DesktopOnlyDeps {
  return {
    handle: vi.fn(),
    window: { getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }) } as never,
    screen: { getDisplayMatching: () => ({ scaleFactor: 2 }) },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [] })) },
    buildMenu: () => ({ popup: vi.fn() }),
    views: {
      setBounds: vi.fn(),
      setDevToolsBounds: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      reload: vi.fn(),
      setDevTools: vi.fn(),
      setDevToolsDock: vi.fn(),
      setVisible: vi.fn(),
      hideAll: vi.fn(),
      requestPictureInPicture: vi.fn(),
    },
    chooseDock: vi.fn(),
    reloadTab: vi.fn(),
    closeTab: vi.fn(),
    startTabRename: vi.fn(),
    startTabPlans: vi.fn(),
    isTerminalTab: vi.fn(() => true),
    shell: { openExternal: vi.fn(async () => {}) },
    background: {
      status: vi.fn(async () => ({ enabled: false, inApp: true, state: { kind: "off" as const } })),
      setEnabled: vi.fn(async () => ({ ok: true as const })),
      restart: vi.fn(async () => ({ ok: true as const })),
      stopNow: vi.fn(async () => ({ ok: true as const })),
    },
    language: "en" as const,
  };
}
