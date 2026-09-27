// The browser build's speaker (Task 13): `speechSynthesis` in place of
// `expo-speech`. Speaking reuses `buildSpeaker` (speech-speaker.ts) over a
// small `SpeechModule` adapter, so segmenting, cancel-on-overlap and the
// outcome mapping are the same code as native. `hasVoice` is stricter than
// native: it answers `false` when the browser has no voice for the
// language (`hasVoiceAmong`), and the UI then shows the reply as text.
import type { Language } from "./i18n";
import { buildSpeaker, type SpeechModule, type SpeechOptions, type Voice } from "./speech-speaker";
import type { Speaker } from "./speaker";
import { hasVoiceAmong, voiceMatches } from "./speaker";

// Chromium cuts off a single long utterance after ~15 s; short segments
// (split at sentence ends by `splitForSpeech`) avoid that.
const WEB_MAX_SPEECH_INPUT_LENGTH = 200;
// `getVoices()` is empty until the browser has loaded its voice list; wait
// this long for `voiceschanged` before answering with what there is.
const VOICES_WAIT_MS = 1500;

function synth(): SpeechSynthesis | undefined {
  return typeof speechSynthesis === "undefined" ? undefined : speechSynthesis;
}

function loadVoices(): Promise<SpeechSynthesisVoice[]> {
  const engine = synth();
  if (engine === undefined) return Promise.resolve([]);
  const now = engine.getVoices();
  if (now.length > 0) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      engine.removeEventListener("voiceschanged", done);
      resolve(engine.getVoices());
    };
    const timer = setTimeout(done, VOICES_WAIT_MS);
    engine.addEventListener("voiceschanged", done);
  });
}

function toVoices(voices: SpeechSynthesisVoice[]): Voice[] {
  return voices.map((voice) => ({ language: voice.lang }));
}

const webSpeechModule: SpeechModule = {
  maxSpeechInputLength: WEB_MAX_SPEECH_INPUT_LENGTH,

  speak(text: string, options?: SpeechOptions): void {
    const engine = synth();
    if (engine === undefined) throw new Error("speechSynthesis unavailable");
    const utterance = new SpeechSynthesisUtterance(text);
    const tag = options?.language;
    if (tag !== undefined) {
      utterance.lang = tag;
      const language: Language = tag.startsWith("ar") ? "ar" : "en";
      const voice = engine.getVoices().find((v) => voiceMatches(v.lang, language));
      if (voice !== undefined) utterance.voice = voice;
    }
    utterance.onend = () => options?.onDone?.();
    utterance.onerror = (event) => {
      if (event.error === "canceled" || event.error === "interrupted") {
        options?.onStopped?.();
        return;
      }
      options?.onError?.(new Error(event.error));
    };
    engine.speak(utterance);
  },

  async stop(): Promise<void> {
    synth()?.cancel();
  },

  async getAvailableVoicesAsync(): Promise<Voice[]> {
    return toVoices(await loadVoices());
  },
};

export function createNativeSpeaker(): Speaker {
  const base = buildSpeaker(() => webSpeechModule);
  return {
    speak: base.speak,
    stop: base.stop,
    async hasVoice(language: Language): Promise<boolean> {
      return hasVoiceAmong(await webSpeechModule.getAvailableVoicesAsync(), language);
    },
  };
}
