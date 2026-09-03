import {
  checkAgent,
  gitFailureText,
  sessionLabel,
  type AgentConfig,
  type AgentHealth,
  type CommandRunner,
  type GitChanges,
  type GitFileDiff,
  type GitOutcome,
  type GitProvider,
  type ProviderStatus,
  type Session,
  type SessionChanges,
  type SessionOutput,
  type SystemMetrics,
  type Turn,
} from "@jarvis/core";
import { join, resolve, sep } from "node:path";
import type { WorkspaceState } from "@jarvis/core";
import { awsLoginCommand, eksUpdateKubeconfigArgs, profileForContext } from "@jarvis/platform";
import type {
  ApiFailure,
  ApiResponse,
  ApiSettings,
  AssertionResult,
  AwsSessionChecker,
  BrunoVariable,
  Cookie,
  HistoryEntry,
  ScriptResult,
  Bookmark,
  BookmarkStore,
  BrunoCollection,
  BrunoTree,
  ClustersConfig,
  CodeServerManager,
  ContainerFacts,
  DbGateManager,
  DockerClient,
  DockerConfig,
  DockerResult,
  EditorsConfig,
  HeadlampManager,
  InstalledVoice,
  ShellManager,
} from "@jarvis/platform";
import type { CompletionSource } from "./completion-source.js";
import type { JarvisConfig } from "./config.js";
import { MESSAGES } from "./messages.js";

export type VoiceNotice = { text: string; language: "ar" | "en" };

export type IpcChannels = {
  "metrics:update": SystemMetrics;
  "sessions:update": Session[];
  "turn:new": Turn;
  "voice:listening": boolean;
  "voice:speaking": boolean;
  "voice:notice": VoiceNotice;
  "git:counts": SessionChanges[];
  "providers:update": ProviderStatus[];
  "session:output": SessionOutput;
  "workspace:update": WorkspaceState;
  "terminal:data": { tabId: string; chunk: string };
  "terminal:exit": { tabId: string; code: number };
};

/**
 * Public status pages are free and unauthenticated, so they can be polled.
 * Five minutes: a provider incident is minutes-scale news, and the endpoint
 * is a small JSON GET. CAPACITY IS NEVER POLLED — see the plan's refresh
 * policy; every capacity read is a billed round trip that consumes the
 * capacity it reports.
 */
export const PROVIDER_HEALTH_INTERVAL_MS = 300_000;

// Every git call the renderer can make returns this. Failures arrive as text
// already localised in the main process, because the renderer has no access
// to the user's configured language and must never build user-facing strings
// of its own (Global Constraints: one bilingual message lane).
export type GitViewResult<T> =
  | { ok: true; value: T }
  | { ok: false; text: string; language: "ar" | "en" };

// The spec requires the Changes view to "name the session that produced" the
// diff, so the session travels with the changes rather than being looked up
// separately by the renderer.
export type ChangesView = {
  session: {
    id: string;
    project: string;
    projectPath: string;
    agentId: string;
    lastActivityAt: number;
    // Set once a session reaches a terminal state (Session.endedAt).
    // gitChanges() always reads the repository's *current* working tree,
    // never a per-session snapshot, so a defined endedAt is the renderer's
    // only signal that what it is about to show is not necessarily this
    // session's own work (ruling P22) — Task 16 replaces this with real
    // per-session recorded counts, at which point the notice this drives
    // goes away for good.
    endedAt: number | undefined;
  };
  changes: GitChanges;
};

export type GitHandlers = {
  changes(sessionId: string): Promise<GitViewResult<ChangesView>>;
  fileDiff(sessionId: string, path: string): Promise<GitViewResult<GitFileDiff>>;
  setStaged(sessionId: string, path: string, staged: boolean): Promise<GitViewResult<null>>;
  commit(sessionId: string, message: string): Promise<GitViewResult<null>>;
};

export type GitHandlerDeps = {
  git: GitProvider;
  sessions: { get(id: string): Session | undefined };
  /** The user's configured primary language, used for every failure string. */
  language: "ar" | "en";
  /** ChangeTracker.refresh — called after anything that mutates the repo. */
  refresh(): Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

// Sessions, not renderer-supplied paths, are the only route into GitProvider
// here: the main process owns the sessionId -> projectPath mapping, so a
// compromised renderer can request git data only for a repo a real session
// is already running against, never an arbitrary filesystem path.
export function createGitHandlers(deps: GitHandlerDeps): GitHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  function invalid(): { ok: false; text: string; language: "ar" | "en" } {
    return fail(MESSAGES.invalidArgument(deps.language));
  }

  function repoFor(sessionId: string): Session | undefined {
    return deps.sessions.get(sessionId);
  }

  // Ruling P26: the renderer already blocks a Commit click while a
  // gitSetStaged is outstanding, but that guard is one window's JavaScript,
  // not real serialization — nothing stops setStaged and commit for the
  // *same* repo from interleaving across two IPC calls in flight together
  // (e.g. a fast double-click, or two renderer code paths racing), and an
  // interleaved commit can capture a staging set that was mid-change. A
  // plain per-repo promise chain is enough: each repo's tail promise is
  // replaced with the new task chained onto the previous one, so
  // setStaged/commit for one repository always run one at a time, in the
  // order they were called, while two different repositories (two open
  // sessions) still run fully concurrently — a global lock would make the
  // app feel broken with several sessions open.
  const repoQueues = new Map<string, Promise<unknown>>();

  function enqueue<T>(repoPath: string, task: () => Promise<T>): Promise<T> {
    const previous = repoQueues.get(repoPath) ?? Promise.resolve();
    // `task` runs only after `previous` settles, whichever way it settled —
    // one repo's failed commit must not wedge that repo's queue forever.
    const run = previous.then(task, task);
    // The stored tail must never itself reject (a rejection stored here
    // would otherwise propagate into the *next* caller's `.then`, not this
    // caller's), so the chain keeps moving regardless of outcome; the
    // caller still gets the real result/rejection via `run` below.
    repoQueues.set(
      repoPath,
      run.catch(() => undefined),
    );
    return run;
  }

  // GitProvider's contract says it never throws (its own guard clauses —
  // e.g. rejecting a path outside the repo — return a GitOutcome failure,
  // not an exception), but ChangeTracker.refresh already sets the house
  // rule of not trusting that contract at the call site: it wraps every
  // provider call so a real-world throw degrades to a failure instead of
  // taking down the caller (ruling P15). This is the IPC-boundary
  // equivalent — an uncaught throw here would cross into the renderer as a
  // raw, English-only, internals-leaking IPC rejection, never a
  // GitViewResult the Changes view can render.
  async function callGit<T>(run: () => Promise<GitOutcome<T>>): Promise<GitOutcome<T>> {
    try {
      return await run();
    } catch (error) {
      return { ok: false, error: { code: "failed", detail: errorMessage(error) } };
    }
  }

  return {
    async changes(sessionId) {
      if (!isString(sessionId)) return invalid();
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      const outcome = await callGit(() => deps.git.changes(session.projectPath));
      if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));

      return {
        ok: true,
        value: {
          session: {
            id: session.id,
            // Already resolved to something displayable here rather than
            // in the renderer: this view names one repository, and a
            // session with no configured project still has a directory.
            project: sessionLabel(session),
            projectPath: session.projectPath,
            agentId: session.agentId,
            lastActivityAt: session.lastActivityAt,
            endedAt: session.endedAt,
          },
          changes: outcome.value,
        },
      };
    },

    async fileDiff(sessionId, path) {
      if (!isString(sessionId) || !isString(path)) return invalid();
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      const outcome = await callGit(() => deps.git.diff(session.projectPath, path));
      if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));
      return { ok: true, value: outcome.value };
    },

    async setStaged(sessionId, path, staged) {
      if (!isString(sessionId) || !isString(path) || !isBoolean(staged)) return invalid();
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      return enqueue(session.projectPath, async () => {
        const outcome = staged
          ? await callGit(() => deps.git.stage(session.projectPath, [path]))
          : await callGit(() => deps.git.unstage(session.projectPath, [path]));
        if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));

        await deps.refresh();
        return { ok: true, value: null };
      });
    },

    async commit(sessionId, message) {
      if (!isString(sessionId) || !isString(message)) return invalid();
      const session = repoFor(sessionId);
      if (session === undefined) return fail(MESSAGES.unknownSession(sessionId, deps.language));

      return enqueue(session.projectPath, async () => {
        const outcome = await callGit(() => deps.git.commit(session.projectPath, message));
        if (!outcome.ok) return fail(gitFailureText(outcome.error, deps.language));

        await deps.refresh();
        return { ok: true, value: null };
      });
    },
  };
}

/**
 * A rectangle as the renderer measured it, in CSS pixels, carrying the
 * device pixel ratio it was measured under. Main converts it to the
 * device-independent pixels a hosted view is placed in; the two units differ
 * on a display running a scaled resolution.
 */
export type ReportedRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  devicePixelRatio: number;
};

export type RendererApi = {
  send(text: string, language: "ar" | "en"): Promise<void>;
  // Drives the exact same start/stop path as the Alt+Space / Alt+Shift+Space
  // global hotkey — the renderer's mic button is a second control on one
  // voice implementation, not a separate click-to-talk feature.
  startVoice(): Promise<void>;
  stopVoice(): Promise<void>;
  onMetrics(cb: (m: SystemMetrics) => void): void;
  onSessions(cb: (s: Session[]) => void): void;
  onTurn(cb: (t: Turn) => void): void;
  onListening(cb: (listening: boolean) => void): void;
  /** True while an utterance is being spoken. The renderer cannot time this
   *  itself: it knows the text, not how long saying it takes. */
  onSpeaking(cb: (speaking: boolean) => void): void;
  // A transient status, distinct from a turn: e.g. "recorded but heard
  // nothing" — shown briefly in the voice-state element, never added to
  // the conversation as a hollow turn.
  onNotice(cb: (notice: VoiceNotice) => void): void;
  // Session history is pulled on demand (when the history panel opens),
  // not pushed like sessions:update — there is no live subscriber to keep
  // in sync, only a snapshot to render once.
  getHistory(): Promise<Session[]>;
  // Git. Each returns a GitViewResult, never rejects for a git-level problem:
  // the spec requires a git error to be shown in the Changes view and never
  // to block the assistant.
  gitChanges(sessionId: string): Promise<GitViewResult<ChangesView>>;
  gitDiff(sessionId: string, path: string): Promise<GitViewResult<GitFileDiff>>;
  gitSetStaged(sessionId: string, path: string, staged: boolean): Promise<GitViewResult<null>>;
  gitCommit(sessionId: string, message: string): Promise<GitViewResult<null>>;
  onChangeCounts(cb: (changes: SessionChanges[]) => void): void;
  // A session's live output, chunk by chunk, for every session at once —
  // the Session view keeps only the one it is showing. Paired with
  // getSessionLog below: the log is the backlog from before the view was
  // opened, this is everything after.
  onSessionOutput(cb: (output: SessionOutput) => void): void;
  /**
   * The retained transcript for one session. Pulled once when the Session
   * view opens, so a session opened partway through a run shows what it
   * already printed instead of starting blank. Returns "" for an unknown
   * session rather than rejecting — a row can be clicked in the instant
   * before its process has written anything.
   */
  getSessionLog(sessionId: string): Promise<string>;
  /**
   * Raw keystrokes for one session's terminal, written to its pty exactly
   * as given — including control bytes (Ctrl-C, arrows, Escape). This is
   * the only way the user talks to a session: there is no separate "send a
   * message" path, because the agent's own terminal UI owns the input line.
   */
  sendSessionInput(sessionId: string, data: string): Promise<void>;
  /**
   * The terminal pane's new size in character cells. A terminal UI lays
   * itself out from this, so it is sent whenever the pane is measured or
   * the window changes shape.
   */
  resizeSession(sessionId: string, cols: number, rows: number): Promise<void>;
  /**
   * Names the session a spoken utterance should be typed into, or
   * `undefined` to send speech back to the brain. Set when a session's
   * terminal is opened and cleared when it is left, so "talking" always
   * means whatever is on screen.
   */
  setVoiceTarget(sessionId: string | undefined): Promise<void>;
  // Provider status: pushed like sessions, plus one pull the user drives.
  onProviders(cb: (statuses: ProviderStatus[]) => void): void;
  /**
   * Explicit user demand only (the panel's refresh control, or asking by
   * voice). Each call spends one billed API query per readable account, so
   * it is never wired to a timer, a focus event, or a route change.
   */
  refreshProviders(): Promise<void>;
  // Workspace. Every call is fire-and-forget: the authoritative state comes
  // back on workspace:update, so the renderer never keeps a second copy it
  // would have to reconcile.
  openTab(
    project: string,
    input: string,
    kind?: "web" | "editor" | "database" | "cluster",
    /** Which one, for a kind a project can have more than one of — the
     *  editor root a code-server tab is rooted at. Becomes part of the
     *  tab's stable title. */
    detail?: string,
  ): Promise<void>;
  closeTab(id: string): Promise<void>;
  activateTab(id: string): Promise<void>;
  navigateTab(id: string, input: string): Promise<void>;
  tabBack(id: string): Promise<void>;
  tabForward(id: string): Promise<void>;
  tabReload(id: string): Promise<void>;
  /** The rectangle the renderer has reserved for the page, in CSS pixels
   *  relative to the window's content area. A hosted view is a native
   *  overlay, so it has to be told; nothing about CSS layout reaches it. */
  setWorkspaceBounds(bounds: ReportedRect): Promise<void>;
  /** Opens or closes DevTools for one tab. They render into a view the main
   *  process positions from setDevToolsBounds, so the panel is part of the
   *  Workspace layout rather than a detached window. */
  setDevTools(tabId: string, open: boolean): Promise<void>;
  setDevToolsBounds(bounds: ReportedRect): Promise<void>;
  /** Called by showView on EVERY route change, not only when entering the
   *  Workspace — a view left visible floats over whatever route follows. */
  setWorkspaceVisible(visible: boolean): Promise<void>;
  /** Hides every tab's page without changing which tab is active — for
   *  switching to a project with no open tab. */
  hideAllTabs(): Promise<void>;
  /** Floats this tab's playing video in Chromium's own Picture-in-Picture
   *  window — an always-on-top OS window, so it keeps playing over other
   *  tabs, other routes and other applications. Offered only while the
   *  tab's `hasPlayingVideo` is set; a second call puts the video back. */
  requestPictureInPicture(tabId: string): Promise<void>;
  onWorkspace(cb: (state: WorkspaceState) => void): void;
  /** Ensures a code-server instance is running for `project`, rooted at the
   *  configured editor root named `root` (the project directory itself when
   *  omitted), and returns its URL — call openTab(project, url, "editor",
   *  root) with the result to actually show it; this call alone does not
   *  open a tab. */
  openEditor(project: string, root?: string): Promise<GitViewResult<string>>;
  /** The names of `project`'s configured `editors:` roots, in config order.
   *  Empty for a project that declares none, which is most of them. */
  editorRoots(project: string): Promise<string[]>;
  /** Ensures a DbGate instance is running for `project` and returns its URL
   *  plus the credential it is guarded with — call openTab(project, url,
   *  "database") with the result to actually show it. */
  openDatabase(project: string): Promise<GitViewResult<DatabaseCredentials>>;
  /** Ensures a headlamp-server instance is running for `project` and returns
   *  the URL of one of its configured clusters — call
   *  openTab(project, url, "cluster", cluster) with the result.
   *
   *  `background` marks a hover pre-warm rather than a click: it warms an
   *  already-connected cluster the same way, but never starts an AWS login
   *  (a terminal tab and an MFA push are not things a hover may cause). */
  openCluster(
    project: string,
    cluster: string,
    background?: boolean,
  ): Promise<GitViewResult<string>>;
  /** The names of `project`'s configured `clusters:`, in config order. Empty
   *  for a project that declares none, and for Personal. */
  clusterNames(project: string): Promise<string[]>;
  /** Opens a terminal tab for `project` and starts its shell. The new tab
   *  arrives through the ordinary workspace:update, so nothing is returned
   *  but success or a localised failure. */
  openTerminal(project: string): Promise<GitViewResult<void>>;
  /** Suggestions for what is typed at `tabId`'s prompt, best first. Each
   *  one is a whole replacement line. An empty array means no dropdown —
   *  and so zsh's own Tab completion, unchanged. */
  suggestCompletions(tabId: string, input: string): Promise<string[]>;
  /** Opens (or reuses) the project's Docker tab. */
  openDockerTab(project: string): Promise<GitViewResult<void>>;
  dockerNames(project: string): Promise<GitViewResult<string[]>>;
  dockerView(project: string): Promise<GitViewResult<DockerView>>;
  /** Every container on the machine, unscoped to a project. Used by Settings
   *  to offer a checklist of containers a project could declare. */
  dockerContainers(): Promise<GitViewResult<ContainerFacts[]>>;
  dockerStart(project: string, container: string): Promise<GitViewResult<void>>;
  dockerStop(project: string, container: string): Promise<GitViewResult<void>>;
  dockerRestart(project: string, container: string): Promise<GitViewResult<void>>;
  dockerComposeUp(project: string): Promise<GitViewResult<void>>;
  dockerComposeDown(project: string): Promise<GitViewResult<void>>;
  dockerShell(project: string, container: string): Promise<GitViewResult<void>>;
  /** Starts (or restarts, if the tab was already following a different
   *  container) a `docker logs -f` for `container`, streamed to `onDockerLog`
   *  tagged with `tabId`. */
  dockerFollow(tabId: string, project: string, container: string): Promise<GitViewResult<void>>;
  /** Stops the log follower for `tabId`, if one is running. Called when the
   *  tab closes or switches to a different container. */
  dockerUnfollow(tabId: string): Promise<void>;
  onDockerLog(cb: (payload: { tabId: string; chunk: string }) => void): void;
  /** Opens (or reuses) the project's API tab. Unlike a terminal there is one
   *  per project: a collection tree is a view of the filesystem, not a
   *  session, so a second tab would be a duplicate. */
  openApiTab(project: string): Promise<GitViewResult<void>>;
  listApiCollections(project: string): Promise<GitViewResult<BrunoCollection[]>>;
  readApiTree(project: string, collectionPath: string): Promise<GitViewResult<BrunoTree>>;
  readApiRequest(project: string, path: string): Promise<GitViewResult<Record<string, unknown>>>;
  saveApiRequest(
    project: string,
    path: string,
    json: Record<string, unknown>,
  ): Promise<GitViewResult<void>>;
  sendApiRequest(
    project: string,
    request: Record<string, unknown>,
    variables: Record<string, string>,
  ): Promise<GitViewResult<ApiSendResult>>;
  apiHistory(project: string): Promise<GitViewResult<HistoryEntry[]>>;
  clearApiHistory(project: string): Promise<GitViewResult<void>>;
  apiCookies(project: string): Promise<GitViewResult<Cookie[]>>;
  clearApiCookies(project: string): Promise<GitViewResult<Cookie[]>>;
  removeApiCookie(project: string, name: string, domain: string, path: string): Promise<GitViewResult<Cookie[]>>;
  apiSettings(project: string): Promise<GitViewResult<ApiSettings>>;
  saveApiSettings(project: string, settings: ApiSettings): Promise<GitViewResult<ApiSettings>>;
  /** Every voice that can be chosen, for the Settings picker. The neural
   *  engine appears among them rather than as a separate control: from where
   *  the user stands it is simply the best-sounding English voice on the
   *  list. `engine` is what tells the renderer which one it picked. */
  listVoices(): Promise<PickableVoice[]>;
  /** Speaks a short sample in one voice, so a name can be chosen by ear
   *  rather than by guessing what it sounds like. */
  previewVoice(name: string, language: "ar" | "en"): Promise<void>;
  /** Opens a native file picker. Returns the chosen paths, or [] if the user
   *  cancelled — cancelling is not a failure. */
  pickFiles(options?: { multiple?: boolean }): Promise<string[]>;
  /** Reads a JSON file the user picked, for importing a collection. */
  readJsonFile(path: string): Promise<GitViewResult<unknown>>;
  apiCurl(
    project: string,
    request: Record<string, unknown>,
    variables: Record<string, string>,
  ): Promise<GitViewResult<string>>;
  createApiRequest(project: string, folderPath: string, name: string, seq: number): Promise<GitViewResult<string>>;
  createApiFolder(project: string, parentPath: string, name: string): Promise<GitViewResult<string>>;
  renameApiEntry(project: string, path: string, name: string, isFolder: boolean): Promise<GitViewResult<string>>;
  deleteApiEntry(project: string, path: string): Promise<GitViewResult<void>>;
  createApiCollection(project: string, name: string): Promise<GitViewResult<string>>;
  saveApiEnvironment(
    project: string,
    collectionPath: string,
    name: string,
    variables: BrunoVariable[],
  ): Promise<GitViewResult<string>>;
  importPostmanCollection(project: string, name: string, collection: unknown): Promise<GitViewResult<string>>;
  /** Announces that this tab's xterm exists; returns whatever the shell
   *  printed before it did. */
  attachTerminal(tabId: string): Promise<string>;
  sendTerminalInput(tabId: string, data: string): Promise<void>;
  resizeTerminal(tabId: string, cols: number, rows: number): Promise<void>;
  onTerminalData(cb: (tabId: string, chunk: string) => void): void;
  onTerminalExit(cb: (tabId: string, code: number) => void): void;
  listBookmarks(project: string): Promise<GitViewResult<Bookmark[]>>;
  addBookmark(project: string, bookmark: Bookmark): Promise<GitViewResult<Bookmark[]>>;
  removeBookmark(project: string, url: string): Promise<GitViewResult<Bookmark[]>>;
  getSettings(): Promise<JarvisConfig>;
  saveSettings(draft: JarvisConfig): Promise<SettingsSaveResult>;
  testAgent(agent: AgentConfig): Promise<AgentHealth>;
  restartApp(): Promise<void>;
  /** The configured project names, for the Workspace's project selector.
   *  Names only — the renderer never receives a filesystem path. */
  getProjects(): Promise<string[]>;
};

export type WiringDeps = {
  send(channel: string, payload: unknown): void;
  readMetrics(): Promise<SystemMetrics>;
  intervalMs: number;
  onSessionsChange(cb: (sessions: Session[]) => void): () => void;
  onTurn(cb: (turn: Turn) => void): () => void;
  onChangeCounts(cb: (changes: SessionChanges[]) => void): () => void;
  onSessionOutput(cb: (output: SessionOutput) => void): () => void;
  /** ChangeTracker.refresh; it guards its own re-entrancy. */
  refreshChanges(): Promise<void>;
  changesIntervalMs: number;
  onProvidersChange(cb: (statuses: ProviderStatus[]) => void): () => void;
  onWorkspaceChange(cb: (state: WorkspaceState) => void): () => void;
  /** Free public status pages only. Never a capacity read. */
  refreshHealth(): Promise<void>;
  healthIntervalMs: number;
};

export function buildWiring(deps: WiringDeps): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  let changesTimer: ReturnType<typeof setInterval> | undefined;
  let healthTimer: ReturnType<typeof setInterval> | undefined;
  const unsubscribes: (() => void)[] = [];

  return {
    start() {
      unsubscribes.push(
        deps.onSessionsChange((s) => {
          deps.send("sessions:update", s);
          // A session starting or dying almost always changes what is on
          // disk, so re-read git then rather than waiting for the next tick.
          void deps.refreshChanges();
        }),
      );
      unsubscribes.push(deps.onTurn((t) => deps.send("turn:new", t)));
      unsubscribes.push(deps.onChangeCounts((c) => deps.send("git:counts", c)));
      unsubscribes.push(deps.onSessionOutput((o) => deps.send("session:output", o)));
      unsubscribes.push(deps.onProvidersChange((s) => deps.send("providers:update", s)));
unsubscribes.push(deps.onWorkspaceChange((state) => deps.send("workspace:update", state)));

      healthTimer = setInterval(() => {
        void deps.refreshHealth();
      }, deps.healthIntervalMs);

      timer = setInterval(() => {
        deps.readMetrics()
          .then((metrics) => deps.send("metrics:update", metrics))
          .catch(() => {
            // A failed sample is skipped; the next tick tries again.
          });
      }, deps.intervalMs);

      changesTimer = setInterval(() => {
        void deps.refreshChanges();
      }, deps.changesIntervalMs);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      if (changesTimer !== undefined) clearInterval(changesTimer);
      changesTimer = undefined;
      if (healthTimer !== undefined) clearInterval(healthTimer);
      healthTimer = undefined;
      while (unsubscribes.length > 0) unsubscribes.pop()?.();
    },
  };
}

export type EditorHandlers = {
  /** Ensures a code-server instance is running for `project`, rooted at the
   *  configured editor root named `root` (the project directory itself when
   *  omitted), and returns its URL — the renderer then opens that URL as an
   *  ordinary Workspace browser tab (openTab), same as any other page. */
  open(project: string, root?: string): Promise<GitViewResult<string>>;
  /** The names of `project`'s configured editor roots, in config order. The
   *  renderer needs them to decide whether the Editor button opens straight
   *  away or offers a choice; it gets names only, never paths. */
  roots(project: string): Promise<string[]>;
};

export type EditorHandlerDeps = {
  codeServer: CodeServerManager;
  /** Name to absolute path, from config. The renderer never sees a path. */
  projects: Readonly<Record<string, string>>;
  /** Per-project editor roots, from config. Empty for most projects. */
  editors: Readonly<EditorsConfig>;
  language: "ar" | "en";
};

export function createEditorHandlers(deps: EditorHandlerDeps): EditorHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  return {
    async roots(project) {
      if (!isString(project)) return [];
      return (deps.editors[project] ?? []).map((entry) => entry.name);
    },

    async open(project, rootName) {
      const projectPath = isString(project) ? deps.projects[project] : undefined;
      if (projectPath === undefined) return fail(MESSAGES.unknownProject(deps.language));

      // The renderer names a root; main resolves it. A name this project
      // does not declare is refused here rather than joined onto the
      // project path — that is what keeps a renderer-supplied string from
      // ever becoming a directory code-server is rooted at.
      let folder = projectPath;
      if (rootName !== undefined) {
        const declared = isString(rootName)
          ? deps.editors[project]?.find((entry) => entry.name === rootName)
          : undefined;
        if (declared === undefined) return fail(MESSAGES.editorUnavailable(deps.language));
        folder = join(projectPath, declared.path);
      }

      try {
        const result = await deps.codeServer.open(projectPath, folder);
        // The manager's own failure detail is developer-facing (e.g. "did
        // not become ready in time") — same discipline as docFailureText:
        // wrap it behind one bilingual headline rather than surface it raw.
        return result.ok ? { ok: true, value: result.url } : fail(MESSAGES.editorUnavailable(deps.language));
      } catch {
        return fail(MESSAGES.editorUnavailable(deps.language));
      }
    },
  };
}

export type DatabaseCredentials = { url: string; login: string; password: string };

export type DatabaseHandlers = {
  /** Ensures a DbGate instance is running for `project` and returns its URL
   *  plus the credential that instance is guarded with — the renderer then
   *  opens the URL as a "database" tab and shows the credential. */
  open(project: string): Promise<GitViewResult<DatabaseCredentials>>;
};

export type DatabaseHandlerDeps = {
  dbgate: DbGateManager;
  /** Only used to reject a project name that is not configured. Unlike the
   *  editor, the manager needs no path: it is keyed by project name and
   *  owns both the workspace directory and the connection set. */
  projects: Readonly<Record<string, string>>;
  language: "ar" | "en";
};

export function createDatabaseHandlers(deps: DatabaseHandlerDeps): DatabaseHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  return {
    async open(project) {
      if (!isString(project) || deps.projects[project] === undefined) {
        return fail(MESSAGES.unknownProject(deps.language));
      }
      try {
        const result = await deps.dbgate.open(project);
        // The manager's own detail ("did not report a port in time") is
        // developer-facing — wrapped behind one bilingual headline, same
        // discipline as createEditorHandlers.
        return result.ok
          ? { ok: true, value: { url: result.url, login: result.login, password: result.password } }
          : fail(MESSAGES.databaseUnavailable(deps.language));
      } catch {
        return fail(MESSAGES.databaseUnavailable(deps.language));
      }
    },
  };
}

export type ClusterHandlers = {
  /** The names of `project`'s configured `clusters:`, in config order. The
   *  renderer needs them to decide whether the Cluster button opens straight
   *  away or offers a choice; it gets names only, never contexts. */
  names(project: string): Promise<string[]>;
  /** Ensures a headlamp-server instance is running for `project` and returns
   *  the URL of the cluster named `cluster` within it — call
   *  openTab(project, url, "cluster", cluster) with the result to actually
   *  show it.
   *
   *  `background: true` marks a call nobody clicked for — the renderer's
   *  hover pre-warm. It warms the server exactly as an ordinary call does,
   *  but it must never start an AWS login: a login is a real `saml2aws`
   *  running in a terminal tab the user did not ask to open, and an MFA push
   *  on their phone. A hover, or a keyboard user tabbing past the button, is
   *  not consent to either. When the session is not connected, a background
   *  call gives up instead. */
  open(
    project: string,
    cluster: string,
    opts?: { background?: boolean },
  ): Promise<GitViewResult<string>>;
};

export type ClusterHandlerDeps = {
  headlamp: HeadlampManager;
  /** Only used to reject a project name that is not configured, and as the
   *  cwd for the login terminal — Personal above all, which has no entry
   *  and therefore no clusters. */
  projects: Readonly<Record<string, string>>;
  clusters: Readonly<ClustersConfig>;
  /** The raw kubeconfig text profileForContext reads. A function, not a
   *  path, so the handler never touches the filesystem directly — same
   *  reasoning as every other injected side effect in this file. */
  readKubeconfig(): Promise<string>;
  checkAwsSession: AwsSessionChecker;
  awaitAwsSession: AwsSessionChecker;
  /** Opens a Terminal tab under `project`, with its shell rooted at `cwd`.
   *  Returns the tab id so the login command can be typed into it. */
  openTerminal(project: string, cwd: string): string;
  sendInput(tabId: string, data: string): void;
  language: "ar" | "en";
};

export function createClusterHandlers(deps: ClusterHandlerDeps): ClusterHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  // A project already mid-login shares this promise rather than opening a
  // second terminal tab and retyping the command — the same reason
  // HeadlampManager.open dedupes concurrent starts one layer down.
  const loggingIn = new Map<string, Promise<boolean>>();

  async function ensureAwsSession(
    project: string,
    context: string,
    background: boolean,
  ): Promise<boolean> {
    const profile = profileForContext(await deps.readKubeconfig(), context);
    const args = eksUpdateKubeconfigArgs(context);
    if (profile === undefined || args === undefined) return true; // nothing to check

    if (await deps.checkAwsSession(profile, args.region)) return true;

    // Checking costs a subprocess and nothing else, so a pre-warm gets that
    // far — that is what makes warming an already-connected cluster work.
    // Logging in is where it stops: no terminal tab, no typed command, and
    // not even an entry in `loggingIn`, so the click that may follow starts
    // its own login rather than inheriting a promise nobody is driving.
    if (background) return false;

    const inFlight = loggingIn.get(project);
    if (inFlight !== undefined) return inFlight;

    const attempt = (async () => {
      const tabId = deps.openTerminal(project, deps.projects[project] ?? "");
      deps.sendInput(tabId, `${awsLoginCommand(args.name, args.region, profile)}\r`);
      return deps.awaitAwsSession(profile, args.region);
    })();
    loggingIn.set(project, attempt);
    try {
      return await attempt;
    } finally {
      loggingIn.delete(project);
    }
  }

  return {
    async names(project) {
      if (!isString(project)) return [];
      return (deps.clusters[project] ?? []).map((entry) => entry.name);
    },

    async open(project, cluster, opts) {
      const background = opts?.background === true;
      if (!isString(project) || deps.projects[project] === undefined) {
        return fail(MESSAGES.unknownProject(deps.language));
      }

      // The renderer names a cluster; main resolves it to a context. A name
      // this project does not declare is refused here rather than passed
      // through — same discipline as the editor's roots, and the reason a
      // renderer-supplied string never reaches the kubeconfig.
      const declared = isString(cluster)
        ? deps.clusters[project]?.find((entry) => entry.name === cluster)
        : undefined;
      if (declared === undefined) return fail(MESSAGES.clusterUnavailable(deps.language));

      try {
        const connected = await ensureAwsSession(project, declared.context, background);
        // A background call that gets here never opened a terminal and never
        // waited, so the timeout headline — "check the terminal and try
        // again" — would name a tab that does not exist. The generic
        // headline is the honest one for "we did not try". Neither is ever
        // seen: the renderer swallows a pre-warm's failures on purpose.
        if (!connected) {
          return fail(
            background
              ? MESSAGES.clusterUnavailable(deps.language)
              : MESSAGES.clusterLoginTimedOut(deps.language),
          );
        }

        const result = await deps.headlamp.open(project, declared.context);
        return result.ok
          ? { ok: true, value: result.url }
          : fail(MESSAGES.clusterUnavailable(deps.language));
      } catch {
        return fail(MESSAGES.clusterUnavailable(deps.language));
      }
    },
  };
}

/** Docker's own name grammar. Validated here because a value read from
 *  jarvis.yaml is about to be typed into a live pty — the same hardening
 *  aws-session.ts was given, for the same reason. */
const CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** One configured container, paired with what Docker currently reports of
 *  it. `facts` is undefined for a container that is configured but does not
 *  exist — a stale entry is shown and named, never silently dropped, because
 *  a row that vanishes looks identical to a row that was never configured. */
export type DockerRow = {
  name: string;
  container: string;
  facts: ContainerFacts | undefined;
};

export type DockerView = {
  rows: DockerRow[];
  /** Set only when every existing row shares one compose project: that is
   *  the only case in which "up" and "down" have an unambiguous target. */
  composeProject: string | undefined;
  composeWorkingDir: string | undefined;
};

export type DockerHandlerDeps = {
  docker: DockerClient;
  /** Only used to reject a project name that is not configured, and as the
   *  cwd for the shell terminal — Personal above all, which has no entry. */
  projects: Readonly<Record<string, string>>;
  containers: Readonly<DockerConfig>;
  /** Opens a Terminal tab under `project`, with its shell rooted at `cwd`.
   *  Returns the tab id so the exec command can be typed into it. */
  openTerminal(project: string, cwd: string): string;
  sendInput(tabId: string, data: string): void;
  language: "ar" | "en";
};

export type DockerHandlers = {
  view(project: string): Promise<GitViewResult<DockerView>>;
  start(project: string, container: string): Promise<GitViewResult<void>>;
  stop(project: string, container: string): Promise<GitViewResult<void>>;
  restart(project: string, container: string): Promise<GitViewResult<void>>;
  composeUp(project: string): Promise<GitViewResult<void>>;
  composeDown(project: string): Promise<GitViewResult<void>>;
  shell(project: string, container: string): GitViewResult<void>;
  /** The display names this project declares, for the renderer to decide
   *  whether the Docker button is a live control at all. Mirrors the
   *  existing `ClusterHandlers.names`. */
  names(project: string): GitViewResult<string[]>;
  /** Every container on the machine, for Settings to offer as a checklist.
   *  Not scoped to a project on purpose: the whole point is to find the
   *  containers a project does not yet declare. */
  containers(): Promise<GitViewResult<ContainerFacts[]>>;
};

export function createDockerHandlers(deps: DockerHandlerDeps): DockerHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  /** A container this project does not declare is refused here rather than
   *  passed to Docker: the renderer names what the config already allowed,
   *  exactly as the Cluster handlers require a declared context. */
  function declared(project: string, container: string): boolean {
    return (deps.containers[project] ?? []).some((entry) => entry.container === container);
  }

  async function build(project: string): Promise<GitViewResult<DockerView>> {
    if (deps.projects[project] === undefined) {
      return fail(MESSAGES.unknownProject(deps.language));
    }
    const entries = deps.containers[project] ?? [];
    const listed = await deps.docker.list();
    if (!listed.ok) {
      return fail(
        listed.reason === "not-installed"
          ? MESSAGES.dockerNotInstalled(deps.language)
          : MESSAGES.dockerDaemonDown(deps.language),
      );
    }

    const byName = new Map(listed.containers.map((facts) => [facts.name, facts]));
    const rows: DockerRow[] = entries.map((entry) => ({
      name: entry.name,
      container: entry.container,
      facts: byName.get(entry.container),
    }));

    const projectsSeen = new Set<string>();
    let workingDir: string | undefined;
    for (const row of rows) {
      if (row.facts?.composeProject === undefined) continue;
      projectsSeen.add(row.facts.composeProject);
      workingDir ??= row.facts.composeWorkingDir;
    }
    const single = projectsSeen.size === 1 ? [...projectsSeen][0] : undefined;

    return {
      ok: true,
      value: {
        rows,
        composeProject: single,
        composeWorkingDir: single === undefined ? undefined : workingDir,
      },
    };
  }

  async function act(
    project: string,
    container: string,
    run: (name: string) => Promise<DockerResult>,
  ): Promise<GitViewResult<void>> {
    if (deps.projects[project] === undefined) {
      return fail(MESSAGES.unknownProject(deps.language));
    }
    if (!declared(project, container) || !CONTAINER_NAME.test(container)) {
      return fail(MESSAGES.dockerUnknownContainer(deps.language));
    }
    const outcome = await run(container);
    return outcome.ok ? { ok: true, value: undefined } : fail(outcome.detail);
  }

  async function compose(
    project: string,
    run: (view: DockerView) => Promise<DockerResult>,
  ): Promise<GitViewResult<void>> {
    const view = await build(project);
    if (!view.ok) return view;
    if (view.value.composeProject === undefined) {
      return fail(MESSAGES.dockerNoComposeProject(deps.language));
    }
    const outcome = await run(view.value);
    return outcome.ok ? { ok: true, value: undefined } : fail(outcome.detail);
  }

  return {
    view: build,
    start: (project, container) => act(project, container, deps.docker.start),
    stop: (project, container) => act(project, container, deps.docker.stop),
    restart: (project, container) => act(project, container, deps.docker.restart),

    composeUp: (project) =>
      compose(project, (view) =>
        view.composeWorkingDir === undefined
          ? Promise.resolve({ ok: false, detail: "no compose working directory" })
          : deps.docker.composeUp(view.composeWorkingDir),
      ),
    composeDown: (project) =>
      // Non-null: compose() has already refused an undefined project.
      compose(project, (view) => deps.docker.composeDown(view.composeProject as string)),

    names(project) {
      if (deps.projects[project] === undefined) {
        return fail(MESSAGES.unknownProject(deps.language));
      }
      return { ok: true, value: (deps.containers[project] ?? []).map((entry) => entry.name) };
    },

    shell(project, container) {
      if (deps.projects[project] === undefined) {
        return fail(MESSAGES.unknownProject(deps.language));
      }
      if (!declared(project, container) || !CONTAINER_NAME.test(container)) {
        return fail(MESSAGES.dockerUnknownContainer(deps.language));
      }
      const tabId = deps.openTerminal(project, deps.projects[project] ?? "");
      // `exec bash || exec sh`: most images have sh, many have bash, and
      // asking for bash outright fails outright on an alpine container.
      deps.sendInput(tabId, `docker exec -it ${container} sh -c 'exec bash || exec sh'\r`);
      return { ok: true, value: undefined };
    },

    async containers() {
      const listed = await deps.docker.list();
      if (!listed.ok) {
        return fail(
          listed.reason === "not-installed"
            ? MESSAGES.dockerNotInstalled(deps.language)
            : MESSAGES.dockerDaemonDown(deps.language),
        );
      }
      return { ok: true, value: listed.containers };
    },
  };
}

export type TerminalHandlers = {
  /** Opens a terminal tab for `project` and starts its shell. Synchronous:
   *  there is no port to wait for and no page to load — the tab and the pty
   *  both exist by the time this returns. */
  open(project: string): GitViewResult<void>;
  input(tabId: string, data: string): void;
  resize(tabId: string, cols: number, rows: number): void;
  /** Kills the tab's shell. Called when the tab is closed. */
  close(tabId: string): void;
  /** What to offer for `input` typed at the prompt of `tabId`. Empty is an
   *  ordinary answer — a closed dropdown, and zsh's own Tab completion
   *  behaving exactly as it does today. */
  suggest(tabId: string, input: string): Promise<string[]>;
};

export type TerminalHandlerDeps = {
  shells: ShellManager;
  /** Opens the tab itself and returns its id — BrowserHost.openTerminal,
   *  injected so these handlers stay testable without a window. */
  openTerminalTab: (project: string) => string;
  /** Name to absolute path, from config. The renderer never sees a path. */
  projects: Readonly<Record<string, string>>;
  language: "ar" | "en";
  /** Terminal autocomplete. Absent — or present and disabled — means no
   *  suggestions at all, which is a terminal exactly as it was before the
   *  feature existed. */
  completion?: { source: CompletionSource; enabled: boolean } | undefined;
};

export function createTerminalHandlers(deps: TerminalHandlerDeps): TerminalHandlers {
  // Which directory each tab's shell was started in. The renderer knows
  // only a tab id, and both directory affinity and path completion are
  // meaningless without the cwd behind it.
  const directories = new Map<string, string>();

  return {
    open(project) {
      const cwd = isString(project) ? deps.projects[project] : undefined;
      if (cwd === undefined) {
        return { ok: false, text: MESSAGES.unknownProject(deps.language), language: deps.language };
      }
      // The tab first, then the shell: the pty is keyed by the tab id, and
      // a shell with no tab to draw it would be an orphan process.
      const tabId = deps.openTerminalTab(project);
      directories.set(tabId, cwd);
      deps.shells.start(tabId, cwd);
      return { ok: true, value: undefined };
    },

    input(tabId, data) {
      // Both arguments cross an untyped IPC boundary; a keystroke stream is
      // no reason to relax that.
      if (!isString(tabId) || !isString(data)) return;
      deps.shells.write(tabId, data);
    },

    resize(tabId, cols, rows) {
      if (!isString(tabId) || typeof cols !== "number" || typeof rows !== "number") return;
      deps.shells.resize(tabId, cols, rows);
    },

    close(tabId) {
      if (!isString(tabId)) return;
      directories.delete(tabId);
      deps.shells.kill(tabId);
    },

    async suggest(tabId, input) {
      const completion = deps.completion;
      if (completion === undefined || !completion.enabled) return [];
      if (!isString(tabId) || !isString(input)) return [];
      const cwd = directories.get(tabId);
      if (cwd === undefined) return [];
      try {
        return await completion.source.suggest(cwd, input);
      } catch {
        // A suggestion that failed is a dropdown that does not open. There
        // is nothing here worth interrupting a terminal for.
        return [];
      }
    },
  };
}

export type ApiHandlers = ApiEditHandlers & {
  collections(project: string): Promise<GitViewResult<BrunoCollection[]>>;
  tree(project: string, collectionPath: string): Promise<GitViewResult<BrunoTree>>;
  request(project: string, path: string): Promise<GitViewResult<Record<string, unknown>>>;
  save(project: string, path: string, json: Record<string, unknown>): Promise<GitViewResult<void>>;
  /** Sends the request and, when it answers, evaluates its assert block
   *  against the response. The two travel together because assertions are
   *  about a response that main already has in hand — asking for them
   *  separately would mean shipping the body back across IPC to be checked. */
  send(
    project: string,
    request: Record<string, unknown>,
    variables: Record<string, string>,
  ): Promise<GitViewResult<ApiSendResult>>;
  history(project: string): Promise<GitViewResult<HistoryEntry[]>>;
  clearHistory(project: string): Promise<GitViewResult<void>>;
  cookies(project: string): Promise<GitViewResult<Cookie[]>>;
  clearCookies(project: string): Promise<GitViewResult<Cookie[]>>;
  removeCookie(project: string, name: string, domain: string, path: string): Promise<GitViewResult<Cookie[]>>;
  settings(project: string): Promise<GitViewResult<ApiSettings>>;
  saveSettings(project: string, settings: ApiSettings): Promise<GitViewResult<ApiSettings>>;
  /** The request as a shell command, with variables resolved. */
  curl(
    project: string,
    request: Record<string, unknown>,
    variables: Record<string, string>,
  ): Promise<GitViewResult<string>>;
};

export type PickableVoice = InstalledVoice & { engine: "piper" | "say" };

export type ApiSendResult = {
  response: ApiResponse | ApiFailure;
  assertions: AssertionResult[];
  /** What the request's own scripts and tests block did, when it has them. */
  scripts?: { logs: string[]; tests: ScriptResult["tests"]; error?: string };
  history: HistoryEntry[];
  cookies: Cookie[];
};

export type ApiEditHandlers = {
  createRequest(project: string, folderPath: string, name: string, seq: number): Promise<GitViewResult<string>>;
  createFolder(project: string, parentPath: string, name: string): Promise<GitViewResult<string>>;
  renameEntry(project: string, path: string, name: string, isFolder: boolean): Promise<GitViewResult<string>>;
  deleteEntry(project: string, path: string): Promise<GitViewResult<void>>;
  createCollection(project: string, name: string): Promise<GitViewResult<string>>;
  saveEnvironment(
    project: string,
    collectionPath: string,
    name: string,
    variables: BrunoVariable[],
  ): Promise<GitViewResult<string>>;
  /** Reads a Postman export and writes it as a new collection. */
  importPostman(project: string, name: string, collection: unknown): Promise<GitViewResult<string>>;
};

export type ApiHandlerDeps = {
  listCollections: (projectPath: string) => Promise<BrunoCollection[]>;
  readCollection: (collectionPath: string) => Promise<BrunoTree>;
  readRequest: (path: string) => Promise<Record<string, unknown>>;
  writeRequest: (path: string, json: Record<string, unknown>) => Promise<void>;
  /** Sends the request for one project: interpolates, runs its scripts, uses
   *  that project's cookie jar and settings, and reports what happened. */
  sendRequest: (
    request: Record<string, unknown>,
    variables: Record<string, string>,
    project: string,
  ) => Promise<{
    response: ApiResponse | ApiFailure;
    scripts?: { logs: string[]; tests: ScriptResult["tests"]; error?: string };
    cookies: Cookie[];
  }>;
  truncateBody: (body: string) => string;
  evaluateAssertions: (
    assertions: readonly { name?: string; value?: string; enabled?: boolean }[],
    subject: { status: number; headers: Record<string, string>; body: string; timeMs: number },
  ) => AssertionResult[];
  toCurl: (request: Record<string, unknown>, variables: Record<string, string>) => string;
  /** The project's persisted API state: history, cookies and settings. */
  store: {
    read: (project: string) => Promise<{ history: HistoryEntry[]; cookies: Cookie[]; settings: ApiSettings }>;
    addHistory: (project: string, entry: HistoryEntry) => Promise<HistoryEntry[]>;
    clearHistory: (project: string) => Promise<void>;
    saveCookies: (project: string, cookies: readonly Cookie[]) => Promise<void>;
    saveSettings: (project: string, settings: ApiSettings) => Promise<ApiSettings>;
  };
  /** Name to absolute path, from config. The renderer never sees a path it
   *  was not first given, and never one this map does not contain. */
  createRequest: (folderPath: string, name: string, seq: number) => Promise<string>;
  createFolder: (parentPath: string, name: string) => Promise<string>;
  renameRequest: (path: string, name: string) => Promise<string>;
  renameFolder: (path: string, name: string) => Promise<string>;
  deleteEntry: (path: string) => Promise<void>;
  createCollection: (projectPath: string, name: string) => Promise<string>;
  writeEnvironment: (
    collectionPath: string,
    name: string,
    variables: BrunoVariable[],
  ) => Promise<string>;
  postmanToRequests: (collection: unknown) => { name: string; requests: readonly unknown[] };
  writeImported: (
    projectPath: string,
    name: string,
    requests: readonly never[],
  ) => Promise<string>;
  projects: Readonly<Record<string, string>>;
  language: "ar" | "en";
};

/**
 * The API tab's main-process half.
 *
 * Every path the renderer sends is checked against the project it claims to
 * belong to before it reaches the filesystem. The renderer does receive real
 * paths here — a collection tree is a filesystem view, and hiding them would
 * mean inventing an id scheme for files — so containment is the guarantee
 * that replaces "the renderer never sees a path": a path may be shown, but
 * only a path inside the named project is ever acted on.
 */
export function createApiHandlers(deps: ApiHandlerDeps): ApiHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  const unknownProject = (): { ok: false; text: string; language: "ar" | "en" } =>
    fail(MESSAGES.unknownProject(deps.language));

  /** The project's root, or undefined if the renderer named one that is not
   *  configured. */
  function rootFor(project: unknown): string | undefined {
    return isString(project) ? deps.projects[project] : undefined;
  }

  /** True only if `path` is inside `root`. resolve() collapses any `..`
   *  first, so a traversal cannot smuggle its way past the prefix test, and
   *  the separator guards against `/p/acme-other` passing for
   *  `/p/acme`. */
  function contains(root: string, path: unknown): boolean {
    if (!isString(path)) return false;
    const resolved = resolve(path);
    return resolved === resolve(root) || resolved.startsWith(`${resolve(root)}${sep}`);
  }

  /** Shared by every write: the project must be known, the path must be
   *  inside it, and the name must be something. */
  async function guardedWrite(
    project: string,
    path: string,
    name: string,
    write: () => Promise<string>,
  ): Promise<GitViewResult<string>> {
    const root = rootFor(project);
    if (root === undefined || !contains(root, path)) return unknownProject();
    if (!isString(name) || name.trim() === "") return fail(MESSAGES.invalidArgument(deps.language));
    try {
      return { ok: true, value: await write() };
    } catch {
      return fail(MESSAGES.apiUnavailable(deps.language));
    }
  }

  return {
    async curl(project, request, variables) {
      if (rootFor(project) === undefined) return unknownProject();
      if (typeof request !== "object" || request === null) {
        return fail(MESSAGES.invalidArgument(deps.language));
      }
      try {
        return { ok: true, value: deps.toCurl(request, variables ?? {}) };
      } catch {
        return fail(MESSAGES.apiUnavailable(deps.language));
      }
    },

    async history(project) {
      if (rootFor(project) === undefined) return unknownProject();
      return { ok: true, value: (await deps.store.read(project)).history };
    },

    async clearHistory(project) {
      if (rootFor(project) === undefined) return unknownProject();
      await deps.store.clearHistory(project);
      return { ok: true, value: undefined };
    },

    async cookies(project) {
      if (rootFor(project) === undefined) return unknownProject();
      return { ok: true, value: (await deps.store.read(project)).cookies };
    },

    async clearCookies(project) {
      if (rootFor(project) === undefined) return unknownProject();
      await deps.store.saveCookies(project, []);
      return { ok: true, value: [] };
    },

    async removeCookie(project, name, domain, path) {
      if (rootFor(project) === undefined) return unknownProject();
      const { cookies } = await deps.store.read(project);
      const kept = cookies.filter(
        (cookie) => !(cookie.name === name && cookie.domain === domain && cookie.path === path),
      );
      await deps.store.saveCookies(project, kept);
      return { ok: true, value: kept };
    },

    async settings(project) {
      if (rootFor(project) === undefined) return unknownProject();
      return { ok: true, value: (await deps.store.read(project)).settings };
    },

    async saveSettings(project, settings) {
      if (rootFor(project) === undefined) return unknownProject();
      if (typeof settings !== "object" || settings === null) {
        return fail(MESSAGES.invalidArgument(deps.language));
      }
      return { ok: true, value: await deps.store.saveSettings(project, settings) };
    },

    async collections(project) {
      const root = rootFor(project);
      if (root === undefined) return unknownProject();
      try {
        return { ok: true, value: await deps.listCollections(root) };
      } catch {
        return fail(MESSAGES.apiUnavailable(deps.language));
      }
    },

    async tree(project, collectionPath) {
      const root = rootFor(project);
      if (root === undefined) return unknownProject();
      if (!contains(root, collectionPath)) return unknownProject();
      try {
        return { ok: true, value: await deps.readCollection(collectionPath) };
      } catch {
        return fail(MESSAGES.apiUnavailable(deps.language));
      }
    },

    async request(project, path) {
      const root = rootFor(project);
      if (root === undefined) return unknownProject();
      if (!contains(root, path)) return unknownProject();
      try {
        return { ok: true, value: await deps.readRequest(path) };
      } catch {
        return fail(MESSAGES.apiUnavailable(deps.language));
      }
    },

    async save(project, path, json) {
      const root = rootFor(project);
      if (root === undefined) return unknownProject();
      if (!contains(root, path)) return unknownProject();
      if (typeof json !== "object" || json === null) return fail(MESSAGES.invalidArgument(deps.language));
      try {
        await deps.writeRequest(path, json);
        return { ok: true, value: undefined };
      } catch {
        return fail(MESSAGES.apiUnavailable(deps.language));
      }
    },

    async createRequest(project, folderPath, name, seq) {
      return guardedWrite(project, folderPath, name, () =>
        deps.createRequest(folderPath, name, typeof seq === "number" ? seq : 1),
      );
    },

    async createFolder(project, parentPath, name) {
      return guardedWrite(project, parentPath, name, () => deps.createFolder(parentPath, name));
    },

    async renameEntry(project, path, name, isFolder) {
      return guardedWrite(project, path, name, () =>
        isFolder === true ? deps.renameFolder(path, name) : deps.renameRequest(path, name),
      );
    },

    async deleteEntry(project, path) {
      const root = rootFor(project);
      if (root === undefined || !contains(root, path)) return unknownProject();
      // Never the collection root itself: deleting that from a tree view is
      // a mis-click away from removing every request in it, and the
      // filesystem is the right place for that decision.
      if (resolve(path) === resolve(root)) return unknownProject();
      try {
        await deps.deleteEntry(path);
        return { ok: true, value: undefined };
      } catch {
        return fail(MESSAGES.apiUnavailable(deps.language));
      }
    },

    async createCollection(project, name) {
      const root = rootFor(project);
      if (root === undefined) return unknownProject();
      if (!isString(name) || name.trim() === "") return fail(MESSAGES.invalidArgument(deps.language));
      try {
        return { ok: true, value: await deps.createCollection(root, name) };
      } catch {
        return fail(MESSAGES.apiUnavailable(deps.language));
      }
    },

    async saveEnvironment(project, collectionPath, name, variables) {
      const root = rootFor(project);
      if (root === undefined || !contains(root, collectionPath)) return unknownProject();
      if (!isString(name) || name.trim() === "" || !Array.isArray(variables)) {
        return fail(MESSAGES.invalidArgument(deps.language));
      }
      try {
        return { ok: true, value: await deps.writeEnvironment(collectionPath, name, variables) };
      } catch {
        return fail(MESSAGES.apiUnavailable(deps.language));
      }
    },

    async importPostman(project, name, collection) {
      const root = rootFor(project);
      if (root === undefined) return unknownProject();
      try {
        const converted = deps.postmanToRequests(collection);
        const target = isString(name) && name.trim() !== "" ? name : converted.name;
        return {
          ok: true,
          value: await deps.writeImported(root, target, converted.requests as readonly never[]),
        };
      } catch (error) {
        // The importer's own message ("Only Postman Collection v2.0 and
        // v2.1 are supported") is the useful part here, unlike a runner's
        // internal detail — an import fails for reasons about the file the
        // user chose, and they are the one who can fix it.
        return {
          ok: false,
          text: error instanceof Error ? error.message : MESSAGES.apiUnavailable(deps.language),
          language: deps.language,
        };
      }
    },

    async send(project, request, variables) {
      if (rootFor(project) === undefined) return unknownProject();
      if (typeof request !== "object" || request === null) {
        return fail(MESSAGES.invalidArgument(deps.language));
      }
      try {
        const outcome = await deps.sendRequest(request, variables ?? {}, project);
        const { response } = outcome;
        const assertions = Array.isArray(request["assertions"])
          ? (request["assertions"] as { name?: string; value?: string; enabled?: boolean }[])
          : [];

        const meta = (request["meta"] ?? {}) as { name?: string };
        const http = (request["http"] ?? {}) as { method?: string; url?: string };
        const state = await deps.store.read(project);
        const history =
          "failed" in response
            ? state.history
            : await deps.store.addHistory(project, {
                at: Date.now(),
                name: meta.name ?? "",
                method: (http.method ?? "get").toUpperCase(),
                url: http.url ?? "",
                status: response.status,
                timeMs: response.timeMs,
                bytes: response.bytes,
                bodyPreview: deps.truncateBody(response.body),
              });

        return {
          ok: true,
          value: {
            response,
            // Nothing to check against a request that never answered.
            assertions:
              "failed" in response
                ? []
                : deps.evaluateAssertions(assertions, {
                    status: response.status,
                    headers: response.headers,
                    body: response.body,
                    timeMs: response.timeMs,
                  }),
            ...(outcome.scripts === undefined ? {} : { scripts: outcome.scripts }),
            history,
            cookies: outcome.cookies,
          },
        };
      } catch {
        // A runner that threw rather than returning an ApiFailure is a bug
        // on our side, not a failed request; it still must not reach the
        // renderer as a raw message.
        return fail(MESSAGES.apiUnavailable(deps.language));
      }
    },
  };
}

export type BookmarksHandlers = {
  list(project: string): Promise<GitViewResult<Bookmark[]>>;
  /** Returns the project's full list after the change, so the renderer
   *  never needs a second list() call just to redraw. */
  add(project: string, bookmark: Bookmark): Promise<GitViewResult<Bookmark[]>>;
  remove(project: string, url: string): Promise<GitViewResult<Bookmark[]>>;
};

export type BookmarksHandlerDeps = {
  store: BookmarkStore;
  language: "ar" | "en";
};

function isBookmark(value: unknown): value is Bookmark {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isString(candidate["url"]) && isString(candidate["title"]);
}

/**
 * Bookmarks are keyed by project *name*, not path — unlike the editor and
 * git handlers, there is no filesystem to reach through this boundary, so
 * (unlike those) any string project name is accepted rather than checked
 * against configured projects.
 */
export function createBookmarksHandlers(deps: BookmarksHandlerDeps): BookmarksHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  return {
    async list(project) {
      if (!isString(project)) return fail(MESSAGES.invalidArgument(deps.language));
      const result = await deps.store.list(project);
      return result.ok ? result : fail(MESSAGES.bookmarksUnavailable(deps.language));
    },

    async add(project, bookmark) {
      if (!isString(project) || !isBookmark(bookmark)) {
        return fail(MESSAGES.invalidArgument(deps.language));
      }
      const result = await deps.store.add(project, bookmark);
      return result.ok ? result : fail(MESSAGES.bookmarksUnavailable(deps.language));
    },

    async remove(project, url) {
      if (!isString(project) || !isString(url)) return fail(MESSAGES.invalidArgument(deps.language));
      const result = await deps.store.remove(project, url);
      return result.ok ? result : fail(MESSAGES.bookmarksUnavailable(deps.language));
    },
  };
}

export type SettingsSaveResult =
  | { ok: true }
  | { ok: false; text: string; detail: string; language: "ar" | "en" };

export type SettingsHandlers = {
  read(): Promise<JarvisConfig>;
  save(draft: unknown): Promise<SettingsSaveResult>;
  testAgent(agent: unknown): Promise<AgentHealth>;
  restart(): void;
};

export type SettingsHandlerDeps = {
  readConfig(): Promise<JarvisConfig>;
  /** settings-io.ts's writeSettingsFile, injected so this file's own tests
   *  never touch a real filesystem. */
  writeConfig(draft: JarvisConfig): Promise<{ ok: true } | { ok: false; detail: string }>;
  run: CommandRunner;
  restart(): void;
  language: "ar" | "en";
};

export function createSettingsHandlers(deps: SettingsHandlerDeps): SettingsHandlers {
  return {
    read: () => deps.readConfig(),

    async save(draft) {
      const result = await deps.writeConfig(draft as JarvisConfig);
      if (result.ok) return { ok: true };
      return {
        ok: false,
        text: MESSAGES.settingsSaveFailed(deps.language),
        detail: result.detail,
        language: deps.language,
      };
    },

    // checkAgent never rejects — a malformed draft agent (missing command,
    // wrong types) degrades to an unhealthy AgentHealth, same as a real
    // broken agent would, rather than needing its own guard here.
    testAgent: (agent) => checkAgent(agent as AgentConfig, deps.run),

    restart: () => deps.restart(),
  };
}
