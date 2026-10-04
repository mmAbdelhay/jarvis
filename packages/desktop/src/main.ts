import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
import type { SocketCoreClient } from "./core/socket-core-client.js";
import { switchableCoreClient } from "./core/switchable-core-client.js";
import { DEFAULT_CONFIG_PATH } from "./config.js";
import { readBuildId } from "./daemon/build-id.js";
import {
  createDaemonMode,
  daemonSettingWriter,
  IN_APP_FLAG,
  relaunchArgs,
  type ChangeResult,
  type DaemonMode,
} from "./daemon/mode.js";
import { nodeDaemonModeDeps } from "./daemon/mode-node.js";
import { answerDbGateChallenge } from "./dbgate-login.js";
import { ELECTRON_BOUND_CHANNELS, registerDesktopOnly } from "./desktop-only.js";
import {
  countRunning,
  createUpdater,
  devOverrides,
  nodeExec,
  nodeUpdaterFs,
  replayStateOnLoad,
} from "./updater.js";
import { webExportDir } from "./web-export.js";
import { createElectronViewFactory } from "./electron-view.js";
import { ViewReconciler } from "./view-reconciler.js";
import { cacheFavicon as fetchFavicon } from "./favicon-fetch.js";
import { isAllowedNavigation } from "./navigation.js";
import { decidePermission } from "./permissions.js";
import { PRIMARY_HOTKEYS, registerVoiceHotkeys } from "./hotkeys.js";
import { errorMessage, isWayland, MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";
import { daemonScriptPath } from "./daemon/script-path.js";
import { launchDaemonFromApp } from "./daemon/app-launcher.js";
import { appImageOf } from "./daemon/service-linux.js";
import { claimSingleInstance } from "./single-instance.js";
import { openBridgeWebUrl } from "./open-external-guard.js";
import type { RemoteStatus } from "@jarvis/remote";

/**
 * `<Jarvis binary> --jarvis-daemon`: start jarvisd (daemon/app-launcher.ts).
 *
 * Windows' autostart (the HKCU Run value, service-win32.ts) and its start
 * button launch the app binary with this flag, since there is no separate
 * Node to run the daemon with; so does a Linux AppImage's systemd unit
 * (service-linux.ts), whose binary lives in a mount that is gone once the
 * app quits. No window and no core either way, and no single-instance lock:
 * this starts the daemon whether or not the app is open. The daemon takes
 * its own lock, so a second launch exits there.
 */
const launchingDaemon = process.argv.includes("--jarvis-daemon");
if (launchingDaemon) {
  launchDaemonFromApp({
    execPath: process.execPath,
    script: daemonScriptPath({
      platform: process.platform,
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      distSrcDir: dirname(fileURLToPath(import.meta.url)),
    }),
    env: process.env,
    spawn(command, args, options) {
      const child = spawn(command, [...args], options);
      return {
        onExit: (listener) => void child.once("exit", (code) => listener(code)),
        onError: (listener) => void child.on("error", listener),
        kill: (signal) => void child.kill(signal),
        unref: () => void child.unref(),
      };
    },
    onSignal: (signal, listener) => void process.on(signal, listener),
    exit: (code) => app.exit(code),
    log: (line) => console.error(line),
  });
}

/** The app's window, once there is one: a second instance brings it forward. */
let focusAppWindow: () => void = () => {};

/** One app per user data directory (single-instance.ts, review I1). */
const onlyInstance = !launchingDaemon && claimSingleInstance(app, () => focusAppWindow());

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
    // The file sidebar's Move to Trash. The core has already proven the
    // path inside a project (ipc.ts's trashEntry) before it gets here.
    trashItem: (path) => electronShell.trashItem(path),
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
  // A second instance: the first has been told, and this one is quitting.
  if (launchingDaemon || !onlyInstance) return;
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
    // Where the core runs (Task 23): in this process, or in jarvisd when
    // "Keep Jarvis running in the background" is on. daemon/mode.ts decides
    // and moves it; this only wires the real dependencies.
    const platform = process.platform;
    const distSrcDir = dirname(fileURLToPath(import.meta.url));
    let inProcessCore: Awaited<ReturnType<typeof createCore>> | undefined;
    /** The daemon the app is attached to, when it is. */
    let attached: SocketCoreClient | undefined;
    const startCore = () =>
      createCore({
        platform,
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
    let appWindow: BrowserWindow | undefined;
    const language = PRIMARY_LANGUAGE;
    const appImage = platform === "linux" ? appImageOf(process.env, process.execPath) : undefined;
    const nodeDeps = nodeDaemonModeDeps({
      platform,
      home: homedir(),
      uid: process.getuid?.() ?? 0,
      execPath: process.execPath,
      // An AppImage's own file: execPath is inside its temporary mount.
      ...(appImage === undefined ? {} : { appImage }),
      daemonScript: daemonScriptPath({
        platform,
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        distSrcDir,
      }),
      build: readBuildId(join(distSrcDir, "..", "build-stamp.json")),
      configPath: DEFAULT_CONFIG_PATH,
      restartDaemon: (): Promise<void> => mode.restartDaemon(),
      log: (line) => console.error(`[jarvisd link] ${line}`),
    });
    const mode: DaemonMode<SocketCoreClient> = createDaemonMode<SocketCoreClient>({
      ...nodeDeps,
      config: {
        read: nodeDeps.config.read,
        // Through the live core's own serialized config writer — the
        // daemon's when attached — so the toggle never races a settings
        // save or the bridge's idle auto-disable. With no core at all
        // (between a daemon's stop and a relaunch) the file is written
        // directly: nothing else is writing it then.
        write: daemonSettingWriter(
          () => ({ inProcess: inProcessCore, attached }),
          nodeDeps.config.write,
        ),
      },
      async confirm(change) {
        const options = {
          type: "question" as const,
          buttons: [MESSAGES.daemonContinue(language), MESSAGES.daemonCancel(language)],
          defaultId: 1,
          cancelId: 1,
          message:
            change === "enable"
              ? MESSAGES.daemonConfirmEnableTitle(language)
              : MESSAGES.daemonConfirmDisableTitle(language),
          detail:
            change === "enable"
              ? MESSAGES.daemonConfirmEnable(language)
              : MESSAGES.daemonConfirmDisable(language),
        };
        const answer =
          appWindow === undefined
            ? await dialog.showMessageBox(options)
            : await dialog.showMessageBox(appWindow, options);
        return answer.response === 0;
      },
      async chooseFallback(failure) {
        const answer = await dialog.showMessageBox({
          type: "error",
          buttons: [MESSAGES.daemonRunInApp(language), MESSAGES.daemonQuit(language)],
          defaultId: 0,
          cancelId: 1,
          message: MESSAGES.daemonFallbackTitle(language),
          detail: MESSAGES.daemonFallback(failure.reason, failure.lastLogLine, language),
        });
        return answer.response === 0 ? "in-app" : "quit";
      },
      async stopInProcess() {
        const core = inProcessCore;
        inProcessCore = undefined;
        await core?.shutdown();
      },
      useDaemon(link) {
        attached = link;
        client.switchTo(link);
        // Everything the renderer drew came from the old core: it starts
        // over against the new one, in the same window.
        appWindow?.webContents.reload();
      },
      async useInProcess() {
        attached = undefined;
        inProcessCore = await startCore();
        client.switchTo(inProcessCoreClient(inProcessCore));
        inProcessCore.startRemote();
        appWindow?.webContents.reload();
      },
      async showError(title, body) {
        dialog.showErrorBox(title, body);
      },
      relaunch({ inApp }) {
        app.relaunch({ args: relaunchArgs(process.argv.slice(1), inApp) });
        app.exit(0);
      },
      log: (line) => console.error(`[background] ${line}`),
    });

    const launch = await mode.launch({ inAppThisSession: process.argv.includes(IN_APP_FLAG) });
    if (launch.kind === "quit") {
      app.quit();
      return;
    }
    if (launch.kind === "in-process") inProcessCore = await startCore();
    else attached = launch.link;
    // Everything below reaches the core through `client` alone
    // (main-core-seam.test.ts): the in-process adapter or jarvisd's socket,
    // and after a switch the other one, with no other change here.
    const client = switchableCoreClient(
      launch.kind === "daemon"
        ? launch.link
        : inProcessCoreClient(inProcessCore as Awaited<ReturnType<typeof createCore>>),
      (line) => console.error(line),
    );
    const { window, views, local } = createDesktopHost(client);
    appWindow = window;
    focusAppWindow = () => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    };
    /** A thrown mode call becomes the renderer's failed result. */
    const settle = (run: () => Promise<ChangeResult>): Promise<ChangeResult> =>
      run().catch((error: unknown) => ({
        ok: false as const,
        reason: "failed" as const,
        detail: errorMessage(error),
      }));
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

    // The updater (updater.ts): checks at launch (below, once the window is
    // shown) and every 24h; installs only on the user's click.
    const updater = createUpdater({
      current: app.getVersion(),
      packaged: app.isPackaged,
      platform,
      arch: process.arch,
      pid: process.pid,
      execPath: process.execPath,
      ...(appImage === undefined ? {} : { appImage }),
      ...devOverrides(process.env, app.isPackaged),
      userData: app.getPath("userData"),
      env: process.env,
      fetch: (input, init) => fetch(input, init),
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      fs: nodeUpdaterFs,
      exec: nodeExec,
      spawnDetached(cmd, args, options) {
        const child = spawn(cmd, args, {
          cwd: options.cwd,
          env: options.env,
          detached: true,
          stdio: "ignore",
        });
        child.on("error", (error) =>
          console.error(`updater: swap script failed to start: ${errorMessage(error)}`),
        );
        child.unref();
      },
      openPath: (path) => electronShell.openPath(path),
      quit: () => app.quit(),
      runningCounts: () =>
        countRunning({
          terminalTabs: () =>
            client.workspace
              .state()
              .tabs.filter((tab) => tab.kind === "terminal")
              .map((tab) => tab.id),
          panes: (tabId) => client.invoke("terminal:panes", [tabId]),
          sessions: () => client.invoke("sessions:list", []),
        }),
      push: (state) => local("update:state", state),
    });
    app.on("will-quit", () => updater.stop());
    replayStateOnLoad(window.webContents, updater, (state) => local("update:state", state));

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
      // Task 8: the tab menu's own Plans item — the renderer owns every
      // tab's plan panel, so main only names which tab to toggle.
      startTabPlans: (tabId) => local("workspace:tabPlans", tabId),
      // Task 8 fix round 1: only a terminal tab has a plan panel at all.
      isTerminalTab: (tabId) =>
        client.workspace.state().tabs.some((tab) => tab.id === tabId && tab.kind === "terminal"),
      shell: electronShell,
      updater,
      language: PRIMARY_LANGUAGE,
      background: {
        status: () => mode.status(),
        setEnabled: (enabled) => settle(() => mode.setEnabled(enabled)),
        restart: () => settle(() => mode.restart()),
        stopNow: () => settle(() => mode.stopNow()),
      },
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
    updater
      .start()
      .catch((error: unknown) => console.error(`updater: start failed: ${errorMessage(error)}`));

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
