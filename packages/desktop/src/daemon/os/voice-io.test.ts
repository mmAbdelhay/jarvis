import { describe, expect, it } from "vitest";
import { makeWav } from "./__fixtures__/wav.js";
import {
  checkWav,
  createVoiceIo,
  resolveVoiceModels,
  type Speaker,
  VoiceUnavailableError,
  voiceAvailability,
} from "./voice-io.js";

describe("checkWav (contracts §2: 16 kHz mono WAV ≤ 4 MiB)", () => {
  it("accepts 16 kHz mono 16-bit PCM and reports its length", () => {
    expect(checkWav(makeWav(16_000))).toEqual({ ok: true, durationMs: 1000 });
  });
  it("refuses other formats, rates, channel counts and bit depths", () => {
    expect(checkWav(makeWav(16_000, { rate: 44_100 })).ok).toBe(false);
    expect(checkWav(makeWav(16_000, { channels: 2 })).ok).toBe(false);
    expect(checkWav(makeWav(16_000, { bits: 8 })).ok).toBe(false);
    expect(checkWav(makeWav(16_000, { format: 3 })).ok).toBe(false);
  });
  it("refuses a click, garbage and anything over 4 MiB", () => {
    expect(checkWav(makeWav(1_000)).ok).toBe(false);
    expect(checkWav(new TextEncoder().encode("RIFF....WAVEjunk")).ok).toBe(false);
    expect(checkWav(new Uint8Array(10)).ok).toBe(false);
    expect(checkWav(makeWav(2_100_000)).ok).toBe(false);
  });
});

describe("resolveVoiceModels (contracts §4)", () => {
  const all = new Set([
    "/usr/lib/jarvis/voice/bin/whisper-cli",
    "/usr/lib/jarvis/voice/bin/piper",
    "/v/stt/ggml-base.bin",
    "/v/stt/ggml-small.bin",
    "/v/tts/en_US-amy-medium.onnx",
  ]);
  const base = {
    dir: "/v",
    whisperBin: "/usr/lib/jarvis/voice/bin/whisper-cli",
    piperBin: "/usr/lib/jarvis/voice/bin/piper",
  };

  it("picks ggml-base up to 8 GB and ggml-small above", () => {
    const small = resolveVoiceModels({
      ...base,
      memTotalBytes: 16 * 1024 ** 3,
      exists: (p) => all.has(p),
    });
    const low = resolveVoiceModels({
      ...base,
      memTotalBytes: 8 * 1024 ** 3,
      exists: (p) => all.has(p),
    });
    expect(small.stt).toEqual({ id: "ggml-small", path: "/v/stt/ggml-small.bin" });
    expect(low.stt).toEqual({ id: "ggml-base", path: "/v/stt/ggml-base.bin" });
    expect(voiceAvailability(low)).toEqual({
      available: true,
      stt: "ggml-base",
      tts: "en_US-amy-medium",
      speak: false,
    });
  });

  it("has no voice without whisper-cli or a model, and no Arabic voice unless shipped", () => {
    const none = resolveVoiceModels({
      ...base,
      memTotalBytes: 4e9,
      exists: (p) => p !== "/usr/lib/jarvis/voice/bin/whisper-cli" && all.has(p),
    });
    expect(voiceAvailability(none)).toEqual({
      available: false,
      stt: null,
      tts: "en_US-amy-medium",
      speak: false,
    });
    expect(none.tts.ar).toBeUndefined();
  });
});

describe("createVoiceIo", () => {
  function io(over: { speakers?: Partial<Record<"en" | "ar", Speaker>>; code?: number } = {}) {
    const removed: string[] = [];
    const written: { path: string; bytes: number }[] = [];
    const runs: string[][] = [];
    const voice = createVoiceIo({
      models: {
        whisperBin: "/usr/lib/jarvis/voice/bin/whisper-cli",
        stt: { id: "ggml-base", path: "/v/stt/ggml-base.bin" },
        piperBin: "/usr/lib/jarvis/voice/bin/piper",
        tts: {},
      },
      makeTempDir: async () => "/run/user/1000/jarvis-voice-x",
      writeFile: async (path, bytes) => {
        written.push({ path, bytes: bytes.byteLength });
      },
      removeDir: async (path) => {
        removed.push(path);
      },
      run: async (command, args) => {
        runs.push([command, ...args]);
        return { code: over.code ?? 0, stdout: "yes\n", stderr: "auto-detected language: en" };
      },
      speakers: over.speakers ?? {},
    });
    return { voice, removed, written, runs };
  }

  it("writes the recording to a private temp dir, runs whisper, and always cleans up", async () => {
    const h = io();
    await expect(h.voice.transcribe(makeWav(16_000), "auto")).resolves.toEqual({
      text: "yes",
      language: "en",
    });
    expect(h.written).toEqual([
      { path: "/run/user/1000/jarvis-voice-x/utterance.wav", bytes: 32_044 },
    ]);
    expect(h.runs[0]?.slice(0, 5)).toEqual([
      "/usr/lib/jarvis/voice/bin/whisper-cli",
      "-m",
      "/v/stt/ggml-base.bin",
      "-l",
      "auto",
    ]);
    expect(h.removed).toEqual(["/run/user/1000/jarvis-voice-x"]);
    const failing = io({ code: 1 });
    await expect(failing.voice.transcribe(makeWav(16_000), "en")).rejects.toThrow();
    expect(failing.removed).toEqual(["/run/user/1000/jarvis-voice-x"]);
  });

  it("refuses to transcribe with no model", async () => {
    const voice = createVoiceIo({
      models: {
        whisperBin: "/usr/lib/jarvis/voice/bin/whisper-cli",
        stt: null,
        piperBin: "/usr/lib/jarvis/voice/bin/piper",
        tts: {},
      },
      makeTempDir: async () => "/x",
      writeFile: async () => {},
      removeDir: async () => {},
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      speakers: {},
    });
    await expect(voice.transcribe(makeWav(16_000), "auto")).rejects.toBeInstanceOf(
      VoiceUnavailableError,
    );
  });

  it("speaks only in a language it has a voice for", async () => {
    const said: string[] = [];
    let stopped = 0;
    const speaker: Speaker = {
      speak: async (text) => {
        said.push(text);
      },
      stopSpeaking: () => {
        stopped++;
      },
    };
    const h = io({ speakers: { en: speaker } });
    await expect(h.voice.speak("Done.", "en")).resolves.toBe(true);
    await expect(h.voice.speak("تم", "ar")).resolves.toBe(false);
    h.voice.stopSpeaking();
    expect(said).toEqual(["Done."]);
    expect(stopped).toBe(1);
  });
});
