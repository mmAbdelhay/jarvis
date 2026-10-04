// The handlers that hold a BrowserWindow, the screen, a native dialog, a
// native menu, a hosted page's view, or (plans:openLink, Task 8) the OS's
// own browser via Electron's `shell`. They can never run for a phone, nor
// in a headless core, so they are registered here rather than entering the
// transport-agnostic table, and `ElectronBoundChannel` in dispatch.ts keeps
// the table from accepting them.
import type { BrowserWindow, Dialog, MenuItemConstructorOptions, Screen, Shell } from "electron";
import { isDevToolsDock, type DevToolsDock } from "./browser-host.js";
import type { ElectronBoundChannel } from "./dispatch.js";
import type { ChangeResult, DaemonStatus } from "./daemon/mode.js";
import type { ReportedRect } from "./ipc.js";
import { errorMessage, MESSAGES } from "./messages.js";
import type { DesktopOnlyChannel } from "./remote-policy.js";
import { tabMenuTemplate } from "./tab-menu.js";
import type { UpdateCheck } from "./update-check.js";
import type { Updater } from "./updater.js";
import { toDeviceIndependent } from "./view-bounds.js";
import type { ViewReconciler } from "./view-reconciler.js";

// Only the one field displayScale() reads — the real Display carries 18
// more, none of which a test double should have to fabricate.
type DisplayMatch = Pick<ReturnType<Screen["getDisplayMatching"]>, "scaleFactor">;

// The intersection with DesktopOnlyChannel makes it a tsc error for an
// Electron-bound channel to be classified remote in remote-policy.ts.
export const ELECTRON_BOUND_CHANNELS: readonly (ElectronBoundChannel & DesktopOnlyChannel)[] = [
  "workspace:bounds",
  "workspace:devtoolsBounds",
  "workspace:devtoolsDockMenu",
  "workspace:tabMenu",
  "workspace:back",
  "workspace:forward",
  "workspace:reload",
  "workspace:devtools",
  "workspace:devtoolsDock",
  "workspace:visible",
  "workspace:hideAll",
  "workspace:pip",
  "dialog:pickFiles",
  "plans:openLink",
  "app:checkUpdate",
  "update:check",
  "update:download",
  "update:cancel",
  "update:counts",
  "update:install",
  "background:status",
  "background:setEnabled",
  "background:restart",
  "background:stopNow",
];

/** plans:openLink's own gate (Task 8, controller ruling). main's own
 *  `setWindowOpenHandler` denies every `target=_blank` outright, so a plan
 *  block's own rendered link has no route to the OS browser without this
 *  channel — and this is what keeps that channel from becoming a generic
 *  "open anything" primitive: only a URL `new URL` can parse, whose scheme
 *  is `http:`, `https:` or `mailto:`, under 2048 characters. Anything else
 *  (a `javascript:`/`data:`/custom-protocol URL, a bare path, an
 *  over-length string) is refused rather than handed to
 *  `shell.openExternal`, which runs whatever the OS has registered for it. */
const OPEN_LINK_MAX_URL_LENGTH = 2048;
const OPEN_LINK_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

export function isAllowedPlanLinkUrl(url: string): boolean {
  if (url.length > OPEN_LINK_MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return OPEN_LINK_SCHEMES.has(parsed.protocol);
}

export type DesktopOnlyDeps = {
  handle(
    channel: ElectronBoundChannel,
    listener: (event: unknown, ...args: unknown[]) => unknown,
  ): void; // ipcMain.handle
  window: BrowserWindow;
  screen: { getDisplayMatching(bounds: Parameters<Screen["getDisplayMatching"]>[0]): DisplayMatch };
  dialog: Pick<Dialog, "showOpenDialog">;
  buildMenu: (template: MenuItemConstructorOptions[]) => {
    popup(options: { window: BrowserWindow; x?: number; y?: number }): void;
  }; // Menu.buildFromTemplate
  /** The hosted pages. Tab state is the core's; these act on a page's view
   *  alone and change no tab. */
  views: Pick<
    ViewReconciler,
    | "setBounds"
    | "setDevToolsBounds"
    | "back"
    | "forward"
    | "reload"
    | "setDevTools"
    | "setDevToolsDock"
    | "setVisible"
    | "hideAll"
    | "requestPictureInPicture"
  >;
  chooseDock: (dock: DevToolsDock) => void; // broadcast.local("workspace:devtoolsDockChosen", dock)
  // Bug 2 / Task 8: the tab menu's own four items. Reload is
  // workspace:reload's own view call, and Close runs the dispatch table's
  // workspace:close (main.ts wires both) — this file duplicates none of
  // that logic. Rename and Plans have nothing to run here at all: each only
  // tells the renderer which chip should act (start its own inline rename,
  // or toggle its own plan panel).
  reloadTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  startTabRename: (tabId: string) => void; // broadcast.local("workspace:tabRename", tabId)
  startTabPlans: (tabId: string) => void; // broadcast.local("workspace:tabPlans", tabId)
  // Task 8 fix round 1: whether `tabId` names a terminal tab — a non-
  // terminal tab (web, editor, database, api, cluster, docker, chat) has
  // no plan panel of its own, so its menu leaves the item off entirely
  // (tab-menu.ts's own `showPlans`) rather than offering an action that
  // does nothing.
  isTerminalTab: (tabId: string) => boolean;
  // plans:openLink's own way out of this process — Pick, not the whole
  // Electron `shell`, the same discipline `dialog` above follows.
  shell: Pick<Shell, "openExternal">;
  /** Settings' Check for updates (update-check.ts): this app's own version
   *  and one request to GitHub's releases API. */
  checkForUpdate: () => Promise<UpdateCheck>;
  /** The updater (updater.ts); its state pushes go out from main.ts. */
  updater: Pick<Updater, "checkNow" | "download" | "cancel" | "counts" | "install">;
  language: "ar" | "en";
  /** Task 23: the background service (daemon/mode.ts, wired in main.ts). */
  background: {
    status(): Promise<DaemonStatus>;
    setEnabled(enabled: boolean): Promise<ChangeResult>;
    restart(): Promise<ChangeResult>;
    stopNow(): Promise<ChangeResult>;
  };
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
    return deps.views.setBounds(toDeviceIndependent(rect, rect.devicePixelRatio, displayScale()));
  });
  deps.handle("workspace:devtoolsBounds", (_event, bounds) => {
    const rect = bounds as ReportedRect;
    return deps.views.setDevToolsBounds(
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
  // Bug 2 / Task 8: a chip's Rename/Reload/Close/Plans menu, native for the
  // same reason the DevTools dock menu above is — a hosted tab's
  // WebContentsView paints above the whole renderer, so a DOM popover drawn
  // under it (the fix syncHostedView carried before this) was invisible,
  // and sinking the hosted view to show it dismissed the popover in the
  // same stroke. `x` and `y` are the renderer's own clientX/clientY from
  // the contextmenu event, so the menu opens exactly where the user
  // right-clicked rather than wherever the cursor happens to be when this
  // IPC round trip lands.
  deps.handle("workspace:tabMenu", (_event, tabId, x, y) => {
    if (typeof tabId !== "string") return;
    if (typeof x !== "number" || !Number.isFinite(x)) return;
    if (typeof y !== "number" || !Number.isFinite(y)) return;
    const template = tabMenuTemplate(
      {
        rename: MESSAGES.tabMenuRename(deps.language),
        reload: MESSAGES.tabMenuReload(deps.language),
        close: MESSAGES.tabMenuClose(deps.language),
        plans: MESSAGES.tabMenuPlans(deps.language),
      },
      {
        onRename: () => deps.startTabRename(tabId),
        onReload: () => deps.reloadTab(tabId),
        onClose: () => deps.closeTab(tabId),
        onPlans: () => deps.startTabPlans(tabId),
      },
      { showPlans: deps.isTerminalTab(tabId) },
    );
    deps.buildMenu(template).popup({ window: deps.window, x: Math.round(x), y: Math.round(y) });
  });
  // Task 8 (controller ruling): the only route a plan block's own rendered
  // link has to the OS browser — main's webContents deny every
  // target=_blank outright (main.ts's setWindowOpenHandler). A url that
  // fails isAllowedPlanLinkUrl is silently ignored, never thrown into the
  // renderer's own await.
  deps.handle("app:checkUpdate", () => deps.checkForUpdate());
  // The updater takes no arguments: what to download and install is the
  // state it already holds, never something the renderer names.
  deps.handle("update:check", () => deps.updater.checkNow());
  deps.handle("update:download", () => deps.updater.download());
  deps.handle("update:cancel", () => deps.updater.cancel());
  deps.handle("update:counts", () => deps.updater.counts());
  deps.handle("update:install", () => deps.updater.install());
  deps.handle("plans:openLink", (_event, url) => {
    if (typeof url !== "string" || !isAllowedPlanLinkUrl(url)) return;
    deps.shell.openExternal(url).catch((error: unknown) => {
      console.error(`plans:openLink: shell.openExternal failed: ${errorMessage(error)}`);
    });
  });
  // What only a hosted page's own view can do. Every argument crosses an
  // untyped IPC boundary, so each is checked before it reaches a view.
  deps.handle("workspace:back", (_event, id) => {
    if (typeof id === "string") deps.views.back(id);
  });
  deps.handle("workspace:forward", (_event, id) => {
    if (typeof id === "string") deps.views.forward(id);
  });
  deps.handle("workspace:reload", (_event, id) => {
    if (typeof id === "string") deps.views.reload(id);
  });
  deps.handle("workspace:devtools", (_event, tabId, open) => {
    if (typeof tabId !== "string" || typeof open !== "boolean") return;
    deps.views.setDevTools(tabId, open);
  });
  deps.handle("workspace:devtoolsDock", (_event, dock) => {
    if (isDevToolsDock(dock)) deps.views.setDevToolsDock(dock);
  });
  deps.handle("workspace:visible", (_event, visible) => deps.views.setVisible(visible === true));
  deps.handle("workspace:hideAll", () => deps.views.hideAll());
  deps.handle("workspace:pip", (_event, tabId) => {
    if (typeof tabId === "string") deps.views.requestPictureInPicture(tabId);
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
  // Task 23: "Keep Jarvis running in the background". The toggle's value
  // crosses an untyped boundary, so anything but a real boolean is refused.
  deps.handle("background:status", () => deps.background.status());
  deps.handle("background:setEnabled", async (_event, enabled): Promise<ChangeResult> => {
    if (typeof enabled !== "boolean") {
      return { ok: false, reason: "failed", detail: "enabled must be true or false" };
    }
    return deps.background.setEnabled(enabled);
  });
  deps.handle("background:restart", () => deps.background.restart());
  deps.handle("background:stopNow", () => deps.background.stopNow());
}
