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
};

contextBridge.exposeInMainWorld("jarvis", api);
