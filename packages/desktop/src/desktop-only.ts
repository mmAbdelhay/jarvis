// The four handlers that hold a BrowserWindow, the screen, a native dialog
// or a native menu. They can never run for a phone, so they are registered
// here rather than entering the transport-agnostic table, and
// `ElectronBoundChannel` in dispatch.ts keeps the table from accepting them.
import type { BrowserWindow, Dialog, MenuItemConstructorOptions, Screen } from "electron";
import type { BrowserHost, DevToolsDock } from "./browser-host.js";
import type { ElectronBoundChannel } from "./dispatch.js";
import type { ReportedRect } from "./ipc.js";
import { MESSAGES } from "./messages.js";
import type { DesktopOnlyChannel } from "./remote-policy.js";
import { toDeviceIndependent } from "./view-bounds.js";

// Only the one field displayScale() reads — the real Display carries 18
// more, none of which a test double should have to fabricate.
type DisplayMatch = Pick<ReturnType<Screen["getDisplayMatching"]>, "scaleFactor">;

// The intersection with DesktopOnlyChannel makes it a tsc error for an
// Electron-bound channel to be classified remote in remote-policy.ts.
export const ELECTRON_BOUND_CHANNELS: readonly (ElectronBoundChannel & DesktopOnlyChannel)[] = [
  "workspace:bounds",
  "workspace:devtoolsBounds",
  "workspace:devtoolsDockMenu",
  "dialog:pickFiles",
];

export type DesktopOnlyDeps = {
  handle(
    channel: ElectronBoundChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void; // ipcMain.handle
  window: BrowserWindow;
  screen: { getDisplayMatching(bounds: Parameters<Screen["getDisplayMatching"]>[0]): DisplayMatch };
  dialog: Pick<Dialog, "showOpenDialog">;
  buildMenu: (template: MenuItemConstructorOptions[]) => {
    popup(options: { window: BrowserWindow }): void;
  }; // Menu.buildFromTemplate
  workspace: Pick<BrowserHost, "setBounds" | "setDevToolsBounds">;
  chooseDock: (dock: DevToolsDock) => void; // broadcast.local("workspace:devtoolsDockChosen", dock)
  language: "ar" | "en";
};

export function registerDesktopOnly(deps: DesktopOnlyDeps): void {
  // Which display the window is actually on: dragging Jarvis to a second
  // screen with a different scale changes the conversion below, and
  // getDisplayMatching answers for the screen the window occupies rather
  // than assuming the primary one.
  const displayScale = (): number =>
    deps.screen.getDisplayMatching(deps.window.getBounds()).scaleFactor;

  // The renderer measures in CSS pixels and a hosted view is placed in
  // device-independent pixels. Those agree only while the display is not
  // running a scaled resolution; converting against the window's own
  // content box is what keeps a page filling its slot on a display where
  // they do not. See view-bounds.ts.
  deps.handle("workspace:bounds", (_event, bounds) => {
    const rect = bounds as ReportedRect;
    return deps.workspace.setBounds(
      toDeviceIndependent(rect, rect.devicePixelRatio, displayScale()),
    );
  });
  deps.handle("workspace:devtoolsBounds", (_event, bounds) => {
    const rect = bounds as ReportedRect;
    return deps.workspace.setDevToolsBounds(
      toDeviceIndependent(rect, rect.devicePixelRatio, displayScale()),
    );
  });
  // A native menu rather than one the renderer draws: it opens from the
  // address bar over the page, and a hosted page is a native view painted
  // above anything in the renderer's DOM. The choice goes back to the
  // renderer, which owns the layout and remembers it.
  deps.handle("workspace:devtoolsDockMenu", (_event, current) => {
    const item = (dock: DevToolsDock): MenuItemConstructorOptions => ({
      label: MESSAGES.devToolsDock(dock, deps.language),
      type: "radio",
      checked: current === dock,
      click: () => deps.chooseDock(dock),
    });
    deps
      .buildMenu([item("undocked"), item("left"), item("bottom"), item("right")])
      .popup({ window: deps.window });
  });
  // A native picker, for a multipart file field and for importing a
  // collection. Cancelling returns [] — it is not a failure.
  deps.handle("dialog:pickFiles", async (_event, options) => {
    const multiple = (options as { multiple?: boolean } | undefined)?.multiple === true;
    const result = await deps.dialog.showOpenDialog(deps.window, {
      properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
    });
    return result.canceled ? [] : result.filePaths;
  });
}
