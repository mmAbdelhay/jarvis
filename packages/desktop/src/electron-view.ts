import { BrowserWindow, WebContentsView, desktopCapturer, screen, type Session } from "electron";
import {
  bridgeEvents,
  bridgePopupWindow,
  hostedUserAgent,
  type DevToolsDock,
  type HostedViewEvent,
  type PopupContentsLike,
  type PopupPolicy,
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

export type ElectronViewOptions = {
  /** Asked on every popup, so the setting is read where it is used. */
  allowPopups(): boolean;
};

/** Sessions that already answer getDisplayMedia. A partition is shared by
 *  every tab of a project, and a session takes one handler. */
const screenShareSessions = new WeakSet<Session>();

/**
 * Lets a hosted page share the screen — "Present now" in Google Meet, and
 * every other getDisplayMedia call. Electron refuses the call outright until
 * a session has a handler, which is why sharing did nothing at all.
 *
 * The system picker first: on macOS 15 and later it is the same "choose a
 * screen or a window" sheet every other app shows, and the handler below is
 * not called. Where that picker does not exist the whole screen the window
 * is on is shared, because a picker of our own could not be drawn above the
 * page asking for it (a hosted view paints over the renderer).
 */
function enableScreenShare(session: Session, window: BrowserWindow): void {
  if (screenShareSessions.has(session)) return;
  screenShareSessions.add(session);
  session.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void desktopCapturer
        .getSources({ types: ["screen"] })
        .then((sources) => {
          const displayId = window.isDestroyed()
            ? undefined
            : String(screen.getDisplayMatching(window.getBounds()).id);
          const source =
            sources.find((candidate) => candidate.display_id === displayId) ?? sources[0];
          // No source means screen recording was refused in System Settings;
          // answering with nothing is how the page is told no.
          callback(source === undefined ? {} : { video: source });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: true },
  );
}

export function createElectronViewFactory(
  window: BrowserWindow,
  options: ElectronViewOptions,
): ViewFactory {
  // No partition here: Chromium creates a popup in its opener's session, which
  // is what keeps a sign-in popup's cookies the project's own.
  //
  // And no `parent`. A child of the full-screen main window makes macOS hide
  // that window when the child appears and never show it again once the child
  // closes: Jarvis went to a black screen after a Microsoft sign-in
  // popup. Unparented, the popup opens on a Space of its own and macOS brings
  // the full-screen window back when it closes — measured on that same popup,
  // the main page went hidden → visible instead of staying hidden.
  const popupPolicy: PopupPolicy = {
    allow: () => options.allowPopups(),
    windowOptions: {
      autoHideMenuBar: true,
      backgroundColor: "#ffffff",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    },
  };

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
    enableScreenShare(contents.session, window);

    const listeners: ((event: HostedViewEvent) => void)[] = [];
    const emit = (event: HostedViewEvent): void => {
      for (const listener of [...listeners]) listener(event);
    };
    bridgeEvents(
      contents as unknown as WebContentsLike,
      {
        canGoBack: () => contents.navigationHistory.canGoBack(),
        canGoForward: () => contents.navigationHistory.canGoForward(),
      },
      emit,
      popupPolicy,
    );

    // Popups this page opened, and any they opened in turn. They belong to
    // the page: closing the tab closes them, rather than leaving a sign-in
    // window open for a page that no longer exists.
    const popupWindows = new Set<BrowserWindow>();
    const adoptPopup = (popup: BrowserWindow): void => {
      popupWindows.add(popup);
      popup.on("closed", () => popupWindows.delete(popup));
      popup.webContents.setUserAgent(hostedUserAgent(popup.webContents.getUserAgent()));
      bridgePopupWindow(popup.webContents as unknown as PopupContentsLike, emit, popupPolicy);
      popup.webContents.on("did-create-window", adoptPopup);
    };
    contents.on("did-create-window", adoptPopup);

    // DevTools, when they have been asked for. Rendered into a second view
    // of our own rather than opened as a detached window or docked by
    // Chromium: docking is a BrowserWindow feature and a hosted view has no
    // window of its own, and a detached window could not be sized as part of
    // the layout. setDevToolsWebContents is the supported way to host them
    // anywhere — the panel is then just another rectangle the renderer
    // measures, exactly like the page slot.
    //
    // Undocked is the same view moved into a window of its own, not a second
    // DevTools: a view can change parents, and DevTools' web contents cannot
    // be swapped once they are attached.
    let devTools: WebContentsView | undefined;
    let devToolsBounds: Rect | undefined;
    let devToolsWanted = false;
    let devToolsDock: DevToolsDock = "bottom";
    let devToolsWindow: BrowserWindow | undefined;
    let pageVisible = false;

    const fitDevToolsWindow = (): void => {
      if (devTools === undefined || devToolsWindow === undefined) return;
      const [width = 0, height = 0] = devToolsWindow.getContentSize();
      devTools.setBounds({ x: 0, y: 0, width, height });
    };

    /** Moves the view back into the main window. `dispose` is false only
     *  from the undocked window's own close handler, where it is already
     *  going away. */
    const redock = (dispose: boolean): void => {
      const undocked = devToolsWindow;
      if (undocked === undefined || devTools === undefined) return;
      devToolsWindow = undefined;
      if (!undocked.isDestroyed()) undocked.contentView.removeChildView(devTools);
      if (!window.isDestroyed()) {
        window.contentView.addChildView(devTools);
        if (devToolsBounds !== undefined) devTools.setBounds(devToolsBounds);
      }
      if (dispose && !undocked.isDestroyed()) {
        undocked.removeAllListeners("close");
        undocked.destroy();
      }
    };

    const undock = (): void => {
      if (devTools === undefined || devToolsWindow !== undefined) return;
      const undocked = new BrowserWindow({
        width: 1000,
        height: 720,
        title: `DevTools — ${contents.getTitle()}`,
        backgroundColor: "#202124",
        autoHideMenuBar: true,
      });
      devToolsWindow = undocked;
      window.contentView.removeChildView(devTools);
      undocked.contentView.addChildView(devTools);
      devTools.setVisible(true);
      fitDevToolsWindow();
      undocked.on("resize", fitDevToolsWindow);
      // Closing the window is closing DevTools. The renderer did not ask for
      // it, so it is told — otherwise the toggle stays lit and the next click
      // "closes" DevTools that are already gone.
      undocked.on("close", () => {
        redock(false);
        devToolsWanted = false;
        contents.closeDevTools();
        placeDevTools();
        emit({ kind: "devtoolsClosed" });
      });
    };

    /** Puts the DevTools view wherever the dock and the open state say.
     *  Undocked DevTools stay on screen whichever tab is showing, as they do
     *  in Chrome; docked ones follow the page. */
    const placeDevTools = (): void => {
      if (devTools === undefined) return;
      if (devToolsWanted && devToolsDock === "undocked") {
        undock();
        return;
      }
      redock(true);
      devTools.setVisible(pageVisible && devToolsWanted);
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
      placeDevTools();
    };

    const closeDevTools = (): void => {
      contents.closeDevTools();
      placeDevTools();
    };

    // Closing DevTools does not destroy the view they were rendered into —
    // the docs are explicit that this is the caller's job.
    const destroyDevTools = (): void => {
      if (devTools === undefined) return;
      const undocked = devToolsWindow;
      devToolsWindow = undefined;
      if (undocked !== undefined && !undocked.isDestroyed()) {
        undocked.removeAllListeners("close");
        undocked.contentView.removeChildView(devTools);
        undocked.destroy();
      } else if (!window.isDestroyed()) {
        window.contentView.removeChildView(devTools);
      }
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
        placeDevTools();
      },
      goBack: () => contents.navigationHistory.goBack(),
      goForward: () => contents.navigationHistory.goForward(),
      reload: () => contents.reload(),
      destroy: () => {
        destroyDevTools();
        for (const popup of popupWindows) if (!popup.isDestroyed()) popup.destroy();
        popupWindows.clear();
        // On quit the window is already gone, and removing a child from a
        // destroyed window throws — which used to stop every tab after the
        // first from being closed at all.
        if (!window.isDestroyed()) window.contentView.removeChildView(view);
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
        // Undocked, the view is sized by its own window, not the layout.
        if (devToolsWindow === undefined) devTools?.setBounds(bounds);
      },
      setDevToolsDock: (dock) => {
        if (dock === devToolsDock) return;
        devToolsDock = dock;
        placeDevTools();
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
            console.error(
              `Picture-in-Picture failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      },
      onEvent: (listener) => {
        listeners.push(listener);
      },
    };
  };
}
