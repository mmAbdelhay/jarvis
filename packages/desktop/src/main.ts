import { spawn } from "node:child_process";
import { dirname } from "node:path";
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
import { INVOKE_CHANNELS, preloadChannelArgs, type PushChannels } from "./channels.js";
import { createCore } from "./core/compose.js";
import { inProcessCoreClient, type CoreChannel, type CoreClient } from "./core/core-client.js";
import { answerDbGateChallenge } from "./dbgate-login.js";
import { ELECTRON_BOUND_CHANNELS, registerDesktopOnly } from "./desktop-only.js";
import { webExportDir } from "./web-export.js";
import { createElectronViewFactory } from "./electron-view.js";
import { ViewReconciler } from "./view-reconciler.js";
import { cacheFavicon as fetchFavicon } from "./favicon-fetch.js";
import { isAllowedNavigation } from "./navigation.js";
import { decidePermission } from "./permissions.js";
import { PRIMARY_HOTKEYS, registerVoiceHotkeys } from "./hotkeys.js";
import { errorMessage, isWayland, MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";
import { daemonScriptPath } from "./daemon/script-path.js";
import { openBridgeWebUrl } from "./open-external-guard.js";
import type { RemoteStatus } from "@jarvis/remote";

/**
 * `<Jarvis binary> --jarvis-daemon`: start jarvisd and get out of the way.
 *
 * Windows' autostart (the HKCU Run value, service-win32.ts) and its start
 * button launch the app binary with this flag, since there is no separate
 * Node to run the daemon with. The binary runs itself again as plain Node
 * (ELECTRON_RUN_AS_NODE) on the daemon's script, detached and without a
 * console window, and this process exits before it is ready — no window,
 * no core, no second anything. The daemon takes its own single-instance
 * lock, so a second launch exits there with code 3.
 */
const launchingDaemon = process.argv.includes("--jarvis-daemon");
if (launchingDaemon) {
  const script = daemonScriptPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    distSrcDir: dirname(fileURLToPath(import.meta.url)),
  });
  try {
    spawn(process.execPath, [script, "run"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    })
      .on("error", (error) => console.error(`jarvisd failed to start: ${errorMessage(error)}`))
      .unref();
  } catch (error) {
    console.error(`jarvisd failed to start: ${errorMessage(error)}`);
  }
  app.exit(0);
}

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
 * The request channels the core answers — every invoke channel but the
 * Electron-bound ones registerDesktopOnly serves here, in the host.
 */
function coreChannels(): CoreChannel[] {
  const local: ReadonlySet<string> = new Set(ELECTRON_BOUND_CHANNELS);
  return [...new Set(Object.values(INVOKE_CHANNELS))].filter(
    (channel): channel is CoreChannel => !local.has(channel),
  );
}

/**
 * The desktop host: the window and the Workspace's pages, attached to the
 * core as its DesktopHost.
 *
 * Everything here is Electron — the BrowserWindow, its permission and
 * navigation guards, the ViewReconciler that keeps one WebContentsView per
 * page tab in the core's tab state, and the per-project session partitions
 * favicons are fetched through. It reaches the core only through `client`,
 * which is the same whether the core runs in this process or in jarvisd.
 */
function createDesktopHost(client: CoreClient) {
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
      additionalArguments: [
        ...(client.firstRun ? ["--jarvis-first-run"] : []),
        ...preloadChannelArgs(),
      ],
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
      allowPopups: () => client.hostConfig().allowPopups,
    }),
    client.workspace,
    {
      cacheFavicon,
      suspendAfterMs: client.hostConfig().suspendTabsAfterMs,
    },
  );
  views.follow(client.workspace);

  /** The size cap, the image-type check and the miss-on-failure rule all
   *  live in favicon-fetch.ts, where they are testable without Electron.
   *  This is only the binding of the store to it. */
  async function cacheFavicon(pageUrl: string, iconUrl: string, from: Session): Promise<void> {
    // The core takes the icon as base64: CoreClient carries JSON values only.
    await fetchFavicon(
      {
        put: (url, bytes, type) =>
          client.favicons.put(url, Buffer.from(bytes).toString("base64"), type),
        putMiss: (url) => client.favicons.putMiss(url),
      },
      pageUrl,
      iconUrl,
      from,
    );
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

  // Every push the core sends this app, into this window's renderer.
  const toWindow = rendererSink(window);
  const stopPushes = client.onPush(toWindow);

  const detach = client.attachHost({
    isFocused: () => window.isFocused(),
    isAwake: () => window.isVisible() && !window.isMinimized(),
    requestFavicon,
    sweepIdleViews: () => views.sweepIdle(),
    destroyViews: () => views.destroy(),
    // Phase 0: a global login lockout or a reused refresh token.
    showNotification: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    // Phase 1: remote:openWebClient's system browser (dispatch.ts).
    // Only the bridge's own web client, checked against its live status
    // (open-external-guard.ts) — the same rule as the socket adapter's.
    openExternal: (url) =>
      openBridgeWebUrl(url, {
        status: () => client.invoke("remote:status", []) as Promise<RemoteStatus>,
        open: (checked) => electronShell.openExternal(checked),
        log: (line) => console.error(line),
      }),
    // A restart the user did not ask for is the wrong kind of "helpful"
    // — this only ever fires from the renderer's own Restart button
    // click, after a save has already succeeded.
    restart: () => {
      app.relaunch();
      app.exit(0);
    },
  });

  // The window is going: stop reaching into it, then drop its pages here,
  // without waiting for the core to ask. Registered before main's own
  // "closed" listener, so this runs before the core's stop(); the core's
  // own views teardown then finds no host and does nothing. A core in
  // jarvisd keeps running after the window closes, so it would never ask.
  // Detaching first also stops a core timer from calling isFocused() on a
  // destroyed BrowserWindow, which throws.
  window.on("closed", () => {
    stopPushes();
    detach();
    views.destroy();
  });

  /** A push about this window alone — its DevTools, its tab chips — which
   *  no other client has a panel for, so it never goes through the core. */
  function local<C extends keyof PushChannels>(channel: C, payload: PushChannels[C]): void {
    toWindow(channel, payload);
  }

  return { window, views, local };
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
  // Launching the daemon only: no window, no core (see launchingDaemon).
  if (launchingDaemon) return;
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
    // The core, in this process. Everything below reaches it through
    // `client` alone (main-core-seam.test.ts), so a core running in jarvisd
    // is a different adapter here and no other change.
    const client = inProcessCoreClient(
      await createCore({
        platform: process.platform,
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
      }),
    );
    const { window, views, local } = createDesktopHost(client);
    const releaseChildren = (): void => client.stop();

    // DbGate is spawned with BASIC_AUTH=1 (dbgate.ts) and answers with
    // Electron's own login challenge rather than showing its JWT form —
    // answerDbGateChallenge is the pure decision of when it is safe to
    // answer; this only wires it (ruling 15).
    app.on("login", (event, _webContents, _details, authInfo, callback) => {
      if (answerDbGateChallenge(authInfo, (port) => client.dbgateCredentialFor(port), callback)) {
        event.preventDefault();
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

    // Every request the core answers (dispatch.ts's table), forwarded
    // through the client in a loop — the renderer's arguments as they
    // came, the origin always the desktop's.
    for (const channel of coreChannels()) {
      ipcMain.handle(channel, (_event, ...args: unknown[]) => client.invoke(channel, args));
    }

    registerDesktopOnly({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      window,
      screen,
      dialog,
      buildMenu: (template) => Menu.buildFromTemplate(template),
      views,
      chooseDock: (dock) => local("workspace:devtoolsDockChosen", dock),
      // Bug 2: the tab menu's Reload is workspace:reload's own view call,
      // and Close runs the dispatch table's workspace:close (terminal
      // close, follower unfollow, desktopSizedPanes cleanup) — called
      // directly rather than duplicated here.
      reloadTab: (tabId) => views.reload(tabId),
      closeTab: (tabId) => {
        client
          .invoke("workspace:close", [tabId])
          .catch((error: unknown) =>
            console.error(`tab menu: close failed: ${errorMessage(error)}`),
          );
      },
      startTabRename: (tabId) => local("workspace:tabRename", tabId),
      language: PRIMARY_LANGUAGE,
    });
    views.onDevToolsClosed((tabId) => local("workspace:devtoolsClosed", tabId));

    // The bridge's lifecycle, started where it always was: after every
    // request handler is registered. See CoreClient.startRemote.
    client.startRemote();

    // Alt+Space, or on Windows a fallback pair when another app holds it —
    // see hotkeys.ts. Which pair is live is reported to the renderer below,
    // so every hint it draws names a key that actually works.
    const hotkeys = registerVoiceHotkeys(
      {
        register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
        unregister: (accelerator) => globalShortcut.unregister(accelerator),
        onStart: () => client.voice.start(),
        onStop: () => client.voice.stop(),
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
      client.broadcast("turn:new", {
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
        client.broadcast("turn:new", {
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
      client.broadcast("voice:hotkeys", hotkeys.active);
    }

    await client.announceStartup();
  } catch (error) {
    dialog.showErrorBox("Jarvis failed to start", errorMessage(error));
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
