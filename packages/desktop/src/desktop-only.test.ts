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

  it("routes the update channels to the updater, ignoring any arguments", async () => {
    const deps = fakeDesktopDeps();
    const handle = vi.fn();
    registerDesktopOnly({ ...deps, handle });
    const listener = (channel: string) =>
      handle.mock.calls.find(([c]) => c === channel)![1] as (
        event: unknown,
        ...args: unknown[]
      ) => Promise<unknown>;

    expect(await listener("update:check")({}, "evil")).toMatchObject({ phase: "current" });
    expect(await listener("update:download")({}, "https://example.com/x")).toMatchObject({
      phase: "ready",
    });
    expect(deps.updater.download).toHaveBeenCalledWith();
    expect(await listener("update:cancel")({})).toMatchObject({ phase: "available" });
    expect(await listener("update:counts")({})).toEqual({ terminals: 2, agents: 1 });
    expect(await listener("update:install")({}, "/tmp/x")).toMatchObject({ phase: "installing" });
    expect(deps.updater.install).toHaveBeenCalledWith();
    for (const channel of [
      "update:check",
      "update:download",
      "update:cancel",
      "update:counts",
      "update:install",
    ] as const) {
      expect(CHANNEL_POLICY[channel]).toBe("desktop-only");
    }
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

  it("dialog:pickFiles picks one folder when asked, opening at defaultPath", async () => {
    const handle = vi.fn();
    const dialog = {
      showOpenDialog: vi.fn(async (..._args: unknown[]) => ({
        canceled: false,
        filePaths: ["/projects/acme"],
      })),
    };
    registerDesktopOnly({ ...fakeDesktopDeps(), handle, dialog });
    const listener = handle.mock.calls.find(([c]) => c === "dialog:pickFiles")![1];
    // `multiple` is ignored beside `directory`: a folder field holds one path.
    expect(
      await listener({}, { directory: true, multiple: true, defaultPath: "/projects" }),
    ).toEqual(["/projects/acme"]);
    expect(dialog.showOpenDialog.mock.calls[0]![1]).toEqual({
      properties: ["openDirectory", "createDirectory"],
      defaultPath: "/projects",
    });
  });

  it("dialog:pickFiles ignores a defaultPath that is not a non-empty string", async () => {
    const handle = vi.fn();
    const dialog = {
      showOpenDialog: vi.fn(async (..._args: unknown[]) => ({ canceled: true, filePaths: [] })),
    };
    registerDesktopOnly({ ...fakeDesktopDeps(), handle, dialog });
    const listener = handle.mock.calls.find(([c]) => c === "dialog:pickFiles")![1];
    await listener({}, { defaultPath: 7 });
    await listener({}, { defaultPath: "" });
    for (const call of dialog.showOpenDialog.mock.calls) {
      expect(call[1]).toEqual({ properties: ["openFile"] });
    }
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
  describe("machine:*", () => {
    function setup() {
      const deps = fakeDesktopDeps();
      const handle = vi.fn();
      registerDesktopOnly({ ...deps, handle });
      const listener = (channel: string) =>
        handle.mock.calls.find(([c]) => c === channel)![1] as (
          event: unknown,
          ...args: unknown[]
        ) => unknown;
      return { deps, listener };
    }

    it("hides the workspace pages and hands the target to the machine views", () => {
      const { deps, listener } = setup();
      const target = { name: "studio.tail1234.ts.net", webPort: 7718, v: 2 };
      listener("machine:show")({}, target);
      expect(deps.views.hideAll).toHaveBeenCalledOnce();
      expect(deps.machines.show).toHaveBeenCalledWith(target);
      listener("machine:showLocal")({});
      expect(deps.machines.showLocal).toHaveBeenCalledOnce();
    });

    it("a bad machine:show target changes nothing", () => {
      const { deps, listener } = setup();
      listener("machine:show")({}, { name: "evil.com/x", webPort: 7718, v: 2 });
      listener("machine:show")({}, null);
      expect(deps.views.hideAll).not.toHaveBeenCalled();
      expect(deps.machines.show).not.toHaveBeenCalled();
    });

    it("converts bounds like workspace:bounds and refuses a malformed rect", () => {
      const { deps, listener } = setup();
      listener("machine:bounds")(
        {},
        { x: 0, y: 0, width: "wide", height: 10, devicePixelRatio: 2 },
      );
      listener("machine:bounds")({}, null);
      expect(deps.machines.setBounds).not.toHaveBeenCalled();
      listener("machine:bounds")({}, { x: 0, y: 0, width: 100, height: 50, devicePixelRatio: 2 });
      expect(deps.machines.setBounds).toHaveBeenCalledOnce();
    });

    it("closes only by a string name", () => {
      const { deps, listener } = setup();
      listener("machine:close")({}, 42);
      expect(deps.machines.close).not.toHaveBeenCalled();
      listener("machine:close")({}, "studio");
      expect(deps.machines.close).toHaveBeenCalledWith("studio");
    });
  });

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
      capture: vi.fn(async () => "data:image/jpeg;base64,AAAA"),
    },
    chooseDock: vi.fn(),
    reloadTab: vi.fn(),
    closeTab: vi.fn(),
    startTabRename: vi.fn(),
    startTabPlans: vi.fn(),
    isTerminalTab: vi.fn(() => true),
    shell: { openExternal: vi.fn(async () => {}) },
    updater: {
      checkNow: vi.fn(async () => ({ phase: "current" as const, current: "0.1.5" })),
      download: vi.fn(async () => ({ phase: "ready" as const, current: "0.1.5" })),
      cancel: vi.fn(async () => ({ phase: "available" as const, current: "0.1.5" })),
      counts: vi.fn(async () => ({ terminals: 2, agents: 1 })),
      install: vi.fn(async () => ({ phase: "installing" as const, current: "0.1.5" })),
    },
    background: {
      status: vi.fn(async () => ({ enabled: false, inApp: true, state: { kind: "off" as const } })),
      setEnabled: vi.fn(async () => ({ ok: true as const })),
      restart: vi.fn(async () => ({ ok: true as const })),
      stopNow: vi.fn(async () => ({ ok: true as const })),
    },
    machines: {
      show: vi.fn(),
      showLocal: vi.fn(),
      setBounds: vi.fn(),
      close: vi.fn(),
    },
    popouts: fakePopouts(),
    mainContentsId: () => 1,
    focusMain: vi.fn(),
    language: "en" as const,
    platform: "darwin" as const,
    screenshots: {
      capture: vi.fn(async () => ({ ok: false as const, reason: "cancelled" as const })),
      save: vi.fn(async () => ({ ok: false as const, reason: "cancelled" as const })),
    },
    screenshotDone: vi.fn(),
  };
}

function fakePopouts(): DesktopOnlyDeps["popouts"] {
  return {
    open: vi.fn(async () => ({ ok: true as const, already: false })),
    returnTab: vi.fn(async () => true),
    focus: vi.fn(() => true),
    list: vi.fn(() => ["t1"]),
    isPopped: vi.fn((tabId: string) => tabId === "t1"),
    canPopOut: vi.fn((tabId: string) => tabId !== "api1"),
    tabOf: vi.fn((contentsId: number) => (contentsId === 7 ? "t1" : undefined)),
    ready: vi.fn((contentsId: number) => (contentsId === 7 ? { tabId: "t1" } : undefined)),
    reportState: vi.fn(),
    provideState: vi.fn(),
    takeReturned: vi.fn(() => undefined),
  };
}

describe("pop-out channels", () => {
  const MAIN = { sender: { id: 1 } };
  const POPOUT = { sender: { id: 7 } };
  const STRANGER = { sender: { id: 99 } };

  function listeners(deps: DesktopOnlyDeps) {
    const handle = vi.fn();
    registerDesktopOnly({ ...deps, handle });
    return (channel: string) =>
      handle.mock.calls.find(([c]) => c === channel)![1] as (
        event: unknown,
        ...args: unknown[]
      ) => Promise<unknown> | unknown;
  }

  it("registers every popout channel, desktop-only", () => {
    for (const channel of [
      "popout:open",
      "popout:return",
      "popout:focus",
      "popout:list",
      "popout:showMain",
      "popout:employeeMenu",
      "popout:ready",
      "popout:state",
      "popout:handedOver",
      "popout:take",
    ] as const) {
      expect(ELECTRON_BOUND_CHANNELS).toContain(channel);
      expect(CHANNEL_POLICY[channel]).toBe("desktop-only");
    }
  });

  it("raises the main window only for a live pop-out's own webContents", () => {
    const deps = fakeDesktopDeps();
    const listener = listeners(deps);
    for (const event of [MAIN, STRANGER, {}, null]) listener("popout:showMain")(event);
    expect(deps.focusMain).not.toHaveBeenCalled();
    listener("popout:showMain")(POPOUT);
    expect(deps.focusMain).toHaveBeenCalledTimes(1);
  });

  it("lets only the main window open, focus, list, take and ask for the employee menu", async () => {
    const deps = fakeDesktopDeps();
    const listener = listeners(deps);
    expect(await listener("popout:open")(MAIN, "t1")).toEqual({ ok: true, already: false });
    expect(deps.popouts.open).toHaveBeenCalledWith("t1");
    for (const event of [POPOUT, STRANGER, {}, null]) {
      expect(await listener("popout:open")(event, "t1")).toEqual({ ok: false, reason: "invalid" });
      expect(listener("popout:focus")(event, "t1")).toBe(false);
      expect(listener("popout:list")(event)).toEqual([]);
      expect(listener("popout:take")(event, "t1")).toBeUndefined();
    }
    expect(deps.popouts.open).toHaveBeenCalledTimes(1);
    expect(listener("popout:focus")(MAIN, "t1", "t1:p1")).toBe(true);
    expect(deps.popouts.focus).toHaveBeenCalledWith("t1", "t1:p1");
    expect(listener("popout:list")(MAIN)).toEqual(["t1"]);
    listener("popout:take")(MAIN, "t1");
    expect(deps.popouts.takeReturned).toHaveBeenCalledWith("t1");
  });

  it("lets the main window return any popped tab, a pop-out only its own", async () => {
    const deps = fakeDesktopDeps();
    const listener = listeners(deps);
    await listener("popout:return")(MAIN, "t1");
    await listener("popout:return")(MAIN, "t2");
    expect(deps.popouts.returnTab).toHaveBeenNthCalledWith(1, "t1");
    expect(deps.popouts.returnTab).toHaveBeenNthCalledWith(2, "t2");
    await listener("popout:return")(POPOUT, "t1");
    expect(deps.popouts.returnTab).toHaveBeenCalledTimes(3);
    expect(await listener("popout:return")(POPOUT, "t2")).toBe(false);
    expect(await listener("popout:return")(STRANGER, "t1")).toBe(false);
    expect(deps.popouts.returnTab).toHaveBeenCalledTimes(3);
  });

  it("tells a pop-out only about itself and takes state only from the window asked", () => {
    const deps = fakeDesktopDeps();
    const listener = listeners(deps);
    expect(listener("popout:ready")(POPOUT)).toEqual({ tabId: "t1" });
    expect(listener("popout:ready")(STRANGER)).toBeUndefined();
    expect(listener("popout:ready")(MAIN)).toBeUndefined();
    listener("popout:state")(POPOUT, { shape: { key: "t1" } });
    listener("popout:state")(STRANGER, { shape: { key: "t1" } });
    expect(deps.popouts.reportState).toHaveBeenCalledTimes(1);
    expect(deps.popouts.reportState).toHaveBeenCalledWith(7, { shape: { key: "t1" } });

    listener("popout:handedOver")(MAIN, "t1", { shape: { key: "t1" } });
    expect(deps.popouts.provideState).toHaveBeenLastCalledWith("main", "t1", {
      shape: { key: "t1" },
    });
    listener("popout:handedOver")(POPOUT, "t1", "x");
    expect(deps.popouts.provideState).toHaveBeenLastCalledWith(7, "t1", "x");
    listener("popout:handedOver")(POPOUT, "t2", "x");
    listener("popout:handedOver")(STRANGER, "t1", "x");
    expect(deps.popouts.provideState).toHaveBeenCalledTimes(2);
  });

  it("pops the employee menu at the point, labelled by whether the tab is popped, and only for a tab that can go", async () => {
    const popup = vi.fn();
    let template: MenuItemConstructorOptions[] = [];
    const buildMenu = vi.fn((built: MenuItemConstructorOptions[]) => {
      template = built;
      return { popup };
    });
    const deps = { ...fakeDesktopDeps(), buildMenu };
    const listener = listeners(deps);
    listener("popout:employeeMenu")(MAIN, "t2", 10.6, 20.2);
    expect(template.map((item) => item.label)).toEqual(["Open in new window"]);
    expect(popup).toHaveBeenCalledWith({ window: deps.window, x: 11, y: 20 });
    (template[0]?.click as (() => void) | undefined)?.();
    expect(deps.popouts.open).toHaveBeenCalledWith("t2");

    listener("popout:employeeMenu")(MAIN, "t1", 1, 2);
    expect(template.map((item) => item.label)).toEqual(["Return to main window"]);
    (template[0]?.click as (() => void) | undefined)?.();
    expect(deps.popouts.returnTab).toHaveBeenCalledWith("t1");

    buildMenu.mockClear();
    listener("popout:employeeMenu")(MAIN, "api1", 1, 2);
    listener("popout:employeeMenu")(MAIN, 5, 1, 2);
    listener("popout:employeeMenu")(MAIN, "t2", Number.NaN, 2);
    listener("popout:employeeMenu")(POPOUT, "t2", 1, 2);
    expect(buildMenu).not.toHaveBeenCalled();
  });

  it("adds Open in new window or Return to main window to the tab chip's menu", () => {
    let template: MenuItemConstructorOptions[] = [];
    const buildMenu = vi.fn((built: MenuItemConstructorOptions[]) => {
      template = built;
      return { popup: vi.fn() };
    });
    const deps = { ...fakeDesktopDeps(), buildMenu };
    const listener = listeners(deps);
    listener("workspace:tabMenu")(MAIN, "t2", 1, 2);
    expect(template.at(-1)?.label).toBe("Open in new window");
    listener("workspace:tabMenu")(MAIN, "t1", 1, 2);
    expect(template.at(-1)?.label).toBe("Return to main window");
    listener("workspace:tabMenu")(MAIN, "api1", 1, 2);
    expect(template.map((item) => item.label)).not.toContain("Open in new window");
    (template.at(-1)?.click as (() => void) | undefined)?.();
  });
});

describe("office:pageShot", () => {
  const MAIN = { sender: { id: 1 } };
  const POPOUT = { sender: { id: 7 } };
  const handler = (deps: DesktopOnlyDeps) => {
    const handle = vi.fn();
    registerDesktopOnly({ ...deps, handle });
    return handle.mock.calls.find(([c]) => c === "office:pageShot")![1] as (
      event: unknown,
      ...args: unknown[]
    ) => Promise<unknown>;
  };

  it("is Electron-bound and desktop-only", () => {
    expect(ELECTRON_BOUND_CHANNELS).toContain("office:pageShot");
    expect(CHANNEL_POLICY["office:pageShot"]).toBe("desktop-only");
  });

  it("answers the main window with the view's capture", async () => {
    const deps = fakeDesktopDeps();
    expect(await handler(deps)(MAIN, "w1")).toBe("data:image/jpeg;base64,AAAA");
    expect(deps.views.capture).toHaveBeenCalledWith("w1");
  });

  it("answers undefined to a pop-out, a stranger, a bad sender or a bad tab id, capturing nothing", async () => {
    const deps = fakeDesktopDeps();
    const listener = handler(deps);
    for (const event of [POPOUT, { sender: { id: 99 } }, {}, null]) {
      expect(await listener(event, "w1")).toBeUndefined();
    }
    for (const id of [undefined, 4, "", "x".repeat(300), {}]) {
      expect(await listener(MAIN, id)).toBeUndefined();
    }
    expect(deps.views.capture).not.toHaveBeenCalled();
  });

  it("answers only a JPEG data URL, and undefined when the capture throws", async () => {
    const deps = fakeDesktopDeps();
    vi.mocked(deps.views.capture).mockResolvedValueOnce("data:image/svg+xml;base64,AAAA");
    expect(await handler(deps)(MAIN, "w1")).toBeUndefined();
    vi.mocked(deps.views.capture).mockRejectedValueOnce(new Error("gone"));
    expect(await handler(deps)(MAIN, "w1")).toBeUndefined();
  });
});

describe("the screenshot channels", () => {
  const MAIN = { sender: { id: 1 } };
  const POPOUT = { sender: { id: 7 } };
  const handler = (deps: DesktopOnlyDeps, channel: string) => {
    const handle = vi.fn();
    registerDesktopOnly({ ...deps, handle });
    return handle.mock.calls.find(([c]) => c === channel)![1] as (
      event: unknown,
      ...args: unknown[]
    ) => Promise<unknown>;
  };

  it("are Electron-bound and desktop-only", () => {
    for (const channel of ["screenshot:menu", "screenshot:save"] as const) {
      expect(ELECTRON_BOUND_CHANNELS).toContain(channel);
      expect(CHANNEL_POLICY[channel]).toBe("desktop-only");
    }
  });

  it("menu pops a native menu at the point for the main window, with the platform's items", async () => {
    for (const [platform, labels] of [
      ["darwin", ["Select an area", "This window", "Whole screen"]],
      ["win32", ["This window", "Whole screen"]],
    ] as const) {
      const popup = vi.fn();
      let template: MenuItemConstructorOptions[] = [];
      const deps = {
        ...fakeDesktopDeps(),
        platform,
        buildMenu: vi.fn((built: MenuItemConstructorOptions[]) => {
          template = built;
          return { popup };
        }),
      };
      await handler(deps, "screenshot:menu")(MAIN, 10.4, 20.6);
      expect(template.map((item) => item.label)).toEqual(labels);
      expect(popup).toHaveBeenCalledWith({ window: deps.window, x: 10, y: 21 });
    }
  });

  it("menu ignores a pop-out, a stranger and bad coordinates", async () => {
    const buildMenu = vi.fn(() => ({ popup: vi.fn() }));
    const deps = { ...fakeDesktopDeps(), buildMenu };
    const listener = handler(deps, "screenshot:menu");
    for (const event of [POPOUT, { sender: { id: 99 } }, {}, null]) await listener(event, 1, 2);
    await listener(MAIN, "1", 2);
    await listener(MAIN, 1, Number.NaN);
    await listener(MAIN, Infinity, 2);
    expect(buildMenu).not.toHaveBeenCalled();
  });

  it("choosing an item captures that mode and pushes the outcome", async () => {
    let template: MenuItemConstructorOptions[] = [];
    const outcome = {
      ok: true as const,
      id: "a",
      thumbnail: "data:image/png;base64,",
      width: 1,
      height: 1,
    };
    const deps = {
      ...fakeDesktopDeps(),
      buildMenu: (built: MenuItemConstructorOptions[]) => {
        template = built;
        return { popup: vi.fn() };
      },
    };
    vi.mocked(deps.screenshots.capture).mockResolvedValue(outcome);
    await handler(deps, "screenshot:menu")(MAIN, 1, 2);
    (template[1]?.click as (() => void) | undefined)?.();
    await vi.waitFor(() => expect(deps.screenshotDone).toHaveBeenCalledWith(outcome));
    expect(deps.screenshots.capture).toHaveBeenCalledWith("window");
  });

  it("a cancelled capture is pushed too, so the renderer can stay quiet", async () => {
    let template: MenuItemConstructorOptions[] = [];
    const deps = {
      ...fakeDesktopDeps(),
      buildMenu: (built: MenuItemConstructorOptions[]) => {
        template = built;
        return { popup: vi.fn() };
      },
    };
    await handler(deps, "screenshot:menu")(MAIN, 1, 2);
    (template[0]?.click as (() => void) | undefined)?.();
    await vi.waitFor(() =>
      expect(deps.screenshotDone).toHaveBeenCalledWith({ ok: false, reason: "cancelled" }),
    );
    expect(deps.screenshots.capture).toHaveBeenCalledWith("area");
  });

  it("save passes only the id, for the main window only", async () => {
    const deps = fakeDesktopDeps();
    const listener = handler(deps, "screenshot:save");
    await listener(MAIN, "abc", "/etc/passwd", Buffer.from("x"));
    expect(deps.screenshots.save).toHaveBeenCalledTimes(1);
    expect(deps.screenshots.save).toHaveBeenCalledWith("abc");
  });

  it("save refuses a pop-out, a stranger and a bad sender without saving", async () => {
    const deps = fakeDesktopDeps();
    const listener = handler(deps, "screenshot:save");
    for (const event of [POPOUT, { sender: { id: 99 } }, {}, null]) {
      expect(await listener(event, "abc")).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(deps.screenshots.save).not.toHaveBeenCalled();
  });
});
