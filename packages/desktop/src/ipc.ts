import {
  gitFailureText,
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
import { parseMarkdown, type DocBlock, type DocEntry, type WorkspaceState } from "@jarvis/core";
import type { DocFailureCode, DocReader } from "@jarvis/platform";
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
  openTab(project: string, input: string): Promise<void>;
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
  onWorkspace(cb: (state: WorkspaceState) => void): void;
  listDocs(project: string): Promise<GitViewResult<DocEntry[]>>;
  readDoc(project: string, path: string): Promise<GitViewResult<DocBlock[]>>;
  writeDoc(project: string, path: string, content: string): Promise<GitViewResult<null>>;
  /** Parses arbitrary text with no filesystem access — used to preview a
   *  Dev-mode edit that has not been saved yet. */
  parseDoc(text: string): Promise<DocBlock[]>;
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

export type DocsHandlers = {
  list(project: string): Promise<GitViewResult<DocEntry[]>>;
  read(project: string, path: string): Promise<GitViewResult<DocBlock[]>>;
  write(project: string, path: string, content: string): Promise<GitViewResult<null>>;
  /** Pure — no project, no filesystem, never fails. Lets the renderer
   *  preview an unsaved Dev-mode edit through the same parser read() uses,
   *  without writing the draft to disk just to look at it. */
  parse(text: string): DocBlock[];
};

export type DocsHandlerDeps = {
  reader: DocReader;
  /** Name to absolute path, from config. The renderer never sees a path. */
  projects: Readonly<Record<string, string>>;
  language: "ar" | "en";
};

function docFailureText(code: DocFailureCode, language: "ar" | "en"): string {
  switch (code) {
    case "too-large":
      return MESSAGES.docTooLarge(language);
    case "not-found":
      return MESSAGES.docNotFound(language);
    // "outside-root" and "unreadable" are both refusals. Neither says which
    // one it was: a caller probing for a file it is not allowed to read
    // learns nothing from the difference, and the user cannot act on it.
    default:
      return MESSAGES.docUnavailable(language);
  }
}

/**
 * Documents cross this boundary as a parsed model, never as markdown source
 * and never as HTML — the renderer builds nodes from data it cannot execute
 * (see markdown.ts). Projects are named, not pathed, for the same reason
 * the git handlers take a sessionId: main owns the mapping, so a compromised
 * renderer can only ever reach a directory the user configured.
 */
export function createDocsHandlers(deps: DocsHandlerDeps): DocsHandlers {
  function fail(text: string): { ok: false; text: string; language: "ar" | "en" } {
    return { ok: false, text, language: deps.language };
  }

  function rootFor(project: unknown): string | undefined {
    if (!isString(project)) return undefined;
    return deps.projects[project];
  }

  return {
    async list(project) {
      const root = rootFor(project);
      if (root === undefined) return fail(MESSAGES.unknownProject(deps.language));
      try {
        const outcome = await deps.reader.list(root);
        return outcome.ok
          ? { ok: true, value: outcome.value }
          : fail(docFailureText(outcome.error.code, deps.language));
      } catch {
        // P15: the contract says it resolves; the cost of trusting that at
        // the call site is an unhandled rejection in the main process.
        return fail(MESSAGES.docUnavailable(deps.language));
      }
    },

    async read(project, path) {
      const root = rootFor(project);
      if (root === undefined) return fail(MESSAGES.unknownProject(deps.language));
      if (!isString(path)) return fail(MESSAGES.invalidArgument(deps.language));
      try {
        const outcome = await deps.reader.read(root, path);
        if (!outcome.ok) return fail(docFailureText(outcome.error.code, deps.language));
        return { ok: true, value: parseMarkdown(outcome.value) };
      } catch {
        return fail(MESSAGES.docUnavailable(deps.language));
      }
    },

    async write(project, path, content) {
      const root = rootFor(project);
      if (root === undefined) return fail(MESSAGES.unknownProject(deps.language));
      if (!isString(path) || !isString(content)) return fail(MESSAGES.invalidArgument(deps.language));
      try {
        const outcome = await deps.reader.write(root, path, content);
        return outcome.ok ? outcome : fail(docFailureText(outcome.error.code, deps.language));
      } catch {
        return fail(MESSAGES.docUnavailable(deps.language));
      }
    },

    parse(text) {
      return parseMarkdown(text);
    },
  };
}
