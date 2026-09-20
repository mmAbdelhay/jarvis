import type { MenuItemConstructorOptions } from "electron";
import { MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";

// The application menu.
//
// Nothing set one before, which was right on darwin: Electron's default is
// the standard Mac menu bar, it lives outside the window, and it is where ⌘Q
// and the edit roles come from. Off darwin the same default draws a visible
// File/Edit/View bar *inside* the window, above a UI that opens full screen
// and has its own chrome.
//
// Removing it outright is the wrong fix. The roles it carries are what make
// copy, paste and select-all work inside ordinary input fields — the composer,
// the Settings editors, the API tab's URL bar — where the app's own chord
// handlers deliberately do not reach. So: a minimal role menu, hidden by
// autoHideMenuBar on the window.
//
// Pure, and returns a template rather than a Menu, so it can be read by a test
// that has no Electron.

/**
 * The menu for `platform`.
 *
 * darwin keeps `appMenu` first, which is the About/Services/Hide/Quit block
 * every Mac app has and the only place ⌘Q lives. Elsewhere there is no menu
 * bar to put an app menu in, and Quit belongs beside the edit roles.
 */
export function appMenuTemplate(
  platform: NodeJS.Platform,
  reloadJarvis: () => void = () => {},
): MenuItemConstructorOptions[] {
  const edit: MenuItemConstructorOptions = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };

  const view: MenuItemConstructorOptions = {
    label: "View",
    submenu: [
      // The only way to see a renderer error in a packaged app. main.ts
      // forwards console errors to the terminal that launched it, which is no
      // help to somebody who launched it from a desktop icon.
      { role: "toggleDevTools" },
      { type: "separator" },
      // A role:reload item installs Ctrl/Cmd+R for the *Jarvis renderer* even
      // while a hosted browser page has focus. Keep a menu path for explicit
      // app reload, without claiming the browser's familiar shortcut.
      { label: MESSAGES.reloadJarvis(PRIMARY_LANGUAGE), click: reloadJarvis },
    ],
  };

  if (platform === "darwin") return [{ role: "appMenu" }, edit, view];

  return [
    edit,
    view,
    // Quit has nowhere else to be off darwin, and a window manager that offers
    // no close button would otherwise leave no menu path out of the app.
    { label: "File", submenu: [{ role: "quit" }] },
  ];
}
