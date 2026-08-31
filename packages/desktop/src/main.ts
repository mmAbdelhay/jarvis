import { fileURLToPath, pathToFileURL } from "node:url";
import { BrowserWindow, app, dialog, globalShortcut, ipcMain } from "electron";
import { AgentRegistry, ChangeTracker, Orchestrator, SessionManager } from "@jarvis/core";
import {
  MacSpeech,
  createBrain,
  createGitProvider,
  createMetricsReader,
  createSpawner,
  createSqliteSessionStore,
  runCommand,
  transcribe,
} from "@jarvis/platform";
import { buildWiring } from "./ipc.js";
import { isAllowedNavigation } from "./navigation.js";
import { loadConfig } from "./config.js";
import { errorMessage, MESSAGES, PRIMARY_LANGUAGE } from "./messages.js";
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
      console.error(`Startup health check failed: ${errorMessage(error)}`);
      return { healthy: [], broken: [], message: "" };
    });
    // Beside jarvis.yaml, created (directory included) on first use — see
    // config.ts's defaultSessionsDbPath() note. SessionManager upserts a
    // row into this store on every state transition it already emits a
    // change event for, so history persistence needs no separate polling.
    const sessionStore = createSqliteSessionStore(config.sessionsDbPath);
    const sessions = new SessionManager(createSpawner(), sessionStore);
    const speech = new MacSpeech({ arabicVoice: "Majed" });
    const git = createGitProvider();
    const changeTracker = new ChangeTracker({ git, sessions });
    // A session starting/finishing/dying re-triggers a refresh too, but
    // that subscription lives in buildWiring's onSessionsChange handler
    // below (ruling P16: this used to be subscribed here *and* there —
    // every session transition fired two refreshes, and this copy was
    // never unsubscribed, unlike wiring's own teardown in `stop()`). Only
    // the initial refresh, before wiring exists, stays here.
    void changeTracker.refresh();

    const orchestrator = new Orchestrator({
      brain: createBrain(config.brain),
      registry,
      sessions,
      git,
      changes: () => changeTracker.snapshot(),
      speak: (text, language) => speech.speak(text, language),
      projects: config.projects,
    });

    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      backgroundColor: "#060a0f",
      webPreferences: {
        preload: fileURLToPath(new URL("preload.cjs", import.meta.url)),
        // This renderer displays untrusted agent output and holds
        // `window.jarvis.send`. These already match Electron 44's implicit
        // defaults; stated explicitly so a future edit that weakens them
        // is visible in review.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

    const indexUrl = pathToFileURL(
      fileURLToPath(new URL("../../renderer/index.html", import.meta.url)),
    ).href;

    window.webContents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url, indexUrl)) {
        event.preventDefault();
      }
    });

    // Important 4: wiring is built and started here — before ipcMain
    // handlers are registered, before the recorder/hotkeys exist, and
    // before the window ever loads a page a user could interact with — so
    // no turn produced between now and the (slow, up-to-5s) startup health
    // report can ever be dropped. Previously wiring.start() (where
    // orchestrator.onTurn / sessions.onChange are first subscribed) ran
    // only after `await reportPromise`, so a turn handled during that
    // window was spoken by TTS but never reached "turn:new" — gone, with
    // no replay.
    const wiring = buildWiring({
      send: (channel, payload) => window.webContents.send(channel, payload),
      readMetrics: createMetricsReader(),
      intervalMs: 2000,
      onSessionsChange: (cb) => sessions.onChange(cb),
      onTurn: (cb) => orchestrator.onTurn(cb),
      onChangeCounts: (cb) => changeTracker.onChange(cb),
      refreshChanges: () => changeTracker.refresh(),
      changesIntervalMs: 15_000,
    });
    wiring.start();
    window.on("closed", () => wiring.stop());

    ipcMain.handle("input:send", async (_event, text: string, language: "ar" | "en") => {
      await orchestrator.handle(text, language);
    });

    // Pulled on demand when the renderer's history panel opens, not
    // pushed — there is no live subscriber to keep in sync for a past-
    // sessions view, only a snapshot to render once per open.
    ipcMain.handle("history:list", () => sessionStore.history());

    const recorder = new Recorder(defaultRecorderDeps);

    function startVoice(): void {
      recorder.start();
      window.webContents.send("voice:listening", true);
    }

    // Alt+Space / Alt+Shift+Space is a press-to-start / press-to-stop-and-send
    // pair, not a genuine toggle on one key: macOS reserves plain toggling of
    // a single combo for other system uses, and a distinct stop key also
    // means "stop without holding" is unambiguous to the user. The mic
    // button in the renderer drives the same pair through voice:start /
    // voice:stop IPC calls below, so voice has exactly one implementation
    // regardless of which control triggers it.
    function stopVoice(): void {
      // The mic button already guards this on the renderer's own
      // `isListening` flag; Alt+Shift+Space has no such guard, so a stop
      // with nothing active (e.g. the hotkey fired twice) must be a
      // silent no-op rather than falling through to recorder.stop()'s
      // "Not recording" throw, which processVoiceTurn's catch renders to
      // the user as a spurious "تعذر تسجيل الصوت: Not recording" turn.
      if (!recorder.isRecording()) return;

      window.webContents.send("voice:listening", false);

      // Important 6: the whole turn — recorder stop, transcription, and
      // orchestrator dispatch — is wrapped in one promise chain with a
      // top-level `.catch`. Previously this was `void (async () => {...})()`
      // with a try/finally but no catch: if the `finally` block itself threw
      // (or any awaited call inside it rejected past its own local catch),
      // the rejection had no handler and Node's default
      // `--unhandled-rejections=throw` would kill the whole main process
      // mid-sentence.
      processVoiceTurn().catch((error) => {
        console.error(`Voice turn failed: ${errorMessage(error)}`);
      });
    }

    async function processVoiceTurn(): Promise<void> {
      let wavPath: string;
      try {
        wavPath = await recorder.stop();
      } catch (error) {
        const message = errorMessage(error);
        console.error(`Recorder stop failed: ${message}`);
        window.webContents.send("turn:new", {
          role: "assistant",
          text: MESSAGES.recordingFailed(message, PRIMARY_LANGUAGE),
          language: PRIMARY_LANGUAGE,
          at: Date.now(),
        });
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
          const message = errorMessage(error);
          console.error(`Transcription failed: ${message}`);
          window.webContents.send("turn:new", {
            role: "assistant",
            text: MESSAGES.transcriptionFailed(message, PRIMARY_LANGUAGE),
            language: PRIMARY_LANGUAGE,
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
    }

    const spaceRegistered = globalShortcut.register("Alt+Space", startVoice);
    const stopRegistered = globalShortcut.register("Alt+Shift+Space", stopVoice);

    // M-b: the renderer's mic button drives the exact same start/stop path
    // as the global hotkey, so voice has one implementation no matter which
    // control triggers it — never a second, unwired-looking "click to talk"
    // affordance beside the real hotkey-driven one.
    ipcMain.handle("voice:start", () => startVoice());
    ipcMain.handle("voice:stop", () => stopVoice());

    app.on("will-quit", () => {
      globalShortcut.unregisterAll();
      // A recording started but never stopped (e.g. the user quits with
      // Alt+Space still active) would otherwise leave ffmpeg running as an
      // orphaned process with the microphone held open indefinitely.
      recorder.abort();
      // Sessions still "starting"/"running"/"waiting" at quit time never
      // reach SessionManager#update's endedAt-setting branch on their own
      // — nothing calls onExit/kill for them once the window is gone — so
      // without this their history() rows stay wrong forever, sorted to
      // the very top (most-recently-active first). kill() is the same
      // path a user-initiated stop already takes, so it persists an
      // endedAt-bearing row through the normal #persist choke point. This
      // only fires on a clean quit, though — a hard kill or crash never
      // reaches `will-quit` at all — so createSqliteSessionStore's own
      // startup reconciliation (session-store.ts) is the backstop that's
      // guaranteed to run regardless of how the previous run ended.
      for (const session of sessions.list()) {
        if (session.state === "done" || session.state === "dead") continue;
        sessions.kill(session.id);
      }
    });

    await window.loadFile(fileURLToPath(new URL("../../renderer/index.html", import.meta.url)));

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
        text: MESSAGES.hotkeyCollision(combo, PRIMARY_LANGUAGE),
        language: PRIMARY_LANGUAGE,
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
  } catch (error) {
    dialog.showErrorBox("Jarvis failed to start", errorMessage(error));
    app.quit();
  }
});

app.on("window-all-closed", () => app.quit());
