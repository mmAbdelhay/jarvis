import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, globalShortcut, ipcMain } from "electron";
import { AgentRegistry, Orchestrator, SessionManager } from "@jarvis/core";
import {
  MacSpeech,
  createBrain,
  createMetricsReader,
  createSpawner,
  runCommand,
  transcribe,
} from "@jarvis/platform";
import { buildWiring } from "./ipc.js";
import { isAllowedNavigation } from "./navigation.js";
import { loadConfig } from "./config.js";
import { defaultRecorderDeps, Recorder } from "./recorder.js";
import { startupReport } from "./startup.js";

app.whenReady().then(async () => {
  try {
    const config = await loadConfig();
    const registry = new AgentRegistry(config.registry);
    // Started, not awaited: the health probe (bounded per-agent in
    // @jarvis/core, but still a network of spawned processes) must never
    // hold up the window appearing. The `.catch` is attached immediately —
    // not after some later `await` — so that if this promise settles after
    // the outer try/catch has already run dialog.showErrorBox/app.quit()
    // for an unrelated startup failure, it cannot surface as an unhandled
    // rejection; checkAgent itself never rejects, so this is a safety net.
    const reportPromise = startupReport(registry, runCommand).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Startup health check failed: ${message}`);
      return { healthy: [], broken: [], message: "" };
    });
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

    const recorder = new Recorder(defaultRecorderDeps);

    // Alt+Space / Alt+Shift+Space is a press-to-start / press-to-stop-and-send
    // pair, not a genuine toggle on one key: macOS reserves plain toggling of
    // a single combo for other system uses, and a distinct stop key also
    // means "stop without holding" is unambiguous to the user.
    globalShortcut.register("Alt+Space", () => {
      recorder.start();
      window.webContents.send("voice:listening", true);
    });

    globalShortcut.register("Alt+Shift+Space", () => {
      window.webContents.send("voice:listening", false);
      void (async () => {
        let wavPath: string;
        try {
          wavPath = await recorder.stop();
        } catch (error) {
          console.error(`Recorder stop failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }

        // transcribe() throws on a broken transcription pipeline (bad model
        // path, corrupt wav) and returns an empty-text transcript for actual
        // silence — two different outcomes that must not be collapsed into
        // one another. A broken pipeline is reported; silence is a quiet
        // no-op, the same as never having pressed the key.
        let transcript: Awaited<ReturnType<typeof transcribe>>;
        try {
          transcript = await transcribe(wavPath, config.whisper, runCommand);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Transcription failed: ${message}`);
          window.webContents.send("turn:new", {
            role: "assistant",
            text: `Transcription failed: ${message}`,
            language: "en",
            at: Date.now(),
          });
          return;
        }

        if (transcript.text.trim() === "") return;
        await orchestrator.handle(transcript.text, transcript.language === "ar" ? "ar" : "en");
      })();
    });

    app.on("will-quit", () => globalShortcut.unregisterAll());

    await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));

    const report = await reportPromise;
    console.log(report.message);
    if (report.message !== "") {
      window.webContents.send("turn:new", {
        role: "assistant",
        text: report.message,
        language: "en",
        at: Date.now(),
      });
    }

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
