// The one place every request handler lives, whatever transport carried it.
//
// main.ts used to hold 101 `ipcMain.handle` registrations, each closing
// over the services it needed. Their argument coercion is the security
// boundary — it is where a renderer's (or, later, a phone's) untyped
// arguments are proven to be the strings, booleans and declared names the
// handlers below expect — and duplicating it for a second transport is the
// most likely place for the remote bridge to grow a hole. So the bodies are
// here, once, keyed by the channel strings from channels.ts, and main.ts
// registers them in a loop. Every check moved verbatim.
//
// `Origin` says who asked. Today it is always the desktop; it earns its
// place in later milestones (audit log, push suppression, proxy URLs).
//
// This file imports nothing from electron and reads nothing from
// process.platform (platform-convention.test.ts). Whatever needs either is
// built in main.ts and handed in through DispatchDeps.
import type { HandleOptions, Session, StreamSnapshot, Turn } from "@jarvis/core";
import type { DockerConfig } from "@jarvis/platform";
import {
  isFileId,
  isSubscriptionKey,
  parsePushRegistration,
  type PushRegisterResult,
  type PushRegistration,
  type TerminalPaneInfo,
} from "@jarvis/wire";
import {
  bindChoices,
  type InterfaceMap,
  type PairingResult,
  type RemoteStatus,
} from "@jarvis/remote";
import type { InvokeChannel } from "./channels.js";
import { isDevToolsDock, type BrowserHost } from "./browser-host.js";
import type { JarvisConfig } from "./config.js";
import {
  DESKTOP_OWNER,
  REMOTE_FOLLOW_TAB_PATTERN,
  type DockerFollowers,
} from "./docker-followers.js";
import {
  isDeclaredContainer,
  type ApiHandlers,
  type BookmarksHandlers,
  type ChatHandlers,
  type ClusterHandlers,
  type createResumeInTerminalHandler,
  type createTranscriptHandler,
  type DatabaseHandlers,
  type DockerHandlers,
  type EditorHandlers,
  type GitHandlers,
  type GitViewResult,
  type SettingsHandlers,
  type SetupHandlers,
  type TerminalHandlers,
} from "./ipc.js";
import { errorMessage, MESSAGES } from "./messages.js";
import type { Notifier } from "./notify.js";
import type { SettingsWriteResult } from "./settings-io.js";
import type { TailscaleCertResult } from "./tailscale-cert.js";

export type Origin = { kind: "desktop" } | { kind: "remote"; deviceId: string; deviceName: string };

export const DESKTOP_ORIGIN: Origin = { kind: "desktop" };

export type Handler = (args: readonly unknown[], origin: Origin) => unknown | Promise<unknown>;

/** `{ ok:false, text: MESSAGES.invalidArgument(language), language }`, named
 *  once so a channel that only needs "the argument was the wrong shape"
 *  (remote:revoke) does not repeat that shape inline. */
export function invalidArgument(language: "ar" | "en"): GitViewResult<never> {
  return { ok: false, text: MESSAGES.invalidArgument(language), language };
}

/** A remote origin's sidecar publish was refused — logged to the console
 *  the way ipc.ts's reportSidecarFailure logs every other sidecar failure
 *  (the reason is developer detail; the phone only ever gets one of two
 *  bilingual sentences, MESSAGES.sidecarProxyUnavailable's own text). */
function sidecarPublishRefused(
  reason: "off" | "needs-certificate" | "not-listening" | "unknown-device" | "bad-target",
  language: "ar" | "en",
): GitViewResult<never> {
  console.error(`sidecar publish refused: ${reason}`);
  return { ok: false, text: MESSAGES.sidecarProxyUnavailable(reason, language), language };
}

/** The bridge lifecycle's controls, as the dispatch table sees them —
 *  remote-access.ts implements this; dispatch.ts only names the shape so it
 *  never has to import remote-access.ts (which imports DispatchTable from
 *  here, and a cycle back would make the two files' build order undefined). */
export type RemoteControls = {
  status(): RemoteStatus;
  openPairing(): Promise<PairingResult>;
  cancelPairing(): void;
  decidePairing(requestId: string, approve: boolean): boolean;
  revoke(deviceId: string): Promise<boolean>;
  /** M10 Task 4: stores this device's Expo push registration — always the
   *  authenticated origin's own `deviceId`, never one carried in `args`. */
  registerPush(deviceId: string, registration: PushRegistration): Promise<PushRegisterResult>;
  /** Clears this device's own registration; ignored either way (unregister
   *  is not a thing a phone can fail at from where it stands). */
  unregisterPush(deviceId: string): Promise<void>;
};

/** Task 4: how a remote origin's `editor:open`/`database:open`/
 *  `cluster:open` turns a manager's loopback URL into the `/s/<handle>/…`
 *  proxy URL a phone is allowed to see — the sidecar's own port and any
 *  credential never leave this process either way. remote-access.ts
 *  implements `publish` (it owns the bridge); dispatch.ts only names the
 *  shape, the same reason RemoteControls above is named rather than
 *  imported (a cycle back through remote-access.ts otherwise). */
export type SidecarPublisher = {
  publish(
    deviceId: string,
    target: {
      kind: "editor" | "database" | "cluster";
      url: string;
      basicAuth?: { login: string; password: string };
    },
  ):
    | { ok: true; url: string }
    | {
        ok: false;
        reason: "off" | "needs-certificate" | "not-listening" | "unknown-device" | "bad-target";
      };
};

/** The four handlers that hold a BrowserWindow, the screen, a native dialog
 *  or a native menu. They can never run for a phone, so they never enter the
 *  table — desktop-only.ts registers them. */
export type ElectronBoundChannel =
  | "workspace:bounds"
  | "workspace:devtoolsBounds"
  | "workspace:devtoolsDockMenu"
  | "dialog:pickFiles";

export type TableChannel = Exclude<InvokeChannel, ElectronBoundChannel>;

/** Total: a channel added to channels.ts without an entry here — or an
 *  entry here for a channel that does not exist — is a tsc error. */
export type DispatchTable = Readonly<Record<TableChannel, Handler>>;

export type DispatchDeps = {
  setup: Pick<SetupHandlers, "check" | "install">;
  // Promise<unknown>, not Promise<void>: Orchestrator.handle resolves with
  // the Turn it produced, which input:send has always discarded (only
  // awaited, never returned) — but the dep's declared type still has to
  // accept the real method's return type, not narrow it away.
  orchestrator: {
    handle(text: string, language: "ar" | "en", options?: HandleOptions): Promise<unknown>;
    // Backs turns:list (ruling 10): a phone recovers a reply it missed
    // while disconnected by pulling the last TURNS_LIST_MAX turns rather
    // than replaying a push it never received.
    transcript(): Turn[];
  };
  sessionStore: { history(): unknown };
  sessions: {
    log(sessionId: string): string;
    write(sessionId: string, data: string): void;
    resize(sessionId: string, cols: number, rows: number): void;
    snapshot(sessionId: string): StreamSnapshot;
    // Jarvis's own sessions plus whatever the last process scan found
    // running outside it (main.ts merges the two) — see sessions:refresh.
    list(): Session[];
  };
  // Backfills any new transcripts and re-scans the process table
  // (process-scan.ts) for agents Jarvis did not start, updates the merged
  // list `sessions.list()` returns, and broadcasts "sessions:update" with
  // it — main.ts coalesces concurrent calls into one in-flight scan.
  refreshSessions(): Promise<{ jarvis: number; external: number; importedTranscripts: number }>;
  sessionTranscript: ReturnType<typeof createTranscriptHandler>;
  sessionResume: ReturnType<typeof createResumeInTerminalHandler>;
  voice: { setTarget(sessionId: string | undefined): void };
  git: Pick<GitHandlers, "changes" | "fileDiff" | "setStaged" | "commit">;
  workspace: Pick<
    BrowserHost,
    | "open"
    | "close"
    | "activate"
    | "rename"
    | "move"
    | "navigate"
    | "back"
    | "forward"
    | "reload"
    | "setDevTools"
    | "setDevToolsDock"
    | "setVisible"
    | "hideAll"
    | "requestPictureInPicture"
    | "openDocker"
    | "openApi"
    | "state"
  >;
  terminal: TerminalHandlers;
  // terminal:attach's backlog read; not part of TerminalHandlers because it
  // reads the shell manager directly rather than going through terminal.ts.
  shells: {
    log(paneKey: string): string;
    snapshot(paneKey: string): StreamSnapshot;
    panes(): readonly TerminalPaneInfo[];
  };
  followers: DockerFollowers;
  editor: EditorHandlers;
  database: DatabaseHandlers;
  cluster: ClusterHandlers;
  chat: ChatHandlers;
  docker: DockerHandlers;
  // config.projects — membership checks only.
  projects: Record<string, unknown>;
  // For isDeclaredContainer.
  dockerConfig: DockerConfig;
  language: "ar" | "en";
  api: ApiHandlers;
  voices: {
    /** The installed system voices plus the Piper ones. Built in main.ts
     *  because which source to ask is a process.platform question. */
    list(): Promise<unknown>;
    /** Speaks a sample through the same engine the app uses. Built in
     *  main.ts because MacSpeech/PiperSpeech selection reads the platform. */
    preview(name: string, language: "ar" | "en"): void;
  };
  bookmarks: BookmarksHandlers;
  settings: SettingsHandlers;
  providers: { refreshCapacity(options: { force: boolean }): Promise<unknown> };
  // startVoice / stopVoice from main.ts — the one voice implementation the
  // hotkey and the mic button both drive.
  voiceControl: { start(): void; stop(): void };
  // For dialog:readJson (desktop-only by policy; its body still moves).
  readFile: (path: string) => Promise<string>;
  // For remote:readJsonUpload (M9 Task 3) — file-upload.ts's own store,
  // narrowed to the one method this channel needs. `deviceId` is always the
  // authenticated origin's, never a value from `args`.
  uploads: { readJson(deviceId: string, fileId: string): Promise<GitViewResult<unknown>> };
  // os.networkInterfaces, injected: reading the host belongs to main.ts, and
  // injected it makes remote:bindChoices a table test over a fake map.
  networkInterfaces: () => InterfaceMap;
  // remote-access.ts's createRemoteAccess() — the bridge lifecycle's own
  // controls, called only from this window's own ipcMain loop (every
  // remote:* channel below is desktop-only by policy).
  remote: RemoteControls;
  // remote-access.ts's own publishSidecar, bound — the only door a remote
  // origin's editor:open/database:open/cluster:open have onto the proxy.
  sidecars: SidecarPublisher;
  // notify.ts's own commandFinished — terminal:commandFinished's only
  // consumer. Narrowed to the one method this channel needs.
  notifier: Pick<Notifier, "commandFinished">;
  // tailscale-cert.ts's obtainCertificate, bound to main.ts's real
  // exec/fs/homedir/platform — the one call remote:tailscaleCert needs
  // before it writes anything.
  tailscaleCert: { obtain(): Promise<TailscaleCertResult> };
  // The same serialized writeConfig closure Settings' own save and
  // remote-idle.ts's onIdleDisabled use (main.ts) — never a second writer
  // to jarvis.yaml. remote:tailscaleCert uses the updater form so its
  // write is pinned to whatever `current.remote` already holds on disk,
  // the same discipline disableRemoteOnDisk follows.
  writeConfig(update: (current: JarvisConfig) => JarvisConfig): Promise<SettingsWriteResult>;
};

/** A terminal/session pty resize dimension: a plain positive integer, no
 *  larger than a real terminal could ever be. Rejects NaN, Infinity, a
 *  float, zero, a negative, and anything absurd (a phone or a compromised
 *  renderer asking for a 10,000-row pty). */
function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000;
}

/** turns:list returns at most this many, the most recent — same rationale
 *  as RECENT_TURNS_PER_DEVICE elsewhere: a phone reconnecting after a long
 *  gap gets a bounded catch-up, not the whole session's history. */
export const TURNS_LIST_MAX = 50;

export function createDispatchTable(deps: DispatchDeps): DispatchTable {
  const {
    setup,
    orchestrator,
    sessionStore,
    sessions,
    git,
    workspace,
    editor,
    database,
    cluster,
    chat,
    docker,
    api,
    terminal,
    bookmarks,
    settings,
  } = deps;
  return {
    "setup:check": () => setup.check(),
    "setup:install": ([id]) => setup.install(id),
    // Refuses anything that is not already the shape orchestrator.handle
    // wants (ruling 29): a phone speaks JSON over the wire, so `text` and
    // `language` are exactly as untrusted as any other remote argument, and
    // "close enough" (a number, a third locale) must never reach the brain.
    "input:send": async ([text, language], origin) => {
      if (typeof text !== "string" || (language !== "ar" && language !== "en")) return;
      // Ruling 5: a remote-origin turn never speaks on the laptop — the
      // same leak input:send had before muting was per-turn rather than a
      // global flag. The desktop path calls handle with exactly its
      // original two arguments, unchanged.
      if (origin.kind === "remote") {
        await orchestrator.handle(text, language, { speakAloud: false });
      } else {
        await orchestrator.handle(text, language);
      }
    },
    // Read-only recovery for a phone that missed a turn:new push while
    // disconnected (ruling 10). Ignores its args like sessions:list above;
    // the renderer never calls this — it already gets turn:new live.
    "turns:list": () => orchestrator.transcript().slice(-TURNS_LIST_MAX),
    // Pulled on demand when the renderer's history panel opens, not
    // pushed — there is no live subscriber to keep in sync for a past-
    // sessions view, only a snapshot to render once per open.
    "history:list": () => sessionStore.history(),
    // The live session list, pullable (M7 ruling 10): the same Session[]
    // "sessions:update" pushes. Ignores its args — no filtering, no
    // projection, no argument coercion, so nothing arrives that could name
    // a path. The renderer never calls this; it already gets the push.
    "sessions:list": () => sessions.list(),
    // Rate-limited like every other remote call by connection.ts's own
    // per-connection limiter — nothing extra here. Ignores its args, same
    // as sessions:list above.
    "sessions:refresh": () => deps.refreshSessions(),
    // The Session view's backlog. Like history:list this is pulled on
    // demand rather than pushed: everything printed *after* the view opens
    // arrives on the "session:output" channel instead. The renderer only
    // ever names a session id — it can never ask for output from a process
    // Jarvis did not itself start.
    "session:log": ([sessionId]) => (typeof sessionId === "string" ? sessions.log(sessionId) : ""),
    // Ruling 10's client rule (M7): subscribe to session:output first, then
    // call this. Same shape and empty-cursor default as terminal:snapshot,
    // below.
    "session:snapshot": ([sessionId]) =>
      typeof sessionId === "string" ? sessions.snapshot(sessionId) : { text: "", end: 0 },
    // The table receives args only, so there is no event to pass by
    // mistake — the bug ipc.test.ts used to grep for.
    "session:transcript": ([sessionId]) => deps.sessionTranscript(sessionId),
    "session:resume": ([sessionId, selectedProject]) =>
      deps.sessionResume(sessionId, selectedProject),
    // Keystrokes into a session's pty. Validated rather than trusted: the
    // renderer names a session id, never a process — the main process owns
    // that mapping, so a compromised renderer can only ever type into a
    // session Jarvis itself started.
    "session:input": ([sessionId, data]) => {
      if (typeof sessionId !== "string" || typeof data !== "string") return;
      sessions.write(sessionId, data);
    },
    // Where a spoken utterance goes. Normally the brain, which decides what
    // to do with it; but while a session's terminal is open, speaking is
    // meant to talk to THAT agent — the same thing as typing into it — so
    // the renderer names the session it is showing and the transcript is
    // typed there instead. Cleared (undefined) whenever the view is left.
    "voice:target": ([sessionId]) => {
      deps.voice.setTarget(typeof sessionId === "string" ? sessionId : undefined);
    },
    "session:resize": ([sessionId, cols, rows]) => {
      if (typeof sessionId !== "string") return;
      if (!isDimension(cols) || !isDimension(rows)) return;
      sessions.resize(sessionId, cols, rows);
    },
    "git:changes": ([sessionId]) => git.changes(sessionId as string),
    "git:diff": ([sessionId, path]) => git.fileDiff(sessionId as string, path as string),
    "git:setStaged": ([sessionId, path, staged]) =>
      git.setStaged(sessionId as string, path as string, staged as boolean),
    "git:commit": ([sessionId, message]) => git.commit(sessionId as string, message as string),
    // Every argument here crosses an untyped IPC boundary. workspace.open
    // and .navigate go into normalizeInput either way, but a non-string
    // still must not reach it as if it were one.
    "workspace:open": ([project, input, kind, detail]) => {
      if (typeof project !== "string" || typeof input !== "string") return;
      workspace.open(
        project,
        input,
        kind === "editor" || kind === "database" || kind === "cluster" ? kind : "web",
        typeof detail === "string" ? detail : undefined,
      );
    },
    "workspace:close": ([id]) => {
      if (typeof id !== "string") return;
      // A terminal tab's shell and a Docker tab's `docker logs -f` are both
      // child processes of their own; closing the tab has to reap them.
      // Either call on a tab that has neither is a no-op, so this needs no
      // test of the tab's kind. The renderer unfollows too when it notices
      // the tab go away, but a guarantee about a live child process must not
      // rest on the renderer alone. workspace:close is desktop-only by
      // policy (remote-policy.ts), so the owner is always the desktop's own
      // — never a phone's follower, which docker:unfollow reaps instead.
      deps.terminal.close(id);
      deps.followers.unfollow(id, DESKTOP_OWNER);
      workspace.close(id);
    },
    "workspace:activate": ([id]) => {
      if (typeof id === "string") workspace.activate(id);
    },
    "workspace:rename": ([id, title]) => {
      if (typeof id === "string" && typeof title === "string") workspace.rename(id, title);
    },
    "workspace:move": ([id, targetId, after]) => {
      if (typeof id === "string" && typeof targetId === "string" && typeof after === "boolean") {
        workspace.move(id, targetId, after);
      }
    },
    "workspace:navigate": ([id, input]) => {
      if (typeof id === "string" && typeof input === "string") workspace.navigate(id, input);
    },
    "workspace:back": ([id]) => {
      if (typeof id === "string") workspace.back(id);
    },
    "workspace:forward": ([id]) => {
      if (typeof id === "string") workspace.forward(id);
    },
    "workspace:reload": ([id]) => {
      if (typeof id === "string") workspace.reload(id);
    },
    "workspace:devtools": ([tabId, open]) => {
      if (typeof tabId !== "string" || typeof open !== "boolean") return;
      workspace.setDevTools(tabId, open);
    },
    "workspace:devtoolsDock": ([dock]) => {
      if (isDevToolsDock(dock)) workspace.setDevToolsDock(dock);
    },
    "workspace:visible": ([visible]) => workspace.setVisible(visible === true),
    "workspace:hideAll": () => workspace.hideAll(),
    "workspace:pip": ([tabId]) => {
      if (typeof tabId === "string") workspace.requestPictureInPicture(tabId);
    },
    "workspace:snapshot": () => workspace.state(),
    "terminal:panes": (args) => {
      if (args.length !== 1) return [];
      const [tabId] = args;
      if (typeof tabId !== "string") return [];
      const tab = workspace.state().tabs.find((candidate) => candidate.id === tabId);
      if (tab?.kind !== "terminal") return [];
      const splitPrefix = `${tabId}:`;
      return deps.shells
        .panes()
        .filter((pane) => pane.paneKey === tabId || pane.paneKey.startsWith(splitPrefix));
    },
    "editor:open": ([project, root], origin) => {
      const p = typeof project === "string" ? project : "";
      // Absent means the project directory itself; anything that is not a
      // string is not a root name and must not be treated as one.
      const r = typeof root === "string" ? root : undefined;
      if (origin.kind !== "remote") return editor.open(p, r);
      // Task 4 rule 2: a remote origin never sees the manager's own
      // loopback URL — only the `/s/<handle>/…` proxy URL deps.sidecars
      // publishes it under, or the reason the phone stays without one.
      return (async () => {
        const result = await editor.open(p, r);
        if (!result.ok) return result;
        const published = deps.sidecars.publish(origin.deviceId, {
          kind: "editor",
          url: result.value,
        });
        if (!published.ok) return sidecarPublishRefused(published.reason, deps.language);
        return { ok: true, value: published.url };
      })();
    },
    "editor:roots": ([project]) => editor.roots(typeof project === "string" ? project : ""),
    "database:open": ([project], origin) => {
      const p = typeof project === "string" ? project : "";
      if (origin.kind !== "remote") {
        // M4: the desktop-origin reply carries only the URL — no consumer
        // reads the DbGate login/password here; Electron's own `login`
        // event (dbgate-login.ts) answers the challenge instead.
        return (async () => {
          const result = await database.open(p);
          return result.ok ? { ok: true, value: { url: result.value.url } } : result;
        })();
      }
      // Task 4 rule 2: the phone gets only `{ url }` — never the DbGate
      // login/password the desktop path returns, which stays on the laptop
      // and is instead injected server-side as basic auth (ruling 3).
      return (async () => {
        const result = await database.open(p);
        if (!result.ok) return result;
        const published = deps.sidecars.publish(origin.deviceId, {
          kind: "database",
          url: result.value.url,
          basicAuth: { login: result.value.login, password: result.value.password },
        });
        if (!published.ok) return sidecarPublishRefused(published.reason, deps.language);
        return { ok: true, value: { url: published.url } };
      })();
    },
    "cluster:open": ([project, clusterName, background], origin) => {
      const p = typeof project === "string" ? project : "";
      const c = typeof clusterName === "string" ? clusterName : "";
      if (origin.kind !== "remote") {
        return cluster.open(p, c, {
          // Anything that is not the literal true is a click: the flag only
          // ever removes capability (no login terminal, no MFA push), so
          // the safe reading of a malformed one is the one that asks for
          // less.
          background: background === true,
        });
      }
      // Ruling 6: a remote origin always forces { background: true }, no
      // matter what the phone sent — cluster:open is remote-legal only
      // because a remote call can never start a login terminal or trigger
      // an MFA push on the laptop.
      return (async () => {
        const result = await cluster.open(p, c, { background: true });
        if (!result.ok) return result;
        const published = deps.sidecars.publish(origin.deviceId, {
          kind: "cluster",
          url: result.value,
        });
        if (!published.ok) return sidecarPublishRefused(published.reason, deps.language);
        return { ok: true, value: published.url };
      })();
    },
    "cluster:names": ([project]) => cluster.names(typeof project === "string" ? project : ""),
    "chat:open": ([project, name]) =>
      chat.open(typeof project === "string" ? project : "", typeof name === "string" ? name : ""),
    "chat:names": ([project]) => chat.names(typeof project === "string" ? project : ""),
    // Whether a project already has a Docker tab is the renderer's business,
    // exactly as it is for the API tab.
    "docker:open": ([project]) => {
      if (typeof project !== "string" || deps.projects[project] === undefined) {
        return {
          ok: false,
          text: MESSAGES.unknownProject(deps.language),
          language: deps.language,
        };
      }
      workspace.openDocker(project);
      return { ok: true, value: undefined };
    },
    "docker:names": ([project]) => docker.names(project as string),
    "docker:view": ([project]) => docker.view(project as string),
    "docker:containers": () => docker.containers(),
    "docker:start": ([project, container]) => docker.start(project as string, container as string),
    "docker:stop": ([project, container]) => docker.stop(project as string, container as string),
    "docker:restart": ([project, container]) =>
      docker.restart(project as string, container as string),
    "docker:composeUp": ([project]) => docker.composeUp(project as string),
    "docker:composeDown": ([project]) => docker.composeDown(project as string),
    "docker:shell": ([project, container]) => docker.shell(project as string, container as string),
    "docker:follow": ([tabId, project, container], origin) => {
      if (
        typeof tabId !== "string" ||
        typeof project !== "string" ||
        typeof container !== "string"
      ) {
        return {
          ok: false,
          text: MESSAGES.unknownProject(deps.language),
          language: deps.language,
        };
      }
      // The same check the Docker handlers apply — membership and name
      // grammar both, from the one shared helper — so `follow` is not the
      // one door into Docker that enforces a weaker rule than the rest.
      if (!isDeclaredContainer(deps.dockerConfig[project], container)) {
        return {
          ok: false,
          text: MESSAGES.dockerUnknownContainer(deps.language),
          language: deps.language,
        };
      }
      const owner = origin.kind === "remote" ? origin.deviceId : DESKTOP_OWNER;
      // A phone's own tab ids always look like `remote-<id>`; anything else
      // from a remote origin is not a tab that device could have opened.
      if (origin.kind === "remote" && !REMOTE_FOLLOW_TAB_PATTERN.test(tabId)) {
        return invalidArgument(deps.language);
      }
      const result = deps.followers.follow(tabId, container, owner);
      if (result === "owned-elsewhere") return invalidArgument(deps.language);
      if (result === "limit") {
        return {
          ok: false,
          text: MESSAGES.dockerFollowLimit(deps.language),
          language: deps.language,
        };
      }
      return { ok: true, value: undefined };
    },
    "docker:unfollow": ([tabId], origin) => {
      if (typeof tabId !== "string") return;
      deps.followers.unfollow(tabId, origin.kind === "remote" ? origin.deviceId : DESKTOP_OWNER);
    },
    // Opening the tab is main's job (only it holds the BrowserHost); deciding
    // whether one already exists is the renderer's, exactly as it is for the
    // Editor and Database buttons.
    "api:open": ([project]) => {
      if (typeof project !== "string" || deps.projects[project] === undefined) {
        return {
          ok: false,
          text: MESSAGES.unknownProject(deps.language),
          language: deps.language,
        };
      }
      workspace.openApi(project);
      return { ok: true, value: undefined };
    },
    "api:collections": ([project]) => api.collections(project as string),
    "api:tree": ([project, path]) => api.tree(project as string, path as string),
    "api:request": ([project, path]) => api.request(project as string, path as string),
    "api:save": ([project, path, json], origin) =>
      origin.kind === "remote"
        ? api.save(project as string, path as string, json as Record<string, unknown>, {
            deviceId: origin.deviceId,
          })
        : api.save(project as string, path as string, json as Record<string, unknown>),
    "api:send": ([project, request, variables], origin) =>
      origin.kind === "remote"
        ? api.send(
            project as string,
            request as Record<string, unknown>,
            variables as Record<string, string>,
            { deviceId: origin.deviceId },
          )
        : api.send(
            project as string,
            request as Record<string, unknown>,
            variables as Record<string, string>,
          ),
    // The sample is spoken through the same MacSpeech the app uses, so a
    // preview sounds exactly like the thing being chosen — including the
    // Enhanced upgrade, which is the whole point of listening first.
    "voice:list": () => deps.voices.list(),
    "voice:preview": ([name, language]) => {
      if (typeof name !== "string" || name.trim() === "") return;
      deps.voices.preview(name, language === "ar" ? "ar" : "en");
    },
    "api:history": ([p]) => api.history(p as string),
    "api:clearHistory": ([p]) => api.clearHistory(p as string),
    "api:cookies": ([p]) => api.cookies(p as string),
    "api:clearCookies": ([p]) => api.clearCookies(p as string),
    "api:removeCookie": ([p, n, d, path]) =>
      api.removeCookie(p as string, n as string, d as string, path as string),
    "api:settings": ([p]) => api.settings(p as string),
    "api:saveSettings": ([p, settings]) => api.saveSettings(p as string, settings as never),
    "dialog:readJson": async ([path]) => {
      if (typeof path !== "string") {
        return {
          ok: false,
          text: MESSAGES.invalidArgument(deps.language),
          language: deps.language,
        };
      }
      try {
        return { ok: true, value: JSON.parse(await deps.readFile(path)) };
      } catch (error) {
        return { ok: false, text: errorMessage(error), language: deps.language };
      }
    },
    // The phone's own path to "a JSON file the user picked" — decodes a
    // file this same device already staged with remote:uploadFile
    // (file-upload.ts owns the bounds: size, JSON depth/node count, no
    // dangerous key). Refuses a desktop origin outright: dispatch.ts's own
    // table is reachable from the renderer's ordinary ipcMain loop
    // regardless of CHANNEL_POLICY (that table only gates the remote
    // bridge), so this channel must reject non-remote origins itself rather
    // than rely on policy alone — and the owner is always the authenticated
    // Origin's own deviceId, never a value from `args`.
    "remote:readJsonUpload": ([fileId], origin) => {
      if (origin.kind !== "remote" || typeof fileId !== "string" || !isFileId(fileId)) {
        return invalidArgument(deps.language);
      }
      return deps.uploads.readJson(origin.deviceId, fileId);
    },
    "api:curl": ([p, request, variables]) =>
      api.curl(
        p as string,
        request as Record<string, unknown>,
        variables as Record<string, string>,
      ),
    "api:createRequest": ([p, folder, name, seq]) =>
      api.createRequest(p as string, folder as string, name as string, seq as number),
    "api:createFolder": ([p, parent, name]) =>
      api.createFolder(p as string, parent as string, name as string),
    "api:rename": ([p, path, name, folder]) =>
      api.renameEntry(p as string, path as string, name as string, folder === true),
    "api:delete": ([p, path]) => api.deleteEntry(p as string, path as string),
    "api:createCollection": ([p, name]) => api.createCollection(p as string, name as string),
    "api:saveEnvironment": ([p, path, name, vars]) =>
      api.saveEnvironment(p as string, path as string, name as string, vars as never[]),
    // `remote` (M9 Task 3) gates the bounded-import guard — see ipc.ts's
    // importPostman for what it does with it — and comes only from the
    // authenticated Origin, never anything in `args`.
    "api:importPostman": ([p, name, collection], origin) =>
      api.importPostman(p as string, name as string, collection, origin.kind === "remote"),
    // Remote (remote-policy.ts): a phone may open a new terminal tab, but
    // only in a project this laptop actually declared — `directory` (the
    // session-resume override) is a desktop-only concern, so a remote call
    // is refused unless it sent exactly the one argument, membership-checked
    // the same way docker:open/api:open check `deps.projects`. A desktop
    // origin is unchanged: any non-string project still coerces to "".
    "terminal:open": (args, origin) => {
      const [project] = args;
      if (origin.kind === "remote") {
        if (
          args.length !== 1 ||
          typeof project !== "string" ||
          deps.projects[project] === undefined
        ) {
          return {
            ok: false,
            text: MESSAGES.unknownProject(deps.language),
            language: deps.language,
          };
        }
        return terminal.open(project);
      }
      return terminal.open(typeof project === "string" ? project : "");
    },
    // The renderer's xterm for this tab is ready: hand over what the shell has
    // printed so far. Streaming is already wired at composition time, so this
    // subscribes nothing and may be called again for a second viewer.
    "terminal:attach": ([paneKey]) => (typeof paneKey === "string" ? deps.shells.log(paneKey) : ""),
    // Ruling 10's client rule (M7): subscribe to terminal:data first, then
    // call this — `text` is `terminal:attach`'s own backlog, `end` is the
    // true UTF-16 count emitted so far, which a client uses to drop any
    // push it already covers. An unknown/non-string pane answers the same
    // empty cursor ShellManager.snapshot returns for one it has never seen.
    "terminal:snapshot": ([paneKey]) =>
      typeof paneKey === "string" ? deps.shells.snapshot(paneKey) : { text: "", end: 0 },
    // A tab's second (and third…) shell, and the one kill that is not the
    // tab's own — see TerminalHandlers.split/closePane.
    "terminal:split": ([tabId, paneId]) => {
      terminal.split(tabId as string, paneId as string);
    },
    "terminal:closePane": ([paneKey]) => {
      terminal.closePane(paneKey as string);
    },
    "terminal:suggest": ([paneKey, input, path], origin) =>
      terminal.suggest(
        paneKey as string,
        input as string,
        path as string | undefined,
        origin.kind === "remote",
      ),
    "terminal:history": ([paneKey, limit]) => terminal.history(paneKey as string, limit as number),
    "terminal:listDir": ([paneKey, path]) => terminal.listDir(paneKey as string, path as string),
    "terminal:openFile": ([paneKey, path]) => terminal.openFile(paneKey as string, path as string),
    "terminal:input": ([tabId, data]) => {
      terminal.input(tabId as string, data as string);
    },
    "terminal:resize": ([tabId, cols, rows]) => {
      if (typeof tabId !== "string") return;
      if (!isDimension(cols) || !isDimension(rows)) return;
      terminal.resize(tabId, cols, rows);
    },
    "terminal:settings": () => terminal.settings(),
    "terminal:workflows": ([project]) =>
      terminal.workflows(typeof project === "string" ? project : ""),
    "terminal:ai": ([kind, text]) =>
      terminal.terminalAi(kind as "generate" | "explain", text as string),
    "terminal:chips": ([paneKey, path]) =>
      // `path` is the renderer's live OSC 7 directory, passed through
      // untyped exactly like every other argument on this boundary —
      // chips() decides what to believe about it (see liveCwd).
      terminal.chips(paneKey as string, path as string | undefined),
    "bookmarks:list": ([project]) => bookmarks.list(typeof project === "string" ? project : ""),
    "bookmarks:add": ([project, bookmark]) =>
      bookmarks.add(typeof project === "string" ? project : "", bookmark as never),
    "bookmarks:remove": ([project, url]) =>
      bookmarks.remove(
        typeof project === "string" ? project : "",
        typeof url === "string" ? url : "",
      ),
    "bookmarks:setPinned": ([project, url, pinned]) =>
      bookmarks.setPinned(project as string, url as string, pinned as boolean),
    "bookmarks:rename": ([project, url, title]) =>
      bookmarks.rename(project as string, url as string, title as string),
    "bookmarks:reorder": ([project, urls]) =>
      bookmarks.reorder(project as string, urls as string[]),
    "settings:read": () => settings.read(),
    // A phone can propose the rest of jarvis.yaml, but never its own bridge
    // configuration — a paired device deciding remote.enabled or its own
    // idle timeout is the bridge granting itself more access than the
    // laptop chose (ruling 28). So a remote-origin object draft has its
    // `remote` key overwritten with whatever is on disk right now before
    // the save, and only that key; every other origin/shape passes through
    // exactly as it always has, including the desktop path, which must
    // never call settings.read() (see settings:read for that path). If the
    // read itself rejects, the save never runs — failing the same way a
    // failed save already does today, rather than proceeding on stale trust.
    "settings:save": async ([draft], origin) => {
      if (origin.kind === "remote" && typeof draft === "object" && draft !== null) {
        const current = await settings.read();
        return settings.save({ ...draft, remote: current.remote });
      }
      return settings.save(draft);
    },
    "settings:testAgent": ([agent]) => settings.testAgent(agent),
    "settings:restart": () => settings.restart(),
    "projects:list": () => Object.keys(deps.projects),
    // Settings' address picker. Takes no arguments, so there is nothing to
    // coerce; the policy, not this body, is what keeps a phone out.
    "remote:bindChoices": () => bindChoices(deps.networkInterfaces()),
    "remote:status": () => deps.remote.status(),
    "remote:pair": async () => {
      const result = await deps.remote.openPairing();
      if (result === "opened") return { ok: true, value: undefined };
      if (result === "disabled") {
        return {
          ok: false,
          text: MESSAGES.remotePairingDisabled(deps.language),
          language: deps.language,
        };
      }
      return {
        ok: false,
        text: MESSAGES.remotePairingUnavailable(deps.language),
        language: deps.language,
      };
    },
    "remote:cancelPair": () => deps.remote.cancelPairing(),
    // Ignored unless both arguments are already the shape the confirmation
    // dialog can only ever produce — a phone cannot reach this channel at
    // all (desktop-only), but the coercion stays exactly as strict as every
    // other boundary here.
    "remote:decidePair": ([requestId, approve]) => {
      if (typeof requestId !== "string" || typeof approve !== "boolean") return;
      deps.remote.decidePairing(requestId, approve);
    },
    "remote:revoke": async ([deviceId]) => {
      if (typeof deviceId !== "string") return invalidArgument(deps.language);
      const ok = await deps.remote.revoke(deviceId);
      if (!ok) {
        return {
          ok: false,
          text: MESSAGES.remoteRevokeFailed(deps.language),
          language: deps.language,
        };
      }
      return { ok: true, value: undefined };
    },
    // M10 Task 4: a phone's own Expo push registration. Remote only
    // (remote-policy.ts) — a desktop origin is refused outright, belt and
    // braces, and never touches the store either way.
    "remote:registerPush": ([registration], origin) => {
      if (origin.kind !== "remote") {
        return {
          registered: false as const,
          text: MESSAGES.invalidArgument(deps.language),
          language: deps.language,
        };
      }
      const parsed = parsePushRegistration(registration);
      if (parsed === undefined) {
        return {
          registered: false as const,
          text: MESSAGES.pushRegisterInvalid(deps.language),
          language: deps.language,
        };
      }
      // The authenticated origin's own deviceId — never anything the
      // registration object itself carries (a `deviceId` key on it, if a
      // phone sent one, is dropped by parsePushRegistration already).
      return deps.remote.registerPush(origin.deviceId, parsed);
    },
    "remote:unregisterPush": (_args, origin) => {
      if (origin.kind !== "remote") return undefined;
      return deps.remote.unregisterPush(origin.deviceId);
    },
    // Desktop-only (remote-policy.ts); refused again here, belt and braces.
    // Carries no command text — only the duration and exit status the
    // renderer's own pane already decided crossed its notifyAfterSeconds
    // threshold.
    "terminal:commandFinished": ([paneKey, seconds, ok], origin) => {
      if (origin.kind === "remote") return undefined;
      if (
        !isSubscriptionKey(paneKey) ||
        typeof seconds !== "number" ||
        !Number.isInteger(seconds) ||
        seconds < 0 ||
        seconds > 86_400 ||
        typeof ok !== "boolean"
      ) {
        return undefined;
      }
      deps.notifier.commandFinished(paneKey, seconds, ok);
    },
    // The only user-triggered call in the app that spends money: one billed
    // query per readable account. `force: true` (the desktop button)
    // deliberately *bypasses* ProviderMonitor's own minimum interval — that
    // is what "Refresh now" means — coalescing (Task 8) with another
    // in-flight forced call is the only throttle left in effect there. A
    // remote origin (I5) gets `force: false` instead: a phone gets whatever
    // the monitor's own minimum-interval throttle already governs, the
    // same as an unforced desktop refresh, rather than a bypass a phone
    // could hold down to run up a bill unattended. A direct forward either
    // way — no wrapping try/catch, no re-implemented throttle or dedup —
    // so this handler never rejects on a normal per-account failure.
    "providers:refresh": (_args, origin) =>
      deps.providers.refreshCapacity({ force: origin.kind !== "remote" }),
    // M-b: the renderer's mic button drives the exact same start/stop path
    // as the global hotkey, so voice has one implementation no matter which
    // control triggers it — never a second, unwired-looking "click to talk"
    // affordance beside the real hotkey-driven one.
    "voice:start": () => deps.voiceControl.start(),
    "voice:stop": () => deps.voiceControl.stop(),
    // Desktop-only (remote-policy.ts). One call gets the certificate
    // (findTailscaleCli → tailnetName → issueCertificate, composed in
    // tailscale-cert.ts's obtainCertificate); on success this then writes
    // remote.tls.certPath/keyPath and remote.sidecarProxy: true through
    // the same serialized writeConfig queue Settings' own save uses,
    // pinned to whatever else is already on disk. A failed write is
    // reported the same shape as any other failure (`kind: "failed"`) —
    // the certificate itself was still obtained, but nothing is served
    // from it until a save succeeds, and Settings has no separate "cert
    // issued but not saved" state to show.
    "remote:tailscaleCert": async () => {
      const result = await deps.tailscaleCert.obtain();
      if (!result.ok) return result;
      const write = await deps.writeConfig((current) => ({
        ...current,
        remote: {
          ...current.remote,
          sidecarProxy: true,
          tls: { certPath: result.certPath, keyPath: result.keyPath },
        },
      }));
      if (!write.ok) {
        return { ok: false as const, kind: "failed" as const, detail: write.detail };
      }
      return result;
    },
  } satisfies Record<TableChannel, Handler>;
}
