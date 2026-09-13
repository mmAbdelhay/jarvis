import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
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
// Piper writes WAV and neither platform has a pipe-to-speaker command as
// reliable as playing a real file. Which player that is differs: macOS has
// exactly one worth using, and Linux has three depending on the sound
// server. See audioPlayer.

export type SpokenProcess = { kill(): void; done: Promise<{ code: number }> };

/** `stdin`, when given, is written to the child and the stream is then
 *  closed. Piper reads the text it is to speak from stdin and produces
 *  nothing at all until it sees EOF. */
export type ProcessRunner = (command: string, args: string[], stdin?: string) => SpokenProcess;

export const defaultProcessRunner: ProcessRunner = (command, args, stdin) => {
  const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });

  if (stdin !== undefined) {
    // end() rather than write(): piper waits for EOF before it synthesises
    // anything, so a stream left open is a process that never finishes.
    //
    // The error handler matters because writing to a child that failed to
    // spawn raises EPIPE asynchronously, which would take the app down past
    // every catch the caller has.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin);
  }

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
  /** Absolute path: the app is launched from Finder or a desktop launcher,
   *  whose PATH does not include ~/.local/bin, so a bare "piper" would not
   *  resolve. */
  binary: string;
  /** The .onnx voice model. One model speaks one language. */
  model: string;
  /** Which platform the player belongs to — it decides what the player is
   *  handed, not which one it is. See playerArgs. */
  platform?: NodeJS.Platform;
  /** What plays the WAV it writes — see audioPlayer. Resolved once by the
   *  caller rather than probed per utterance. */
  player: string;
};

/** The Linux players, most modern first. pw-play is PipeWire's own, paplay
 *  PulseAudio's, aplay ALSA's — and on a PipeWire system all three work,
 *  which is why this is an order and not a detection. */
const LINUX_PLAYERS = ["pw-play", "paplay", "aplay"] as const;

/**
 * What plays the WAV Piper just wrote.
 *
 * macOS has exactly one worth using. Linux has three, and which are installed
 * depends on the sound server, so this probes rather than assumes.
 *
 * When none is found it still returns the last candidate. The alternative is
 * an undefined that every caller has to grow a "cannot play" branch for, when
 * spawning `aplay` and failing already produces an error naming a binary the
 * user can go and install.
 */
export function audioPlayer(
  platform: NodeJS.Platform,
  exists: (command: string) => boolean,
  env: NodeJS.ProcessEnv = {},
): string {
  if (platform === "darwin") return "afplay";
  // Windows ships no player on PATH at all, and there is nothing to probe
  // for: .NET's SoundPlayer is always there, and PowerShell is how a process
  // reaches it. It plays synchronously, which is the contract afplay gives —
  // the process ends when the sound does, and killing it stops the sound.
  if (platform === "win32") {
    const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows";
    return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  }
  return LINUX_PLAYERS.find((player) => exists(player)) ?? LINUX_PLAYERS[LINUX_PLAYERS.length - 1]!;
}

/**
 * What the player is handed.
 *
 * Every player but Windows' takes the path and nothing else. PowerShell takes
 * a script, and it takes it base64'd as UTF-16LE rather than as a command
 * line: a wav path is arbitrary text, and a command line goes through the
 * console code page, which is not UTF-8 on Windows PowerShell.
 */
export function playerArgs(platform: NodeJS.Platform, wavPath: string): string[] {
  if (platform !== "win32") return [wavPath];
  const script = `(New-Object System.Media.SoundPlayer '${wavPath.replaceAll("'", "''")}').PlaySync()`;
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

/** Whether `command` is an executable on PATH. Used once, at startup, to
 *  settle audioPlayer's probe — the same "asked once and reused" shape
 *  loginShellPath uses in headlamp.ts. */
export function onPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = "linux",
): boolean {
  // Windows separates PATH with ";" and marks nothing executable — there is
  // no X_OK bit to test, so presence is the whole question. This is only ever
  // asked to choose a Linux player, but a wrong separator here would make it
  // answer nonsense rather than nothing.
  for (const dir of (env["PATH"] ?? "").split(platform === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    try {
      accessSync(join(dir, command), constants.X_OK);
      return true;
    } catch {
      // Not here; try the next entry.
    }
  }
  return false;
}

export type PiperDeps = {
  run?: ProcessRunner;
  makeTempDir?: () => Promise<string>;
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
    this.#removeDir = deps.removeDir ?? ((path) => rm(path, { recursive: true, force: true }));
  }

  async speak(text: string, _language: "ar" | "en"): Promise<void> {
    if (text.trim() === "") return;
    this.stopSpeaking();
    const generation = ++this.#generation;

    const dir = await this.#makeTempDir();
    const wav = join(dir, "line.wav");

    try {
      // The text goes in on stdin, because that is the only way piper takes
      // it. There is no input-file flag — an earlier `-i <path>` here was
      // accepted silently, ignored, and left piper reading an empty stdin: it
      // logged "Initialized piper", logged "Terminated piper", wrote no file,
      // and exited 0. Every utterance failed at the *player*, complaining
      // about a wav that was never created.
      //
      // stdin needs no quoting or escaping either, which was the worry that
      // put the text in a file to begin with. It is a byte stream; only argv
      // would have needed rules.
      const synth = this.#run(this.#config.binary, ["-m", this.#config.model, "-f", wav], text);
      this.#current = synth;
      const synthesised = await synth.done;
      if (generation !== this.#generation) return;
      if (synthesised.code !== 0) throw new Error(`piper exited with code ${synthesised.code}`);

      const playback = this.#run(
        this.#config.player,
        playerArgs(this.#config.platform ?? "linux", wav),
      );
      this.#current = playback;
      const played = await playback.done;
      if (generation !== this.#generation) return;
      if (played.code !== 0) {
        throw new Error(`${this.#config.player} exited with code ${played.code}`);
      }
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
  readonly #english: {
    speak(text: string, language: "ar" | "en"): Promise<void>;
    stopSpeaking(): void;
  };
  readonly #other: {
    speak(text: string, language: "ar" | "en"): Promise<void>;
    stopSpeaking(): void;
  };

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

/**
 * A speech object that says nothing and reports why, once per utterance.
 *
 * It exists so "no voice is installed for this language" is a normal outcome
 * with a normal shape, rather than a null every caller has to branch on or a
 * rejection nobody catches. Silence with no explanation is the failure mode
 * this codebase refuses; `notify` is how it explains.
 */
export function silentSpeech(notify: (language: "ar" | "en") => void): {
  speak(text: string, language: "ar" | "en"): Promise<void>;
  stopSpeaking(): void;
} {
  return {
    async speak(text: string, language: "ar" | "en"): Promise<void> {
      if (text.trim() === "") return;
      notify(language);
    },
    stopSpeaking(): void {
      // Nothing is ever playing.
    },
  };
}
