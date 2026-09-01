import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Speech through Piper, a local neural text-to-speech engine.
//
// macOS ships every `say` voice in a *compact* form; the Enhanced and Premium
// versions that do not sound synthetic are downloads driven by the Speech
// preference pane, with no supported command-line way to fetch them. Piper is
// the alternative that can actually be installed by a script: it runs locally,
// needs no account and no network at speaking time, and its output is not in
// the same league as a compact macOS voice.
//
// Two processes per utterance — synthesise to a file, then play it — because
// Piper writes WAV and macOS has no pipe-to-speaker command that is as
// reliable as afplay on a real file.

export type SpokenProcess = { kill(): void; done: Promise<{ code: number }> };

export type ProcessRunner = (command: string, args: string[]) => SpokenProcess;

export const defaultProcessRunner: ProcessRunner = (command, args) => {
  const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });

  // A spawn that fails to start fires "error"; without a listener Node throws
  // it as an uncaught exception the caller cannot catch. Same latch as
  // speech.ts's runner.
  let settled = false;
  const done = new Promise<{ code: number }>((resolve) => {
    const settle = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code });
    };
    child.on("error", () => settle(1));
    child.on("close", (code) => settle(code ?? 1));
  });

  return { kill: () => child.kill(), done };
};

export type PiperConfig = {
  /** Absolute path: the app is launched from Finder, whose PATH does not
   *  include ~/.local/bin, so a bare "piper" would not resolve. */
  binary: string;
  /** The .onnx voice model. */
  model: string;
};

export type PiperDeps = {
  run?: ProcessRunner;
  /** Where the synthesised wav goes. Injected so tests need no filesystem. */
  makeTempDir?: () => Promise<string>;
  writeFile?: (path: string, text: string) => Promise<void>;
  removeDir?: (path: string) => Promise<void>;
};

/**
 * One utterance at a time, with the same barge-in contract MacSpeech has:
 * speaking again stops whatever is currently being said.
 */
export class PiperSpeech {
  readonly #config: PiperConfig;
  readonly #run: ProcessRunner;
  readonly #makeTempDir: () => Promise<string>;
  readonly #writeFile: (path: string, text: string) => Promise<void>;
  readonly #removeDir: (path: string) => Promise<void>;

  /** Bumped by every speak and every stop, so an utterance whose synthesis
   *  finishes after a barge-in knows not to start playing. Without it, a
   *  stop that lands between synthesis and playback is ignored and the old
   *  line is spoken over the new one. */
  #generation = 0;
  #current: { kill(): void } | undefined;

  constructor(config: PiperConfig, deps: PiperDeps = {}) {
    this.#config = config;
    this.#run = deps.run ?? defaultProcessRunner;
    this.#makeTempDir = deps.makeTempDir ?? (() => mkdtemp(join(tmpdir(), "jarvis-speech-")));
    this.#writeFile = deps.writeFile ?? ((path, text) => writeFile(path, text, "utf8"));
    this.#removeDir = deps.removeDir ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  async speak(text: string, _language: "ar" | "en"): Promise<void> {
    if (text.trim() === "") return;
    this.stopSpeaking();
    const generation = ++this.#generation;

    const dir = await this.#makeTempDir();
    const input = join(dir, "line.txt");
    const wav = join(dir, "line.wav");

    try {
      // Through a file rather than stdin: the text is arbitrary and may
      // contain anything, and a file needs no quoting or encoding rules.
      await this.#writeFile(input, text);

      const synth = this.#run(this.#config.binary, [
        "-m",
        this.#config.model,
        "-i",
        input,
        "-f",
        wav,
      ]);
      this.#current = synth;
      const synthesised = await synth.done;
      if (generation !== this.#generation) return;
      if (synthesised.code !== 0) throw new Error(`piper exited with code ${synthesised.code}`);

      const playback = this.#run("afplay", [wav]);
      this.#current = playback;
      const played = await playback.done;
      if (generation !== this.#generation) return;
      if (played.code !== 0) throw new Error(`afplay exited with code ${played.code}`);
    } finally {
      if (this.#current !== undefined && generation === this.#generation) {
        this.#current = undefined;
      }
      await this.#removeDir(dir);
    }
  }

  stopSpeaking(): void {
    this.#generation += 1;
    this.#current?.kill();
    this.#current = undefined;
  }
}

/**
 * English through Piper, everything else through the fallback.
 *
 * A Piper model speaks one language. Jarvis is bilingual, and the Arabic voice
 * (`say -v Majed`) has to keep working — so this routes by language rather
 * than replacing speech wholesale, which would have made the app mute in
 * Arabic the moment a better English voice arrived.
 */
export class RoutedSpeech {
  readonly #english: { speak(text: string, language: "ar" | "en"): Promise<void>; stopSpeaking(): void };
  readonly #other: { speak(text: string, language: "ar" | "en"): Promise<void>; stopSpeaking(): void };

  constructor(
    english: { speak(text: string, language: "ar" | "en"): Promise<void>; stopSpeaking(): void },
    other: { speak(text: string, language: "ar" | "en"): Promise<void>; stopSpeaking(): void },
  ) {
    this.#english = english;
    this.#other = other;
  }

  async speak(text: string, language: "ar" | "en"): Promise<void> {
    // Both are stopped, not just the one about to speak: a barge-in in the
    // other language must still silence what is playing.
    this.stopSpeaking();
    await (language === "en" ? this.#english : this.#other).speak(text, language);
  }

  stopSpeaking(): void {
    this.#english.stopSpeaking();
    this.#other.stopSpeaking();
  }
}
