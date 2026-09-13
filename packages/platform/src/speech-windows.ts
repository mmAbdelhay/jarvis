import { spawn } from "node:child_process";
import type { InstalledVoice, SpeechConfig, SpeechRunner } from "./speech.js";

// Windows' own voices, through System.Speech — the SAPI engine every Windows
// has, driven from PowerShell because there is no `say` to call.
//
// It fills the same slot MacSpeech fills on darwin: the system voice, always
// present, and the thing that speaks when Piper is not installed. Linux has
// no equivalent — no voice engine ships on every machine there — which is
// why that platform has Piper or silence and this one does not.
//
// Everything reaches PowerShell as an -EncodedCommand (base64 UTF-16LE): the
// text is arbitrary and bilingual, and a command line goes through the
// console code page, which is not UTF-8 on Windows PowerShell — an Arabic
// greeting passed as an argument arrives as question marks.

/** Where Windows PowerShell lives on every installation. PowerShell 7 is not
 *  needed for System.Speech and may not be there. */
export function windowsPowerShellPath(env: NodeJS.ProcessEnv): string {
  const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** A PowerShell single-quoted literal: the only escape is a doubled quote. */
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** The arguments that run `script` in a fresh, silent PowerShell. */
export function encodedCommandArgs(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

/**
 * The script that speaks one utterance.
 *
 * Voice choice is best-effort in three steps: the configured name if it is
 * installed, else the first installed voice for the language, else whatever
 * the system default is. A configured name that is not installed is the
 * ordinary case on a fresh machine — the defaults in config.ts are macOS's
 * names — and going silent over it is the one outcome this must not have.
 */
export function speakScript(
  text: string,
  language: "ar" | "en",
  voice: string | undefined,
): string {
  return [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$s.SetOutputToDefaultAudioDevice()",
    `$wanted = ${psQuote(voice ?? "")}`,
    `$language = ${psQuote(language)}`,
    "$voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo })",
    "$pick = $voices | Where-Object { $_.Name -eq $wanted } | Select-Object -First 1",
    "if (-not $pick) { $pick = $voices | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $language } | Select-Object -First 1 }",
    "if ($pick) { try { $s.SelectVoice($pick.Name) } catch {} }",
    `$s.Speak(${psQuote(text)})`,
  ].join("\n");
}

/** The script that lists installed voices as `Name<TAB>Culture` lines. */
export const LIST_VOICES_SCRIPT = [
  // stdout is read as UTF-8 below; Windows PowerShell would otherwise write
  // it in the OEM code page, and a voice name is not guaranteed ASCII.
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  '$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + "`t" + $_.VoiceInfo.Culture.Name }',
].join("\n");

/** `Name<TAB>Culture` lines to voices. The culture arrives as `en-US` and is
 *  reported as `en_US`, the spelling `say` uses, so the Settings picker
 *  groups both platforms' voices by one rule. Nothing on Windows is an
 *  Enhanced download, so `upgraded` is always false. */
export function parseWindowsVoices(output: string): InstalledVoice[] {
  const voices: InstalledVoice[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab).trim();
    const language = line
      .slice(tab + 1)
      .trim()
      .replaceAll("-", "_");
    if (name === "" || language === "") continue;
    voices.push({ name, language, upgraded: false });
  }
  return voices;
}

export class WindowsSpeech {
  readonly #config: SpeechConfig;
  readonly #run: SpeechRunner;
  readonly #powershell: string;
  #current: { kill(): void } | undefined;
  /** Nothing to resolve up front — Windows voices have no Enhanced variants
   *  to upgrade to — but main awaits `ready` on whichever engine it holds. */
  readonly ready: Promise<void> = Promise.resolve();

  constructor(config: SpeechConfig, run: SpeechRunner, powershell: string) {
    this.#config = config;
    this.#run = run;
    this.#powershell = powershell;
  }

  async speak(text: string, language: "ar" | "en"): Promise<void> {
    if (text.trim() === "") return;
    this.stopSpeaking();

    const voice = language === "ar" ? this.#config.arabicVoice : this.#config.englishVoice;
    const utterance = this.#run(
      this.#powershell,
      encodedCommandArgs(speakScript(text, language, voice)),
    );
    this.#current = utterance;
    const result = await utterance.done;

    // Only clear #current if it still refers to this utterance: a barge-in
    // may already have replaced it. The same rule MacSpeech follows.
    if (this.#current === utterance) this.#current = undefined;

    if (result.code !== 0) {
      throw new Error(`PowerShell speech exited with code ${result.code}`);
    }
  }

  stopSpeaking(): void {
    this.#current?.kill();
    this.#current = undefined;
  }
}

/** Every installed Windows voice, for the Settings picker. */
export function listWindowsVoices(powershell: string): Promise<InstalledVoice[]> {
  const child = spawn(powershell, encodedCommandArgs(LIST_VOICES_SCRIPT), {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => (output += chunk));

  return new Promise((resolve) => {
    child.on("error", () => resolve([]));
    child.on("close", () => resolve(parseWindowsVoices(output)));
  });
}
