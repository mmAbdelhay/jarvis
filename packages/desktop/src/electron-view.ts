import { WebContentsView, type BrowserWindow } from "electron";
import {
  bridgeEvents,
  hostedUserAgent,
  type Rect,
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
/**
 * Run in the page to find the video worth acting on. "Playing" is spelled
 * out rather than left to `!paused`: a <video> that has never decoded a
 * frame reports videoWidth 0, and an <audio>-only stream in a <video> tag
 * reports the same — neither has anything to float, and offering to float
 * them is exactly the dead button this check exists to prevent.
 *
 * Only the top document. A cross-origin iframe cannot be reached from here
 * at all, and the sites this is for (YouTube, and any page with its own
 * player) put the element in the top document.
 */
const FIND_PLAYING_VIDEO =
  "Array.from(document.querySelectorAll('video')).find(" +
  "(v) => !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0)";

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

    // Hosted pages must not look like an Electron app to themselves — see
    // hostedUserAgent. Set on the WebContents rather than the session so it
    // covers subframes and survives a partition shared with another view.
    contents.setUserAgent(hostedUserAgent(contents.getUserAgent()));

    // DevTools, when they have been asked for. Rendered into a second view
    // of our own rather than opened as a detached window or docked by
    // Chromium: docking is a BrowserWindow feature and a hosted view has no
    // window of its own, and a detached window could not be sized as part of
    // the layout. setDevToolsWebContents is the supported way to host them
    // anywhere — the panel is then just another rectangle the renderer
    // measures, exactly like the page slot.
    let devTools: WebContentsView | undefined;
    let devToolsBounds: Rect | undefined;
    let devToolsWanted = false;
    let pageVisible = false;

    const syncDevToolsVisibility = (): void => {
      devTools?.setVisible(pageVisible && devToolsWanted);
    };

    const openDevTools = (): void => {
      if (devTools === undefined) {
        devTools = new WebContentsView({
          webPreferences: { contextIsolation: true, nodeIntegration: false },
        });
        window.contentView.addChildView(devTools);
        if (devToolsBounds !== undefined) devTools.setBounds(devToolsBounds);
        contents.setDevToolsWebContents(devTools.webContents);
      }
      // openDevTools() is what actually loads the panel into the view above.
      // 'detach' keeps Chromium from trying to dock them itself; the view is
      // already ours to place.
      contents.openDevTools({ mode: "detach" });
      syncDevToolsVisibility();
    };

    const closeDevTools = (): void => {
      contents.closeDevTools();
      syncDevToolsVisibility();
    };

    // Closing DevTools does not destroy the view they were rendered into —
    // the docs are explicit that this is the caller's job.
    const destroyDevTools = (): void => {
      if (devTools === undefined) return;
      window.contentView.removeChildView(devTools);
      devTools.webContents.close();
      devTools = undefined;
    };

    return {
      loadURL: (url) => {
        // A load rejects on an aborted or failed navigation; did-fail-load
        // already reports that, and an unhandled rejection here would take
        // down the main process.
        void contents.loadURL(url).catch(() => undefined);
      },
      setBounds: (bounds) => view.setBounds(bounds),
      setVisible: (visible) => {
        pageVisible = visible;
        view.setVisible(visible);
        syncDevToolsVisibility();
      },
      goBack: () => contents.navigationHistory.goBack(),
      goForward: () => contents.navigationHistory.goForward(),
      reload: () => contents.reload(),
      destroy: () => {
        destroyDevTools();
        window.contentView.removeChildView(view);
        contents.close();
      },
      setDevTools: (open) => {
        if (open === devToolsWanted) return;
        devToolsWanted = open;
        if (open) openDevTools();
        else closeDevTools();
      },
      setDevToolsBounds: (bounds) => {
        devToolsBounds = bounds;
        devTools?.setBounds(bounds);
      },
      hasPlayingVideo: () =>
        contents
          .executeJavaScript(`!!(${FIND_PLAYING_VIDEO})`)
          // A page that is navigating away, or one whose frame has already
          // gone, rejects instead of answering. That is "no video", not a
          // reason to take the main process down with an unhandled
          // rejection.
          .then((result: unknown) => result === true)
          .catch(() => false),
      requestPictureInPicture: () => {
        // The page's own API, not a window of ours: Chromium's PiP window
        // is a real always-on-top OS window that outlives switching tabs,
        // routes and applications, which a WebContentsView could never be
        // (it is a child of our window and is painted inside it). Verified
        // to work in a WebContentsView — see spikes/pip/FINDINGS.md.
        //
        // A second press puts it back, which is what every browser's PiP
        // button does.
        //
        // userGesture: true because requestPictureInPicture() is gated on
        // one, and the user's click landed on our chrome rather than in
        // the page.
        void contents
          .executeJavaScript(
            `(async () => {
               const video = ${FIND_PLAYING_VIDEO};
               if (video === undefined) return "no-video";
               if (document.pictureInPictureElement !== null) {
                 await document.exitPictureInPicture();
                 return "exited";
               }
               // Netflix and Prime Video ship their players with Picture-in-
               // Picture switched off at the element — the attribute and the
               // property both, re-applied as the player rebuilds its video
               // tag. requestPictureInPicture() rejects with InvalidStateError
               // while either is set, which is why PiP appeared to do nothing
               // on exactly the two sites the CDM was added for.
               //
               // Clearing it is the same thing every "enable PiP everywhere"
               // extension does. It is cleared per request rather than once
               // per page because the player puts it back: the flag is read
               // by the browser only at the moment of the call, so the value
               // that matters is the one in place on this line.
               video.disablePictureInPicture = false;
               video.removeAttribute("disablePictureInPicture");
               await video.requestPictureInPicture();
               return "entered";
             })()`,
            true,
          )
          // Silence here is what made this hard to diagnose: a rejected
          // request looked exactly like a working one. The failure is not
          // worth a dialog — the user can press the button again — but it
          // belongs in the log.
          .catch((error: unknown) => {
            console.error(`Picture-in-Picture failed: ${error instanceof Error ? error.message : String(error)}`);
          });
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
