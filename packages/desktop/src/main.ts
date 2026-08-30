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
    const spaceRegistered = globalShortcut.register("Alt+Space", () => {
      recorder.start();
      window.webContents.send("voice:listening", true);
    });

    const stopRegistered = globalShortcut.register("Alt+Shift+Space", () => {
      window.webContents.send("voice:listening", false);
      void (async () => {
        let wavPath: string;
        try {
          wavPath = await recorder.stop();
        } catch (error) {
          console.error(`Recorder stop failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }

        try {
          // transcribe() throws on a broken transcription pipeline (bad
          // model path, corrupt wav, missing ffmpeg/whisper binary — a
          // recording that never started leaves no readable wav behind,
          // and transcription fails on that missing file) and returns an
          // empty-text transcript for actual silence — two different
          // outcomes that must not be collapsed into one another. A broken
          // pipeline is reported as an assistant turn; silence gets a
          // brief, non-turn notice so the user knows the hotkey worked and
          // nothing was heard, rather than the UI just going quiet.
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

          if (transcript.text.trim() === "") {
            const language = transcript.language === "ar" ? "ar" : "en";
            window.webContents.send("voice:notice", {
              text: language === "ar" ? "لم يُسمع شيء" : "Didn't catch that",
              language,
            });
            return;
          }
          await orchestrator.handle(transcript.text, transcript.language === "ar" ? "ar" : "en");
        } finally {
          // Recorder owns the wav file it created; nothing else reads it
          // past this point on any of the branches above, so it's always
          // deleted here rather than left behind in tmpdir().
          await recorder.cleanup(wavPath);
        }
      })();
    });

    app.on("will-quit", () => {
      globalShortcut.unregisterAll();
      // A recording started but never stopped (e.g. the user quits with
      // Alt+Space still active) would otherwise leave ffmpeg running as an
      // orphaned process with the microphone held open indefinitely.
      recorder.abort();
    });

    await window.loadFile(fileURLToPath(new URL("../renderer/index.html", import.meta.url)));

    // globalShortcut.register() does not throw on collision — a combo
    // already claimed by another app (window managers, Alfred, Raycast and
    // input-source switchers commonly claim Alt-combos) makes it return
    // false silently. Left unchecked, the headline feature is inert and
    // the UI still advertises a hotkey that will never fire.
    for (const [combo, registered] of [
      ["Alt+Space", spaceRegistered],
      ["Alt+Shift+Space", stopRegistered],
    ] as const) {
      if (registered) continue;
      window.webContents.send("turn:new", {
        role: "assistant",
        text: `Could not register the ${combo} shortcut — another app is probably already using it.`,
        language: "en",
        at: Date.now(),
      });
    }

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
