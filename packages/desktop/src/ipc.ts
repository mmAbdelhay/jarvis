import {
  checkAgent,
  gitFailureText,
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
import type { WorkspaceState } from "@jarvis/core";
import type { Bookmark, BookmarkStore, CodeServerManager, DbGateManager } from "@jarvis/platform";
import type { JarvisConfig } from "./config.js";
import { MESSAGES } from "./messages.js";

export type VoiceNotice = { text: string; language: "ar" | "en" };

export type IpcChannels = {
  "metrics:update": SystemMetrics;
  "sessions:update": Session[];
  "turn:new": Turn;
  "voice:listening": boolean;
  "voice:notice": VoiceNotice;
  "git:counts": SessionChanges[];
  "providers:update": ProviderStatus[];
  "session:output": SessionOutput;
  "workspace:update": WorkspaceState;
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
            project: session.project,
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
  openTab(project: string, input: string, kind?: "web" | "editor" | "database"): Promise<void>;
  closeTab(id: string): Promise<void>;
  activateTab(id: string): Promise<void>;
  navigateTab(id: string, input: string): Promise<void>;
  tabBack(id: string): Promise<void>;
  tabForward(id: string): Promise<void>;
  tabReload(id: string): Promise<void>;
  /** The rectangle the renderer has reserved for the page, in CSS pixels
   *  relative to the window's content area. A hosted view is a native
   *  overlay, so it has to be told; nothing about CSS layout reaches it. */
  setWorkspaceBounds(bounds: { x: number; y: number; width: number; height: number }): Promise<void>;
  /** Called by showView on EVERY route change, not only when entering the
   *  Workspace — a view left visible floats over whatever route follows. */
  setWorkspaceVisible(visible: boolean): Promise<void>;
  /** Hides every tab's page without changing which tab is active — for
   *  switching to a project with no open tab. */
  hideAllTabs(): Promise<void>;
  onWorkspace(cb: (state: WorkspaceState) => void): void;
  /** Ensures a code-server instance is running for `project` and returns
   *  its URL — call openTab(project, url) with the result to actually show
   *  it; this call alone does not open a tab. */
  openEditor(project: string): Promise<GitViewResult<string>>;
  /** Ensures a DbGate instance is running for `project` and returns its URL
   *  plus the credential it is guarded with — call openTab(project, url,
   *  "database") with the result to actually show it. */
  openDatabase(project: string): Promise<GitViewResult<DatabaseCredentials>>;
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
  /** Ensures a code-server instance is running for `project` and returns
   *  its URL — the renderer then opens that URL as an ordinary Workspace
   *  browser tab (openTab), same as any other page. */
  open(project: string): Promise<GitViewResult<string>>;
};

export type EditorHandlerDeps = {
  codeServer: CodeServerManager;
  /** Name to absolute path, from config. The renderer never sees a path. */
  projects: Readonly<Record<string, string>>;
  language: "ar" | "en";
};

export function createEditorHandlers(deps: EditorHandlerDeps): EditorHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  return {
    async open(project) {
      const root = isString(project) ? deps.projects[project] : undefined;
      if (root === undefined) return fail(MESSAGES.unknownProject(deps.language));
      try {
        const result = await deps.codeServer.open(root);
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
