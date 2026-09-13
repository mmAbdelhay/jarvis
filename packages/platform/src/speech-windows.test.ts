import { describe, expect, it } from "vitest";
import type { SpeechRunner } from "./speech.js";
import {
  WindowsSpeech,
  encodedCommandArgs,
  parseWindowsVoices,
  speakScript,
  windowsPowerShellPath,
} from "./speech-windows.js";

function decode(args: readonly string[]): string {
  const index = args.indexOf("-EncodedCommand");
  return Buffer.from(args[index + 1] ?? "", "base64").toString("utf16le");
}

function runner(code = 0) {
  const calls: { command: string; args: string[]; killed: boolean }[] = [];
  const run: SpeechRunner = (command, args) => {
    const call = { command, args, killed: false };
    calls.push(call);
    return {
      kill: () => {
        call.killed = true;
      },
      done: Promise.resolve({ code }),
    };
  };
  return { run, calls };
}

const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

describe("speakScript", () => {
  it("prefers the configured voice, then any voice of the language, then the default", () => {
    const script = speakScript("Good evening", "en", "Microsoft David Desktop");

    expect(script).toContain("$wanted = 'Microsoft David Desktop'");
    expect(script).toContain("$language = 'en'");
    expect(script).toContain("TwoLetterISOLanguageName -eq $language");
    expect(script).toContain("$s.Speak('Good evening')");
  });

  // The defaults in config.ts are macOS's voice names, so a configured voice
  // that is not installed here is the ordinary case, not an error.
  it("quotes the text as a PowerShell literal, apostrophes doubled, Arabic intact", () => {
    const script = speakScript("it's مساء الخير", "ar", undefined);

    expect(script).toContain("$s.Speak('it''s مساء الخير')");
    expect(script).toContain("$wanted = ''");
  });
});

describe("encodedCommandArgs", () => {
  // A command line goes through the console code page, which is not UTF-8 on
  // Windows PowerShell; an Arabic greeting passed as an argument arrives as
  // question marks.
  it("hands the script over as UTF-16LE base64, in a silent profile-less shell", () => {
    const args = encodedCommandArgs("Write-Output 'مرحبا'");

    expect(args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
    expect(decode(args)).toBe("Write-Output 'مرحبا'");
  });
});

describe("parseWindowsVoices", () => {
  it("reads Name<TAB>Culture lines, CRLF included, into say's spelling of the tag", () => {
    const output = "Microsoft David Desktop\ten-US\r\nMicrosoft Naayf Desktop\tar-SA\r\n\r\n";

    expect(parseWindowsVoices(output)).toEqual([
      { name: "Microsoft David Desktop", language: "en_US", upgraded: false },
      { name: "Microsoft Naayf Desktop", language: "ar_SA", upgraded: false },
    ]);
  });

  it("skips a line that carries no culture", () => {
    expect(parseWindowsVoices("garbage\nMicrosoft Zira Desktop\ten-US")).toEqual([
      { name: "Microsoft Zira Desktop", language: "en_US", upgraded: false },
    ]);
  });
});

describe("WindowsSpeech", () => {
  it("speaks through PowerShell with the voice configured for the language", async () => {
    const { run, calls } = runner();
    const speech = new WindowsSpeech(
      { arabicVoice: "Naayf", englishVoice: "David" },
      run,
      POWERSHELL,
    );

    await speech.speak("hello", "en");
    await speech.speak("مرحبا", "ar");

    expect(calls.map((call) => call.command)).toEqual([POWERSHELL, POWERSHELL]);
    expect(decode(calls[0]?.args ?? [])).toContain("$wanted = 'David'");
    expect(decode(calls[1]?.args ?? [])).toContain("$wanted = 'Naayf'");
  });

  it("says nothing for blank text, and reports a PowerShell that failed", async () => {
    const { run, calls } = runner(1);
    const speech = new WindowsSpeech({ arabicVoice: "x" }, run, POWERSHELL);

    await speech.speak("   ", "en");
    expect(calls).toHaveLength(0);

    await expect(speech.speak("hi", "en")).rejects.toThrow("exited with code 1");
  });

  // The same barge-in contract MacSpeech has.
  it("kills the utterance in flight when told to stop", async () => {
    const { run, calls } = runner();
    const speech = new WindowsSpeech({ arabicVoice: "x" }, run, POWERSHELL);

    const speaking = speech.speak("one", "en");
    speech.stopSpeaking();
    await speaking;

    expect(calls[0]?.killed).toBe(true);
  });

  it("has a ready promise main can await, as MacSpeech does", async () => {
    const { run } = runner();
    await expect(
      new WindowsSpeech({ arabicVoice: "x" }, run, POWERSHELL).ready,
    ).resolves.toBeUndefined();
  });
});

describe("windowsPowerShellPath", () => {
  it("lives under SystemRoot, wherever that is", () => {
    expect(windowsPowerShellPath({ SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(windowsPowerShellPath({})).toContain("C:\\Windows");
  });
});
