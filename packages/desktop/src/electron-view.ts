import { WebContentsView, type BrowserWindow } from "electron";
import {
  bridgeEvents,
  type ViewFactory,
  type WebContentsLike,
} from "./browser-host.js";

/**
 * The only place in the app that constructs a WebContentsView, kept apart
 * from browser-host.ts so that nothing which imports `electron` is pulled
 * into the Node-environment tests that cover the host's logic.
 *
 * A hosted view is a native child of the window's contentView: it is
 * positioned in window pixels and painted above the renderer, which is why
 * BrowserHost has to be told about bounds and visibility explicitly.
 *
 * Each view gets the same hardening the main renderer has, plus its own
 * persistent partition. Web pages here are fully untrusted; they are in
 * their own process precisely so that a compromise reaches nothing holding
 * window.jarvis.
 */
export function createElectronViewFactory(window: BrowserWindow): ViewFactory {
  return (partition) => {
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // No preload: nothing of Jarvis is exposed to a web page.
      },
    });
    // Without an explicit background the view paints transparent for the
    // first frames, showing the dashboard through the page.
    view.setBackgroundColor("#ffffff");
    window.contentView.addChildView(view);
    view.setVisible(false);

    const contents = view.webContents;

    return {
      loadURL: (url) => {
        // A load rejects on an aborted or failed navigation; did-fail-load
        // already reports that, and an unhandled rejection here would take
        // down the main process.
        void contents.loadURL(url).catch(() => undefined);
      },
      setBounds: (bounds) => view.setBounds(bounds),
      setVisible: (visible) => view.setVisible(visible),
      goBack: () => contents.navigationHistory.goBack(),
      goForward: () => contents.navigationHistory.goForward(),
      reload: () => contents.reload(),
      destroy: () => {
        window.contentView.removeChildView(view);
        contents.close();
      },
      onEvent: (listener) => {
        bridgeEvents(
          contents as unknown as WebContentsLike,
          {
            canGoBack: () => contents.navigationHistory.canGoBack(),
            canGoForward: () => contents.navigationHistory.canGoForward(),
          },
          listener,
        );
      },
    };
  };
}
