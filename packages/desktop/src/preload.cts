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
  openTab: (project, input, kind) => ipcRenderer.invoke("workspace:open", project, input, kind),
  closeTab: (id) => ipcRenderer.invoke("workspace:close", id),
  activateTab: (id) => ipcRenderer.invoke("workspace:activate", id),
  navigateTab: (id, input) => ipcRenderer.invoke("workspace:navigate", id, input),
  tabBack: (id) => ipcRenderer.invoke("workspace:back", id),
  tabForward: (id) => ipcRenderer.invoke("workspace:forward", id),
  tabReload: (id) => ipcRenderer.invoke("workspace:reload", id),
  setWorkspaceBounds: (bounds) => ipcRenderer.invoke("workspace:bounds", bounds),
  setWorkspaceVisible: (visible) => ipcRenderer.invoke("workspace:visible", visible),
  hideAllTabs: () => ipcRenderer.invoke("workspace:hideAll"),
  onWorkspace: (cb) => {
    ipcRenderer.on("workspace:update", (_e, state) => cb(state));
  },
  openEditor: (project) => ipcRenderer.invoke("editor:open", project),
  getSettings: () => ipcRenderer.invoke("settings:read"),
  saveSettings: (draft) => ipcRenderer.invoke("settings:save", draft),
  testAgent: (agent) => ipcRenderer.invoke("settings:testAgent", agent),
  restartApp: () => ipcRenderer.invoke("settings:restart"),
  getProjects: () => ipcRenderer.invoke("projects:list"),
};

contextBridge.exposeInMainWorld("jarvis", api);
