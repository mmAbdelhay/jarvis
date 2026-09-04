import { contextBridge, ipcRenderer } from "electron";
import type { RendererApi } from "./ipc.js";

const api: RendererApi = {
  send: (text, language) => ipcRenderer.invoke("input:send", text, language),
  startVoice: () => ipcRenderer.invoke("voice:start"),
  stopVoice: () => ipcRenderer.invoke("voice:stop"),
  onMetrics: (cb) => {
    ipcRenderer.on("metrics:update", (_e, m) => cb(m));
  },
  onSessions: (cb) => {
    ipcRenderer.on("sessions:update", (_e, s) => cb(s));
  },
  onTurn: (cb) => {
    ipcRenderer.on("turn:new", (_e, t) => cb(t));
  },
  onSpeaking: (cb) => {
    ipcRenderer.on("voice:speaking", (_e, speaking) => cb(speaking));
  },
  onListening: (cb) => {
    ipcRenderer.on("voice:listening", (_e, listening) => cb(listening));
  },
  onNotice: (cb) => {
    ipcRenderer.on("voice:notice", (_e, notice) => cb(notice));
  },
  getHistory: () => ipcRenderer.invoke("history:list"),
  gitChanges: (sessionId) => ipcRenderer.invoke("git:changes", sessionId),
  gitDiff: (sessionId, path) => ipcRenderer.invoke("git:diff", sessionId, path),
  gitSetStaged: (sessionId, path, staged) =>
    ipcRenderer.invoke("git:setStaged", sessionId, path, staged),
  gitCommit: (sessionId, message) => ipcRenderer.invoke("git:commit", sessionId, message),
  onChangeCounts: (cb) => {
    ipcRenderer.on("git:counts", (_e, changes) => cb(changes));
  },
  onSessionOutput: (cb) => {
    ipcRenderer.on("session:output", (_e, output) => cb(output));
  },
  getSessionLog: (sessionId) => ipcRenderer.invoke("session:log", sessionId),
  sendSessionInput: (sessionId, data) => ipcRenderer.invoke("session:input", sessionId, data),
  resizeSession: (sessionId, cols, rows) =>
    ipcRenderer.invoke("session:resize", sessionId, cols, rows),
  setVoiceTarget: (sessionId) => ipcRenderer.invoke("voice:target", sessionId),
  onProviders: (cb) => {
    ipcRenderer.on("providers:update", (_e, statuses) => cb(statuses));
  },
  refreshProviders: () => ipcRenderer.invoke("providers:refresh"),
  openTab: (project, input, kind, detail) =>
    ipcRenderer.invoke("workspace:open", project, input, kind, detail),
  closeTab: (id) => ipcRenderer.invoke("workspace:close", id),
  activateTab: (id) => ipcRenderer.invoke("workspace:activate", id),
  navigateTab: (id, input) => ipcRenderer.invoke("workspace:navigate", id, input),
  tabBack: (id) => ipcRenderer.invoke("workspace:back", id),
  tabForward: (id) => ipcRenderer.invoke("workspace:forward", id),
  tabReload: (id) => ipcRenderer.invoke("workspace:reload", id),
  setWorkspaceBounds: (bounds) => ipcRenderer.invoke("workspace:bounds", bounds),
  setDevTools: (tabId, open) => ipcRenderer.invoke("workspace:devtools", tabId, open),
  setDevToolsBounds: (bounds) => ipcRenderer.invoke("workspace:devtoolsBounds", bounds),
  setWorkspaceVisible: (visible) => ipcRenderer.invoke("workspace:visible", visible),
  hideAllTabs: () => ipcRenderer.invoke("workspace:hideAll"),
  requestPictureInPicture: (tabId) => ipcRenderer.invoke("workspace:pip", tabId),
  onWorkspace: (cb) => {
    ipcRenderer.on("workspace:update", (_e, state) => cb(state));
  },
  openEditor: (project, root) => ipcRenderer.invoke("editor:open", project, root),
  editorRoots: (project) => ipcRenderer.invoke("editor:roots", project),
  openDatabase: (project) => ipcRenderer.invoke("database:open", project),
  openCluster: (project, cluster, background) =>
    ipcRenderer.invoke("cluster:open", project, cluster, background),
  clusterNames: (project) => ipcRenderer.invoke("cluster:names", project),
  openChat: (project, name) => ipcRenderer.invoke("chat:open", project, name),
  chatNames: (project) => ipcRenderer.invoke("chat:names", project),
  openTerminal: (project) => ipcRenderer.invoke("terminal:open", project),
  suggestCompletions: (tabId, input) => ipcRenderer.invoke("terminal:suggest", tabId, input),
  terminalHistory: (paneKey, limit) => ipcRenderer.invoke("terminal:history", paneKey, limit),
  listTerminalDir: (paneKey, path) => ipcRenderer.invoke("terminal:listDir", paneKey, path),
  openTerminalFile: (paneKey, path) => ipcRenderer.invoke("terminal:openFile", paneKey, path),
  terminalSettings: () => ipcRenderer.invoke("terminal:settings"),
  terminalWorkflows: (project) => ipcRenderer.invoke("terminal:workflows", project),
  terminalAi: (kind, text) => ipcRenderer.invoke("terminal:ai", kind, text),
  terminalChips: (paneKey) => ipcRenderer.invoke("terminal:chips", paneKey),
  openDockerTab: (project) => ipcRenderer.invoke("docker:open", project),
  dockerNames: (project) => ipcRenderer.invoke("docker:names", project),
  dockerView: (project) => ipcRenderer.invoke("docker:view", project),
  dockerContainers: () => ipcRenderer.invoke("docker:containers"),
  dockerStart: (project, container) => ipcRenderer.invoke("docker:start", project, container),
  dockerStop: (project, container) => ipcRenderer.invoke("docker:stop", project, container),
  dockerRestart: (project, container) => ipcRenderer.invoke("docker:restart", project, container),
  dockerComposeUp: (project) => ipcRenderer.invoke("docker:composeUp", project),
  dockerComposeDown: (project) => ipcRenderer.invoke("docker:composeDown", project),
  dockerShell: (project, container) => ipcRenderer.invoke("docker:shell", project, container),
  dockerFollow: (tabId, project, container) =>
    ipcRenderer.invoke("docker:follow", tabId, project, container),
  dockerUnfollow: (tabId) => ipcRenderer.invoke("docker:unfollow", tabId),
  onDockerLog: (cb) => {
    ipcRenderer.on("docker:log", (_e, payload) => cb(payload));
  },
  openApiTab: (project) => ipcRenderer.invoke("api:open", project),
  listApiCollections: (project) => ipcRenderer.invoke("api:collections", project),
  readApiTree: (project, path) => ipcRenderer.invoke("api:tree", project, path),
  readApiRequest: (project, path) => ipcRenderer.invoke("api:request", project, path),
  saveApiRequest: (project, path, json) => ipcRenderer.invoke("api:save", project, path, json),
  sendApiRequest: (project, request, variables) =>
    ipcRenderer.invoke("api:send", project, request, variables),
  apiCurl: (project, request, variables) => ipcRenderer.invoke("api:curl", project, request, variables),
  apiHistory: (project) => ipcRenderer.invoke("api:history", project),
  clearApiHistory: (project) => ipcRenderer.invoke("api:clearHistory", project),
  apiCookies: (project) => ipcRenderer.invoke("api:cookies", project),
  clearApiCookies: (project) => ipcRenderer.invoke("api:clearCookies", project),
  removeApiCookie: (project, name, domain, path) =>
    ipcRenderer.invoke("api:removeCookie", project, name, domain, path),
  apiSettings: (project) => ipcRenderer.invoke("api:settings", project),
  saveApiSettings: (project, settings) => ipcRenderer.invoke("api:saveSettings", project, settings),
  listVoices: () => ipcRenderer.invoke("voice:list"),
  previewVoice: (name, language) => ipcRenderer.invoke("voice:preview", name, language),
  pickFiles: (options) => ipcRenderer.invoke("dialog:pickFiles", options),
  readJsonFile: (path) => ipcRenderer.invoke("dialog:readJson", path),
  createApiRequest: (project, folderPath, name, seq) =>
    ipcRenderer.invoke("api:createRequest", project, folderPath, name, seq),
  createApiFolder: (project, parentPath, name) =>
    ipcRenderer.invoke("api:createFolder", project, parentPath, name),
  renameApiEntry: (project, path, name, isFolder) =>
    ipcRenderer.invoke("api:rename", project, path, name, isFolder),
  deleteApiEntry: (project, path) => ipcRenderer.invoke("api:delete", project, path),
  createApiCollection: (project, name) => ipcRenderer.invoke("api:createCollection", project, name),
  saveApiEnvironment: (project, collectionPath, name, variables) =>
    ipcRenderer.invoke("api:saveEnvironment", project, collectionPath, name, variables),
  importPostmanCollection: (project, name, collection) =>
    ipcRenderer.invoke("api:importPostman", project, name, collection),
  attachTerminal: (paneKey) => ipcRenderer.invoke("terminal:attach", paneKey),
  sendTerminalInput: (paneKey, data) => ipcRenderer.invoke("terminal:input", paneKey, data),
  resizeTerminal: (paneKey, cols, rows) => ipcRenderer.invoke("terminal:resize", paneKey, cols, rows),
  onTerminalData: (cb) => {
    ipcRenderer.on("terminal:data", (_e, payload) => cb(payload.paneKey, payload.chunk));
  },
  onTerminalExit: (cb) => {
    ipcRenderer.on("terminal:exit", (_e, payload) => cb(payload.paneKey, payload.code));
  },
  splitTerminal: (tabId, paneId) => ipcRenderer.invoke("terminal:split", tabId, paneId),
  closeTerminalPane: (paneKey) => ipcRenderer.invoke("terminal:closePane", paneKey),
  listBookmarks: (project) => ipcRenderer.invoke("bookmarks:list", project),
  addBookmark: (project, bookmark) => ipcRenderer.invoke("bookmarks:add", project, bookmark),
  removeBookmark: (project, url) => ipcRenderer.invoke("bookmarks:remove", project, url),
  setBookmarkPinned: (project, url, pinned) =>
    ipcRenderer.invoke("bookmarks:setPinned", project, url, pinned),
  reorderBookmarks: (project, urls) => ipcRenderer.invoke("bookmarks:reorder", project, urls),
  getSettings: () => ipcRenderer.invoke("settings:read"),
  saveSettings: (draft) => ipcRenderer.invoke("settings:save", draft),
  testAgent: (agent) => ipcRenderer.invoke("settings:testAgent", agent),
  restartApp: () => ipcRenderer.invoke("settings:restart"),
  getProjects: () => ipcRenderer.invoke("projects:list"),
};

contextBridge.exposeInMainWorld("jarvis", api);
