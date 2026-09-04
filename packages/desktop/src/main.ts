import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, globalShortcut, ipcMain, screen, session } from "electron";
import type { Session } from "electron";
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
import {
  MacSpeech,
  PiperSpeech,
  RoutedSpeech,
  createBookmarkStore,
  createBrain,
  createCapacityReader,
  createCodeServerManager,
  createDbGateManager,
  createFaviconStore,
  createFsImportDeps,
  createGitProvider,
  createHeadlampManager,
  createKubeContextLister,
  createMetricsReader,
  createPtySpawner,
  createRealCodeServerSpawner,
  createRealDockerClient,
  createRealShellSpawner,
  createSessionImporter,
  createShellManager,
  installZshIntegration,
  createCollection,
  createFolder,
  apiFetch,
  apiMultipart,
  createApiStore,
  createAwsSessionChecker,
  createAwsSessionPoller,
  createCookieJar,
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
  defaultVoiceLister,
  loginShellPath,
  randomPassword,
  findFreePort,
  readStatusPage,
  runCommand,
  transcribe,
  waitUntilReady,
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
  isDeclaredContainer,
  PROVIDER_HEALTH_INTERVAL_MS,
  showEditorTab,
} from "./ipc.js";
import { BrowserHost, type Rect } from "./browser-host.js";
import { createElectronViewFactory } from "./electron-view.js";
import { cacheFavicon as fetchFavicon } from "./favicon-fetch.js";
import { isAllowedNavigation } from "./navigation.js";
import {
  createCompletionSource,
  createDirectoryLister,
  createFileReader,
} from "./completion-source.js";
import { DEFAULT_CONFIG_PATH, defaultWorkflowsDir, loadConfig } from "./config.js";
import { LOGIN_TERMINAL_DETAIL } from "./login-terminal.js";
import { writeSettingsFile } from "./settings-io.js";
import { errorMessage, MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";
import { defaultRecorderDeps, Recorder } from "./recorder.js";
import { capacityReport, startupReport } from "./startup.js";
import { toDeviceIndependent } from "./view-bounds.js";
import type { ReportedRect } from "./ipc.js";

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

const VOICE_SAMPLE = {
  en: "Good evening sir, how can I help you today?",
  ar: "مساء الخير يا سيدي، كيف أقدر أساعدك اليوم؟",
};

app.whenReady().then(async () => {
  setDockIcon();
  try {
    const config = await loadConfig();
    const registry = new AgentRegistry(config.registry);

    const providerStore = new ProviderStatusStore(registry.list());
    const readCapacity = createCapacityReader({ cwd: config.brain.cwd });
    const providers = new ProviderMonitor({
      agents: registry.list(),
      store: providerStore,
      readCapacity,
      readHealth: (vendor) => readStatusPage(vendor),
    });

    // Started, never awaited — ruling R35: nothing that touches the network
    // may sit between app-ready and the window existing. The health poll is
    // free; the capacity refresh is one billed query per readable account and
    // happens exactly once here, at launch. There is no capacity interval
    // anywhere in this file, deliberately.
    void providers.refreshHealth();
    const capacityPromise = providers.refreshCapacity().catch((error) => {
      console.error(`Provider capacity refresh failed: ${errorMessage(error)}`);
    });

    // Started, not awaited: the health probe (bounded per-agent in
    // @jarvis/core, but still a network of spawned processes) must never
    // hold up the window appearing. The `.catch` is attached immediately —
    // not after some later `await` — so that if this promise settles after
    // the outer try/catch has already run dialog.showErrorBox/app.quit()
    // for an unrelated startup failure, it cannot surface as an unhandled
    // rejection; checkAgent itself never rejects, so this is a safety net.
    const reportPromise = startupReport(registry, runCommand).catch((error) => {
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
    const sessions = new SessionManager(createPtySpawner(), sessionStore);

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
    // macOS's own voices, always — Arabic goes through these whichever engine
    // English uses, because a Piper model speaks one language.
    const macSpeech = new MacSpeech(
      { arabicVoice: config.voice.arabicVoice, englishVoice: config.voice.englishVoice },
      defaultSpeechRunner,
      defaultVoiceLister,
    );

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
        `Piper is configured but not installed (${config.voice.piperBinary}, ${config.voice.piperModel}) — using macOS voices.`,
      );
    }

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
      window.webContents.send("voice:speaking", true);
      try {
        await speech.speak(text, language);
      } finally {
        window.webContents.send("voice:speaking", false);
      }
    };

    const speech = piperReady
      ? new RoutedSpeech(
          new PiperSpeech({ binary: config.voice.piperBinary, model: config.voice.piperModel }),
          macSpeech,
        )
      : macSpeech;
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
      // else: it opens full screen. The width and height are still worth
      // stating — they are the size the window restores to the moment
      // anyone leaves full screen.
      fullscreen: true,
      width: 1440,
      height: 900,
      backgroundColor: "#060a0f",
      // Windows and Linux take the icon from the window; macOS takes it from
      // the bundle at package time and from the dock while developing, which
      // is what setDockIcon below is for.
      icon: iconPath("icon.png"),
      webPreferences: {
        preload: fileURLToPath(new URL("preload.cjs", import.meta.url)),
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

    // The Workspace's hosted browser tabs. Each is a native WebContentsView
    // over this window, so the host — not CSS — decides where they sit and
    // whether they are visible at all.
    const workspace = new BrowserHost(createElectronViewFactory(window), { cacheFavicon });

    // One code-server process per project, started lazily the first time
    // its editor is opened. Jarvis-managed profile directories, separate
    // from anywhere the user's own VS Code (if any) keeps its own settings.
    const codeServerRoot = join(homedir(), ".config/jarvis/code-server");
    const codeServer = createCodeServerManager({
      spawn: createRealCodeServerSpawner(),
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
      spawn: createRealDbGateSpawner(),
      findFreePort,
      waitUntilReady,
      ensureDir: async (path) => {
        await mkdir(path, { recursive: true });
      },
      workspaceRoot: dbgateRoot,
      connectionsFor: (project) => config.databases[project] ?? [],
      env: process.env,
      randomPassword,
    });
    const database = createDatabaseHandlers({
      dbgate,
      projects: config.projects,
      language: PRIMARY_LANGUAGE,
    });

    // Asked once, at startup: the exec credential plugin a kubeconfig names
    // (aws, gcloud, kubelogin) is resolved on PATH, and a GUI app's PATH is
    // not the user's. Undefined when the shell could not be asked, in which
    // case the inherited environment stands — right for a Jarvis launched
    // from a terminal.
    const shellPath = await loginShellPath();
    const env = shellPath === undefined ? process.env : { ...process.env, PATH: shellPath };
    const headlamp = createHeadlampManager({
      spawn: createRealHeadlampSpawner(env),
      findFreePort,
      waitUntilReady,
      listContexts: createKubeContextLister(join(homedir(), ".kube/config")),
      clusters: config.clusters,
      binary: config.headlamp.binary,
      kubeconfigPath: join(homedir(), ".kube/config"),
    });
    const checkAwsSession = createAwsSessionChecker(env);
    const awaitAwsSession = createAwsSessionPoller(checkAwsSession);
    // Same reasoning as headlamp above: `docker` lives wherever the login
    // shell's PATH puts it (Homebrew, OrbStack, Docker Desktop's shim), not
    // wherever a GUI-launched process's PATH puts it.
    const dockerClient = createRealDockerClient(env);

    // Terminal autocomplete's shell integration, installed before the first
    // shell can be started. It writes a Jarvis-owned ZDOTDIR whose files
    // chain to the user's real dotfiles; ~/.zshrc and friends are read and
    // never modified. Undefined means no integration — disabled, not zsh,
    // or unwritable — and the terminal then behaves exactly as it did
    // before this feature existed.
    const completionEnabled = config.terminal.completion.enabled;
    const zdotdir = join(homedir(), ".config/jarvis/zdotdir");
    await mkdir(zdotdir, { recursive: true }).catch(() => undefined);
    await mkdir(dirname(config.terminal.completion.commandLogPath), { recursive: true }).catch(
      () => undefined,
    );
    const installedZdotdir = await installZshIntegration({
      shell: process.env["SHELL"],
      enabled: completionEnabled,
      dir: zdotdir,
      realZdotdir: process.env["ZDOTDIR"] ?? homedir(),
      write: (path, contents) => writeFile(path, contents, "utf8"),
    });

    // One login shell per Terminal tab, under a real pty. Unlike the editor
    // and the database this hosts no page and opens no port: the tab has no
    // view at all, and its screen is drawn by the renderer's own xterm.
    const shells = createShellManager({
      spawn: createRealShellSpawner(process.env, {
        zdotdir: installedZdotdir,
        // Only worth writing when the wrapper that reads it is installed.
        commandLog:
          installedZdotdir === undefined
            ? undefined
            : config.terminal.completion.commandLogPath,
      }),
    });

    const completionSource = createCompletionSource({
      readHistory: createFileReader(config.terminal.completion.historyPath),
      readCommandLog: createFileReader(config.terminal.completion.commandLogPath),
      listDirectory: createDirectoryLister(),
      now: () => Date.now(),
    });
    // The API tab. Requests are issued from here, in the main process, which
    // is what makes CORS irrelevant — see http-runner.ts.
    const apiStore = createApiStore(join(homedir(), ".config/jarvis/api.json"));

    /**
     * One send, with everything a request can ask for around it: the
     * project's cookie jar and network settings, its pre-request and
     * post-response scripts, and an OAuth2 token when the request wants one.
     *
     * Assembled here rather than inside http-runner.ts because every piece of
     * it is a policy decision — which jar, whose settings, whether scripts run
     * — and the runner's job is only to make the call.
     */
    async function sendApiRequest(
      request: Record<string, unknown>,
      variables: Record<string, string>,
      project: string,
    ) {
      const state = await apiStore.read(project);
      const jar = createCookieJar(state.cookies);
      const settings = state.settings;

      const http = (request["http"] ?? {}) as { method?: string; url?: string; auth?: string };
      const scriptBlock = (request["script"] ?? {}) as { req?: string; res?: string };
      const logs: string[] = [];
      const tests: { name: string; passed: boolean; error?: string }[] = [];
      let scriptError: string | undefined;

      const scriptRequest = {
        method: (http.method ?? "get").toUpperCase(),
        url: http.url ?? "",
        headers: {},
        body: request["body"],
      };

      // The pre-request script runs first, and the variables it sets are
      // available to the request it precedes — that is the whole point of it.
      let resolved = { ...variables };
      if (typeof scriptBlock.req === "string" && scriptBlock.req.trim() !== "") {
        const outcome = runScript(scriptBlock.req, { variables: resolved, request: scriptRequest });
        resolved = { ...resolved, ...outcome.variables };
        logs.push(...outcome.logs);
        tests.push(...outcome.tests);
        scriptError = outcome.error;
      }

      // OAuth2 is fetched after the pre-request script, so a script can set
      // the client secret the token call needs.
      let token;
      if (http.auth === "oauth2") {
        const config = ((request["auth"] ?? {}) as Record<string, never>)["oauth2"] ?? {};
        const result = await fetchOAuth2Token(config, resolved, {
          fetch: apiFetch,
          now: () => Date.now(),
          authorize: (url, redirectUri) => authorizeInWorkspace(project, url, redirectUri),
        });
        if (!result.ok) {
          return {
            response: { failed: true as const, detail: `OAuth2: ${result.detail}`, timeMs: 0 },
            cookies: jar.list(),
            scripts: { logs, tests, ...(scriptError === undefined ? {} : { error: scriptError }) },
          };
        }
        token = result.token;
      }

      const response = await sendRequest(
        request,
        resolved,
        {
          fetch: apiFetch,
          now: () => Date.now(),
          jar,
          readFile: (path) => readFile(path),
          multipart: apiMultipart,
          dispatcherFor,
          ...(token === undefined ? {} : { token }),
        },
        {
          verifyCertificate: settings.verifyCertificate,
          timeoutMs: settings.timeoutMs,
          ...(settings.proxyUrl === "" ? {} : { proxyUrl: settings.proxyUrl }),
        },
      );

      // The post-response script and the tests block see the response. A
      // response body that is JSON arrives parsed, which is what every
      // example in the wild assumes.
      if (!("failed" in response)) {
        let parsed: unknown = response.body;
        try {
          parsed = JSON.parse(response.body);
        } catch {
          // Not JSON; the script gets the text.
        }
        const scriptResponse = {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          body: parsed,
          responseTime: response.timeMs,
        };
        const after = [scriptBlock.res, request["tests"]].filter(
          (code): code is string => typeof code === "string" && code.trim() !== "",
        );
        for (const code of after) {
          const outcome = runScript(code, {
            variables: resolved,
            request: scriptRequest,
            response: scriptResponse,
          });
          logs.push(...outcome.logs);
          tests.push(...outcome.tests);
          scriptError = scriptError ?? outcome.error;
        }
      }

      await apiStore.saveCookies(project, jar.list());

      return {
        response,
        cookies: jar.list(),
        ...(logs.length === 0 && tests.length === 0 && scriptError === undefined
          ? {}
          : { scripts: { logs, tests, ...(scriptError === undefined ? {} : { error: scriptError }) } }),
      };
    }

    /** Drives an OAuth2 authorization-code redirect through a Workspace tab:
     *  the app already has a browser, and sending the user to their system
     *  browser to copy a code back by hand would be the worse product. */
    function authorizeInWorkspace(project: string, url: string, redirectUri = ""): Promise<string> {
      return workspace.openForResult(project, url, redirectUri);
    }

    const api = createApiHandlers({
      listCollections,
      readCollection,
      readRequest,
      writeRequest,
      sendRequest: (request, variables, project) => sendApiRequest(request, variables, project),
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
    });

    const terminal = createTerminalHandlers({
      shells,
      openTerminalTab: (project, label) => workspace.openTerminal(project, label),
      projects: config.projects,
      language: PRIMARY_LANGUAGE,
      completion: { source: completionSource, enabled: completionEnabled },
      terminal: config.terminal,
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
    });

    const settings = createSettingsHandlers({
      readConfig: () => loadConfig(DEFAULT_CONFIG_PATH),
      writeConfig: (draft) => writeSettingsFile(DEFAULT_CONFIG_PATH, draft),
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

    const indexUrl = pathToFileURL(
      fileURLToPath(new URL("../../renderer/index.html", import.meta.url)),
    ).href;

    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url, indexUrl)) {
        event.preventDefault();
      }
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
      send: (channel, payload) => window.webContents.send(channel, payload),
      readMetrics: createMetricsReader(),
      intervalMs: 2000,
      onSessionsChange: (cb) => sessions.onChange(cb),
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
    });
    wiring.start();

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
      safely("docker logs", () => {
        for (const follower of logFollowers.values()) follower.close();
        logFollowers.clear();
      });
    };

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

    ipcMain.handle("input:send", async (_event, text: string, language: "ar" | "en") => {
      await orchestrator.handle(text, language);
    });

    // Pulled on demand when the renderer's history panel opens, not
    // pushed — there is no live subscriber to keep in sync for a past-
    // sessions view, only a snapshot to render once per open.
    ipcMain.handle("history:list", () => sessionStore.history());

    // The Session view's backlog. Like history:list this is pulled on
    // demand rather than pushed: everything printed *after* the view opens
    // arrives on the "session:output" channel instead. The renderer only
    // ever names a session id — it can never ask for output from a process
    // Jarvis did not itself start.
    ipcMain.handle("session:log", (_event, sessionId: string) =>
      typeof sessionId === "string" ? sessions.log(sessionId) : "",
    );

    // A session started in a terminal has no pty backlog — only the
    // transcript the importer recorded a path to. Without this the session
    // view opened blank for all 89 imported sessions.
    const sessionTranscript = createTranscriptHandler({
      history: () => sessionStore.history(),
      readFile: (path) => readFile(path, "utf8"),
    });
    // (_event, id), never the bare handler: ipcMain.handle calls its
    // listener with the invoke event first, so a handler taking the id as
    // its first parameter silently receives the event instead and refuses
    // every session.
    ipcMain.handle("session:transcript", (_event, sessionId: unknown) =>
      sessionTranscript(sessionId),
    );

    // Continuing a past session in a Workspace Terminal tab: Jarvis opens
    // the tab in the directory the session ran in and types the resume
    // command. The agent then runs as an ordinary terminal process that
    // Jarvis does not own — a real shell, at the cost of no live state.
    const sessionResume = createResumeInTerminalHandler({
      history: () => sessionStore.history(),
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
    ipcMain.handle(
      "session:resume",
      (_event, sessionId: unknown, selectedProject: unknown) =>
        sessionResume(sessionId, selectedProject),
    );

    // Keystrokes into a session's pty. Validated rather than trusted: the
    // renderer names a session id, never a process — the main process owns
    // that mapping, so a compromised renderer can only ever type into a
    // session Jarvis itself started.
    ipcMain.handle("session:input", (_event, sessionId: string, data: string) => {
      if (typeof sessionId !== "string" || typeof data !== "string") return;
      sessions.write(sessionId, data);
    });

    // Where a spoken utterance goes. Normally the brain, which decides what
    // to do with it; but while a session's terminal is open, speaking is
    // meant to talk to THAT agent — the same thing as typing into it — so
    // the renderer names the session it is showing and the transcript is
    // typed there instead. Cleared (undefined) whenever the view is left.
    let voiceTargetSessionId: string | undefined;

    ipcMain.handle("voice:target", (_event, sessionId: unknown) => {
      voiceTargetSessionId = typeof sessionId === "string" ? sessionId : undefined;
    });

    ipcMain.handle("session:resize", (_event, sessionId: string, cols: number, rows: number) => {
      if (typeof sessionId !== "string") return;
      if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
      sessions.resize(sessionId, cols, rows);
    });

    // The main process owns the sessionId -> projectPath mapping, so a
    // compromised renderer can request git data only for a repo a real
    // session is already running against, never an arbitrary path — see
    // createGitHandlers' own doc comment. Registered here, before
    // `window.loadFile` below, following the same ordering fix as
    // "input:send"/"history:list" above and phase 1's Task 12 ruling: a
    // handler must exist before the page that could invoke it loads.
    const gitHandlers = createGitHandlers({
      git,
      sessions: { get: (id) => sessions.get(id) },
      language: PRIMARY_LANGUAGE,
      refresh: () => changeTracker.refresh(),
    });

    ipcMain.handle("git:changes", (_event, sessionId: string) => gitHandlers.changes(sessionId));
    ipcMain.handle("git:diff", (_event, sessionId: string, path: string) =>
      gitHandlers.fileDiff(sessionId, path),
    );
    ipcMain.handle("git:setStaged", (_event, sessionId: string, path: string, staged: boolean) =>
      gitHandlers.setStaged(sessionId, path, staged),
    );
    ipcMain.handle("git:commit", (_event, sessionId: string, message: string) =>
      gitHandlers.commit(sessionId, message),
    );

    // Every argument here crosses an untyped IPC boundary. workspace.open
    // and .navigate go into normalizeInput either way, but a non-string
    // still must not reach it as if it were one.
    ipcMain.handle(
      "workspace:open",
      (_event, project: unknown, input: unknown, kind: unknown, detail: unknown) => {
        if (typeof project !== "string" || typeof input !== "string") return;
        workspace.open(
          project,
          input,
          kind === "editor" || kind === "database" || kind === "cluster" ? kind : "web",
          typeof detail === "string" ? detail : undefined,
        );
      },
    );
    ipcMain.handle("workspace:close", (_event, id: unknown) => {
      if (typeof id !== "string") return;
      // A terminal tab's shell and a Docker tab's `docker logs -f` are both
      // child processes of their own; closing the tab has to reap them.
      // Either call on a tab that has neither is a no-op, so this needs no
      // test of the tab's kind. The renderer unfollows too when it notices
      // the tab go away, but a guarantee about a live child process must not
      // rest on the renderer alone.
      terminal.close(id);
      unfollow(id);
      workspace.close(id);
    });
    ipcMain.handle("workspace:activate", (_event, id: unknown) => {
      if (typeof id === "string") workspace.activate(id);
    });
    ipcMain.handle("workspace:navigate", (_event, id: unknown, input: unknown) => {
      if (typeof id === "string" && typeof input === "string") workspace.navigate(id, input);
    });
    ipcMain.handle("workspace:back", (_event, id: unknown) => {
      if (typeof id === "string") workspace.back(id);
    });
    ipcMain.handle("workspace:forward", (_event, id: unknown) => {
      if (typeof id === "string") workspace.forward(id);
    });
    ipcMain.handle("workspace:reload", (_event, id: unknown) => {
      if (typeof id === "string") workspace.reload(id);
    });
    // Which display the window is actually on: dragging Jarvis to a second
    // screen with a different scale changes the conversion below, and
    // getDisplayMatching answers for the screen the window occupies rather
    // than assuming the primary one.
    const displayScale = (): number => screen.getDisplayMatching(window.getBounds()).scaleFactor;

    // The renderer measures in CSS pixels and a hosted view is placed in
    // device-independent pixels. Those agree only while the display is not
    // running a scaled resolution; converting against the window's own
    // content box is what keeps a page filling its slot on a display where
    // they do not. See view-bounds.ts.
    ipcMain.handle("workspace:bounds", (_event, bounds: ReportedRect) =>
      workspace.setBounds(toDeviceIndependent(bounds, bounds.devicePixelRatio, displayScale())),
    );
    ipcMain.handle("workspace:devtools", (_event, tabId: unknown, open: unknown) => {
      if (typeof tabId !== "string" || typeof open !== "boolean") return;
      workspace.setDevTools(tabId, open);
    });
    ipcMain.handle("workspace:devtoolsBounds", (_event, bounds: ReportedRect) =>
      workspace.setDevToolsBounds(
        toDeviceIndependent(bounds, bounds.devicePixelRatio, displayScale()),
      ),
    );
    ipcMain.handle("workspace:visible", (_event, visible: unknown) =>
      workspace.setVisible(visible === true),
    );
    ipcMain.handle("workspace:hideAll", () => workspace.hideAll());
    ipcMain.handle("workspace:pip", (_event, tabId: unknown) => {
      if (typeof tabId === "string") workspace.requestPictureInPicture(tabId);
    });
    ipcMain.handle("editor:open", (_event, project: unknown, root: unknown) =>
      editor.open(
        typeof project === "string" ? project : "",
        // Absent means the project directory itself; anything that is not a
        // string is not a root name and must not be treated as one.
        typeof root === "string" ? root : undefined,
      ),
    );
    ipcMain.handle("editor:roots", (_event, project: unknown) =>
      editor.roots(typeof project === "string" ? project : "")
    );
    ipcMain.handle("database:open", (_event, project: unknown) =>
      database.open(typeof project === "string" ? project : ""),
    );
    ipcMain.handle(
      "cluster:open",
      (_event, project: unknown, clusterName: unknown, background: unknown) =>
        cluster.open(
          typeof project === "string" ? project : "",
          typeof clusterName === "string" ? clusterName : "",
          // Anything that is not the literal true is a click: the flag only
          // ever removes capability (no login terminal, no MFA push), so the
          // safe reading of a malformed one is the one that asks for less.
          { background: background === true },
        ),
    );
    ipcMain.handle("cluster:names", (_event, project: unknown) =>
      cluster.names(typeof project === "string" ? project : ""),
    );
    ipcMain.handle("chat:open", (_event, project: unknown, name: unknown) =>
      chat.open(
        typeof project === "string" ? project : "",
        typeof name === "string" ? name : "",
      ),
    );
    ipcMain.handle("chat:names", (_event, project: unknown) =>
      chat.names(typeof project === "string" ? project : ""),
    );

    // Whether a project already has a Docker tab is the renderer's business,
    // exactly as it is for the API tab.
    ipcMain.handle("docker:open", (_event, project: unknown) => {
      if (typeof project !== "string" || config.projects[project] === undefined) {
        return { ok: false, text: MESSAGES.unknownProject(PRIMARY_LANGUAGE), language: PRIMARY_LANGUAGE };
      }
      workspace.openDocker(project);
      return { ok: true, value: undefined };
    });
    ipcMain.handle("docker:names", (_event, project: unknown) => docker.names(project as string));
    ipcMain.handle("docker:view", (_event, project: unknown) => docker.view(project as string));
    ipcMain.handle("docker:containers", () => docker.containers());
    ipcMain.handle("docker:start", (_event, project: unknown, container: unknown) =>
      docker.start(project as string, container as string),
    );
    ipcMain.handle("docker:stop", (_event, project: unknown, container: unknown) =>
      docker.stop(project as string, container as string),
    );
    ipcMain.handle("docker:restart", (_event, project: unknown, container: unknown) =>
      docker.restart(project as string, container as string),
    );
    ipcMain.handle("docker:composeUp", (_event, project: unknown) =>
      docker.composeUp(project as string),
    );
    ipcMain.handle("docker:composeDown", (_event, project: unknown) =>
      docker.composeDown(project as string),
    );
    ipcMain.handle("docker:shell", (_event, project: unknown, container: unknown) =>
      docker.shell(project as string, container as string),
    );

    // One `docker logs -f` per open Docker tab, never per container: the tab
    // shows one log at a time, and a follower per row would be a process per
    // container for output nobody is looking at.
    const logFollowers = new Map<string, { close(): void }>();
    const unfollow = (tabId: string): void => {
      logFollowers.get(tabId)?.close();
      logFollowers.delete(tabId);
    };
    ipcMain.handle(
      "docker:follow",
      (_event, tabId: unknown, project: unknown, container: unknown) => {
        if (typeof tabId !== "string" || typeof project !== "string" || typeof container !== "string") {
          return { ok: false, text: MESSAGES.unknownProject(PRIMARY_LANGUAGE), language: PRIMARY_LANGUAGE };
        }
        // The same check the Docker handlers apply — membership and name
        // grammar both, from the one shared helper — so `follow` is not the
        // one door into Docker that enforces a weaker rule than the rest.
        if (!isDeclaredContainer(config.docker[project], container)) {
          return {
            ok: false,
            text: MESSAGES.dockerUnknownContainer(PRIMARY_LANGUAGE),
            language: PRIMARY_LANGUAGE,
          };
        }
        unfollow(tabId);
        logFollowers.set(
          tabId,
          dockerClient.follow(container, (chunk) => {
            if (window.isDestroyed()) return;
            window.webContents.send("docker:log", { tabId, chunk });
          }),
        );
        return { ok: true, value: undefined };
      },
    );
    ipcMain.handle("docker:unfollow", (_event, tabId: unknown) => {
      if (typeof tabId === "string") unfollow(tabId);
    });

    // Opening the tab is main's job (only it holds the BrowserHost); deciding
    // whether one already exists is the renderer's, exactly as it is for the
    // Editor and Database buttons.
    ipcMain.handle("api:open", (_event, project: unknown) => {
      if (typeof project !== "string" || config.projects[project] === undefined) {
        return { ok: false, text: MESSAGES.unknownProject(PRIMARY_LANGUAGE), language: PRIMARY_LANGUAGE };
      }
      workspace.openApi(project);
      return { ok: true, value: undefined };
    });
    ipcMain.handle("api:collections", (_event, project: unknown) =>
      api.collections(project as string),
    );
    ipcMain.handle("api:tree", (_event, project: unknown, path: unknown) =>
      api.tree(project as string, path as string),
    );
    ipcMain.handle("api:request", (_event, project: unknown, path: unknown) =>
      api.request(project as string, path as string),
    );
    ipcMain.handle("api:save", (_event, project: unknown, path: unknown, json: unknown) =>
      api.save(project as string, path as string, json as Record<string, unknown>),
    );
    ipcMain.handle("api:send", (_event, project: unknown, request: unknown, variables: unknown) =>
      api.send(
        project as string,
        request as Record<string, unknown>,
        variables as Record<string, string>,
      ),
    );
    ipcMain.handle("voice:list", async () => {
      const installed = await listInstalledVoices();
      // Piper is offered beside the system voices rather than in a separate
      // control: from where the user stands it is simply the best-sounding
      // English voice on the list.
      const system = installed.map((voice) => ({ ...voice, engine: "say" as const }));
      return piperReady
        ? [{ name: PIPER_VOICE, language: "en_GB", upgraded: true, engine: "piper" as const }, ...system]
        : system;
    });
    // The sample is spoken through the same MacSpeech the app uses, so a
    // preview sounds exactly like the thing being chosen — including the
    // Enhanced upgrade, which is the whole point of listening first.
    ipcMain.handle("voice:preview", (_event, name: unknown, language: unknown) => {
      if (typeof name !== "string" || name.trim() === "") return;
      const spoken = language === "ar" ? VOICE_SAMPLE.ar : VOICE_SAMPLE.en;
      // PIPER_VOICE is not a `say` voice, so a preview of it has to go through
      // Piper — otherwise the button would demo a different voice than the one
      // being chosen, which is the one thing a preview must not do.
      const preview =
        name === PIPER_VOICE && piperReady
          ? new PiperSpeech({ binary: config.voice.piperBinary, model: config.voice.piperModel })
          : new MacSpeech({ arabicVoice: name, englishVoice: name }, defaultSpeechRunner);
      void preview.speak(spoken, language === "ar" ? "ar" : "en").catch(() => undefined);
    });
    ipcMain.handle("api:history", (_event, p: unknown) => api.history(p as string));
    ipcMain.handle("api:clearHistory", (_event, p: unknown) => api.clearHistory(p as string));
    ipcMain.handle("api:cookies", (_event, p: unknown) => api.cookies(p as string));
    ipcMain.handle("api:clearCookies", (_event, p: unknown) => api.clearCookies(p as string));
    ipcMain.handle("api:removeCookie", (_event, p: unknown, n: unknown, d: unknown, path: unknown) =>
      api.removeCookie(p as string, n as string, d as string, path as string),
    );
    ipcMain.handle("api:settings", (_event, p: unknown) => api.settings(p as string));
    ipcMain.handle("api:saveSettings", (_event, p: unknown, settings: unknown) =>
      api.saveSettings(p as string, settings as never),
    );
    // A native picker, for a multipart file field and for importing a
    // collection. Cancelling returns [] — it is not a failure.
    ipcMain.handle("dialog:pickFiles", async (_event, options: unknown) => {
      const multiple = (options as { multiple?: boolean } | undefined)?.multiple === true;
      const result = await dialog.showOpenDialog(window, {
        properties: multiple ? ["openFile", "multiSelections"] : ["openFile"],
      });
      return result.canceled ? [] : result.filePaths;
    });
    ipcMain.handle("dialog:readJson", async (_event, path: unknown) => {
      if (typeof path !== "string") {
        return { ok: false, text: MESSAGES.invalidArgument(PRIMARY_LANGUAGE), language: PRIMARY_LANGUAGE };
      }
      try {
        return { ok: true, value: JSON.parse(await readFile(path, "utf8")) };
      } catch (error) {
        return { ok: false, text: errorMessage(error), language: PRIMARY_LANGUAGE };
      }
    });
    ipcMain.handle("api:curl", (_event, p: unknown, request: unknown, variables: unknown) =>
      api.curl(p as string, request as Record<string, unknown>, variables as Record<string, string>),
    );
    ipcMain.handle("api:createRequest", (_event, p: unknown, folder: unknown, name: unknown, seq: unknown) =>
      api.createRequest(p as string, folder as string, name as string, seq as number),
    );
    ipcMain.handle("api:createFolder", (_event, p: unknown, parent: unknown, name: unknown) =>
      api.createFolder(p as string, parent as string, name as string),
    );
    ipcMain.handle("api:rename", (_event, p: unknown, path: unknown, name: unknown, folder: unknown) =>
      api.renameEntry(p as string, path as string, name as string, folder === true),
    );
    ipcMain.handle("api:delete", (_event, p: unknown, path: unknown) =>
      api.deleteEntry(p as string, path as string),
    );
    ipcMain.handle("api:createCollection", (_event, p: unknown, name: unknown) =>
      api.createCollection(p as string, name as string),
    );
    ipcMain.handle("api:saveEnvironment", (_event, p: unknown, path: unknown, name: unknown, vars: unknown) =>
      api.saveEnvironment(p as string, path as string, name as string, vars as never[]),
    );
    ipcMain.handle("api:importPostman", (_event, p: unknown, name: unknown, collection: unknown) =>
      api.importPostman(p as string, name as string, collection),
    );
    ipcMain.handle("terminal:open", (_event, project: unknown) =>
      terminal.open(typeof project === "string" ? project : ""),
    );
    // The renderer's xterm for this tab is ready: hand over whatever the
    // shell printed before it existed, then stream the rest.
    ipcMain.handle("terminal:attach", (_event, paneKey: unknown) => {
      if (typeof paneKey !== "string") return "";
      return shells.attach(
        paneKey,
        (chunk) => window.webContents.send("terminal:data", { paneKey, chunk }),
        (code) => window.webContents.send("terminal:exit", { paneKey, code }),
      );
    });
    // A tab's second (and third…) shell, and the one kill that is not the
    // tab's own — see TerminalHandlers.split/closePane.
    ipcMain.handle("terminal:split", (_event, tabId: unknown, paneId: unknown) => {
      terminal.split(tabId as string, paneId as string);
    });
    ipcMain.handle("terminal:closePane", (_event, paneKey: unknown) => {
      terminal.closePane(paneKey as string);
    });
    ipcMain.handle("terminal:suggest", (_event, paneKey: unknown, input: unknown, path: unknown) =>
      terminal.suggest(paneKey as string, input as string, path as string | undefined),
    );
    ipcMain.handle("terminal:history", (_event, paneKey: unknown, limit: unknown) =>
      terminal.history(paneKey as string, limit as number),
    );
    ipcMain.handle("terminal:listDir", (_event, paneKey: unknown, path: unknown) =>
      terminal.listDir(paneKey as string, path as string),
    );
    ipcMain.handle("terminal:openFile", (_event, paneKey: unknown, path: unknown) =>
      terminal.openFile(paneKey as string, path as string),
    );
    ipcMain.handle("terminal:input", (_event, tabId: unknown, data: unknown) => {
      terminal.input(tabId as string, data as string);
    });
    ipcMain.handle("terminal:resize", (_event, tabId: unknown, cols: unknown, rows: unknown) => {
      terminal.resize(tabId as string, cols as number, rows as number);
    });
    ipcMain.handle("terminal:settings", () => terminal.settings());
    ipcMain.handle("terminal:workflows", (_event, project: unknown) =>
      terminal.workflows(typeof project === "string" ? project : ""),
    );
    ipcMain.handle("terminal:ai", (_event, kind: unknown, text: unknown) =>
      terminal.terminalAi(kind as "generate" | "explain", text as string),
    );
    ipcMain.handle("terminal:chips", (_event, paneKey: unknown, path: unknown) =>
      // `path` is the renderer's live OSC 7 directory, passed through
      // untyped exactly like every other argument on this boundary —
      // chips() decides what to believe about it (see liveCwd).
      terminal.chips(paneKey as string, path as string | undefined),
    );
    ipcMain.handle("bookmarks:list", (_event, project: unknown) =>
      bookmarks.list(typeof project === "string" ? project : ""),
    );
    ipcMain.handle("bookmarks:add", (_event, project: unknown, bookmark: unknown) =>
      bookmarks.add(typeof project === "string" ? project : "", bookmark as never),
    );
    ipcMain.handle("bookmarks:remove", (_event, project: unknown, url: unknown) =>
      bookmarks.remove(typeof project === "string" ? project : "", typeof url === "string" ? url : ""),
    );
    ipcMain.handle("bookmarks:setPinned", (_event, project: unknown, url: unknown, pinned: unknown) =>
      bookmarks.setPinned(project as string, url as string, pinned as boolean),
    );
    ipcMain.handle("bookmarks:reorder", (_event, project: unknown, urls: unknown) =>
      bookmarks.reorder(project as string, urls as string[]),
    );
    ipcMain.handle("settings:read", () => settings.read());
    ipcMain.handle("settings:save", (_event, draft: unknown) => settings.save(draft));
    ipcMain.handle("settings:testAgent", (_event, agent: unknown) => settings.testAgent(agent));
    ipcMain.handle("settings:restart", () => settings.restart());
    ipcMain.handle("projects:list", () => Object.keys(config.projects));

    // The only user-triggered call in the app that spends money: one billed
    // query per readable account, guarded by ProviderMonitor's own minimum
    // interval so a held-down button cannot run up a bill. A direct forward
    // — no wrapping try/catch, no re-implemented throttle or dedup — so
    // ProviderMonitor's own coalescing (Task 8) is the only one in effect,
    // and this handler never rejects on a normal per-account failure.
    ipcMain.handle("providers:refresh", () => providers.refreshCapacity({ force: true }));

    const recorder = new Recorder(defaultRecorderDeps);

    function startVoice(): void {
      recorder.start();
      window.webContents.send("voice:listening", true);
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

      window.webContents.send("voice:listening", false);

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

    async function processVoiceTurn(): Promise<void> {
      let wavPath: string;
      try {
        wavPath = await recorder.stop();
      } catch (error) {
        const message = errorMessage(error);
        console.error(`Recorder stop failed: ${message}`);
        window.webContents.send("turn:new", {
          role: "assistant",
          text: MESSAGES.recordingFailed(message, PRIMARY_LANGUAGE),
          language: PRIMARY_LANGUAGE,
          at: Date.now(),
        });
        return;
      }

      try {
        // transcribe() throws on a broken transcription pipeline (bad
        // model path, corrupt wav, missing ffmpeg/whisper binary — a
        // recording that never started leaves no readable wav behind,
        // and transcription fails on that missing file) and returns an
        // empty-text transcript for actual silence — two different
        // outcomes that must not be collapsed into one another. A broken
        // pipeline is reported as an assistant turn; silence gets a
        // brief, non-turn notice so the user knows the hotkey worked and
        // nothing was heard, rather than the UI just going quiet.
        let transcript: Awaited<ReturnType<typeof transcribe>>;
        try {
          transcript = await transcribe(wavPath, config.whisper, runCommand);
        } catch (error) {
          const message = errorMessage(error);
          console.error(`Transcription failed: ${message}`);
          window.webContents.send("turn:new", {
            role: "assistant",
            text: MESSAGES.transcriptionFailed(message, PRIMARY_LANGUAGE),
            language: PRIMARY_LANGUAGE,
            at: Date.now(),
          });
          return;
        }

        if (transcript.text.trim() === "") {
          const language = transcript.language === "ar" ? "ar" : "en";
          window.webContents.send("voice:notice", {
            text: language === "ar" ? "لم يُسمع شيء" : "Didn't catch that",
            language,
          });
          return;
        }
        const language = transcript.language === "ar" ? "ar" : "en";

        // A session's terminal is open: type the utterance into it, exactly
        // as if it had been typed at the keyboard, so the agent cannot tell
        // speech from typing. The carriage return is what a terminal
        // receives for Enter. Checked against the live session list rather
        // than trusted: the renderer's target can name a session that has
        // since exited, and the utterance must fall back to the brain
        // rather than vanishing into a dead pty.
        const target =
          voiceTargetSessionId === undefined ? undefined : sessions.get(voiceTargetSessionId);
        if (target !== undefined && target.endedAt === undefined) {
          sessions.write(target.id, `${transcript.text}\r`);
          // Echoed as a notice, not a turn: this was not a conversation
          // with the brain, and the agent's own terminal is about to show
          // the line. The notice is what confirms the speech was heard and
          // where it went.
          window.webContents.send("voice:notice", { text: transcript.text, language });
          return;
        }

        await orchestrator.handle(transcript.text, language);
      } finally {
        // Recorder owns the wav file it created; nothing else reads it
        // past this point on any of the branches above, so it's always
        // deleted here rather than left behind in tmpdir().
        await recorder.cleanup(wavPath);
      }
    }

    const spaceRegistered = globalShortcut.register("Alt+Space", startVoice);
    const stopRegistered = globalShortcut.register("Alt+Shift+Space", stopVoice);

    // M-b: the renderer's mic button drives the exact same start/stop path
    // as the global hotkey, so voice has one implementation no matter which
    // control triggers it — never a second, unwired-looking "click to talk"
    // affordance beside the real hotkey-driven one.
    ipcMain.handle("voice:start", () => startVoice());
    ipcMain.handle("voice:stop", () => stopVoice());

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
      console.error(`[renderer:${event.level}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    });

    // A page that fails to load at all never reaches the console at all.
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.error(`[renderer] failed to load ${url}: ${description} (${code})`);
    });

    await window.loadFile(fileURLToPath(new URL("../../renderer/index.html", import.meta.url)));

    // globalShortcut.register() does not throw on collision — a combo
    // already claimed by another app (window managers, Alfred, Raycast and
    // input-source switchers commonly claim Alt-combos) makes it return
    // false silently. Left unchecked, the headline feature is inert and
    // the UI still advertises a hotkey that will never fire.
    for (const [combo, registered] of [
      ["Alt+Space", spaceRegistered],
      ["Alt+Shift+Space", stopRegistered],
    ] as const) {
      if (registered) continue;
      window.webContents.send("turn:new", {
        role: "assistant",
        text: MESSAGES.hotkeyCollision(combo, PRIMARY_LANGUAGE),
        language: PRIMARY_LANGUAGE,
        at: Date.now(),
      });
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
    if (!piperReady) await macSpeech.ready;

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
    window.webContents.send("turn:new", {
      role: "assistant",
      text: greeting,
      language: PRIMARY_LANGUAGE,
      at: Date.now(),
    });
    void announceSpeaking(greeting, PRIMARY_LANGUAGE);

    const report = await reportPromise;
    console.log(report.message);
    if (report.message !== "") {
      window.webContents.send("turn:new", {
        role: "assistant",
        text: report.message,
        language: "en",
        at: Date.now(),
      });
    }

    window.webContents.send("providers:update", providers.snapshot());

    void capacityPromise.then(() => {
      // The capacity refresh takes up to 20s per account, so this callback
      // can land long after a user who launched, glanced and quit. Sending
      // on a destroyed webContents throws, and this chain has no catch of
      // its own — an unhandled rejection in the main process on every quick
      // quit. There is nothing to report to a window that is gone.
      if (window.isDestroyed()) return;
      window.webContents.send("providers:update", providers.snapshot());
      const capacity = capacityReport(providers.snapshot(), PRIMARY_LANGUAGE);
      if (capacity === "") return;
      window.webContents.send("turn:new", {
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
