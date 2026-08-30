import { spawn } from "node:child_process";

export type SpeechRunner = (
  command: string,
  args: string[],
) => { kill(): void; done: Promise<{ code: number }> };

export type SpeechConfig = { arabicVoice: string; englishVoice?: string };

export const defaultSpeechRunner: SpeechRunner = (command, args) => {
  const child = spawn(command, args, { stdio: "ignore" });

  // A spawn that fails to start (missing binary, EAGAIN, bad argv) fires
  // an "error" event; without a listener Node throws it as an uncaught
  // exception that the caller has no way to catch. A failed spawn also
  // fires a trailing "close", so settle from whichever event arrives
  // first and ignore the other.
  let settled = false;
  const done = new Promise<{ code: number }>((resolve) => {
    const settle = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code });
    };
    child.on("error", () => settle(1));
    child.on("close", (code) => settle(code ?? 1));
  });

  return { kill: () => child.kill(), done };
};

export class MacSpeech {
  readonly #config: SpeechConfig;
  readonly #run: SpeechRunner;
  #current: { kill(): void } | undefined;

  constructor(config: SpeechConfig, run: SpeechRunner = defaultSpeechRunner) {
    this.#config = config;
    this.#run = run;
  }

  async speak(text: string, language: "ar" | "en"): Promise<void> {
    if (text.trim() === "") return;
    this.stopSpeaking();

    const voice = language === "ar" ? this.#config.arabicVoice : this.#config.englishVoice;
    const args = voice === undefined ? [text] : ["-v", voice, text];

    const utterance = this.#run("say", args);
    this.#current = utterance;
    const result = await utterance.done;

    // Only clear #current if it still refers to this utterance: a
    // barge-in may have already replaced it with a newer one by the time
    // this (superseded) utterance's `done` settles.
    if (this.#current === utterance) {
      this.#current = undefined;
    }

    if (result.code !== 0) {
      throw new Error(`say exited with code ${result.code}`);
    }
  }

  stopSpeaking(): void {
    this.#current?.kill();
    this.#current = undefined;
  }
}
