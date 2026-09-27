import type { MenuItemConstructorOptions } from "electron";

// A workspace tab chip's native right-click menu (bug 2). The DOM popover it
// replaces had to be drawn under the hosted view's WebContentsView (which
// paints above the whole renderer, regardless of any popover's top layer),
// so opening it flashed the hosted view away and closed the menu right back
// — see views.ts's syncHostedView and desktop-only.ts's own handler for this
// channel. Pure, like app-menu.ts's appMenuTemplate: it returns a template
// rather than a Menu, so it can be read by a test that has no Electron and
// takes no BrowserWindow, screen position or IPC of its own.

export type TabMenuLabels = {
  rename: string;
  reload: string;
  close: string;
};

export type TabMenuCallbacks = {
  onRename: () => void;
  onReload: () => void;
  onClose: () => void;
};

/** Rename / Reload / Close, in that order — the same order the old DOM
 *  popover's menuItem() calls built it in. */
export function tabMenuTemplate(
  labels: TabMenuLabels,
  callbacks: TabMenuCallbacks,
): MenuItemConstructorOptions[] {
  return [
    { label: labels.rename, click: callbacks.onRename },
    { label: labels.reload, click: callbacks.onReload },
    { label: labels.close, click: callbacks.onClose },
  ];
}
