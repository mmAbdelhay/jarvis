import { spawn } from "node:child_process";

export type SpeechRunner = (
  command: string,
  args: string[],
) => { kill(): void; done: Promise<void> };

export type SpeechConfig = { arabicVoice: string; englishVoice?: string };

export const defaultSpeechRunner: SpeechRunner = (command, args) => {
  const child = spawn(command, args, { stdio: "ignore" });
  const done = new Promise<void>((resolve) => child.on("close", () => resolve()));
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
    await utterance.done;
  }

  stopSpeaking(): void {
    this.#current?.kill();
    this.#current = undefined;
  }
}
