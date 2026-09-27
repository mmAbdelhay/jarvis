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
    workspace: { setBounds: vi.fn(), setDevToolsBounds: vi.fn() },
    chooseDock: vi.fn(),
    reloadTab: vi.fn(),
    closeTab: vi.fn(),
    startTabRename: vi.fn(),
    language: "en" as const,
  };
}
