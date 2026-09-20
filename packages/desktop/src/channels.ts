import type { RemoteStatus } from "@jarvis/remote";
import type { DevToolsDock } from "./browser-host.js";
import type { IpcChannels, RendererApi } from "./ipc.js";

/**
 * Every channel main pushes to the renderer.
 *
 * `IpcChannels` covers the thirteen that go through the interval wiring.
 * These five are outside it and were never in it, which is exactly the kind
 * of gap that lets a channel be forgotten when a second client is added —
 * so the broadcaster's type is an intersection (`&`) of both: the two sides
 * declare disjoint keys, so this merges them into one type with all 18. Four
 * of the five are sent directly from main.ts; the fifth, "remote:update", is
 * sent from remote-access.ts's `onStatus` instead (main.ts only builds and
 * starts the `RemoteAccess` that sends it). If a key were ever declared on
 * both sides with different payload types, that key would silently collapse
 * to `never` here, and the failure would surface confusingly at a
 * `send`/`local` call site rather than at this definition.
 *
 * Lives here, not in broadcast.ts, so `PayloadOf` below can be built on it
 * directly rather than on `IpcChannels` alone — the five channels outside
 * the interval wiring deserve real adapter types too.
 */
export type PushChannels = IpcChannels & {
  "setup:output": string;
  "docker:log": { tabId: string; chunk: string };
  "workspace:devtoolsDockChosen": DevToolsDock;
  "workspace:devtoolsClosed": string;
  // remote-access.ts's `onStatus` — always local to this window (ruling 36).
  // A paired phone never receives this: the wire protocol
  // (packages/remote/src/protocol.ts's ServerMessage) has no message that
  // carries a RemoteStatus, and REMOTE_PUSH_POLICY (remote-push-policy.ts)
  // classifies this channel "desktop-only", so it never reaches
  // remotePushPolicies() for a phone to subscribe to in the first place.
  "remote:update": RemoteStatus;
};

/**
 * Every RendererApi member that is a request: a method returning a Promise,
 * excluding the `on*` listeners. Derived from the interface rather than
 * listed, so the `satisfies` below can hold the table to it.
 */
export type InvokeKey = {
  [K in keyof RendererApi]: RendererApi[K] extends (...args: never[]) => Promise<unknown>
    ? K extends `on${string}`
      ? never
      : K
    : never;
}[keyof RendererApi];

/** Every RendererApi member that registers a push listener. */
export type PushKey = Extract<keyof RendererApi, `on${string}`>;

/** Every channel string a request can name — the values of INVOKE_CHANNELS.
 *  The dispatch table and the remote policy are both keyed by this, so a
 *  channel added to the table without a policy entry (or the reverse) is a
 *  tsc error, not a runtime surprise. */
export type InvokeChannel = (typeof INVOKE_CHANNELS)[InvokeKey];

/**
 * Method → channel, for every request. `satisfies` is what makes this the
 * single source of truth: `tsc` fails if a method is added to RendererApi
 * without a channel here, and fails if a channel is invented for a method
 * that does not exist. Neither a codegen step nor a runtime check could give
 * that, and this workspace has no bundler to run one in.
 */
export const INVOKE_CHANNELS = {
  checkPrerequisites: "setup:check",
  installPrerequisite: "setup:install",
  send: "input:send",
  // Read-only recovery for a phone that missed a turn:new push while
  // disconnected (M8 ruling 10). Not called by the renderer — it already
  // gets turn:new live — kept here so the channel exists to be reached at
  // all.
  listTurns: "turns:list",
  startVoice: "voice:start",
  stopVoice: "voice:stop",
  getHistory: "history:list",
  listSessions: "sessions:list",
  // A phone or the desktop's own Refresh button asking for a fresh look at
  // the machine, not just Jarvis's own state: re-imports any new
  // transcripts and re-scans the process table for agents running outside
  // Jarvis (process-scan.ts). Resolves once both have run and
  // "sessions:update" has already gone out with the merged result.
  refreshSessions: "sessions:refresh",
  gitChanges: "git:changes",
  gitDiff: "git:diff",
  gitSetStaged: "git:setStaged",
  gitCommit: "git:commit",
  getSessionLog: "session:log",
  sessionSnapshot: "session:snapshot",
  getSessionTranscript: "session:transcript",
  resumeSession: "session:resume",
  sendSessionInput: "session:input",
  resizeSession: "session:resize",
  setVoiceTarget: "voice:target",
  refreshProviders: "providers:refresh",
  openTab: "workspace:open",
  closeTab: "workspace:close",
  activateTab: "workspace:activate",
  renameTab: "workspace:rename",
  moveTab: "workspace:move",
  navigateTab: "workspace:navigate",
  tabBack: "workspace:back",
  tabForward: "workspace:forward",
  tabReload: "workspace:reload",
  setWorkspaceBounds: "workspace:bounds",
  setDevTools: "workspace:devtools",
  setDevToolsBounds: "workspace:devtoolsBounds",
  setDevToolsDock: "workspace:devtoolsDock",
  showDevToolsDockMenu: "workspace:devtoolsDockMenu",
  setWorkspaceVisible: "workspace:visible",
  hideAllTabs: "workspace:hideAll",
  requestPictureInPicture: "workspace:pip",
  workspaceSnapshot: "workspace:snapshot",
  terminalPanes: "terminal:panes",
  openEditor: "editor:open",
  editorRoots: "editor:roots",
  openDatabase: "database:open",
  openCluster: "cluster:open",
  clusterNames: "cluster:names",
  openChat: "chat:open",
  chatNames: "chat:names",
  openTerminal: "terminal:open",
  suggestCompletions: "terminal:suggest",
  terminalHistory: "terminal:history",
  listTerminalDir: "terminal:listDir",
  openTerminalFile: "terminal:openFile",
  terminalSettings: "terminal:settings",
  terminalWorkflows: "terminal:workflows",
  terminalAi: "terminal:ai",
  terminalChips: "terminal:chips",
  attachTerminal: "terminal:attach",
  terminalSnapshot: "terminal:snapshot",
  sendTerminalInput: "terminal:input",
  resizeTerminal: "terminal:resize",
  splitTerminal: "terminal:split",
  closeTerminalPane: "terminal:closePane",
  // M10 Task 4: a slow block's own duration/exit code, reported so the
  // laptop can decide whether to push — never the command itself.
  reportCommandFinished: "terminal:commandFinished",
  openDockerTab: "docker:open",
  dockerNames: "docker:names",
  dockerView: "docker:view",
  dockerContainers: "docker:containers",
  dockerStart: "docker:start",
  dockerStop: "docker:stop",
  dockerRestart: "docker:restart",
  dockerComposeUp: "docker:composeUp",
  dockerComposeDown: "docker:composeDown",
  dockerShell: "docker:shell",
  dockerFollow: "docker:follow",
  dockerUnfollow: "docker:unfollow",
  openApiTab: "api:open",
  listApiCollections: "api:collections",
  readApiTree: "api:tree",
  readApiRequest: "api:request",
  saveApiRequest: "api:save",
  sendApiRequest: "api:send",
  apiCurl: "api:curl",
  apiHistory: "api:history",
  clearApiHistory: "api:clearHistory",
  apiCookies: "api:cookies",
  clearApiCookies: "api:clearCookies",
  removeApiCookie: "api:removeCookie",
  apiSettings: "api:settings",
  saveApiSettings: "api:saveSettings",
  createApiRequest: "api:createRequest",
  createApiFolder: "api:createFolder",
  renameApiEntry: "api:rename",
  deleteApiEntry: "api:delete",
  createApiCollection: "api:createCollection",
  saveApiEnvironment: "api:saveEnvironment",
  importPostmanCollection: "api:importPostman",
  listVoices: "voice:list",
  previewVoice: "voice:preview",
  pickFiles: "dialog:pickFiles",
  readJsonFile: "dialog:readJson",
  readJsonUpload: "remote:readJsonUpload",
  listBookmarks: "bookmarks:list",
  addBookmark: "bookmarks:add",
  removeBookmark: "bookmarks:remove",
  setBookmarkPinned: "bookmarks:setPinned",
  renameBookmark: "bookmarks:rename",
  reorderBookmarks: "bookmarks:reorder",
  getSettings: "settings:read",
  saveSettings: "settings:save",
  testAgent: "settings:testAgent",
  restartApp: "settings:restart",
  getProjects: "projects:list",
  remoteBindChoices: "remote:bindChoices",
  remoteStatus: "remote:status",
  openRemotePairing: "remote:pair",
  cancelRemotePairing: "remote:cancelPair",
  decideRemotePairing: "remote:decidePair",
  revokeRemoteDevice: "remote:revoke",
  // M10 Task 4: a phone's own Expo push registration — acts only on the
  // authenticated device, never a device id in the arguments.
  registerPush: "remote:registerPush",
  unregisterPush: "remote:unregisterPush",
  // Desktop-only: finds Tailscale, reads this machine's own MagicDNS name,
  // and runs `tailscale cert` for it — then writes remote.tls.certPath/
  // keyPath and turns remote.sidecarProxy on, through the same serialized
  // writeConfig queue Settings' own save uses. See tailscale-cert.ts.
  tailscaleCert: "remote:tailscaleCert",
} as const satisfies Record<InvokeKey, string>;

/** Method → channel, for every push. */
export const PUSH_CHANNELS = {
  onInstallOutput: "setup:output",
  onMetrics: "metrics:update",
  onSessions: "sessions:update",
  onTurn: "turn:new",
  onSpeaking: "voice:speaking",
  onListening: "voice:listening",
  onVoiceHotkeys: "voice:hotkeys",
  onNotice: "voice:notice",
  onChangeCounts: "git:counts",
  onSessionOutput: "session:output",
  onProviders: "providers:update",
  onWorkspace: "workspace:update",
  onDevToolsDockChosen: "workspace:devtoolsDockChosen",
  onDevToolsClosed: "workspace:devtoolsClosed",
  onTerminalData: "terminal:data",
  onTerminalExit: "terminal:exit",
  onDockerLog: "docker:log",
  onRemoteStatus: "remote:update",
} as const satisfies Record<PushKey, string>;

/**
 * Map a push method key to its channel string, then to the payload type that
 * channel sends. Derived rather than restated so an adapter cannot be
 * annotated with a payload shape its channel never sends — `(payload: never)`
 * could not express that, because parameter contravariance makes every
 * one-argument function assignable to it.
 *
 * Built on `PushChannels`, not `IpcChannels`: every channel `PUSH_CHANNELS`
 * names is one of `PushChannels`'s 18 keys (the assertion below is what
 * guarantees that at compile time), so every one of these 18 adapters gets a
 * real payload type — none of them needs to fall back to `unknown`.
 */
type ChannelOf<K extends PushKey> = (typeof PUSH_CHANNELS)[K];
type PayloadOf<K extends PushKey> =
  ChannelOf<K> extends keyof PushChannels ? PushChannels[ChannelOf<K>] : never;

/**
 * Compile-time proof that `PUSH_CHANNELS`'s values and `PushChannels`'s keys
 * are the same 18 strings, checked in both directions: a channel added to
 * one but not the other fails `tsc` right here rather than surfacing later
 * as a stray `unknown` in `PayloadOf`, or worse, silently at a call site.
 * `AssertTrue<false>` is a type error ("does not satisfy the constraint
 * 'true'"), which is what turns a mismatch into a build failure; the two
 * aliases are exported so `tsc` cannot call them unused and skip evaluating
 * them.
 */
type AssertTrue<T extends true> = T;
type PushChannelValue = (typeof PUSH_CHANNELS)[PushKey];
export type EveryPushChannelHasAPayloadType = AssertTrue<
  PushChannelValue extends keyof PushChannels ? true : false
>;
export type EveryPushChannelsKeyIsSent = AssertTrue<
  keyof PushChannels extends PushChannelValue ? true : false
>;

/**
 * The two listeners whose callback takes two arguments rather than the
 * payload itself. Every other push passes its payload straight through, so
 * the generic loop in preload needs to know only about these. The mapped type
 * ensures each adapter's parameter type matches its channel's actual payload,
 * catching annotation errors at compile time.
 */
// `satisfies`, not `:`, so the inferred type keeps exactly these two keys
// rather than widening to all of PushKey as optional — preload.cts's own
// copy of these two adapters checks its key set against `keyof typeof
// PUSH_ADAPTERS`, and that check is only meaningful if this stays narrow.
export const PUSH_ADAPTERS = {
  onTerminalData: (payload) => [payload.paneKey, payload.chunk],
  onTerminalExit: (payload) => [payload.paneKey, payload.code],
} satisfies { [K in PushKey]?: (payload: PayloadOf<K>) => unknown[] };

/**
 * The argv flag main.ts hands the channel table to preload on. A sandboxed
 * preload (see main.ts's BrowserWindow) can only `require` Electron's own
 * built-ins, never `require("./channels.js")`, so the table has to arrive
 * some other way. preload.cts keeps its own copy of this exact string —
 * it can only `import type` from this file, so it cannot read the constant
 * back from here at runtime.
 */
export const CHANNELS_ARG_PREFIX = "--jarvis-channels=";

/**
 * The `additionalArguments` entries carrying INVOKE_CHANNELS and
 * PUSH_CHANNELS to preload, JSON-encoded as one argv string — the same path
 * `--jarvis-first-run` already uses, since the renderer needs both while it
 * is deciding what to draw, before any round trip could answer. A pure,
 * Electron-free function so main.ts's window construction stays testable
 * without a BrowserWindow.
 */
export function preloadChannelArgs(): string[] {
  return [
    `${CHANNELS_ARG_PREFIX}${JSON.stringify({ invoke: INVOKE_CHANNELS, push: PUSH_CHANNELS })}`,
  ];
}
