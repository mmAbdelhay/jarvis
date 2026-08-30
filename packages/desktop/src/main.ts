import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, ipcMain } from "electron";
import { AgentRegistry, Orchestrator, SessionManager } from "@jarvis/core";
import {
  MacSpeech,
  createBrain,
  createMetricsReader,
  createSpawner,
  runCommand,
} from "@jarvis/platform";
import { buildWiring } from "./ipc.js";
import { isAllowedNavigation } from "./navigation.js";
import { loadConfig } from "./config.js";
import { startupReport } from "./startup.js";

app.whenReady().then(async () => {
  try {
    const config = await loadConfig();
    const registry = new AgentRegistry(config.registry);
    const report = await startupReport(registry, runCommand);
    console.log(report.message);
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

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    const indexUrl = pathToFileURL(
      fileURLToPath(new URL("../renderer/index.html", import.meta.url)),
    ).href;

    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url, indexUrl)) {
        event.preventDefault();
      }
    });

    ipcMain.handle("input:send", async (_event, text: string, language: "ar" | "en") => {
      await orchestrator.handle(text, language);
    });

    await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));

    window.webContents.send("turn:new", {
      role: "assistant",
      text: report.message,
      language: "en",
      at: Date.now(),
    });

    const wiring = buildWiring({
      send: (channel, payload) => window.webContents.send(channel, payload),
      readMetrics: createMetricsReader(),
      intervalMs: 2000,
      onSessionsChange: (cb) => sessions.onChange(cb),
      onTurn: (cb) => orchestrator.onTurn(cb),
    });

    wiring.start();
    window.on("closed", () => wiring.stop());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Jarvis failed to start", message);
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
