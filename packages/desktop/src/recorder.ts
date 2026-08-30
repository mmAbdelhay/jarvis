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
  spawnRecorder(outputPath: string): { kill(): void; done: Promise<RecordingResult> };
  tmpDir: string;
  deleteFile(path: string): Promise<void>;
};

// Records 16 kHz mono, which is what whisper.cpp expects.
export const defaultRecorderDeps: RecorderDeps = {
  tmpDir: tmpdir(),
  spawnRecorder(outputPath: string) {
    const child = spawn(
      "ffmpeg",
      ["-f", "avfoundation", "-i", ":default", "-ar", "16000", "-ac", "1", "-y", outputPath],
      { stdio: "ignore" },
    );

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
        const message = error instanceof Error ? error.message : String(error);
        settle({ error: `Could not start the microphone recorder: ${message}` });
      });
      child.on("close", () => settle({}));
    });

    return { kill: () => child.kill("SIGINT"), done };
  },
  deleteFile: (path: string) => unlink(path).then(
    () => undefined,
    () => undefined,
  ),
};

export class Recorder {
  readonly #deps: RecorderDeps;
  #active: { path: string; process: { kill(): void; done: Promise<RecordingResult> } } | undefined;

  constructor(deps: RecorderDeps = defaultRecorderDeps) {
    this.#deps = deps;
  }

  start(): void {
    if (this.#active !== undefined) return;
    const path = join(this.#deps.tmpDir, `jarvis-${randomUUID()}.wav`);
    this.#active = { path, process: this.#deps.spawnRecorder(path) };
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
