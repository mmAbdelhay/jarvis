import { fileURLToPath } from "node:url";
import { BrowserWindow, app, ipcMain } from "electron";
import { AgentRegistry, Orchestrator, SessionManager } from "@jarvis/core";
import { MacSpeech, createBrain, createMetricsReader, createSpawner } from "@jarvis/platform";
import { buildWiring } from "./ipc.js";
import { loadConfig } from "./config.js";

app.whenReady().then(async () => {
  const config = await loadConfig();
  const registry = new AgentRegistry(config.registry);
  const sessions = new SessionManager(createSpawner());
  const speech = new MacSpeech({ arabicVoice: "Majed" });

  const orchestrator = new Orchestrator({
    brain: createBrain(config.brain),
    registry,
    sessions,
    speak: (text, language) => speech.speak(text, language),
    projects: config.projects,
  });

  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#060a0f",
    webPreferences: { preload: fileURLToPath(new URL("preload.cjs", import.meta.url)) },
  });

  await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));

  const wiring = buildWiring({
    send: (channel, payload) => window.webContents.send(channel, payload),
    readMetrics: createMetricsReader(),
    intervalMs: 2000,
    onSessionsChange: (cb) => sessions.onChange(cb),
    onTurn: (cb) => orchestrator.onTurn(cb),
  });

  wiring.start();
  window.on("closed", () => wiring.stop());

  ipcMain.handle("input:send", async (_event, text: string, language: "ar" | "en") => {
    await orchestrator.handle(text, language);
  });
});

app.on("window-all-closed", () => app.quit());
