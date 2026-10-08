// Push-to-talk I/O for jarvisd (Rafiq M3 §2, §4): the WAV check, which
// whisper model and Piper voices are installed, and the two side effects —
// transcribing a recording (Jarvis's stt.ts) and speaking a reply (Jarvis's
// PiperSpeech). Recordings go to a private temp dir that is always removed;
// transcripts are never logged.
//
// No electron here (core/no-electron.test.ts).
import { posix } from "node:path";
import {
  CONTROL_TEXT,
  type CommandRunner,
  type VoiceAvailability,
  type VoiceLang,
} from "@jarvis/core";
import { transcribe } from "@jarvis/platform/voice";
import { MAX_VOICE_BYTES } from "@jarvis/wire";

export const VOICE_DIR = "/usr/share/jarvis/voice";
export const WHISPER_BIN = "/usr/lib/jarvis/voice/bin/whisper-cli";
export const PIPER_BIN = "/usr/lib/jarvis/voice/bin/piper";
/** Contracts §4: ggml-base up to 8 GB of RAM, ggml-small above. */
export const SMALL_STT_MIN_RAM_BYTES = 8 * 1024 ** 3;
export const TTS_VOICES: Readonly<Record<VoiceLang, string>> = {
  en: "en_US-amy-medium",
  ar: "ar_JO-kareem-medium",
};
const LANGS: readonly VoiceLang[] = ["en", "ar"];
const SAMPLE_RATE = 16_000;
const MIN_SPEECH_MS = 200;

export type WavCheck = { ok: true; durationMs: number } | { ok: false };

export function checkWav(bytes: Uint8Array): WavCheck {
  if (bytes.byteLength < 44 || bytes.byteLength > MAX_VOICE_BYTES) return { ok: false };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => {
    let text = "";
    for (let i = 0; i < 4; i++) text += String.fromCharCode(view.getUint8(at + i));
    return text;
  };
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return { ok: false };
  let format: { audio: number; channels: number; rate: number; bits: number } | undefined;
  let dataBytes: number | undefined;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === "data") {
      if (format === undefined) return { ok: false };
      // Streaming recorders may leave the size at 0xFFFFFFFF: trust the bytes.
      dataBytes = Math.min(size, bytes.byteLength - body);
      break;
    }
    if (body + size > bytes.byteLength) return { ok: false };
    if (id === "fmt ") {
      if (size < 16) return { ok: false };
      format = {
        audio: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    }
    offset = body + size + (size % 2);
  }
  if (format === undefined || dataBytes === undefined) return { ok: false };
  if (
    format.audio !== 1 ||
    format.channels !== 1 ||
    format.rate !== SAMPLE_RATE ||
    format.bits !== 16
  ) {
    return { ok: false };
  }
  const durationMs = Math.floor((dataBytes / 2 / SAMPLE_RATE) * 1000);
  return durationMs < MIN_SPEECH_MS ? { ok: false } : { ok: true, durationMs };
}

export type VoiceModels = {
  whisperBin: string;
  stt: { id: string; path: string } | null;
  piperBin: string;
  tts: Partial<Record<VoiceLang, { id: string; path: string }>>;
};

export function resolveVoiceModels(o: {
  dir: string;
  whisperBin: string;
  piperBin: string;
  memTotalBytes: number;
  exists(path: string): boolean;
}): VoiceModels {
  const sttPath = (id: string) => posix.join(o.dir, "stt", `${id}.bin`);
  const order =
    o.memTotalBytes > SMALL_STT_MIN_RAM_BYTES
      ? ["ggml-small", "ggml-base"]
      : ["ggml-base", "ggml-small"];
  const sttId = o.exists(o.whisperBin) ? order.find((id) => o.exists(sttPath(id))) : undefined;
  const tts: VoiceModels["tts"] = {};
  if (o.exists(o.piperBin)) {
    for (const lang of LANGS) {
      const id = TTS_VOICES[lang];
      const path = posix.join(o.dir, "tts", `${id}.onnx`);
      if (o.exists(path)) tts[lang] = { id, path };
    }
  }
  return {
    whisperBin: o.whisperBin,
    stt: sttId === undefined ? null : { id: sttId, path: sttPath(sttId) },
    piperBin: o.piperBin,
    tts,
  };
}

export function voiceAvailability(models: VoiceModels): VoiceAvailability {
  return {
    available: models.stt !== null,
    stt: models.stt?.id ?? null,
    tts: models.tts.en?.id ?? models.tts.ar?.id ?? null,
    speak: false,
  };
}

export type Speaker = {
  speak(text: string, language: VoiceLang): Promise<void>;
  stopSpeaking(): void;
};

export type VoiceIo = {
  availability(): VoiceAvailability;
  transcribe(
    wav: Uint8Array,
    lang: "auto" | "en" | "ar",
  ): Promise<{ text: string; language: VoiceLang }>;
  /** false when no voice is installed for `lang` (nothing is said). */
  speak(text: string, lang: VoiceLang): Promise<boolean>;
  stopSpeaking(): void;
};

export class VoiceUnavailableError extends Error {
  constructor() {
    super(CONTROL_TEXT.en.voiceUnavailable);
    this.name = "VoiceUnavailableError";
  }
}

export function createVoiceIo(deps: {
  models: VoiceModels;
  makeTempDir(): Promise<string>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  removeDir(path: string): Promise<void>;
  run: CommandRunner;
  speakers: Partial<Record<VoiceLang, Speaker>>;
}): VoiceIo {
  const availability = voiceAvailability(deps.models);
  return {
    availability: () => availability,
    async transcribe(wav, lang) {
      const stt = deps.models.stt;
      if (stt === null) throw new VoiceUnavailableError();
      const dir = await deps.makeTempDir();
      try {
        const path = posix.join(dir, "utterance.wav");
        await deps.writeFile(path, wav);
        const heard = await transcribe(
          path,
          { binaryPath: deps.models.whisperBin, modelPath: stt.path },
          deps.run,
          lang,
        );
        return { text: heard.text, language: heard.language === "ar" ? "ar" : "en" };
      } finally {
        await deps.removeDir(dir).catch(() => {});
      }
    },
    async speak(text, lang) {
      const speaker = deps.speakers[lang];
      if (speaker === undefined) return false;
      await speaker.speak(text, lang);
      return true;
    },
    stopSpeaking() {
      for (const lang of LANGS) deps.speakers[lang]?.stopSpeaking();
    },
  };
}
