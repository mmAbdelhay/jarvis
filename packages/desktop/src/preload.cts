import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("jarvis", {
  send: (text: string, language: "ar" | "en") => ipcRenderer.invoke("input:send", text, language),
  onMetrics: (cb: (m: unknown) => void) =>
    ipcRenderer.on("metrics:update", (_e, m) => cb(m)),
  onSessions: (cb: (s: unknown) => void) =>
    ipcRenderer.on("sessions:update", (_e, s) => cb(s)),
  onTurn: (cb: (t: unknown) => void) =>
    ipcRenderer.on("turn:new", (_e, t) => cb(t)),
});
