import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `error` (undefined on a clean settle) carries the reason the recording
// process never produced a usable file — e.g. ffmpeg missing from PATH.
// Recorder.stop() rejects with this instead of silently returning a path
// to a wav that was never written, which previously surfaced as an opaque
// whisper-cli failure on the *next* step instead of naming the real cause.
export type RecordingResult = { error?: string };

export type RecorderDeps = {
  spawnRecorder(outputPath: string): {
    kill(): void;
    done: Promise<RecordingResult>;
  };
  tmpDir: string;
  deleteFile(path: string): Promise<void>;
};

/**
 * How ffmpeg is asked for the microphone.
 *
 * This is the one thing about recording that is not portable: the input
 * device is named by an OS capture framework, and there are three.
 *
 * On Linux `pulse` rather than `alsa`, because PipeWire — the default now on
 * Fedora, Ubuntu and most of the rest — ships a PulseAudio shim, so the one
 * spelling covers both sound servers. Raw ALSA would work only on the
 * machines that have neither, and on the ones that do it takes the device
 * away from the mixer for as long as it holds it.
 *
 * Windows is the awkward one. DirectShow has no "default" device at all: a
 * capture device must be named, which is why `device` exists and why the
 * factory below asks ffmpeg what the machine has before it records anything.
 *
 * 16 kHz mono on all three, which is what whisper.cpp expects.
 */
export function recorderCommand(
  platform: NodeJS.Platform,
  outputPath: string,
  device?: string,
): { command: string; args: string[] } {
  const input =
    platform === "darwin"
      ? ["-f", "avfoundation", "-i", ":default"]
      : platform === "win32"
        ? ["-f", "dshow", "-i", `audio=${device ?? "default"}`]
        : ["-f", "pulse", "-i", "default"];
  return {
    command: "ffmpeg",
    args: [...input, "-ar", "16000", "-ac", "1", "-y", outputPath],
  };
}

/**
 * The audio capture devices in `ffmpeg -list_devices true -f dshow -i dummy`'s
 * stderr, in the order ffmpeg lists them.
 *
 * Every ffmpeg since 2013 prints each as `"Name" (audio)`. The alternative
 * `@device_…` name it prints underneath is deliberately not matched, and
 * neither are the video devices.
 */
export function parseDshowAudioDevices(stderr: string): string[] {
  const devices: string[] = [];
  for (const line of stderr.split("\n")) {
    const match = /"([^"]+)"\s+\(audio\)/.exec(line);
    if (match?.[1] !== undefined) devices.push(match[1]);
  }
  return devices;
}

/** How long a stopped ffmpeg gets to finish writing before it is killed
 *  outright. Finalising a wav header is milliseconds; this only has to
 *  outlast a slow disk. */
const GRACEFUL_STOP_MS = 3000;

/** The real recorder, for `platform`'s capture framework. A factory rather
 *  than a constant because it now needs to be told which one. */
export function createRecorderDeps(platform: NodeJS.Platform): RecorderDeps {
  return {
    tmpDir: tmpdir(),
    spawnRecorder(outputPath: string) {
      if (platform === "win32") return spawnWindowsRecorder(outputPath);
      const { command, args } = recorderCommand(platform, outputPath);
      const child = spawn(command, args, { stdio: "ignore" });

      // A spawn that fails to start (missing binary, EAGAIN, bad argv) fires
      // an "error" event; without a listener Node throws it as an uncaught
      // exception the caller has no way to catch — exactly the bug
      // defaultSpeechRunner (packages/platform/src/speech.ts) already guards
      // against. A failed spawn can also fire a trailing "close", so settle
      // from whichever event arrives first and ignore the other. Every
      // normal stop() kills ffmpeg with SIGINT, which ffmpeg reports as a
      // non-zero close code even on a fully successful recording, so unlike
      // defaultSpeechRunner there is no exit code worth distinguishing on
      // "close" — only "error" carries a real failure. The "error" message
      // is captured here and handed back on the settled result so the
      // caller (Recorder.stop()) can name the actual cause — a missing
      // recorder binary or unreachable microphone — instead of silently
      // returning a path to a wav that was never written.
      let settled = false;
      const done = new Promise<RecordingResult>((resolve) => {
        const settle = (result: RecordingResult) => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        child.on("error", (error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          settle({
            error: `Could not start the microphone recorder: ${message}`,
          });
        });
        child.on("close", () => settle({}));
      });

      return { kill: () => child.kill("SIGINT"), done };
    },
    deleteFile: (path: string) =>
      unlink(path).then(
        () => undefined,
        () => undefined,
      ),
  };
}

/** Asks ffmpeg what capture devices exist; empty when it cannot be asked.
 *  Cached after the first answer — the microphone does not change between
 *  utterances, and the listing is a whole ffmpeg start. */
let dshowDevices: Promise<string[]> | undefined;
function listDshowDevices(): Promise<string[]> {
  if (dshowDevices !== undefined) return dshowDevices;
  dshowDevices = new Promise((resolve) => {
    let stderr = "";
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve(parseDshowAudioDevices(stderr));
    };
    try {
      const child = spawn(
        "ffmpeg",
        ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => (stderr += chunk));
      child.on("error", settle);
      child.on("close", settle);
    } catch {
      settle();
    }
  });
  return dshowDevices;
}

/**
 * Recording on Windows, which differs from the others in two ways.
 *
 * DirectShow names no default device, so the first capture device ffmpeg
 * lists is the one used — asked once, before the recording starts.
 *
 * And stopping is not a signal. Windows has no SIGINT: `child.kill()` there
 * is TerminateProcess, and a terminated ffmpeg leaves a wav whose header
 * still says zero bytes, which whisper then refuses to read. So ffmpeg's
 * stdin is kept open and told `q`, its own quit command, which finalises the
 * file exactly as SIGINT does elsewhere; the kill is only the fallback for an
 * ffmpeg that does not answer.
 */
function spawnWindowsRecorder(outputPath: string): {
  kill(): void;
  done: Promise<RecordingResult>;
} {
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false;
  let settled = false;
  let settle: (result: RecordingResult) => void = () => undefined;
  const done = new Promise<RecordingResult>((resolve) => {
    settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
  });

  void listDshowDevices().then((devices) => {
    if (stopped) {
      settle({ error: "Could not start the microphone recorder: stopped before ffmpeg started" });
      return;
    }
    const first = devices[0];
    if (first === undefined) {
      settle({
        error:
          "Could not start the microphone recorder: ffmpeg lists no DirectShow audio device (is ffmpeg installed, and a microphone connected?)",
      });
      return;
    }
    const { command, args } = recorderCommand("win32", outputPath, first);
    child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", (error) =>
      settle({ error: `Could not start the microphone recorder: ${error.message}` }),
    );
    child.on("close", () => settle({}));
    // Writing `q` to an ffmpeg that has already gone raises EPIPE on stdin;
    // without a listener that is an uncaught exception.
    child.stdin?.on("error", () => undefined);
  });

  return {
    kill: () => {
      stopped = true;
      const running = child;
      if (running === undefined) return;
      try {
        running.stdin?.write("q\n");
      } catch {
        // Already gone; the close has fired or is about to.
      }
      const timer = setTimeout(() => running.kill(), GRACEFUL_STOP_MS);
      running.on("close", () => clearTimeout(timer));
    },
    done,
  };
}

export class Recorder {
  readonly #deps: RecorderDeps;
  #active:
    | {
        path: string;
        process: { kill(): void; done: Promise<RecordingResult> };
      }
    | undefined;

  constructor(deps: RecorderDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#active !== undefined) return;
    const path = join(this.#deps.tmpDir, `jarvis-${randomUUID()}.wav`);
    this.#active = { path, process: this.#deps.spawnRecorder(path) };
  }

  // Lets a caller (main.ts's stopVoice, driven by the stop hotkey) tell a
  // real "nothing to stop" apart from an actual failure before calling
  // stop() — stop() still throws "Not recording" for callers that need
  // that distinction preserved.
  isRecording(): boolean {
    return this.#active !== undefined;
  }

  async stop(): Promise<string> {
    const active = this.#active;
    if (active === undefined) throw new Error("Not recording");
    this.#active = undefined;
    active.process.kill();
    const result = await active.process.done;
    if (result.error !== undefined) throw new Error(result.error);
    return active.path;
  }

  // Stops an in-flight recording without returning its path, for shutdown
  // paths (e.g. app "will-quit") where nobody is going to transcribe the
  // result. Killing the process is synchronous and unconditional so the
  // microphone is released even if nothing ever awaits this call; deleting
  // the half-written file is best-effort and happens once ffmpeg actually
  // exits.
  abort(): void {
    const active = this.#active;
    if (active === undefined) return;
    this.#active = undefined;
    active.process.kill();
    void active.process.done.then(() => this.#deps.deleteFile(active.path));
  }

  // Recorder owns the wav file it creates (the path is derived from its
  // own tmpDir), so it also owns deleting it. Callers invoke this once
  // they are done with the file — after transcription succeeds, after it
  // fails, or after a silent recording is discarded — so nothing is left
  // behind in tmpdir() on any path.
  async cleanup(path: string): Promise<void> {
    await this.#deps.deleteFile(path);
  }
}
