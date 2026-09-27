import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BrowserWindow,
  Menu,
  Notification,
  app,
  components,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  session,
  shell as electronShell,
} from "electron";
import type { Session } from "electron";
import { appMenuTemplate } from "./app-menu.js";
import { windowChrome } from "./window-chrome.js";
import { rendererSink } from "./broadcast.js";
import { preloadChannelArgs } from "./channels.js";
import { createCore, MINUTE_MS, type HostContext } from "./core/compose.js";
import { dbGateLoginAnswer } from "./dbgate-login.js";
import { DESKTOP_ORIGIN } from "./dispatch.js";
import { registerDesktopOnly } from "./desktop-only.js";
import { webExportDir } from "./web-export.js";
import { createElectronViewFactory } from "./electron-view.js";
import { ViewReconciler } from "./view-reconciler.js";
import { cacheFavicon as fetchFavicon } from "./favicon-fetch.js";
import { isAllowedNavigation } from "./navigation.js";
import { decidePermission } from "./permissions.js";
import { PRIMARY_HOTKEYS, registerVoiceHotkeys } from "./hotkeys.js";
import { errorMessage, isWayland, MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";

/** An asset beside the compiled main process. `import.meta.url` is
 *  dist/src/main.js at runtime and the build copies assets to dist/assets,
 *  which is one hop up — the same move copy-vendor.mjs makes for the
 *  renderer's vendored files. */
function iconPath(file: string): string {
  return fileURLToPath(new URL(`../assets/${file}`, import.meta.url));
}

/**
 * The dock icon while developing.
 *
 * A packaged .app takes its icon from the bundle, but `electron .` shows
 * Electron's own until it is told otherwise — which is every run during
 * development, and the only version of the app that exists today.
 */
function setDockIcon(): void {
  if (process.platform !== "darwin" || app.dock === undefined) return;
  try {
    app.dock.setIcon(iconPath("icon.png"));
  } catch {
    // A missing or unreadable icon is not a reason to fail to start.
  }
}

/**
 * The desktop host: the window and the Workspace's pages, built at the
 * point in createCore where main.ts always built them.
 *
 * Everything here is Electron — the BrowserWindow, its permission and
 * navigation guards, the ViewReconciler that keeps one WebContentsView per
 * page tab in the core's TabHost, and the per-project session partitions
 * favicons are fetched through. The core reaches it only through the
 * CoreHost it returns.
 */
function createDesktopHost({ firstRun, config, favicons, tabs }: HostContext) {
  const window = new BrowserWindow({
    // Jarvis is the surface you work from, not a panel beside something
    // else: it opens at the full working area — maximized, NOT macOS
    // fullscreen (the user asked for full width and height without the
    // separate fullscreen Space). `show: false` + maximize() below, so
    // the window never flashes at 1440×900 first; that stated size is
    // what unmaximize restores to.
    show: false,
    width: 1440,
    height: 900,
    // Linux and Windows draw the menu bar inside the window; macOS never
    // has and ignores this. See appMenuTemplate for what is in it and why
    // it is not simply removed.
    autoHideMenuBar: true,
    backgroundColor: "#060a0f",
    // Windows and Linux take the icon from the window; macOS takes it from
    // the bundle at package time and from the dock while developing, which
    // is what setDockIcon below is for.
    icon: iconPath("icon.png"),
    // Bug 1: Linux (GNOME/Wayland especially) and some Windows configs
    // leave the WM drawing no min/max/close decorations at all. See
    // window-chrome.ts — darwin gets {} back and is unaffected.
    ...windowChrome(process.platform),
    webPreferences: {
      preload: fileURLToPath(new URL("preload.cjs", import.meta.url)),
      // argv rather than an IPC call, because the renderer needs both
      // this and the channel table below while it is deciding what to
      // draw, before any round trip could answer. The channel table
      // itself has to travel this way too: preload runs sandboxed (see
      // below) and can't require("./channels.js"), so this is the only
      // path left to hand it the 118 channel names without pasting them
      // into preload.cts by hand.
      additionalArguments: [...(firstRun ? ["--jarvis-first-run"] : []), ...preloadChannelArgs()],
      // This renderer displays untrusted agent output and holds
      // `window.jarvis.send`. These already match Electron 44's implicit
      // defaults; stated explicitly so a future edit that weakens them
      // is visible in review.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Hosted views use persist:project-* partitions and never reach this
  // handler. In the Jarvis session, only geolocation needs caller gating.
  window.webContents.session.setPermissionRequestHandler((requesting, permission, callback) => {
    callback(decidePermission(permission, requesting.id === window.webContents.id));
  });

  // The Workspace's hosted pages. Each is a native WebContentsView over
  // this window, so the host — not CSS — decides where they sit and whether
  // they are visible at all. Which pages exist is the core's tab state; the
  // reconciler follows it.
  const views = new ViewReconciler(
    createElectronViewFactory(window, {
      allowPopups: () => config.browser.allowPopups,
    }),
    tabs,
    {
      cacheFavicon,
      suspendAfterMs: config.performance.suspendTabsAfterMinutes * MINUTE_MS,
    },
  );
  views.follow(tabs);

  /** The size cap, the image-type check and the miss-on-failure rule all
   *  live in favicon-fetch.ts, where they are testable without Electron.
   *  This is only the binding of the store to it. */
  async function cacheFavicon(pageUrl: string, iconUrl: string, from: Session): Promise<void> {
    await fetchFavicon(favicons, pageUrl, iconUrl, from);
  }

  /** The fallback path, for a bookmark never opened in Jarvis — which is
   *  everything imported from another browser. One request to the site's
   *  own /favicon.ico, through the project's own session partition — a
   *  site reachable only there (SSO, a VPN-scoped profile) would
   *  otherwise fail against a shared session and record a week-long
   *  miss. A failure is recorded as a miss so it is not retried on every
   *  render. The in-flight guard is keyed by project and origin
   *  together: two projects legitimately fetch the same origin through
   *  different sessions, and an origin-only key would let the first
   *  project's in-flight request suppress the second's entirely. */
  const fetching = new Set<string>();
  function requestFavicon(project: string, url: string): void {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return;
    }
    const key = `${project}\n${origin}`;
    if (fetching.has(key)) return;
    fetching.add(key);
    // The partition is what makes a project's logins its own, mirroring
    // view-reconciler.ts's own partition name — encodeURIComponent because
    // a project name is user-supplied config and a partition name with a
    // slash or a space in it is not addressable.
    const from = session.fromPartition(`persist:project-${encodeURIComponent(project)}`);
    void cacheFavicon(url, `${origin}/favicon.ico`, from).finally(() => fetching.delete(key));
  }

  const indexUrl = pathToFileURL(
    fileURLToPath(new URL("../../renderer/index.html", import.meta.url)),
  ).href;

  window.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, indexUrl)) {
      event.preventDefault();
    }
  });

  return {
    window,
    views,
    toRenderer: rendererSink(window),
    isFocused: () => window.isFocused(),
    isAwake: () => window.isVisible() && !window.isMinimized(),
    requestFavicon,
  };
}

/**
 * The Widevine CDM install, started at launch and awaited only by the tabs
 * that need it.
 *
 * `components` is the one API Electron for Content Security adds over stock
 * Electron: Chromium's component updater downloads the CDM into the user
 * data directory on first launch, and DRM playback fails until it lands.
 * castLabs' own example awaits it before creating the window; ruling R35
 * forbids that here, because it is a network fetch on the path between
 * app-ready and the window existing — a first launch would sit on a blank
 * screen for as long as the download takes.
 *
 * So it is started unawaited and the promise kept. A hosted tab that needs
 * DRM awaits this; every other tab, and the window itself, ignores it. The
 * cost of the split is that the very first DRM page after a fresh install
 * may load before the CDM does. Every later launch already has it on disk.
 */
export let widevineReady: Promise<void> | undefined;

app.whenReady().then(async () => {
  setDockIcon();

  // Electron's default menu is the standard Mac menu bar on darwin — which is
  // right, and where ⌘Q and the edit roles come from. Off darwin the same
  // default draws a visible File/Edit/View bar inside the window, over a UI
  // that opens full screen and has chrome of its own.
  //
  // So: a minimal role menu, hidden by autoHideMenuBar below. The roles are
  // not decoration — without them copy and paste stop working in ordinary
  // input fields, which is what makes "just remove the menu" the wrong fix.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate(process.platform, () => BrowserWindow.getFocusedWindow()?.reload()),
    ),
  );

  widevineReady = components
    .whenReady()
    .then(() => {
      console.log(`Widevine components ready: ${JSON.stringify(components.status())}`);
    })
    .catch((error: unknown) => {
      // Not fatal: everything in Jarvis except DRM playback works without it.
      console.error(`Widevine component install failed: ${errorMessage(error)}`);
    });
  try {
    const core = await createCore({
      platform: process.platform,
      attachHost: createDesktopHost,
      // Phase 0: a global login lockout or a reused refresh token.
      showNotification: (title, body) => {
        if (Notification.isSupported()) new Notification({ title, body }).show();
      },
      // Phase 1: remote:openWebClient's system browser (dispatch.ts).
      openExternal: (url) => electronShell.openExternal(url),
      // A restart the user did not ask for is the wrong kind of "helpful"
      // — this only ever fires from the renderer's own Restart button
      // click, after a save has already succeeded.
      restart: () => {
        app.relaunch();
        app.exit(0);
      },
      // Phase 1: the browser client's own listener, behind the bridge's
      // web gate. The export is read once, lazily (web-export.ts).
      webExportDir: () =>
        webExportDir({
          packaged: app.isPackaged,
          resourcesPath: process.resourcesPath,
          // From dist/src/main.js: packages/desktop/web, where `pnpm build`
          // copies the mobile app's web export (scripts/copy-web.mjs) —
          // the same directory electron-builder ships.
          devDir: fileURLToPath(new URL("../../web", import.meta.url)),
        }),
    });
    const { window, views } = core.host;
    const { dispatch, broadcast } = core;
    const releaseChildren = core.stop;

    // DbGate is spawned with BASIC_AUTH=1 (dbgate.ts) and answers with
    // Electron's own login challenge rather than showing its JWT form —
    // dbGateLoginAnswer is the pure decision of when it is safe to answer;
    // this only wires it (ruling 15).
    app.on("login", (event, _webContents, _details, authInfo, callback) => {
      const answer = dbGateLoginAnswer(authInfo, core.dbgateCredentialFor);
      if (answer !== undefined) {
        event.preventDefault();
        callback(answer.login, answer.password);
      }
    });

    window.on("closed", releaseChildren);
    // Cmd+Q with the window already gone, and every other quit that never
    // destroys a window.
    app.on("will-quit", releaseChildren);
    // A signal is not a quit: Electron's default handling tears the process
    // down without running "will-quit" listeners, so the children have to be
    // released here and the quit asked for explicitly. Exit code follows the
    // shell convention of 128 + signal number.
    for (const [signal, number] of [
      ["SIGINT", 2],
      ["SIGTERM", 15],
      ["SIGHUP", 1],
    ] as const) {
      process.on(signal, () => {
        releaseChildren();
        process.exit(128 + number);
      });
    }

    // Every request handler, in one table (dispatch.ts). Registered in a
    // loop so a second transport can call the same table with a different
    // Origin.
    for (const [channel, handler] of Object.entries(dispatch)) {
      ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(args, DESKTOP_ORIGIN));
    }

    registerDesktopOnly({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      window,
      screen,
      dialog,
      buildMenu: (template) => Menu.buildFromTemplate(template),
      views,
      chooseDock: (dock) => broadcast.local("workspace:devtoolsDockChosen", dock),
      // Bug 2: the tab menu's Reload is workspace:reload's own view call,
      // and Close runs the dispatch table's workspace:close (terminal
      // close, follower unfollow, desktopSizedPanes cleanup) — called
      // directly rather than duplicated here.
      reloadTab: (tabId) => views.reload(tabId),
      closeTab: (tabId) => void dispatch["workspace:close"]([tabId], DESKTOP_ORIGIN),
      startTabRename: (tabId) => broadcast.local("workspace:tabRename", tabId),
      language: PRIMARY_LANGUAGE,
    });
    views.onDevToolsClosed((tabId) => broadcast.local("workspace:devtoolsClosed", tabId));

    // The bridge's lifecycle, started where it always was: after every
    // request handler is registered. See core.startRemote.
    core.startRemote();

    // Alt+Space, or on Windows a fallback pair when another app holds it —
    // see hotkeys.ts. Which pair is live is reported to the renderer below,
    // so every hint it draws names a key that actually works.
    const hotkeys = registerVoiceHotkeys(
      {
        register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
        unregister: (accelerator) => globalShortcut.unregister(accelerator),
        onStart: core.voiceControl.start,
        onStop: core.voiceControl.stop,
      },
      process.platform,
    );

    // The recorder and any live sessions are released by releaseChildren,
    // which is already wired to "will-quit" above — and, unlike this
    // listener, to the signals that never reach "will-quit" at all. Only
    // the shortcuts are left here; nothing owns a process. A hard kill or
    // crash still reaches none of this, which is why
    // createSqliteSessionStore's startup reconciliation (session-store.ts)
    // remains the backstop for session rows.
    app.on("will-quit", () => {
      globalShortcut.unregisterAll();
    });

    // The renderer's own errors, surfaced in the terminal that launched the
    // app. Without this a renderer that dies at module load — a bad import
    // path, a CSP refusal, a missing element — takes the whole UI down in
    // total silence, which is exactly how it went unnoticed three times
    // during phase 1. Errors and warnings only: routine logs are the
    // renderer's business.
    window.webContents.on("console-message", (event) => {
      if (event.level !== "error" && event.level !== "warning") return;
      console.error(
        `[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`,
      );
    });

    // A page that fails to load at all never reaches the console at all.
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
    });

    await window.loadFile(fileURLToPath(new URL("../../renderer/index.html", import.meta.url)));

    // Maximized, then shown: the full working area without entering the
    // separate macOS fullscreen Space (see the BrowserWindow options above).
    window.maximize();
    window.show();

    // globalShortcut.register() does not throw on collision — a combo
    // already claimed by another app (window managers, Alfred, Raycast and
    // input-source switchers commonly claim Alt-combos) makes it return
    // false silently. Left unchecked, the headline feature is inert and
    // the UI still advertises a hotkey that will never fire.
    if (hotkeys.fellBack && hotkeys.active !== undefined) {
      // Taken, and answered rather than merely reported: the keys that do
      // work are named, and the renderer is told so its hints agree.
      broadcast.send("turn:new", {
        role: "assistant",
        text: MESSAGES.hotkeyFallback(
          PRIMARY_HOTKEYS.start,
          hotkeys.active.start,
          PRIMARY_LANGUAGE,
        ),
        language: PRIMARY_LANGUAGE,
        at: Date.now(),
      });
    } else {
      for (const combo of hotkeys.refused) {
        // Two causes, two pieces of advice. A collision means another app
        // holds the combo and the user can close it or pick another. Wayland
        // means no application can hold one at all, and saying "another app
        // is probably using it" would send them looking for something that
        // does not exist.
        broadcast.send("turn:new", {
          role: "assistant",
          text: isWayland(process.env)
            ? MESSAGES.hotkeyUnavailableWayland(combo, PRIMARY_LANGUAGE)
            : MESSAGES.hotkeyCollision(combo, PRIMARY_LANGUAGE),
          language: PRIMARY_LANGUAGE,
          at: Date.now(),
        });
      }
    }
    if (hotkeys.active !== undefined && hotkeys.active !== PRIMARY_HOTKEYS) {
      broadcast.send("voice:hotkeys", hotkeys.active);
    }

    await core.announceStartup();
  } catch (error) {
    dialog.showErrorBox("Jarvis failed to start", errorMessage(error));
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
