import { spawn } from "node:child_process";

export type SpeechRunner = (
  command: string,
  args: string[],
) => { kill(): void; done: Promise<{ code: number }> };

export type SpeechConfig = { arabicVoice: string; englishVoice?: string };

/** Lists the voices `say` can use, one name per line, as `say -v '?'` does. */
export type VoiceLister = () => Promise<string[]>;

/**
 * macOS ships every voice in a *compact* form and offers Enhanced and Premium
 * downloads for many of them. The compact ones are the robotic-sounding
 * originals; the downloads are a different technology entirely, and the
 * difference is not subtle.
 *
 * Once installed, an upgraded voice appears under a decorated name —
 * "Daniel (Enhanced)" — so a config that simply says "Daniel" keeps using the
 * compact one forever. This resolves a plain name to the best installed
 * variant, so installing a voice in System Settings is the whole of the work:
 * there is no second step where the exact string has to be discovered and
 * typed into a config file.
 *
 * Premium is preferred over Enhanced, which is preferred over compact, which
 * is macOS's own ordering of them.
 */
export function bestVariant(name: string, installed: readonly string[]): string {
  const wanted = name.trim();
  if (wanted === "") return wanted;

  const matches = installed.filter(
    (voice) => voice === wanted || voice.startsWith(`${wanted} (`),
  );
  const byRank = (voice: string): number =>
    voice.includes("(Premium)") ? 0 : voice.includes("(Enhanced)") ? 1 : 2;

  return [...matches].sort((a, b) => byRank(a) - byRank(b))[0] ?? wanted;
}

/** Reads the installed voice names from `say -v '?'`, whose lines look like
 *  `Daniel (Enhanced)     en_GB    # Hello! My name is Daniel.` */
export function parseVoiceList(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.split(/\s{2,}/)[0]?.trim() ?? "")
    .filter((name) => name !== "");
}

export type InstalledVoice = {
  name: string;
  /** The BCP-47-ish tag say reports, e.g. en_GB or ar_001. */
  language: string;
  /** True for an Enhanced or Premium download rather than the compact voice
   *  macOS ships. Worth surfacing: it is the difference between a voice that
   *  sounds robotic and one that does not. */
  upgraded: boolean;
};

/** The same listing, with the language and quality each line carries. */
export function parseVoices(output: string): InstalledVoice[] {
  const voices: InstalledVoice[] = [];
  for (const line of output.split("\n")) {
    const parts = line.split(/\s{2,}/);
    const name = parts[0]?.trim() ?? "";
    const language = parts[1]?.trim() ?? "";
    if (name === "" || language === "") continue;
    voices.push({
      name,
      language,
      upgraded: name.includes("(Enhanced)") || name.includes("(Premium)"),
    });
  }
  return voices;
}

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
  /** The names actually passed to `say`. They start as configured and are
   *  upgraded in place once the installed set is known. */
  readonly #names: { ar: string; en: string | undefined };
  /** Settles when the voice listing has been read. main awaits it before the
   *  greeting, so the first thing the app says already uses the good voice. */
  readonly ready: Promise<void>;

  /** `listVoices` is not defaulted on purpose: a unit test that constructs
   *  this class should not spawn `say -v ?` to find out what is installed on
   *  whichever machine happens to be running it. main.ts passes the real one. */
  constructor(
    config: SpeechConfig,
    run: SpeechRunner = defaultSpeechRunner,
    listVoices?: VoiceLister,
  ) {
    this.#config = config;
    this.#run = run;
    this.#names = { ar: config.arabicVoice, en: config.englishVoice };

    // Resolved once, eagerly, and read synchronously by speak(). Awaiting
    // inside speak() would defer the spawn by a microtask, and a barge-in
    // that arrives in that window would find nothing in flight to stop.
    this.ready =
      listVoices === undefined
        ? Promise.resolve()
        : listVoices()
            .then((installed) => {
              this.#names.ar = bestVariant(config.arabicVoice, installed);
              if (config.englishVoice !== undefined) {
                this.#names.en = bestVariant(config.englishVoice, installed);
              }
            })
            // Listing is an optimisation, not a requirement: a failure leaves
            // the configured names exactly as written.
            .catch(() => undefined);
  }

  async speak(text: string, language: "ar" | "en"): Promise<void> {
    if (text.trim() === "") return;
    this.stopSpeaking();

    const voice = language === "ar" ? this.#names.ar : this.#names.en;
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


/** Every installed voice, for the Settings picker. */
export async function listInstalledVoices(): Promise<InstalledVoice[]> {
  return parseVoices(await sayVoiceOutput());
}

/** The real voice lister. */
export const defaultVoiceLister: VoiceLister = async () => parseVoiceList(await sayVoiceOutput());

function sayVoiceOutput(): Promise<string> {
  const child = spawn("say", ["-v", "?"], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (output += chunk));

  return new Promise((resolve) => {
    child.on("error", () => resolve(""));
    child.on("close", () => resolve(output));
  });
}
