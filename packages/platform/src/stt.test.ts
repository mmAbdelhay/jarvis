import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseWhisperOutput, transcribe } from "./stt.js";
import type { WhisperConfig } from "./stt.js";
import { runCommand } from "./spawn.js";

describe("parseWhisperOutput", () => {
  it("extracts the transcript text", () => {
    const result = parseWhisperOutput(" افتح مشروع متجر أكمي\n", "");
    expect(result.text).toBe("افتح مشروع متجر أكمي");
  });

  it("extracts the auto-detected language from stderr", () => {
    const stderr = "whisper_full_with_state: auto-detected language: ar (p = 0.998946)";
    expect(parseWhisperOutput("نص", stderr).language).toBe("ar");
  });

  it("defaults to en when no language line is present", () => {
    expect(parseWhisperOutput("hello", "").language).toBe("en");
  });

  it("joins multi-line transcripts with single spaces", () => {
    expect(parseWhisperOutput(" line one\n line two\n", "").text).toBe("line one line two");
  });

  it("returns empty text for silence", () => {
    expect(parseWhisperOutput("\n\n", "").text).toBe("");
  });

  it("lowercases a language code reported in mixed case", () => {
    const stderr = "auto-detected language: EN (p = 0.987654)";
    expect(parseWhisperOutput("hello", stderr).language).toBe("en");
  });

  it("ignores unrelated stderr noise when extracting language", () => {
    const stderr = [
      "whisper_init_state: loading Core ML model",
      "whisper_full_with_state: auto-detected language: fr (p = 0.912345)",
      "whisper_print_timings:     load time =   145.13 ms",
    ].join("\n");
    expect(parseWhisperOutput("bonjour", stderr).language).toBe("fr");
  });

  it("captures three-letter language codes in full instead of truncating them", () => {
    const stderr = "auto-detected language: yue (p = 0.912345)";
    expect(parseWhisperOutput("你好", stderr).language).toBe("yue");
  });
});

describe("transcribe", () => {
  it("invokes the whisper binary with the model, auto language, no-timestamps, and the wav path", async () => {
    const calls: { command: string; args: string[] }[] = [];
    const fakeRun = async (command: string, args: string[]) => {
      calls.push({ command, args });
      return { code: 0, stdout: "hi\n", stderr: "" };
    };
    const config: WhisperConfig = { binaryPath: "/bin/whisper-cli", modelPath: "/models/ggml-base.bin" };

    await transcribe("/tmp/audio.wav", config, fakeRun);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/bin/whisper-cli");
    expect(calls[0]?.args).toEqual([
      "-m", "/models/ggml-base.bin",
      "-l", "auto",
      "-nt",
      "-f", "/tmp/audio.wav",
    ]);
  });

  it("returns the parsed transcript and detected language from the runner's output", async () => {
    const fakeRun = async () => ({
      code: 0,
      stdout: " hello there\n",
      stderr: "auto-detected language: ar (p = 0.999)",
    });
    const config: WhisperConfig = { binaryPath: "/bin/whisper-cli", modelPath: "/models/ggml-base.bin" };

    const result = await transcribe("/tmp/audio.wav", config, fakeRun);

    expect(result).toEqual({ text: "hello there", language: "ar" });
  });

  it("throws when whisper exits with a non-zero code instead of returning a silent-looking transcript", async () => {
    const fakeRun = async () => ({
      code: 1,
      stdout: "",
      stderr: "error: failed to load model",
    });
    const config: WhisperConfig = { binaryPath: "/bin/whisper-cli", modelPath: "/models/ggml-base.bin" };

    await expect(transcribe("/tmp/audio.wav", config, fakeRun)).rejects.toThrow();
  });
});

const whisper = join(homedir(), ".voicemode/services/whisper/build/bin/whisper-cli");
const model = join(homedir(), ".voicemode/services/whisper/models/ggml-base.bin");
const fixture = fileURLToPath(new URL("../test-fixtures/ar_test.wav", import.meta.url));
const installed = existsSync(whisper) && existsSync(model);

describe.skipIf(!installed)("transcribe (integration)", () => {
  it("transcribes Arabic audio and detects the language", async () => {
    const result = await transcribe(fixture, { binaryPath: whisper, modelPath: model }, runCommand);
    expect(result.language).toBe("ar");
    // What the fixture recording actually says. Unrelated to the example
    // project names elsewhere — this asserts a transcription, not a config.
    expect(result.text).toContain("سعودي");
  }, 60_000);
});
