import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BrowserWindow,
  Menu,
  app,
  components,
  dialog,
  globalShortcut,
  ipcMain,
  screen,
  session,
} from "electron";
import type { Session } from "electron";
import { appMenuTemplate } from "./app-menu.js";
import { createBroadcaster, rendererSink } from "./broadcast.js";
import { preloadChannelArgs } from "./channels.js";
import { dbGateLoginAnswer } from "./dbgate-login.js";
import { createDispatchTable, DESKTOP_ORIGIN } from "./dispatch.js";
import { handleUtterance, type UtteranceDeps } from "./voice-turn.js";
import { createBlobTable } from "./remote-blob.js";
import { createFileUploadHandler, createFileUploadStore } from "./file-upload.js";
import { createApiExecutor } from "./api-executor.js";
import {
  createVoiceUploadHandler,
  TRANSCODE_TIMEOUT_MS,
  TRANSCRIBE_TIMEOUT_MS,
  type VoiceUploadDeps,
} from "./voice-upload.js";
import { registerDesktopOnly } from "./desktop-only.js";
import { createBridge } from "@jarvis/remote";
import {
  createSidecarProxy,
  listenTls,
  loadCertificate,
  nodeFs,
  nodeTimers,
} from "@jarvis/remote/listen";
import { createRemoteAccess, type RemoteAccess } from "./remote-access.js";
import { disableRemoteOnDisk } from "./remote-idle.js";
import { obtainCertificate, type TailscaleCertDeps } from "./tailscale-cert.js";
import { createNotifier } from "./notify.js";
import { createDockerFollowers } from "./docker-followers.js";
import { createSetupHandlers } from "./ipc.js";
import {
  AgentRegistry,
  ChangeTracker,
  Orchestrator,
  ProviderMonitor,
  ProviderStatusStore,
  SessionManager,
  greetingText,
  scanDirtyProjects,
} from "@jarvis/core";
// Aliased: electron's own `Session` (webContents session) is imported below
// under the bare name, and this file's cacheFavicon() already depends on
// that being the unqualified `Session`.
import type { Session as CoreSession, TabKind, WorkspaceTab } from "@jarvis/core";
import {
  audioPlayer,
  MacSpeech,
  WindowsSpeech,
  windowsPowerShellPath,
  onPath,
  PiperSpeech,
  RoutedSpeech,
  silentSpeech,
  createBookmarkStore,
  createBrain,
  createCapacityReader,
  createCodeServerManager,
  codeServerKey,
  createDbGateManager,
  createFaviconStore,
  createFsImportDeps,
  createGitProvider,
  createHeadlampManager,
  defaultHeadlampBinary,
  defaultHistoryPath,
  installShellIntegration,
  isBash,
  isPowerShell,
  parseBashHistory,
  parsePowerShellHistory,
  parseZshHistory,
  createKubeContextLister,
  createMetricsReader,
  createPtySpawner,
  createRealCodeServerSpawner,
  createRealDockerClient,
  createRealShellSpawner,
  shellCommand,
  createSessionImporter,
  listAgentProcesses,
  resolveProject,
  createShellManager,
  createCollection,
  createFolder,
  apiFetch,
  apiMultipart,
  createApiStore,
  createAwsSessionChecker,
  createAwsSessionPoller,
  createRequest,
  deleteEntry,
  dispatcherFor,
  evaluateAssertions,
  fetchOAuth2Token,
  runScript,
  truncateBody,
  listCollections,
  postmanToRequests,
  readCollection,
  readRequest,
  renameFolder,
  renameRequest,
  sendRequest,
  toCurl,
  writeEnvironment,
  writeImported,
  writeRequest,
  createRealDbGateSpawner,
  createRealHeadlampSpawner,
  createSqliteSessionStore,
  defaultSpeechRunner,
  listInstalledVoices,
  listWindowsVoices,
  defaultVoiceLister,
  loginShellPath,
  randomPassword,
  findFreePort,
  readStatusPage,
  resolveRealZdotdir,
  runCommand,
  runCommandWithLimits,
  transcodeToWhisperWavCommand,
  transcribe,
  waitUntilReady,
  withLocalBin,
} from "@jarvis/platform";
import {
  buildWiring,
  createApiHandlers,
  createBookmarksHandlers,
  createChatHandlers,
  createClusterHandlers,
  createDatabaseHandlers,
  createDockerHandlers,
  createEditorHandlers,
  createTerminalHandlers,
  createTranscriptHandler,
  createResumeInTerminalHandler,
  createGitHandlers,
  createSettingsHandlers,
  PROVIDER_HEALTH_INTERVAL_MS,
  showEditorTab,
} from "./ipc.js";
import { BrowserHost } from "./browser-host.js";
import { createSidecarReaper } from "./sidecar-reaper.js";
import { createElectronViewFactory } from "./electron-view.js";
import { cacheFavicon as fetchFavicon } from "./favicon-fetch.js";
import { isAllowedNavigation } from "./navigation.js";
import {
  createCompletionSource,
  createDirectoryLister,
  createFileReader,
} from "./completion-source.js";
import {
  DEFAULT_CONFIG_PATH,
  DEFAULT_TERMINAL,
  mergeConfigInPlace,
  providerAgentListsEqual,
  defaultSessionsScanPath,
  defaultWorkflowsDir,
  ensureConfigFile,
  loadConfig,
  type JarvisConfig,
} from "./config.js";
import { parseScan, serializeScan } from "./session-scan-cache.js";
import { decidePermission } from "./permissions.js";
import { PRIMARY_HOTKEYS, registerVoiceHotkeys } from "./hotkeys.js";
import { LOGIN_TERMINAL_DETAIL } from "./login-terminal.js";
import { serialize } from "./serialize.js";
import { writeSettingsFile } from "./settings-io.js";
import { errorMessage, isWayland, MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";
import { createRecorderDeps, Recorder } from "./recorder.js";
import { capacityReport, startupReport } from "./startup.js";

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

/** The `performance:` section states its timeouts in minutes, because that is
 *  the unit anybody reasons about "leave a tab alone for a while" in. Every
 *  consumer wants milliseconds. */
const MINUTE_MS = 60_000;

/** How often the idle sweeps run. Both are cheap — one walks the tab list,
 *  the other a map of at most a handful of child processes — so a minute is
 *  frequent enough to be responsive and rare enough to be invisible. It also
 *  bounds how far past its timeout anything can live: a tab set to suspend
 *  after fifteen minutes goes at fifteen, plus up to one. */
const SWEEP_INTERVAL_MS = 60_000;

/** How long the chip row's runtime probe waits for `node -v` before giving
 *  up on it. A hung shim (a broken version manager, a stalled
 *  network-mounted directory) must resolve `undefined`, not leave chips()
 *  pending forever — an absent chip beats one that never appears. */
const NODE_VERSION_PROBE_TIMEOUT_MS = 2000;

/**
 * `node -v` run inside `cwd` — the chip row's runtime probe. Spawned with
 * an explicit `cwd` rather than through the shared `runCommand` (which has
 * no cwd of its own and would report this process's own directory for
 * every pane): a version manager whose `node` shim reads the directory
 * (Volta, an `.nvmrc`-aware wrapper) only answers correctly when the
 * working directory it sees is the pane's, not Jarvis's. Resolves
 * `undefined` on a non-zero exit, any spawn failure, or a timeout — never
 * an error surfaced in a terminal, and never a promise left pending.
 */
function nodeVersionIn(cwd: string): Promise<string | undefined> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (result: string | undefined) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    try {
      const child = spawn("node", ["-v"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
      const timer = setTimeout(() => {
        // Kill it rather than leave it running unattended: a stuck probe
        // is not this pane's business to keep alive once it has stopped
        // being worth waiting for.
        child.kill();
        finish(undefined);
      }, NODE_VERSION_PROBE_TIMEOUT_MS);

      let stdout = "";
      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.on("error", () => {
        clearTimeout(timer);
        finish(undefined);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        finish(code === 0 ? stdout.trim() : undefined);
      });
    } catch {
      finish(undefined);
    }
  });
}

/** What a voice preview says. The greeting itself, so the sample is the
 *  sentence the user will actually hear every morning rather than a neutral
 *  line that hides how the voice handles it. */
/** How the Piper engine appears in the voice picker. */
const PIPER_VOICE = "Alan (neural)";
/** And its Arabic model, which off darwin is the only Arabic voice there is.
 *  Named for the picker the same way — the user is choosing a voice, not an
 *  engine. */
const PIPER_ARABIC_VOICE = "Kareem (neural)";

const VOICE_SAMPLE = {
  en: "Good evening sir, how can I help you today?",
  ar: "مساء الخير يا سيدي، كيف أقدر أساعدك اليوم؟",
};

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
    // First run on a machine writes the file it is about to read. Without
    // this, loadConfig throws ENOENT and the handler at the bottom of this
    // block turns it into "Jarvis failed to start" — which is what every
    // downloaded build did, on every machine but the one it was built on.
    // Whether this launch created the config file. The first-run setup screen
    // opens for it — and for a missing required prerequisite, which is the
    // other way a machine can have nothing to run an agent with.
    const firstRun = await ensureConfigFile(DEFAULT_CONFIG_PATH);
    const config = await loadConfig();
    const registry = new AgentRegistry(config.registry);

    const providerStore = new ProviderStatusStore(registry.list());
    // agentEnv is declared here, ahead of the capacity reader that closes
    // over it; the comment explaining it sits with the health check below,
    // which is what it was first built for.
    let agentEnv: NodeJS.ProcessEnv = withLocalBin(process.env, process.platform, homedir());
    const agentEnvReady = loginShellPath(process.env, process.platform)
      .then((path) => {
        if (path !== undefined) {
          agentEnv = withLocalBin({ ...process.env, PATH: path }, process.platform, homedir());
        }
      })
      .catch(() => undefined);
    // Free, all three sources — a snapshot file, Codex's own logs, one `gh`
    // call — never a billed query; see capacity-reader.ts. `gh` runs with
    // agentEnv (the login-shell PATH), so the first refresh waits for it.
    const readCapacity = createCapacityReader({
      run: (command, args) => runCommand(command, args, agentEnv),
      platform: process.platform,
    });
    const providers = new ProviderMonitor({
      agents: registry.list(),
      store: providerStore,
      readCapacity,
      readHealth: (vendor) => readStatusPage(vendor),
    });

    // Started, never awaited — ruling R35: nothing that touches the network
    // may sit between app-ready and the window existing. The health poll is
    // free, and so is the capacity refresh now (a snapshot file per account);
    // it still happens once here, at launch, and on the panel's refresh
    // button. There is no capacity interval anywhere in this file.
    void providers.refreshHealth();
    const capacityPromise = agentEnvReady
      .then(() => providers.refreshCapacity())
      .catch((error) => {
        console.error(`Provider capacity refresh failed: ${errorMessage(error)}`);
      });

    // Started, not awaited: the health probe (bounded per-agent in
    // @jarvis/core, but still a network of spawned processes) must never
    // hold up the window appearing. The `.catch` is attached immediately —
    // not after some later `await` — so that if this promise settles after
    // the outer try/catch has already run dialog.showErrorBox/app.quit()
    // for an unrelated startup failure, it cannot surface as an unhandled
    // rejection; checkAgent itself never rejects, so this is a safety net.
    // An agent's command is resolved on PATH, and a GUI app's PATH is
    // /usr/bin:/bin:/usr/sbin:/sbin — not where Homebrew or npm put
    // `claude`. Left inherited, every agent was reported broken here and no
    // session could start, in installed builds only; from a terminal it all
    // worked, which is exactly why it hid for so long.
    //
    // Started, never awaited: asking a login shell for its PATH costs a
    // shell start, and a heavy .zshrc between app-ready and the window is
    // its own regression (ruling R35). Both readers below take the answer
    // late — the spawner when somebody starts a session, the health check
    // by awaiting this promise, which it can afford because its own line is
    // already deferred behind the greeting.
    // ~/.local/bin on both branches: it is where the prerequisites screen
    // links what it installs, and macOS's PATH does not carry it even in a
    // login shell — so without this the app cannot find a tool it installed
    // itself a minute earlier. See withLocalBin.

    const reportPromise = agentEnvReady
      .then(() => startupReport(registry, (command, args) => runCommand(command, args, agentEnv)))
      .catch((error) => {
        console.error(`Startup health check failed: ${errorMessage(error)}`);
        return { healthy: [], broken: [], message: "" };
      });
    // Beside jarvis.yaml, created (directory included) on first use — see
    // config.ts's defaultSessionsDbPath() note. SessionManager upserts a
    // row into this store on every state transition it already emits a
    // change event for, so history persistence needs no separate polling.
    const sessionStore = createSqliteSessionStore(config.sessionsDbPath);
    // A pty, not pipes: an interactive coding agent checks whether stdin is
    // a TTY and, finding a pipe, exits after three seconds having decided it
    // was handed a single non-interactive prompt. See createPtySpawner.
    const sessions = new SessionManager(
      createPtySpawner(() => agentEnv),
      sessionStore,
    );

    // Sessions Jarvis did not spawn — the ones started by typing an agent
    // into a terminal, which on this machine outnumber the recorded ones
    // twenty to one — exist only as JSONL transcripts on disk. The importer
    // reads them into the same table. The two writers converge on one row
    // per session rather than fighting, because agents are now spawned with
    // --session-id (pty.ts) and so write their transcripts under the id
    // SessionManager already minted.
    const sessionImporter = createSessionImporter({
      ...createFsImportDeps(),
      now: () => Date.now(),
      store: sessionStore,
      // Read per file rather than captured once: a session can start
      // between two files, and the importer must never write live state
      // for one SessionManager is running.
      ownedIds: () => new Set(sessions.list().map((session) => session.id)),
      agents: registry.list(),
      // Where an agent that names no configDir is looked for — which is
      // every agent in the config Jarvis writes on first run.
      home: homedir(),
      projects: config.projects,
      // Excluded by path: these are the brain talking to itself, and
      // imported they would outnumber real sessions two to one.
      brainCwd: config.brain.cwd,
      importWindowDays: config.sessions.importWindowDays,
      log: (message) => console.log(message),
    });
    // Started, not awaited — the same reasoning as the health probe above:
    // a scan of the transcript directories must never hold up the window
    // appearing, and the .catch is attached immediately so a late failure
    // cannot surface as an unhandled rejection.
    void sessionImporter
      .start()
      .then((imported) => {
        if (imported > 0) console.log(`Imported ${imported} session transcripts.`);
      })
      .catch((error) => {
        console.error(`Session import failed: ${errorMessage(error)}`);
      });
    // What plays a synthesised WAV. Probed once here rather than per
    // utterance — see audioPlayer.
    const player = audioPlayer(process.platform, (command) => onPath(command, process.env));

    // The operating system's own voices, where it has any. On darwin they are
    // the fallback for anything Piper is not speaking, and on Windows the
    // same: System.Speech is present on every install. Linux has neither —
    // no voice engine ships on every machine — and constructing something
    // there would only produce a speech object whose every utterance rejects.
    //
    // That rejection was not theoretical: with Piper absent, the greeting hit
    // `say`, and announceSpeaking awaited a promise nobody caught.
    const voices = {
      arabicVoice: config.voice.arabicVoice,
      englishVoice: config.voice.englishVoice,
    };
    const systemSpeech =
      process.platform === "darwin"
        ? new MacSpeech(voices, defaultSpeechRunner, defaultVoiceLister)
        : process.platform === "win32"
          ? new WindowsSpeech(voices, defaultSpeechRunner, windowsPowerShellPath(process.env))
          : undefined;

    // Piper only if it is actually installed. Configured-but-absent must fall
    // back rather than leave the app silent: the model is a 60MB download the
    // user may not have made yet, and being mute is a worse failure than
    // sounding synthetic.
    const piperReady =
      config.voice.engine === "piper" &&
      existsSync(config.voice.piperBinary) &&
      existsSync(config.voice.piperModel);
    if (config.voice.engine === "piper" && !piperReady) {
      console.log(
        `Piper is configured but not installed (${config.voice.piperBinary}, ${config.voice.piperModel})` +
          `${systemSpeech === undefined ? " — nothing else here can speak." : " — using the system voices."}`,
      );
    }

    // Arabic. A Piper model speaks one language, so the Arabic voice is its
    // own model — and on a platform with no system voices it is the only
    // thing that can say an Arabic sentence at all.
    const arabicPiperReady =
      existsSync(config.voice.piperBinary) && existsSync(config.voice.piperArabicModel);
    const arabicSpeech =
      systemSpeech ??
      (arabicPiperReady
        ? new PiperSpeech({
            binary: config.voice.piperBinary,
            model: config.voice.piperArabicModel,
            player,
          })
        : silentSpeech(() => {
            // Never silence with no explanation: the feature says why rather
            // than appearing broken.
            //
            // Which explanation depends on what is actually missing. With
            // Piper installed and only the Arabic model absent, the Arabic
            // model is the thing to go and get. With Piper absent entirely
            // this object is the whole of speech — English included — and
            // naming the Arabic model would send the user to fix something
            // that is not the problem.
            const piperInstalled = existsSync(config.voice.piperBinary);
            broadcast.send("turn:new", {
              role: "assistant",
              text: piperInstalled
                ? MESSAGES.arabicVoiceUnavailable(PRIMARY_LANGUAGE)
                : MESSAGES.noVoiceInstalled(PRIMARY_LANGUAGE),
              language: PRIMARY_LANGUAGE,
              at: Date.now(),
            });
          }));

    /**
     * Speaks, and tells the renderer while it is happening.
     *
     * The Dashboard's presence indicator reports what Jarvis is doing, and
     * "speaking" is the one state the renderer cannot work out for itself:
     * the text arrives as a turn, but how long it takes to say is known only
     * here. Announced around every utterance rather than guessed from the
     * length of the text.
     */
    const announceSpeaking = async (text: string, language: "ar" | "en"): Promise<void> => {
      broadcast.send("voice:speaking", true);
      try {
        await speech.speak(text, language);
      } catch (error) {
        // A voice that cannot speak is not a reason to take the process down.
        // Every caller of this is fire-and-forget — the greeting, a reply, a
        // capacity report — so a rejection here reached nobody's catch and
        // surfaced as an UnhandledPromiseRejectionWarning, which under
        // --unhandled-rejections=strict would be a crash. The turn is already
        // on screen; only the audio is missing, and that is what is logged.
        console.error(`Speech failed (${language}): ${errorMessage(error)}`);
      } finally {
        broadcast.send("voice:speaking", false);
      }
    };

    const speech = piperReady
      ? new RoutedSpeech(
          new PiperSpeech({
            binary: config.voice.piperBinary,
            model: config.voice.piperModel,
            player,
          }),
          arabicSpeech,
        )
      : (systemSpeech ?? arabicSpeech);
    const git = createGitProvider();
    const changeTracker = new ChangeTracker({ git, sessions });

    // Started here, awaited only once the window has loaded: the greeting
    // wants it, and nothing else does, so it runs alongside window creation
    // instead of in front of it.
    //
    // Its own provider, with a 3s timeout rather than the default 30s. A
    // project that cannot be read that fast is simply left out of the
    // greeting — the alternative is a greeting held back half a minute by
    // one unresponsive repository, which is a worse answer than an
    // incomplete one.
    const dirtyProjects = scanDirtyProjects(config.projects, createGitProvider(3_000)).catch(
      (error) => {
        console.error(`Launch scan failed: ${errorMessage(error)}`);
        return [];
      },
    );
    // A session starting/finishing/dying re-triggers a refresh too, but
    // that subscription lives in buildWiring's onSessionsChange handler
    // below (ruling P16: this used to be subscribed here *and* there —
    // every session transition fired two refreshes, and this copy was
    // never unsubscribed, unlike wiring's own teardown in `stop()`). Only
    // the initial refresh, before wiring exists, stays here.
    void changeTracker.refresh();

    // Task 16's writer: every refresh (the initial one above, wiring's
    // per-session-change and 5s-interval refreshes below, and the ones
    // git:setStaged/git:commit trigger through createGitHandlers) ends
    // here, recording each session's counts against its own row so
    // history keeps them after the session and its live ChangeTracker
    // entry are gone (P21). A session reaching "done"/"dead" itself fires
    // a sessions:update, which wiring's onSessionsChange handler turns
    // into an immediate (not merely the next 5s tick) refreshChanges()
    // call — so the counts persisted here for a session that just ended
    // are its last *live* snapshot, taken right as it tore down, not a
    // stale interval sample.
    changeTracker.onChange((changes) => {
      for (const entry of changes) {
        sessionStore.updateGit(entry.sessionId, {
          branch: entry.branch,
          insertions: entry.insertions,
          deletions: entry.deletions,
          changedFiles: entry.files,
        });
      }
    });

    // Shared with the terminal's two AI actions below (TerminalHandlerDeps.brain)
    // — one brain, one account attribution, rather than a second SDK session
    // with its own onUsage wiring.
    const brain = createBrain({
      ...config.brain,
      onUsage: (agentId, reading) => providers.recordPiggyback(agentId, reading),
    });

    const orchestrator = new Orchestrator({
      brain,
      registry,
      sessions,
      git,
      changes: () => changeTracker.snapshot(),
      speak: (text, language) => announceSpeaking(text, language),
      projects: config.projects,
      providers: {
        snapshot: () => providers.snapshot(),
        refresh: () => providers.refreshCapacity({ force: true }),
      },
    });

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

    // Rebuilding a suspended tab is not always just reloading its URL. A
    // hosted app's sidecar may have been stopped underneath it by the reaper
    // below and will come back on a different free port, so the address it
    // was suspended holding points at nothing. Only the handler that owns
    // that manager can say where it went.
    //
    // Assigned rather than passed, because every one of those handlers is
    // built from `workspace` and so cannot exist before it. The host only
    // ever calls this from a click, long after startup has finished.
    let resumeHostedApp: ((tab: WorkspaceTab) => Promise<string | undefined>) | undefined;

    // The Workspace's hosted browser tabs. Each is a native WebContentsView
    // over this window, so the host — not CSS — decides where they sit and
    // whether they are visible at all.
    const workspace = new BrowserHost(
      createElectronViewFactory(window, {
        allowPopups: () => config.browser.allowPopups,
      }),
      {
        cacheFavicon,
        suspendAfterMs: config.performance.suspendTabsAfterMinutes * MINUTE_MS,
        resumeUrl: (tab) =>
          resumeHostedApp === undefined ? Promise.resolve(undefined) : resumeHostedApp(tab),
      },
    );

    // Asked once, at startup: every sidecar below is a binary resolved on
    // PATH — `code-server`, `dbgate-serve`, `docker`, and the exec
    // credential plugin a kubeconfig names (aws, gcloud, kubelogin). A GUI
    // app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`, so none of them are
    // findable in an installed build; from a terminal they all are, which
    // is why this only ever broke for the packaged app. Undefined when the
    // shell could not be asked, in which case the inherited environment
    // stands — right for a Jarvis launched from a terminal.
    // The same lookup the agents above started; awaited here because the
    // sidecars are wired now and want a concrete environment.
    await agentEnvReady;
    // A getter, never `agentEnv` itself.
    //
    // agentEnv starts as process.env and is replaced when loginShellPath()
    // answers — which happens after startup, deliberately, because asking
    // costs a login shell and a heavy profile would sit between app-ready and
    // the window. Capturing the value here captured whatever was there before
    // that answer arrived, which for a launcher-started app is a PATH with no
    // Homebrew, npm, nvm or ~/.local/bin in it. Every sidecar below then
    // resolved its binary against that stripped-down PATH for the rest of the
    // session, and the Editor, Database, Cluster and Docker tabs failed with
    // "could not open" on a machine where the binary was installed and on
    // PATH in every terminal.
    //
    // It was a race, which is why it looked intermittent: the same build
    // worked when launched from a terminal (whose PATH is already the user's)
    // and failed from a desktop launcher. createPtySpawner has taken a getter
    // for exactly this reason since it was written; these did not.
    const env = (): NodeJS.ProcessEnv => agentEnv;

    // One code-server process per project, started lazily the first time
    // its editor is opened. Jarvis-managed profile directories, separate
    // from anywhere the user's own VS Code (if any) keeps its own settings.
    const codeServerRoot = join(homedir(), ".config/jarvis/code-server");
    const codeServer = createCodeServerManager({
      spawn: createRealCodeServerSpawner(env, process.platform),
      findFreePort,
      waitUntilReady,
      userDataDir: join(codeServerRoot, "user-data"),
      extensionsDir: join(codeServerRoot, "extensions"),
    });
    const editor = createEditorHandlers({
      codeServer,
      projects: config.projects,
      editors: config.editors,
      language: PRIMARY_LANGUAGE,
    });

    // One DbGate process per project, on the same terms as code-server:
    // started lazily, reused, killed on quit. Each gets its own workspace
    // directory so a project's saved connections stay its own, and the
    // connections declared in jarvis.yaml are seeded into it at spawn.
    const dbgateRoot = join(homedir(), ".config/jarvis/dbgate");
    const dbgate = createDbGateManager({
      spawn: createRealDbGateSpawner(env, process.platform),
      findFreePort,
      waitUntilReady,
      ensureDir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      workspaceRoot: dbgateRoot,
      connectionsFor: (project) => config.databases[project] ?? [],
      // Not the getter above: this one is read for `passwordEnv` lookups, not
      // to resolve a binary, and the variables it reads are the same in both.
      // Only PATH is late.
      env: process.env,
      randomPassword,
    });
    // The first-run prerequisites screen. `env` is the getter for the same
    // reason the sidecars take one: the login shell's PATH arrives after
    // startup, and checking against the pre-answer environment would report
    // every tool missing and offer to install what is already there.
    const setup = createSetupHandlers({
      platform: process.platform,
      arch: process.arch,
      env,
      home: homedir(),
      fileExists: (path) => existsSync(path),
      onOutput: (chunk) => broadcast.local("setup:output", chunk),
      installDeps: (onOutput) => ({
        onOutput,
        home: homedir(),
        run: (command, args, emit) =>
          new Promise<number>((resolve) => {
            const child = spawn(command, [...args], {
              stdio: ["ignore", "pipe", "pipe"],
              env: env(),
            });
            for (const stream of [child.stdout, child.stderr]) {
              stream?.setEncoding("utf8");
              stream?.on("data", (chunk: string) => emit(chunk));
            }
            // A missing binary arrives as an async "error", not a throw.
            child.on("error", (error) => {
              emit(`${error.message}\n`);
              resolve(1);
            });
            child.on("close", (code) => resolve(code ?? 1));
          }),
        download: async (url, dest) => {
          await mkdir(dirname(dest), { recursive: true });
          const response = await fetch(url);
          if (!response.ok) throw new Error(`${url} returned ${response.status}`);
          await writeFile(dest, Buffer.from(await response.arrayBuffer()));
        },
        extract: async (url, dest) => {
          await mkdir(dest, { recursive: true });
          const archive = join(dest, basename(new URL(url).pathname));
          const response = await fetch(url);
          if (!response.ok) throw new Error(`${url} returned ${response.status}`);
          await writeFile(archive, Buffer.from(await response.arrayBuffer()));
          // tar is on every macOS and Linux, and on Windows since 1803.
          await new Promise<void>((resolve, reject) => {
            const child = spawn("tar", ["-xf", archive, "-C", dest], { stdio: "ignore" });
            child.on("error", reject);
            child.on("close", (code) =>
              code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)),
            );
          });
          await rm(archive, { force: true });
          // Where the contents actually landed, which is what this is
          // documented to return. Every piper release is a tarball with one
          // top-level `piper/` directory, so the binary sits at
          // dest/piper/piper; returning dest linked the *directory* into
          // ~/.local/bin, where it existed, read as installed, and could not
          // be run.
          const entries = await readdir(dest, { withFileTypes: true });
          const only =
            entries.length === 1 && entries[0]?.isDirectory() === true
              ? entries[0].name
              : undefined;
          return only === undefined ? dest : join(dest, only);
        },
        link: async (from, to) => {
          await mkdir(dirname(to), { recursive: true });
          await rm(to, { force: true });
          await symlink(from, to);
        },
        locate: async (command) => {
          const { code, stdout } = await runCommand("sh", ["-lc", `command -v ${command}`], env());
          const found = stdout.trim();
          return code === 0 && found !== "" ? found : undefined;
        },
      }),
    });
    const database = createDatabaseHandlers({
      dbgate,
      projects: config.projects,
      language: PRIMARY_LANGUAGE,
    });

    const headlamp = createHeadlampManager({
      spawn: createRealHeadlampSpawner(env, undefined, process.platform),
      findFreePort,
      waitUntilReady,
      listContexts: createKubeContextLister(join(homedir(), ".kube/config")),
      clusters: config.clusters,
      // The per-OS default lives here rather than in config.ts: resolving it
      // there would mean config parsing reading process.platform, and every
      // headlamp assertion in its tests would then hold only on the OS the
      // test happened to run on.
      binary: config.headlamp.binary ?? defaultHeadlampBinary(process.platform, process.env),
      kubeconfigPath: join(homedir(), ".kube/config"),
    });
    const checkAwsSession = createAwsSessionChecker(env);
    const awaitAwsSession = createAwsSessionPoller(checkAwsSession);
    // Same reasoning as headlamp above: `docker` lives wherever the login
    // shell's PATH puts it (Homebrew, OrbStack, Docker Desktop's shim), not
    // wherever a GUI-launched process's PATH puts it.
    const dockerClient = createRealDockerClient(env, process.platform);

    // Terminal autocomplete's shell integration, installed before the first
    // shell can be started. It writes a Jarvis-owned wrapper — a ZDOTDIR
    // directory for zsh, an rcfile for bash — whose contents chain to the
    // user's real dotfiles; ~/.zshrc, ~/.profile and friends are read and
    // never modified. Undefined means no integration — disabled, a shell
    // neither wrapper knows, or unwritable — and the terminal then behaves
    // exactly as it did before this feature existed.
    const completionEnabled = config.terminal.completion.enabled;
    // On Windows `$SHELL` is either absent or an MSYS path that ConPTY cannot
    // start, so the shell the tab will really run is the one shellCommand
    // picks — and the integration has to be chosen for *that*, not for a
    // variable this process happened to inherit.
    const shell =
      process.platform === "win32"
        ? shellCommand(process.env, process.platform)
        : process.env["SHELL"];
    const zdotdir = join(homedir(), ".config/jarvis/zdotdir");
    const bashDir = join(homedir(), ".config/jarvis/bash");
    const powerShellDir = join(homedir(), ".config/jarvis/powershell");
    await mkdir(zdotdir, { recursive: true }).catch(() => undefined);
    await mkdir(bashDir, { recursive: true }).catch(() => undefined);
    await mkdir(powerShellDir, { recursive: true }).catch(() => undefined);
    await mkdir(dirname(config.terminal.completion.commandLogPath), { recursive: true }).catch(
      () => undefined,
    );
    const installedIntegration = await installShellIntegration({
      shell,
      enabled: completionEnabled,
      zdotdirDir: zdotdir,
      bashDir,
      powerShellDir,
      realZdotdir: resolveRealZdotdir(process.env, zdotdir, homedir()),
      home: homedir(),
      write: (path, contents) => writeFile(path, contents, "utf8"),
    });

    // One login shell per Terminal tab, under a real pty. Unlike the editor
    // and the database this hosts no page and opens no port: the tab has no
    // view at all, and its screen is drawn by the renderer's own xterm.
    const shells = createShellManager({
      spawn: createRealShellSpawner(
        process.env,
        {
          ...(installedIntegration ?? {}),
          // Only worth writing when a wrapper that reads it is installed.
          commandLog:
            installedIntegration === undefined
              ? undefined
              : config.terminal.completion.commandLogPath,
        },
        process.platform,
      ),
    });

    // Subscribed once here rather than inside terminal:attach, because a
    // subscription created per attach can only ever have one subscriber —
    // see the ShellManager change. Every pane's output flows whether or not
    // anything has asked for a backlog.
    shells.onOutput(({ paneKey, chunk, offset }) =>
      broadcast.send("terminal:data", { paneKey, chunk, offset }),
    );
    shells.onShellExit(({ paneKey, code }) => broadcast.send("terminal:exit", { paneKey, code }));

    // The history file, and the parser that matches it.
    //
    // config.ts defaults this to zsh's HISTFILE and knows nothing about the
    // host — deliberately, so its tests hold on both platforms. Comparing
    // against DEFAULT_TERMINAL is how a caller tells "the user never wrote
    // this key" from "the user wrote it and it happens to match", which is
    // exactly what that export exists for. Only the former is overridden: a
    // path the user actually chose is theirs.
    //
    // The parser has to follow the file. zsh's reads a bash history without
    // failing and silently drops every timestamp, taking the recency half of
    // the ranking with it.
    const historyPath =
      config.terminal.completion.historyPath === DEFAULT_TERMINAL.completion.historyPath
        ? defaultHistoryPath(shell, homedir(), process.env)
        : config.terminal.completion.historyPath;

    const completionSource = createCompletionSource({
      readHistory: createFileReader(historyPath),
      parseHistory: isPowerShell(shell)
        ? parsePowerShellHistory
        : isBash(shell)
          ? parseBashHistory
          : parseZshHistory,
      readCommandLog: createFileReader(config.terminal.completion.commandLogPath),
      listDirectory: createDirectoryLister(),
      now: () => Date.now(),
    });
    // The API tab. Requests are issued from here, in the main process, which
    // is what makes CORS irrelevant — see http-runner.ts.
    const apiStore = createApiStore(join(homedir(), ".config/jarvis/api.json"));

    /** Drives an OAuth2 authorization-code redirect through a Workspace tab:
     *  the app already has a browser, and sending the user to their system
     *  browser to copy a code back by hand would be the worse product.
     *  Desktop-only: api-executor.ts never calls this for a remote origin. */
    function authorizeInWorkspace(project: string, url: string, redirectUri = ""): Promise<string> {
      return workspace.openForResult(project, url, redirectUri);
    }

    // One send, with everything a request can ask for around it: the
    // project's cookie jar and network settings, its pre-request and
    // post-response scripts, and an OAuth2 token when the request wants one.
    // Assembled here rather than inside http-runner.ts because every piece of
    // it is a policy decision — which jar, whose settings, whether scripts
    // run — and the runner's job is only to make the call.
    //
    // The decision itself (api-executor.ts, Important 2/review) is unit-
    // tested on its own with every one of these deps as a spy; this is only
    // the wiring, built from state that only exists once Electron is up.
    const sendApiRequest = createApiExecutor({
      apiFetch,
      now: () => Date.now(),
      runScript,
      fetchOAuth2Token,
      sendRequest,
      readFile: (path: string) => readFile(path),
      multipart: apiMultipart,
      dispatcherFor,
      uploads: { resolve: (deviceId, uploadId) => uploadStore.resolve(deviceId, uploadId) },
      authorizeInWorkspace: (project, url, redirectUri) =>
        authorizeInWorkspace(project, url, redirectUri),
      store: {
        read: (project) => apiStore.read(project),
        saveCookies: (project, cookies) => apiStore.saveCookies(project, cookies),
      },
    });

    const api = createApiHandlers({
      listCollections,
      readCollection,
      readRequest,
      writeRequest,
      sendRequest: (request, variables, project, remote) =>
        sendApiRequest(request, variables, project, remote),
      evaluateAssertions,
      toCurl,
      createRequest,
      createFolder,
      renameRequest,
      renameFolder,
      deleteEntry,
      createCollection,
      writeEnvironment,
      postmanToRequests,
      writeImported,
      truncateBody,
      store: apiStore,
      projects: config.projects,
      language: PRIMARY_LANGUAGE,
      realPath: (path) => realpathSync(path),
    });

    const terminal = createTerminalHandlers({
      shells,
      openTerminalTab: (project, label) => workspace.openTerminal(project, label),
      projects: config.projects,
      language: PRIMARY_LANGUAGE,
      completion: { source: completionSource, enabled: completionEnabled },
      terminal: config.terminal,
      terminalScrollback: config.performance.terminalScrollback,
      // The file sidebar's disk access. Immediate children only, and
      // realpath is what the containment check compares against — see
      // resolveWithin.
      files: {
        readDir: (path) =>
          readdirSync(path, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            directory: entry.isDirectory(),
          })),
        realPath: (path) => realpathSync(path),
      },
      // The file sidebar's route into the Editor tab — see
      // TerminalHandlerDeps.editor. `open` is codeServer.open bound
      // directly rather than routed through createEditorHandlers' named
      // roots: openFile's folder is a per-file directory, already proven
      // inside the project by resolveWithin, not one of the project's
      // declared `editors:` roots.
      editor: {
        open: (projectPath, folderPath) => codeServer.open(projectPath, folderPath),
        // Reuses an already-open tab at the same (project, detail) rather
        // than opening a new one every click — BrowserHost's MAX_TABS cap
        // would otherwise silently evict a user's other hosted tabs (a
        // DbGate tab with an unsaved query, say) as a side effect of
        // browsing the file tree. Reuse means navigating that tab to the
        // new URL — a real reload, since `payload` is only honoured at
        // page load — so opening a second file loses whatever the tab's
        // own browser session held that code-server's server-side state
        // did not. The decision itself lives in showEditorTab, where it
        // has a test; this is only the wiring.
        openTab: (project, url, detail) =>
          showEditorTab(
            {
              tabs: () => workspace.state().tabs,
              navigate: (id, target) => workspace.navigate(id, target),
              activate: (id) => workspace.activate(id),
              open: (name, target, tabDetail) => workspace.open(name, target, "editor", tabDetail),
            },
            project,
            url,
            detail,
          ),
      },
      workflows: {
        readDir: (path) => readdirSync(path),
        readFile: (path) => readFileSync(path, "utf8"),
        config: config.workflows,
        defaultDir: defaultWorkflowsDir(),
      },
      // The two AI actions' only route to the brain — see
      // TerminalHandlerDeps.brain's own note on why nothing else in ipc.ts
      // calls it.
      brain,
      // The chip row's git half — the same GitProvider the Changes view
      // uses, not a second git integration.
      git,
      // The chip row's runtime half. Gated on a `package.json` existing so
      // a directory with none is never spawned into for nothing; a
      // non-zero exit or a throw is `undefined`, same as every other
      // chip-data failure — never surfaced as an error in a terminal.
      runtimeVersion: (cwd) =>
        existsSync(join(cwd, "package.json")) ? nodeVersionIn(cwd) : Promise.resolve(undefined),
    });

    // Constructed here, not beside headlamp above, because opening the
    // AWS login terminal needs a live tab and shell to type the login
    // command into. terminal.open itself doesn't hand back a tab id (there
    // is no caller today that needs one), so openTerminal reaches for the
    // same workspace.openTerminal + shells.start pairing terminal.open uses
    // internally; sendInput reuses terminal.input as-is, since that already
    // has the exact right shape.
    const cluster = createClusterHandlers({
      headlamp,
      projects: config.projects,
      clusters: config.clusters,
      readKubeconfig: async () => {
        try {
          return await readFile(join(homedir(), ".kube/config"), "utf8");
        } catch {
          return "";
        }
      },
      checkAwsSession,
      awaitAwsSession,
      openTerminal: (project: string, cwd: string) => {
        // Marked as the login terminal, which is what tells the renderer to
        // draw it without blocks — see LOGIN_TERMINAL_DETAIL.
        const tabId = workspace.openTerminal(project, LOGIN_TERMINAL_DETAIL);
        // The tab exists before the shell does. If the pty never starts, the
        // caller reports a failure and the tab would otherwise be left behind
        // empty — a terminal with nothing in it and no explanation, next to a
        // message about the cluster browser.
        try {
          shells.start(tabId, cwd);
        } catch (error) {
          workspace.close(tabId);
          throw error;
        }
        return tabId;
      },
      sendInput: (tabId: string, data: string) => terminal.input(tabId, data),
      language: PRIMARY_LANGUAGE,
    });

    // Nothing to inject but the config itself: a chat tab is a hosted page
    // with no server behind it, so there is no manager to build, nothing to
    // kill on quit, and no side effect for a test to fake.
    const chat = createChatHandlers({
      projects: config.projects,
      chat: config.chat,
      language: PRIMARY_LANGUAGE,
    });

    // Same openTerminal/sendInput pairing as cluster above, copied rather
    // than shared: the two are wired to different handler sets and keeping
    // each construction self-contained is worth the few duplicated lines.
    const docker = createDockerHandlers({
      docker: dockerClient,
      projects: config.projects,
      containers: config.docker,
      openTerminal: (project: string, cwd: string) => {
        const tabId = workspace.openTerminal(project);
        try {
          shells.start(tabId, cwd);
        } catch (error) {
          workspace.close(tabId);
          throw error;
        }
        return tabId;
      },
      sendInput: (tabId: string, data: string) => terminal.input(tabId, data),
      language: PRIMARY_LANGUAGE,
    });

    const favicons = createFaviconStore(join(homedir(), ".config/jarvis/favicons"));

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
      // browser-host.ts's own partition name — encodeURIComponent because
      // a project name is user-supplied config and a partition name with a
      // slash or a space in it is not addressable.
      const from = session.fromPartition(`persist:project-${encodeURIComponent(project)}`);
      void cacheFavicon(url, `${origin}/favicon.ico`, from).finally(() => fetching.delete(key));
    }

    const bookmarks = createBookmarksHandlers({
      store: createBookmarkStore(join(homedir(), ".config/jarvis/bookmarks.json")),
      favicons,
      requestFavicon,
      language: PRIMARY_LANGUAGE,
      projects: config.projects,
    });

    const indexUrl = pathToFileURL(
      fileURLToPath(new URL("../../renderer/index.html", import.meta.url)),
    ).href;

    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url, indexUrl)) {
        event.preventDefault();
      }
    });

    // The one way out to a client. Centralising also fixes a real latent bug:
    // of the direct sends this replaces, only the docker:log one checked
    // isDestroyed(), so every other push would throw on a window that had
    // gone away. The guard now lives in one place and applies to all of them.
    const broadcast = createBroadcaster({
      toRenderer: rendererSink(window),
    });

    // Sessions the process scan (process-scan.ts) found running outside
    // Jarvis, keyed by "ext-<pid>" — rebuilt wholesale on every
    // refreshSessions() call, never written to sessionStore (session-
    // import.ts's own discipline: nothing here can prove a process is
    // still alive between one scan and the next, so this is scan-fresh
    // state, not a persisted claim). It is, however, cached to disk (see
    // sessionScanPath below) purely so the user's last scan still shows at
    // the next launch instead of going blank until the next refresh.
    let externalSessions = new Map<string, CoreSession>();

    // Beside jarvis.yaml — see config.ts's defaultSessionsScanPath().
    const sessionScanPath = defaultSessionsScanPath();

    // Loaded before the window can be asked for "sessions:list"/pushed a
    // "sessions:update" (both wired further down, and the startup scan
    // below is fired but not awaited): the last scan's rows appear
    // immediately, exactly as they were, rather than the card going blank
    // until this launch's own scan finishes. Unreadable for any reason —
    // missing (first run, or nothing ever scanned yet), malformed, a
    // permission problem — is treated as "nothing cached", same discipline
    // ensureConfigFile() uses for jarvis.yaml itself: never an error the
    // user sees.
    try {
      const cached = parseScan(await readFile(sessionScanPath, "utf8"));
      externalSessions = new Map(cached.map((row) => [row.id, row]));
    } catch {
      externalSessions = new Map();
    }

    /** Jarvis's own live sessions plus the last scan's external ones — the
     *  one list "sessions:list" and "sessions:update" both show. */
    function mergedSessions(): CoreSession[] {
      return [...sessions.list(), ...externalSessions.values()];
    }

    // Temp file + rename: a reader (the load above, on the next launch)
    // never sees a half-written file, whichever of the two processes gets
    // there first. Failures are logged and swallowed — a scan the user
    // triggered must still resolve, and a Dashboard refresh must still
    // finish, even on a read-only or full disk.
    async function persistSessionScan(): Promise<void> {
      const text = serializeScan([...externalSessions.values()]);
      const tmpPath = `${sessionScanPath}.${process.pid}.tmp`;
      try {
        await mkdir(dirname(sessionScanPath), { recursive: true });
        await writeFile(tmpPath, text, "utf8");
        await rename(tmpPath, sessionScanPath);
      } catch (error) {
        console.error(`Writing cached session scan failed: ${errorMessage(error)}`);
        await rm(tmpPath, { force: true }).catch(() => undefined);
      }
    }

    // Coalesced: a scan mid-flight is shared with any call that arrives
    // while it runs, rather than starting a second `ps`/`lsof` pass —
    // Task 3's "a scan must not run concurrently".
    let sessionRefreshInFlight:
      | Promise<{ jarvis: number; external: number; importedTranscripts: number }>
      | undefined;

    async function refreshSessions(): Promise<{
      jarvis: number;
      external: number;
      importedTranscripts: number;
    }> {
      if (sessionRefreshInFlight !== undefined) return sessionRefreshInFlight;
      const run = (async () => {
        const importedTranscripts = await sessionImporter.backfill();

        const processes = await listAgentProcesses({
          exec: (command, args) => runCommand(command, args),
          platform: process.platform,
          agents: registry.list(),
          // Never double-count a pty child SessionManager is already
          // running as also "running outside Jarvis".
          ownedPids: () => sessions.ownedPids(),
          jarvisPid: process.pid,
          now: () => Date.now(),
        });

        const next = new Map<string, CoreSession>();
        for (const found of processes) {
          const transcript =
            found.cwd === null
              ? null
              : await sessionImporter.latestTranscriptFor(found.agentId, found.cwd);
          const id = `ext-${found.pid}`;
          next.set(id, {
            id,
            project: resolveProject(found.cwd ?? "", config.projects),
            projectPath: found.cwd ?? "",
            agentId: found.agentId,
            state: "running",
            summary:
              transcript !== null
                ? transcript.session.summary
                : MESSAGES.sessionRunningOutsideJarvis(PRIMARY_LANGUAGE),
            startedAt: found.startedAt,
            lastActivityAt: transcript?.session.lastActivityAt ?? Date.now(),
            ...(transcript === null ? {} : { transcriptPath: transcript.path }),
            origin: "external",
            pid: found.pid,
          });
        }
        externalSessions = next;
        broadcast.send("sessions:update", mergedSessions());
        await persistSessionScan();

        return {
          jarvis: sessions.list().length,
          external: externalSessions.size,
          importedTranscripts,
        };
      })();
      sessionRefreshInFlight = run;
      try {
        return await run;
      } finally {
        sessionRefreshInFlight = undefined;
      }
    }

    // No scan at startup any more: the user asked for the sessions table to
    // show the last scan, unchanged, until they press Refresh — and the
    // cached rows loaded above are exactly that. A startup scan here used
    // to overwrite them seconds after launch (and drop any process that had
    // ended meanwhile). The importer's own start() above still backfills
    // transcripts; only the process discovery is on demand now.

    // The remote bridge. File-mode enforcement (0600/0700 under
    // ~/.config/jarvis/remote/) is skipped only on win32, same convention
    // process.platform already follows everywhere else in this file
    // (platform-convention.test.ts).
    const remoteEnforceFileModes = process.platform !== "win32";
    const remoteDir = join(homedir(), ".config/jarvis/remote");

    // Private per-device file staging (M9 Task 3) — a paired phone's
    // remote:uploadFile and remote:readJsonUpload alike, under the same
    // ~/.config/jarvis/remote/ tree the bridge's own TLS material lives in.
    // Declared before remoteAccess/dispatch below: both close over it
    // (onDeviceRevoked and the uploads dep, respectively).
    const uploadStore = createFileUploadStore({
      now: Date.now,
      randomId: () => randomBytes(16).toString("hex"),
      baseDir: join(remoteDir, "uploads"),
      language: PRIMARY_LANGUAGE,
      log: (line) => console.error(line),
    });

    // Declared before remoteAccess itself: both createSettingsHandlers
    // below and the bridge's own onIdleDisabled callback (in
    // createRemoteAccess's deps, right below) close over this one
    // `writeConfig` instance, so a Settings save and an idle auto-disable
    // can never interleave their writes to jarvis.yaml — M12 Task 2's rule
    // that the disk write goes through "the same serialized writeConfig
    // closure Settings uses", never a second writer. `remoteAccess` is
    // assigned a few lines down; `applyFromDisk` only reads it once
    // actually invoked (after a successful write, always later), by which
    // time it is always assigned — never referenced synchronously before
    // that.
    let remoteAccess: RemoteAccess;

    // I2: a second, dedicated queue for the re-read-and-apply-to-the-bridge
    // that follows a successful save. Kept separate from the write queue
    // below (rather than awaited inside it) so a save's own promise still
    // resolves as soon as the write lands — Settings does not wait on the
    // bridge to catch up — while still guaranteeing every apply() this
    // produces runs in the same order the writes that triggered them did.
    // Each queued turn reads the file fresh *when it runs*, not when it was
    // enqueued, so two fast saves (On, then Off) can never apply out of
    // order and leave the bridge listening: whichever apply runs last
    // always reads whatever is on disk last, and the queue is what makes
    // "last to run" mean "last enqueued", never "whichever read finished
    // first".
    const applyFromDisk = serialize(async () => {
      const next = await loadConfig(DEFAULT_CONFIG_PATH);
      await remoteAccess.apply(next.remote);
    });

    // After a successful write, the file on disk is the only source of
    // truth for `remote:` (settings:save already pins a remote-origin
    // draft's own `remote` key to it — dispatch.ts) — so this re-reads
    // the file rather than trusting `draft.remote`, and applies whatever
    // that read finds to the live bridge, via the queued applyFromDisk
    // above. A rejected re-read (or a rejected apply) is logged, never
    // thrown: the save itself already succeeded, and a phone or the
    // laptop's own Settings panel is not left hanging on the bridge
    // catching up.
    // Serialised (I2): two overlapping saves must never interleave their
    // own read-then-write, or one can silently undo the other (e.g. the
    // user turning the bridge off while a stale draft is mid-write).
    //
    // Also accepts an updater — `(current) => draft` — for a caller that
    // must read before it writes, remote-idle.ts above all (M12 Task 12
    // minor): the read happens right here, inside this same serialized
    // call, so nothing queued behind it can land between the read and the
    // write the way a bare outside `readConfig()` followed by a
    // separately-queued `writeConfig(draft)` could. An updater that hands
    // back the exact `current` object it was given — remote-idle.ts's own
    // "already off" no-op — skips the disk write (and the re-apply below)
    // entirely.
    const writeConfig = serialize(
      async (input: JarvisConfig | ((current: JarvisConfig) => JarvisConfig)) => {
        let draft: JarvisConfig;
        if (typeof input === "function") {
          const current = await loadConfig(DEFAULT_CONFIG_PATH);
          draft = input(current);
          if (draft === current) return { ok: true as const };
        } else {
          draft = input;
        }
        const result = await writeSettingsFile(DEFAULT_CONFIG_PATH, draft);
        if (result.ok) {
          // Keep the same object identities held by already-running handlers.
          // Reads on their next operation see the saved values immediately.
          const next = await loadConfig(DEFAULT_CONFIG_PATH);
          const previousAgents = registry.list();
          mergeConfigInPlace(
            config as unknown as Record<string, unknown>,
            next as unknown as Record<string, unknown>,
          );
          registry.replace(next.registry);
          const nextAgents = registry.list();
          if (!providerAgentListsEqual(previousAgents, nextAgents)) {
            providers.replaceAgents(nextAgents);
          }
          void applyFromDisk().catch((error: unknown) => {
            console.error(`remote bridge: apply after save failed: ${errorMessage(error)}`);
          });
        }
        return result;
      },
    );

    remoteAccess = createRemoteAccess({
      table: () => dispatch,
      blobs: () => blobTable,
      broadcast,
      language: PRIMARY_LANGUAGE,
      createBridge,
      io: {
        dir: remoteDir,
        fs: nodeFs,
        random: randomBytes,
        now: Date.now,
        timers: nodeTimers,
        listen: listenTls,
        loadCertificate: (config) =>
          loadCertificate(config, {
            fs: nodeFs,
            dir: remoteDir,
            random: randomBytes,
            now: Date.now,
            enforceFileModes: remoteEnforceFileModes,
          }),
        createProxy: (registry) =>
          createSidecarProxy({ registry, log: (line) => console.error(line) }),
        enforceFileModes: remoteEnforceFileModes,
        log: (line) => console.error(line),
      },
      // Backs remoteKeyAuthorizer's pane/session checks. `followers` is
      // declared further down (it needs `dockerClient` and `broadcast`,
      // both already in scope here) — safe to reference from these
      // closures because neither runs until a real subscribe/disconnect
      // happens, well after the whole window's setup has finished.
      streams: {
        hasPane: (paneKey) => shells.has(paneKey),
        hasSession: (sessionId) => sessions.get(sessionId) !== undefined,
        followerOwner: (tabId) => followers.ownerOf(tabId),
      },
      // A disconnected device's Docker followers are dead weight — nobody
      // is left to receive their docker:log pushes — so its cap is
      // reclaimed the same way its terminal/session subscriptions already
      // are (remote-access.ts's own per-device cleanup).
      onDeviceDisconnected: (deviceId) => {
        followers.unfollowOwnedBy(deviceId);
      },
      // M9 Task 3: a revoked device's staged files and quota reservation
      // are reclaimed here — never on a plain disconnect, which leaves them
      // for their own TTL so an explicit retry still finds them.
      onDeviceRevoked: (deviceId) => {
        void uploadStore.revoke(deviceId);
      },
      // M12 Task 2: the bridge's own idle timer fired — nothing a phone
      // can send reaches this path, only the bridge's own timer callback.
      // Fire-and-forget: disableRemoteOnDisk never throws, so this
      // callback itself can never throw a rejection (with a filesystem
      // path in its message or otherwise) into the bridge's own
      // onIdleDisabled try/catch.
      onIdleDisabled: () => {
        void disableRemoteOnDisk({
          writeConfig,
          log: (line) => console.error(line),
        });
      },
      // The bridge's own Expo push sender (M10 Task 4) uses the platform's
      // global fetch — the same one api-executor.ts already relies on
      // existing — never `@jarvis/platform`'s apiFetch or undici directly.
      fetch: (url, init) => fetch(url, init),
    });

    // M10 Task 4: built right after remoteAccess and before wiring.start(),
    // so no session change or turn produced from here on can slip past the
    // notifier the way an early turn once slipped past wiring (see the
    // comment above wiring.start() itself). `context()` is read fresh on
    // every decision — remoteAccess.pushSettings()/pushTargets()/
    // watchingDevices always answer the *current* state, never one
    // captured here.
    const notifier = createNotifier({
      sessions,
      onTurn: (cb) => orchestrator.onTurn(cb),
      context: () => ({
        ...remoteAccess.pushSettings(),
        focused: window.isFocused(),
        targets: remoteAccess.pushTargets(),
        watching: remoteAccess.watchingDevices,
      }),
      send: (messages) => remoteAccess.sendPush(messages),
      // M12 Task 3, rule 9: every queued push gets one audit line, via the
      // same bridge recordPushQueued already reaches for a mutating call —
      // never the token, the title, the body or the project.
      audit: (entries) => {
        for (const e of entries) remoteAccess.recordPushQueued(e.deviceId, e.kind);
      },
      now: Date.now,
      timers: nodeTimers,
      log: (line) => console.error(line),
    });

    const settings = createSettingsHandlers({
      readConfig: () => loadConfig(DEFAULT_CONFIG_PATH),
      // The same hoisted writeConfig instance createRemoteAccess's own
      // onIdleDisabled callback uses above — never a second writer to
      // jarvis.yaml. After a successful write, the file on disk is the
      // only source of truth for `remote:` (settings:save already pins a
      // remote-origin draft's own `remote` key to it — dispatch.ts) — so
      // writeConfig re-reads the file rather than trusting `draft.remote`,
      // and applies whatever that read finds to the live bridge, via the
      // queued applyFromDisk above it. A rejected re-read (or a rejected
      // apply) is logged, never thrown: the save itself already succeeded,
      // and a phone or the laptop's own Settings panel is not left hanging
      // on the bridge catching up.
      writeConfig,
      run: runCommand,
      // A restart the user did not ask for is the wrong kind of "helpful"
      // — this only ever fires from the renderer's own Restart button
      // click, after a save has already succeeded.
      restart: () => {
        app.relaunch();
        app.exit(0);
      },
      language: PRIMARY_LANGUAGE,
    });

    // Important 4: wiring is built and started here — before ipcMain
    // handlers are registered, before the recorder/hotkeys exist, and
    // before the window ever loads a page a user could interact with — so
    // no turn produced between now and the (slow, up-to-5s) startup health
    // report can ever be dropped. Previously wiring.start() (where
    // orchestrator.onTurn / sessions.onChange are first subscribed) ran
    // only after `await reportPromise`, so a turn handled during that
    // window was spoken by TTS but never reached "turn:new" — gone, with
    // no replay.
    const wiring = buildWiring({
      send: broadcast.send,
      readMetrics: createMetricsReader(),
      intervalMs: 2000,
      // Merged, so a Jarvis session's own state change does not push a
      // Jarvis-only list and drop every external row until the next
      // explicit sessions:refresh.
      onSessionsChange: (cb) => sessions.onChange(() => cb(mergedSessions())),
      onTurn: (cb) => orchestrator.onTurn(cb),
      onChangeCounts: (cb) => changeTracker.onChange(cb),
      onSessionOutput: (cb) => sessions.onOutput(cb),
      refreshChanges: () => changeTracker.refresh(),
      // Slower than the 2s metrics tick: a git status on a large repository
      // is far more expensive than reading /proc-equivalent counters, and
      // change counts do not need second-level freshness.
      changesIntervalMs: 5000,
      onProvidersChange: (cb) => providers.onChange(cb),
      onWorkspaceChange: (cb) => workspace.onChange(cb),
      refreshHealth: () => providers.refreshHealth(),
      healthIntervalMs: PROVIDER_HEALTH_INTERVAL_MS,
      // Minimised, or behind the screen lock. Not `isVisible()` alone: a
      // full-screen window on a background Space still reports visible, and
      // refreshChanges spawns two git processes per repo every tick. A
      // hidden window still wakes for a paired phone actually subscribed to
      // this specific push — a phone watching metrics should not have to
      // wait for the laptop's own window to be on screen too.
      isAwake: (channel) =>
        (window.isVisible() && !window.isMinimized()) || remoteAccess.hasSubscriber(channel),
    });
    wiring.start();

    // Where a suspended hosted-app tab should be rebuilt — see the
    // declaration of resumeHostedApp above the BrowserHost. Every branch goes
    // through the same handler the tab's own button uses, so "reuse if
    // running, start if not" is decided in exactly one place.
    resumeHostedApp = async (tab) => {
      switch (tab.kind) {
        case "editor": {
          const result = await editor.open(tab.project, tab.detail);
          return result.ok ? result.value : undefined;
        }
        case "database": {
          const result = await database.open(tab.project);
          return result.ok ? result.value.url : undefined;
        }
        case "cluster": {
          if (tab.detail === undefined) return undefined;
          // `background: true` because this resume is a consequence of Jarvis
          // reclaiming memory, not of anybody asking to sign in. A foreground
          // call may start a real `saml2aws` in a terminal tab and push MFA
          // to the user's phone; clicking a tab you already had open is not
          // consent to that. With the session gone the tab reloads its stored
          // URL and says so, and the Cluster button is right there.
          const result = await cluster.open(tab.project, tab.detail, { background: true });
          return result.ok ? result.value : undefined;
        }
        default:
          // A web or chat tab is its URL and nothing else.
          return undefined;
      }
    };

    /** Projects whose `kind` tab is open and not suspended. DbGate and
     *  Headlamp both key by project name, so this is their whole answer. */
    const neededProjects = (kind: TabKind): Set<string> =>
      new Set(
        workspace
          .state()
          .tabs.filter((tab) => tab.kind === kind && !tab.suspended)
          .map((tab) => tab.project),
      );

    /** code-server keys by the (project, folder) pair rather than by project,
     *  so a project with two editor roots has two processes and only one of
     *  them may still be needed. `detail` is the root's declared name, and
     *  resolving it exactly as createEditorHandlers does is what keeps this
     *  in step with what was actually started — codeServerKey is shared for
     *  the same reason. */
    const neededEditorKeys = (): Set<string> => {
      const keys = new Set<string>();
      for (const tab of workspace.state().tabs) {
        if (tab.kind !== "editor" || tab.suspended) continue;
        const projectPath = config.projects[tab.project];
        if (projectPath === undefined) continue;
        if (tab.detail === undefined) {
          keys.add(codeServerKey(projectPath, projectPath));
          continue;
        }
        const root = config.editors[tab.project]?.find((entry) => entry.name === tab.detail);
        if (root !== undefined) keys.add(codeServerKey(projectPath, join(projectPath, root.path)));
      }
      return keys;
    };

    const sidecarIdleMs = config.performance.stopSidecarsAfterMinutes * MINUTE_MS;
    const editorReaper = createSidecarReaper({
      runningKeys: () => codeServer.runningKeys(),
      stop: (key) => codeServer.stop(key),
      now: Date.now,
      idleMs: sidecarIdleMs,
    });
    const databaseReaper = createSidecarReaper({
      runningKeys: () => dbgate.runningKeys(),
      stop: (key) => dbgate.stop(key),
      now: Date.now,
      idleMs: sidecarIdleMs,
    });
    const clusterReaper = createSidecarReaper({
      runningKeys: () => headlamp.runningKeys(),
      stop: (key) => headlamp.stop(key),
      now: Date.now,
      idleMs: sidecarIdleMs,
    });

    // The order matters: sweepIdle runs first, so a tab suspended on this
    // very tick is already out of `needed` when the reapers read it, and its
    // sidecar starts its own grace period from here rather than a minute
    // later.
    const sweepTimer = setInterval(() => {
      workspace.sweepIdle();
      editorReaper.sweep(neededEditorKeys());
      databaseReaper.sweep(neededProjects("database"));
      clusterReaper.sweep(neededProjects("cluster"));
    }, SWEEP_INTERVAL_MS);

    // Every child this process started, released exactly once.
    //
    // Hung off more than the window's "closed" event on purpose. Each of
    // these children outlives its parent on POSIX — there is no
    // PDEATHSIG on macOS — so anything that ends the main process without
    // closing the window leaks them, and they are long-lived servers, not
    // one-shot commands. Ctrl+C in the terminal that ran `pnpm start` is
    // the case that actually bit: it left three headlamp-server processes
    // alive at once, each holding a port and a kubeconfig exec plugin.
    // Idempotent because the paths below overlap on a clean quit.
    let released = false;
    const releaseChildren = (): void => {
      if (released) return;
      released = true;
      // Each step is guarded so that one that throws — destroying a
      // WebContentsView from a signal handler is the plausible one — does
      // not strand every child after it. A leaked process is worse than a
      // logged error.
      const safely = (what: string, release: () => void): void => {
        try {
          release();
        } catch (error) {
          console.error(`[shutdown] ${what} failed: ${errorMessage(error)}`);
        }
      };
      safely("wiring", () => wiring.stop());
      // The bridge's own listener and its sockets — stop() removes the push
      // sink too (remote-access.ts), so a relaunch never double-sends.
      //
      // `void`, not `await`: releaseChildren() itself is synchronous, called
      // from three unawaitable places (window "closed", app "will-quit",
      // and a signal handler that calls process.exit() right after it) —
      // making it async would need "will-quit" to event.preventDefault()
      // and re-quit once every safely() step's promise settles, which the
      // signal-handler path can't do at all (there is no listener to
      // prevent-default there; the process is exiting on its own). So
      // remoteAccess.stop()'s final audit line (and any other in-flight
      // config/devices write bridge.stop() awaits) may not finish flushing
      // to disk before the process actually exits on a fast quit — a real,
      // accepted gap (M4 final review, minor), not one this fix wave closes.
      safely("remote bridge", () => {
        void remoteAccess
          .stop()
          .catch((error: unknown) =>
            console.error(`remote bridge: stop failed: ${errorMessage(error)}`),
          );
      });
      // Clears the notifier's own quiet timers and unsubscribes from
      // sessions/onTurn — otherwise both outlive the window they were
      // watching for.
      safely("notifier", () => notifier.dispose());
      // M9 Task 3: invalidates every staged device's generation before best-
      // effort disk cleanup, same fire-and-forget treatment as the bridge's
      // own stop() above — a fast quit may not see this finish flushing
      // either, and that is the same accepted gap.
      safely("uploads", () => {
        void uploadStore
          .stop()
          .catch((error: unknown) => console.error(`uploads: stop failed: ${errorMessage(error)}`));
      });
      // The idle sweeps. A live interval keeps the event loop open, so a
      // quit that got this far would otherwise sit there ticking.
      safely("idle sweeps", () => clearInterval(sweepTimer));
      // Each hosted view is a live Chromium process; they do not go away
      // with the window on their own.
      safely("hosted views", () => workspace.destroy());
      // Each open editor is a live code-server child process, same reasoning.
      safely("code-server", () => codeServer.stopAll());
      // And each open Database tab is a live dbgate-serve child process.
      safely("dbgate", () => dbgate.stopAll());
      // And each open Cluster tab is a live headlamp-server child process.
      safely("headlamp-server", () => headlamp.stopAll());
      // And each open Terminal tab is a live shell.
      safely("shells", () => shells.stopAll());
      // And the importer holds an fs watch per transcript directory.
      safely("session importer", () => sessionImporter.stop());
      // A recording started but never stopped holds ffmpeg — and the
      // microphone — open indefinitely.
      safely("recorder", () => recorder.abort());
      // Sessions still "starting"/"running"/"waiting" never reach
      // SessionManager#update's endedAt-setting branch on their own once
      // the window is gone, so their history() rows would stay wrong
      // forever, sorted to the very top (most-recently-active first).
      // kill() is the same path a user-initiated stop takes, so it
      // persists an endedAt-bearing row through the normal #persist choke
      // point — and it releases the agent process, which is the reason
      // this belongs here rather than only in "will-quit".
      safely("sessions", () => {
        for (const session of sessions.list()) {
          if (session.state === "done" || session.state === "dead") continue;
          sessions.kill(session.id);
        }
      });
      // Each followed container log is a live `docker logs -f` child.
      safely("docker logs", () => followers.closeAll());
    };

    // DbGate is spawned with BASIC_AUTH=1 (dbgate.ts) and answers with
    // Electron's own login challenge rather than showing its JWT form —
    // dbGateLoginAnswer is the pure decision of when it is safe to answer;
    // this only wires it (ruling 15).
    app.on("login", (event, _webContents, _details, authInfo, callback) => {
      const answer = dbGateLoginAnswer(authInfo, dbgate.credentialFor);
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

    // A session started in a terminal has no pty backlog — only the
    // transcript the importer recorded a path to. Without this the session
    // view opened blank for all 89 imported sessions. External rows are
    // included here (never in sessionResume just below): opening a
    // transcript is read-only, exactly what "outside Jarvis" is still
    // allowed to do.
    const sessionTranscript = createTranscriptHandler({
      history: () => [...sessionStore.history(), ...externalSessions.values()],
      readFile: (path) => readFile(path, "utf8"),
    });

    // Continuing a past session in a Workspace Terminal tab: Jarvis opens
    // the tab in the directory the session ran in and types the resume
    // command. The agent then runs as an ordinary terminal process that
    // Jarvis does not own — a real shell, at the cost of no live state.
    //
    // `history` deliberately excludes externalSessions (unlike
    // sessionTranscript above): an "ext-<pid>" id is not a real transcript
    // id `--resume` understands, and a row already running outside Jarvis
    // has no business being typed into a second time — resuming it here
    // would fail unhelpfully at best. history().find() finding nothing for
    // such an id is exactly cannotResumeSession's refusal path.
    const sessionResume = createResumeInTerminalHandler({
      history: () => sessionStore.history(),
      // Which shell the tab will type this into — the only thing about the
      // line that differs by platform. main is one of the three files the
      // platform convention lets read process.platform.
      shell: process.platform === "win32" ? "powershell" : "posix",
      agents: Object.fromEntries(registry.list().map((agent) => [agent.id, agent])),
      projects: config.projects,
      directoryExists: async (path: string) => {
        try {
          return (await stat(path)).isDirectory();
        } catch {
          return false;
        }
      },
      // Through the terminal handlers, never around them: they are what
      // registers a tab's directory for path completion and history
      // affinity, so a resumed terminal is a terminal like any other.
      openTerminal: (project: string, cwd: string) => {
        const opened = terminal.open(project, cwd);
        if (!opened.ok) throw new Error(opened.text);
        return opened.value;
      },
      sendInput: (tabId: string, data: string) => terminal.input(tabId, data),
      language: PRIMARY_LANGUAGE,
    });

    // The main process owns the sessionId -> projectPath mapping, so a
    // compromised renderer can request git data only for a repo a real
    // session is already running against, never an arbitrary path — see
    // createGitHandlers' own doc comment.
    const gitHandlers = createGitHandlers({
      git,
      sessions: { get: (id) => sessions.get(id) },
      language: PRIMARY_LANGUAGE,
      refresh: () => changeTracker.refresh(),
    });

    // See docker-followers.ts for why there is one `docker logs -f` per tab.
    const followers = createDockerFollowers({
      follow: (container, onChunk) => dockerClient.follow(container, onChunk),
      send: (tabId, chunk) => broadcast.send("docker:log", { tabId, chunk }),
    });

    async function listVoices() {
      // Each platform's own source of system voices, and nothing where there
      // is none: asking `say -v '?'` on Linux spawns a binary that is not
      // there, waits for it to fail, and returns the same empty list this
      // does immediately.
      const installed =
        process.platform === "darwin"
          ? await listInstalledVoices()
          : process.platform === "win32"
            ? await listWindowsVoices(windowsPowerShellPath(process.env))
            : [];
      // Piper is offered beside the system voices rather than in a separate
      // control: from where the user stands it is simply the best-sounding
      // English voice on the list.
      const system = installed.map((voice) => ({ ...voice, engine: "say" as const }));
      const piperVoices = [
        ...(piperReady
          ? [{ name: PIPER_VOICE, language: "en_GB", upgraded: true, engine: "piper" as const }]
          : []),
        // Arabic is only ever a Piper model off darwin — there is no `say` to
        // name a system voice with, so without this the Arabic picker would
        // be an empty control on a bilingual app.
        ...(arabicPiperReady && process.platform !== "darwin"
          ? [
              {
                name: PIPER_ARABIC_VOICE,
                language: "ar_JO",
                upgraded: true,
                engine: "piper" as const,
              },
            ]
          : []),
      ];
      return [...piperVoices, ...system];
    }
    // The sample is spoken through the same MacSpeech the app uses, so a
    // preview sounds exactly like the thing being chosen — including the
    // Enhanced upgrade, which is the whole point of listening first.
    function previewVoice(name: string, language: "ar" | "en"): void {
      const spoken = language === "ar" ? VOICE_SAMPLE.ar : VOICE_SAMPLE.en;
      // PIPER_VOICE is not a `say` voice, so a preview of it has to go through
      // Piper — otherwise the button would demo a different voice than the one
      // being chosen, which is the one thing a preview must not do.
      const preview =
        name === PIPER_VOICE && piperReady
          ? new PiperSpeech({
              binary: config.voice.piperBinary,
              model: config.voice.piperModel,
              player,
            })
          : name === PIPER_ARABIC_VOICE && arabicPiperReady
            ? new PiperSpeech({
                binary: config.voice.piperBinary,
                model: config.voice.piperArabicModel,
                player,
              })
            : process.platform === "darwin"
              ? new MacSpeech({ arabicVoice: name, englishVoice: name }, defaultSpeechRunner)
              : undefined;
      // Off darwin there is no `say` to preview a named system voice with,
      // and the Settings panel does not offer that list there — see
      // renderer/settings.ts.
      void preview?.speak(spoken, language).catch(() => undefined);
    }

    const recorder = new Recorder(createRecorderDeps(process.platform));

    function startVoice(): void {
      recorder.start();
      broadcast.send("voice:listening", true);
    }

    // Alt+Space / Alt+Shift+Space is a press-to-start / press-to-stop-and-send
    // pair, not a genuine toggle on one key: macOS reserves plain toggling of
    // a single combo for other system uses, and a distinct stop key also
    // means "stop without holding" is unambiguous to the user. The mic
    // button in the renderer drives the same pair through voice:start /
    // voice:stop IPC calls below, so voice has exactly one implementation
    // regardless of which control triggers it.
    function stopVoice(): void {
      // The mic button already guards this on the renderer's own
      // `isListening` flag; Alt+Shift+Space has no such guard, so a stop
      // with nothing active (e.g. the hotkey fired twice) must be a
      // silent no-op rather than falling through to recorder.stop()'s
      // "Not recording" throw, which processVoiceTurn's catch renders to
      // the user as a spurious "تعذر تسجيل الصوت: Not recording" turn.
      if (!recorder.isRecording()) return;

      broadcast.send("voice:listening", false);

      // Important 6: the whole turn — recorder stop, transcription, and
      // orchestrator dispatch — is wrapped in one promise chain with a
      // top-level `.catch`. Previously this was `void (async () => {...})()`
      // with a try/finally but no catch: if the `finally` block itself threw
      // (or any awaited call inside it rejected past its own local catch),
      // the rejection had no handler and Node's default
      // `--unhandled-rejections=throw` would kill the whole main process
      // mid-sentence.
      processVoiceTurn().catch((error) => {
        console.error(`Voice turn failed: ${errorMessage(error)}`);
      });
    }

    // See dispatch.ts's "voice:target" comment for where this goes.
    let voiceTargetSessionId: string | undefined;

    // Every request handler, in one table (dispatch.ts). Registered in a
    // loop so a second transport can call the same table with a different
    // Origin.
    // tailscale-cert.ts's own injected deps, wired to the real
    // subprocess/filesystem/home directory — the fixed macOS app-bundle CLI
    // path only applies on darwin (findTailscaleCli), so process.platform is
    // read here at main.ts's edge, the same place defaultHeadlampBinary
    // reads it, rather than inside tailscale-cert.ts itself.
    const tailscaleCertDeps: TailscaleCertDeps = {
      exec: (command, args, limits) => runCommandWithLimits(command, args, limits),
      fs: {
        access: (path) => access(path),
        mkdir: async (path, options) => {
          await mkdir(path, options);
        },
        chmod: (path, mode) => chmod(path, mode),
      },
      homedir,
      platform: process.platform,
    };

    const dispatch = createDispatchTable({
      setup,
      orchestrator,
      sessionStore,
      // Same four methods SessionManager itself implements, plus `list`
      // overridden to the merged view (mergedSessions()) — everything
      // else stays a direct call through to the real manager, which is
      // never fooled about an "ext-<pid>" id: log/snapshot answer their
      // documented empty default for one, write/resize no-op.
      sessions: {
        log: (id) => sessions.log(id),
        write: (id, data) => sessions.write(id, data),
        resize: (id, cols, rows) => sessions.resize(id, cols, rows),
        snapshot: (id) => sessions.snapshot(id),
        list: () => mergedSessions(),
      },
      refreshSessions,
      sessionTranscript,
      sessionResume,
      voice: {
        setTarget: (id) => {
          voiceTargetSessionId = id;
        },
      },
      git: gitHandlers,
      workspace,
      terminal,
      shells,
      followers,
      editor,
      database,
      cluster,
      chat,
      docker,
      projects: config.projects,
      dockerConfig: config.docker,
      language: PRIMARY_LANGUAGE,
      api,
      voices: { list: listVoices, preview: previewVoice },
      bookmarks,
      settings,
      providers,
      voiceControl: { start: startVoice, stop: stopVoice },
      readFile: (path) => readFile(path, "utf8"),
      uploads: { readJson: uploadStore.readJson },
      networkInterfaces: () => networkInterfaces(),
      remote: remoteAccess,
      sidecars: { publish: remoteAccess.publishSidecar },
      notifier,
      tailscaleCert: { obtain: () => obtainCertificate(tailscaleCertDeps) },
      writeConfig,
    });
    for (const [channel, handler] of Object.entries(dispatch)) {
      ipcMain.handle(channel, (_event, ...args: unknown[]) => handler(args, DESKTOP_ORIGIN));
    }

    registerDesktopOnly({
      handle: (channel, listener) => ipcMain.handle(channel, listener),
      window,
      screen,
      dialog,
      buildMenu: (template) => Menu.buildFromTemplate(template),
      workspace,
      chooseDock: (dock) => broadcast.local("workspace:devtoolsDockChosen", dock),
      language: PRIMARY_LANGUAGE,
    });
    workspace.onDevToolsClosed((tabId) => broadcast.local("workspace:devtoolsClosed", tabId));

    // Nothing listens until the bridge's own gate (rule 3) says so — this
    // only ever starts the lifecycle, and its own `apply` decides whether
    // that opens a socket. Fired and forgotten (never awaited): a slow or
    // failing bridge start must not hold up the window's first paint, and
    // any rejection is logged rather than becoming an unhandled one.
    void remoteAccess
      .start(config.remote)
      .catch((error: unknown) =>
        console.error(`remote bridge: start failed: ${errorMessage(error)}`),
      );

    // The desktop side of handleUtterance's UtteranceDeps: everything after
    // transcribe() itself lives in voice-turn.ts now, shared with the
    // phone's remote:uploadAudio handler (M8 Task 4). Only the transcribe
    // runner differs per caller — this is the desktop's unchanged one.
    const utteranceDeps: UtteranceDeps = {
      transcribe: (wavPath) => transcribe(wavPath, config.whisper, runCommand),
      sessions: { get: (id) => sessions.get(id), write: (id, data) => sessions.write(id, data) },
      orchestrator: {
        handle: (text, language, options) => orchestrator.handle(text, language, options),
      },
      broadcast,
      primaryLanguage: PRIMARY_LANGUAGE,
      log: (line) => console.error(line),
    };

    // `runCommandWithLimits` adapted to `CommandRunner`'s shape (`transcribe`
    // just wants {code, stdout, stderr}) so a phone-origin turn's whisper
    // call is bounded exactly like its ffmpeg one: killed after
    // TRANSCRIBE_TIMEOUT_MS, output capped at 1 MiB. A timeout, or a
    // truncated stream (the 1 MiB cap actually hit — code review M2: an
    // unreachable case for <=120s of audio, but free to guard), always
    // comes back with a non-zero code (SIGKILL already yields one via
    // runCommandWithLimits's own exit-code mapping; the `? 1` is belt-and-
    // braces) so `transcribe` throws instead of parsing a truncated
    // mid-decode stdout as though it were a complete transcript.
    async function limitedWhisperRunner(
      command: string,
      args: string[],
    ): Promise<{ code: number; stdout: string; stderr: string }> {
      const result = await runCommandWithLimits(command, args, {
        timeoutMs: TRANSCRIBE_TIMEOUT_MS,
        maxOutputBytes: 1_048_576,
      });
      const forceFailure = result.timedOut || result.truncated;
      return {
        code: forceFailure && result.code === 0 ? 1 : result.code,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }

    // ruling 4's pinned ffmpeg argv, bounded the same way: killed after
    // TRANSCODE_TIMEOUT_MS, each stream capped at 64 KiB. `detail` never
    // crosses the wire (ruling 17) and is not logged either (voice-upload.ts
    // logs a site category, "failed:transcode", never this string) — it
    // exists purely to satisfy this function's own declared return shape.
    // No stderr tail (review I1): a crafted or genuinely erroring input can
    // put its own path into ffmpeg's stderr (e.g. "No such file or
    // directory: <path>"), so `detail` carries only the exit code and
    // whether it was killed for running long — never a byte of stderr.
    async function transcodeVoiceUpload(
      input: string,
      output: string,
    ): Promise<{ ok: true } | { ok: false; detail: string }> {
      const { command, args } = transcodeToWhisperWavCommand(input, output);
      const result = await runCommandWithLimits(command, args, {
        timeoutMs: TRANSCODE_TIMEOUT_MS,
        maxOutputBytes: 65_536,
      });
      if (result.code === 0 && !result.timedOut) return { ok: true };
      return { ok: false, detail: `code=${result.code} timedOut=${result.timedOut}` };
    }

    // The phone's private temp directory (global constraints): a fresh
    // mkdtemp under os.tmpdir() (Node creates it 0700), one exclusive
    // 0600 write, removed before the request answers — never a phone-
    // supplied string in a path.
    async function makeVoiceTempDir(): Promise<string> {
      return mkdtemp(join(tmpdir(), "jarvis-voice-"));
    }

    async function writeVoiceFileExclusive(path: string, bytes: Uint8Array): Promise<void> {
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    }

    async function removeVoiceDir(dir: string): Promise<void> {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Never throws (voice-upload.ts's contract) — a removal that fails
        // leaves an orphaned temp dir rather than breaking the upload's own
        // response.
      }
    }

    const voiceUploadDeps: VoiceUploadDeps = {
      now: Date.now,
      makeTempDir: makeVoiceTempDir,
      writeFileExclusive: writeVoiceFileExclusive,
      removeDir: removeVoiceDir,
      transcode: transcodeVoiceUpload,
      utterance: (request) =>
        handleUtterance(request, {
          ...utteranceDeps,
          transcribe: (wavPath) => transcribe(wavPath, config.whisper, limitedWhisperRunner),
        }),
      language: PRIMARY_LANGUAGE,
      log: (line) => console.error(line),
    };

    // The blob channels the bridge accepts (remote-access.ts's blobLimit).
    // Built once; remote-access.ts calls `blobs()` lazily, so this only has
    // to exist by the time a phone's first upload arrives, same as
    // `dispatch` above.
    const blobTable = createBlobTable({
      uploadAudio: createVoiceUploadHandler(voiceUploadDeps),
      uploadFile: createFileUploadHandler(uploadStore, PRIMARY_LANGUAGE),
    });

    async function processVoiceTurn(): Promise<void> {
      let wavPath: string;
      try {
        wavPath = await recorder.stop();
      } catch (error) {
        const message = errorMessage(error);
        console.error(`Recorder stop failed: ${message}`);
        broadcast.send("turn:new", {
          role: "assistant",
          text: MESSAGES.recordingFailed(message, PRIMARY_LANGUAGE),
          language: PRIMARY_LANGUAGE,
          at: Date.now(),
        });
        return;
      }

      try {
        const { answered } = await handleUtterance(
          { wavPath, targetSessionId: voiceTargetSessionId, origin: { kind: "desktop" } },
          utteranceDeps,
        );
        await answered;
      } finally {
        // Recorder owns the wav file it created; nothing else reads it
        // past this point on any of the branches above, so it's always
        // deleted here rather than left behind in tmpdir().
        await recorder.cleanup(wavPath);
      }
    }

    // Alt+Space, or on Windows a fallback pair when another app holds it —
    // see hotkeys.ts. Which pair is live is reported to the renderer below,
    // so every hint it draws names a key that actually works.
    const hotkeys = registerVoiceHotkeys(
      {
        register: (accelerator, handler) => globalShortcut.register(accelerator, handler),
        unregister: (accelerator) => globalShortcut.unregister(accelerator),
        onStart: startVoice,
        onStop: stopVoice,
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

    // The greeting comes first, before the health line: it is instant, it is
    // the thing a person opening the app is owed, and the health probe takes
    // up to 5s. Spoken as well as shown — the same string, so the two can
    // never drift — and this is the only place the app speaks unprompted.
    // Nothing here waits for anything the greeting does not use. Two things
    // were being waited on unconditionally, and together they left the
    // conversation panel empty for about two seconds on every launch:
    //
    //   `say -v ?` takes 1.2s, and it only decides which macOS voice to use —
    //   which the default configuration does not, because English goes
    //   through Piper.
    //
    //   Scanning four repositories for uncommitted work takes 0.9s, and the
    //   default greeting no longer mentions it. A template that asks for
    //   {uncommitted} still gets it; one that does not, does not pay for it.
    // Silent by request: voice.speakGreeting off means the panel still gets
    // the greeting and nothing is said aloud. Asking `say` for its voice
    // list costs 1.2s and only decides which macOS voice to speak with, so
    // with nothing to speak there is nothing to wait for either.
    const speakGreeting = config.voice.speakGreeting;
    if (speakGreeting && !piperReady) await systemSpeech?.ready;

    const template = config.voice.greeting[PRIMARY_LANGUAGE] ?? "";
    const wantsUncommitted = template.includes("{uncommitted}");
    const greeting = greetingText(
      {
        now: Date.now(),
        history: sessionStore.history(),
        dirtyProjects: wantsUncommitted ? await dirtyProjects : [],
        template: config.voice.greeting,
      },
      PRIMARY_LANGUAGE,
    );
    broadcast.send("turn:new", {
      role: "assistant",
      text: greeting,
      language: PRIMARY_LANGUAGE,
      at: Date.now(),
    });
    if (speakGreeting) void announceSpeaking(greeting, PRIMARY_LANGUAGE);

    const report = await reportPromise;
    console.log(report.message);
    if (report.message !== "") {
      broadcast.send("turn:new", {
        role: "assistant",
        text: report.message,
        language: "en",
        at: Date.now(),
      });
    }

    broadcast.send("providers:update", providers.snapshot());

    void capacityPromise.then(() => {
      // The capacity refresh takes up to 20s per account, so this callback
      // can land long after a user who launched, glanced and quit. Nothing
      // here needs guarding on that any more: every broadcast.send below
      // goes through rendererSink, which already swallows a destroyed
      // window on its own — and this push is for every sink, not only the
      // one window this process happens to have.
      broadcast.send("providers:update", providers.snapshot());
      const capacity = capacityReport(providers.snapshot(), PRIMARY_LANGUAGE);
      if (capacity === "") return;
      broadcast.send("turn:new", {
        role: "assistant",
        text: capacity,
        language: PRIMARY_LANGUAGE,
        at: Date.now(),
      });
    });
  } catch (error) {
    dialog.showErrorBox("Jarvis failed to start", errorMessage(error));
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
