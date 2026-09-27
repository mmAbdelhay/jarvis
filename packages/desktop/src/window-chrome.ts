import type { BrowserWindowConstructorOptions } from "electron";

// Mirrors styles.css's --ground / --text and the redesigned .topbar's 48px height. This
// runs in the main process, before any renderer or CSS exists, so the
// values are a literal copy rather than something read from the stylesheet
// — if the topbar's background, text colour or height tokens change, these
// need updating too.
const TOPBAR_BACKGROUND = "#0b0d12";
const TOPBAR_TEXT = "#f4f5f7";
const TOPBAR_HEIGHT_PX = 48;

/**
 * The window's title-bar chrome for `platform`.
 *
 * Bug 1: the BrowserWindow otherwise relies entirely on the window manager
 * to draw min/max/close decorations. On GNOME/Wayland (and some Windows
 * configurations) it draws none — or close only — leaving the window with
 * no way to minimize, maximize or close from its frame. Rather than depend
 * on the WM, Linux and Windows get `titleBarStyle: "hidden"` plus Electron's
 * own `titleBarOverlay`, which paints its min/max/close buttons in the
 * window's own colours regardless of what the WM does. macOS already draws
 * its traffic lights without any of this and is left with the default
 * (empty) chrome.
 *
 * Pure — returns the options to spread into the BrowserWindow constructor
 * rather than building a window itself — so this is testable without ever
 * launching Electron, the same shape as appMenuTemplate.
 */
export function windowChrome(
  platform: NodeJS.Platform,
): Pick<BrowserWindowConstructorOptions, "titleBarStyle" | "titleBarOverlay"> {
  if (platform !== "linux" && platform !== "win32") return {};
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: TOPBAR_BACKGROUND,
      symbolColor: TOPBAR_TEXT,
      height: TOPBAR_HEIGHT_PX,
    },
  };
}
