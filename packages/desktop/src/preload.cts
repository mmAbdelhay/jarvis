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
  onProviders: (cb) => {
    ipcRenderer.on("providers:update", (_e, statuses) => cb(statuses));
  },
  refreshProviders: () => ipcRenderer.invoke("providers:refresh"),
};

contextBridge.exposeInMainWorld("jarvis", api);
