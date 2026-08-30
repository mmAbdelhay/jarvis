import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type RecorderDeps = {
  spawnRecorder(outputPath: string): { kill(): void; done: Promise<void> };
  tmpDir: string;
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
    const done = new Promise<void>((resolve) => child.on("close", () => resolve()));
    return { kill: () => child.kill("SIGINT"), done };
  },
};

export class Recorder {
  readonly #deps: RecorderDeps;
  #active: { path: string; process: { kill(): void; done: Promise<void> } } | undefined;

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
    await active.process.done;
    return active.path;
  }
}
