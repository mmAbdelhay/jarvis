import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, globalShortcut, ipcMain } from "electron";
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
  createBookmarkStore,
  createBrain,
  createCapacityReader,
  createCodeServerManager,
  createDbGateManager,
  createGitProvider,
  createMetricsReader,
  createPtySpawner,
  createRealCodeServerSpawner,
  createRealShellSpawner,
  createShellManager,
  createCollection,
  createFolder,
  apiFetch,
  apiMultipart,
  createApiStore,
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
  createSqliteSessionStore,
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
  createDatabaseHandlers,
  createEditorHandlers,
  createTerminalHandlers,
  createGitHandlers,
  createSettingsHandlers,
  PROVIDER_HEALTH_INTERVAL_MS,
} from "./ipc.js";
import { BrowserHost, type Rect } from "./browser-host.js";
import { createElectronViewFactory } from "./electron-view.js";
import { isAllowedNavigation } from "./navigation.js";
import { DEFAULT_CONFIG_PATH, loadConfig } from "./config.js";
import { writeSettingsFile } from "./settings-io.js";
import { errorMessage, MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";
import { defaultRecorderDeps, Recorder } from "./recorder.js";
import { capacityReport, startupReport } from "./startup.js";

app.whenReady().then(async () => {
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
    const speech = new MacSpeech({ arabicVoice: "Majed" });
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

    const orchestrator = new Orchestrator({
      brain: createBrain({
        ...config.brain,
        onUsage: (agentId, reading) => providers.recordPiggyback(agentId, reading),
      }),
      registry,
      sessions,
      git,
      changes: () => changeTracker.snapshot(),
      speak: (text, language) => speech.speak(text, language),
      projects: config.projects,
      providers: {
        snapshot: () => providers.snapshot(),
        refresh: () => providers.refreshCapacity({ force: true }),
      },
    });

    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      backgroundColor: "#060a0f",
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
    const workspace = new BrowserHost(createElectronViewFactory(window));

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

    // One login shell per Terminal tab, under a real pty. Unlike the editor
    // and the database this hosts no page and opens no port: the tab has no
    // view at all, and its screen is drawn by the renderer's own xterm.
    const shells = createShellManager({ spawn: createRealShellSpawner() });
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
      openTerminalTab: (project) => workspace.openTerminal(project),
      projects: config.projects,
      language: PRIMARY_LANGUAGE,
    });

    const bookmarks = createBookmarksHandlers({
      store: createBookmarkStore(join(homedir(), ".config/jarvis/bookmarks.json")),
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
    window.on("closed", () => {
      wiring.stop();
      // Each hosted view is a live Chromium process; they do not go away
      // with the window on their own.
      workspace.destroy();
      // Each open editor is a live code-server child process, same reasoning.
      codeServer.stopAll();
      // And each open Database tab is a live dbgate-serve child process.
      dbgate.stopAll();
      // And each open Terminal tab is a live shell.
      shells.stopAll();
    });

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
    ipcMain.handle("workspace:open", (_event, project: unknown, input: unknown, kind: unknown) => {
      if (typeof project !== "string" || typeof input !== "string") return;
      workspace.open(project, input, kind === "editor" || kind === "database" ? kind : "web");
    });
    ipcMain.handle("workspace:close", (_event, id: unknown) => {
      if (typeof id !== "string") return;
      // A terminal tab's shell is a child process of its own; closing the
      // tab has to reap it. kill() on a tab with no shell is a no-op, so
      // this needs no test of the tab's kind.
      terminal.close(id);
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
    ipcMain.handle("workspace:bounds", (_event, bounds: Rect) => workspace.setBounds(bounds));
    ipcMain.handle("workspace:devtools", (_event, tabId: unknown, open: unknown) => {
      if (typeof tabId !== "string" || typeof open !== "boolean") return;
      workspace.setDevTools(tabId, open);
    });
    ipcMain.handle("workspace:devtoolsBounds", (_event, bounds: Rect) =>
      workspace.setDevToolsBounds(bounds),
    );
    ipcMain.handle("workspace:visible", (_event, visible: unknown) =>
      workspace.setVisible(visible === true),
    );
    ipcMain.handle("workspace:hideAll", () => workspace.hideAll());
    ipcMain.handle("editor:open", (_event, project: unknown) =>
      editor.open(typeof project === "string" ? project : ""),
    );
    ipcMain.handle("database:open", (_event, project: unknown) =>
      database.open(typeof project === "string" ? project : ""),
    );
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
    ipcMain.handle("terminal:attach", (_event, tabId: unknown) => {
      if (typeof tabId !== "string") return "";
      return shells.attach(
        tabId,
        (chunk) => window.webContents.send("terminal:data", { tabId, chunk }),
        (code) => window.webContents.send("terminal:exit", { tabId, code }),
      );
    });
    ipcMain.handle("terminal:input", (_event, tabId: unknown, data: unknown) => {
      terminal.input(tabId as string, data as string);
    });
    ipcMain.handle("terminal:resize", (_event, tabId: unknown, cols: unknown, rows: unknown) => {
      terminal.resize(tabId as string, cols as number, rows as number);
    });
    ipcMain.handle("bookmarks:list", (_event, project: unknown) =>
      bookmarks.list(typeof project === "string" ? project : ""),
    );
    ipcMain.handle("bookmarks:add", (_event, project: unknown, bookmark: unknown) =>
      bookmarks.add(typeof project === "string" ? project : "", bookmark as never),
    );
    ipcMain.handle("bookmarks:remove", (_event, project: unknown, url: unknown) =>
      bookmarks.remove(typeof project === "string" ? project : "", typeof url === "string" ? url : ""),
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

    app.on("will-quit", () => {
      globalShortcut.unregisterAll();
      // A recording started but never stopped (e.g. the user quits with
      // Alt+Space still active) would otherwise leave ffmpeg running as an
      // orphaned process with the microphone held open indefinitely.
      recorder.abort();
      // Sessions still "starting"/"running"/"waiting" at quit time never
      // reach SessionManager#update's endedAt-setting branch on their own
      // — nothing calls onExit/kill for them once the window is gone — so
      // without this their history() rows stay wrong forever, sorted to
      // the very top (most-recently-active first). kill() is the same
      // path a user-initiated stop already takes, so it persists an
      // endedAt-bearing row through the normal #persist choke point. This
      // only fires on a clean quit, though — a hard kill or crash never
      // reaches `will-quit` at all — so createSqliteSessionStore's own
      // startup reconciliation (session-store.ts) is the backstop that's
      // guaranteed to run regardless of how the previous run ended.
      for (const session of sessions.list()) {
        if (session.state === "done" || session.state === "dead") continue;
        sessions.kill(session.id);
      }
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
    const greeting = greetingText(
      { now: Date.now(), history: sessionStore.history(), dirtyProjects: await dirtyProjects },
      PRIMARY_LANGUAGE,
    );
    window.webContents.send("turn:new", {
      role: "assistant",
      text: greeting,
      language: PRIMARY_LANGUAGE,
      at: Date.now(),
    });
    speech.speak(greeting, PRIMARY_LANGUAGE);

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
