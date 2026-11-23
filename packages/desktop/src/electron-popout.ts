import { BrowserWindow, screen } from "electron";
import { pathToFileURL } from "node:url";
import { rendererSink, type PushSink } from "./broadcast.js";
import { isAllowedNavigation } from "./navigation.js";
import {
  clampPopoutSize,
  popoutPushAllowed,
  type PopoutHandlers,
  type PopoutSpec,
  type PopoutWindow,
} from "./popout.js";

/**
 * The only place a pop-out's BrowserWindow is constructed (popout.ts holds
 * the rules and is tested without Electron).
 *
 * A pop-out gets exactly the hardening the main window has: context
 * isolation, the sandbox, no node integration. A terminal's pop-out loads
 * renderer/popout.html with Jarvis's own preload and is told its tab on the
 * argv flag; a page's pop-out has no preload and loads nothing at all — the
 * hosted page's WebContentsView fills it. Neither can open a window, and
 * neither can navigate away from its own file. Never parented: a child of a
 * full-screen window makes macOS hide the parent (see electron-view.ts).
 */
export type PopoutWindowOptions = {
  preload: string;
  /** The compiled preload's argv: the channel table. */
  preloadArguments: string[];
  /** renderer/popout.html. */
  popoutHtml: string;
  icon: string;
  /** Every push the core sends this app; filtered per window below. */
  onPush(listener: PushSink): () => void;
};

/** Whether a webContents event is the close chord. */
function isCloseChord(input: {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}): boolean {
  return (
    input.type === "keyDown" &&
    input.key.toLowerCase() === "w" &&
    (input.control || input.meta) &&
    !input.alt &&
    !input.shift
  );
}

export function createPopoutWindowFactory(
  options: PopoutWindowOptions,
): (spec: PopoutSpec, handlers: PopoutHandlers) => PopoutWindow {
  const popoutUrl = pathToFileURL(options.popoutHtml).href;

  return (spec, handlers) => {
    const isTerminal = spec.kind === "terminal";
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workAreaSize;
    const size = clampPopoutSize(spec.size, area);
    const window = new BrowserWindow({
      ...size,
      minWidth: 320,
      minHeight: 240,
      title: spec.title,
      autoHideMenuBar: true,
      backgroundColor: isTerminal ? "#060a0f" : "#ffffff",
      icon: options.icon,
      webPreferences: {
        ...(isTerminal
          ? {
              preload: options.preload,
              additionalArguments: [...options.preloadArguments, `--jarvis-popout=${spec.tabId}`],
            }
          : {}),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const contents = window.webContents;
    // The title is the tab's: a page changing document.title must not rename
    // the window behind the host's back.
    window.on("page-title-updated", (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, url) => {
      if (!isTerminal || !isAllowedNavigation(url, popoutUrl)) event.preventDefault();
    });
    contents.on("before-input-event", (event, input) => {
      if (!isCloseChord(input)) return;
      event.preventDefault();
      handlers.onCloseRequested();
    });
    contents.on("render-process-gone", () => handlers.onCrashed());

    // The window's pushes: through the broadcaster's sink, and only what
    // popoutPushAllowed lets this tab's window see.
    const sink = rendererSink(window);
    const stopPushes = options.onPush((channel, payload) => {
      if (popoutPushAllowed(spec.tabId, channel, payload)) sink(channel, payload);
    });

    const contentSize = (): { width: number; height: number } => {
      const [width = 0, height = 0] = window.getContentSize();
      return { width, height };
    };
    // Closing is the host's to decide: it moves the page (or asks the
    // renderer for its state) first, then destroys the window itself.
    window.on("close", (event) => {
      event.preventDefault();
      handlers.onCloseRequested();
    });
    window.on("closed", () => {
      stopPushes();
      handlers.onClosed();
    });
    window.on("resize", () => handlers.onResize(contentSize()));
    window.on("focus", () => handlers.onFocusChanged());
    window.on("blur", () => handlers.onFocusChanged());
    window.on("minimize", () => handlers.onFocusChanged());
    window.on("restore", () => handlers.onFocusChanged());

    if (isTerminal) {
      void window.loadFile(options.popoutHtml).catch((error: unknown) => {
        console.error(
          `popout: failed to load the page: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
    window.show();

    return {
      contentsId: contents.id,
      target: window,
      focus: () => {
        if (window.isDestroyed()) return;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      },
      isFocused: () => !window.isDestroyed() && window.isFocused(),
      isAwake: () => !window.isDestroyed() && window.isVisible() && !window.isMinimized(),
      setTitle: (title) => {
        if (!window.isDestroyed()) window.setTitle(title);
      },
      contentSize,
      send: sink,
      destroy: () => {
        stopPushes();
        if (window.isDestroyed()) return;
        window.removeAllListeners("close");
        window.destroy();
      },
    };
  };
}
