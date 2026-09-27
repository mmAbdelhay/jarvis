import type { MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  ELECTRON_BOUND_CHANNELS,
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

    it("runs Reload and Close in main directly, for this tab's id", () => {
      const reloadTab = vi.fn();
      const closeTab = vi.fn();
      const startTabRename = vi.fn();
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
      });

      listener({}, "tab-1", 42, 24);
      const [rename, reload, close] = template;
      (rename?.click as (() => void) | undefined)?.();
      (reload?.click as (() => void) | undefined)?.();
      (close?.click as (() => void) | undefined)?.();

      expect(startTabRename).toHaveBeenCalledWith("tab-1");
      expect(reloadTab).toHaveBeenCalledWith("tab-1");
      expect(closeTab).toHaveBeenCalledWith("tab-1");
    });
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
    language: "en" as const,
  };
}
