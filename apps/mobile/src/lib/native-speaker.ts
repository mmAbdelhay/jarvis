// A thin wrapper over `expo-speech` — behaviour rules 6 and 8 in
// task-6-brief.md / ruling 8. Segmenting and language-tag decisions live
// in `speaker.ts`; this file only drives the native module. Names used
// from the installed `expo-speech@57.0.3` (Speech.d.ts):
//   `speak(text, options)` with `options.language`, `.onDone`,
//     `.onStopped`, `.onError` (Speech.types.d.ts's `SpeechOptions`).
//   `stop(): Promise<void>`.
//   `getAvailableVoicesAsync(): Promise<Voice[]>`, `Voice.language`.
//   `maxSpeechInputLength: number`.
//
// `createNativeSpeaker` itself is not exercised by any test here (native
// only — global constraint): `expo-speech` is loaded lazily with `require`
// inside each function, as `native-transport.ts` does, so a static
// `import` never reaches Vitest. `buildSpeaker` below is exported
// separately and IS unit-tested (native-speaker.test.ts, fix round 1): it
// takes a `SpeechModule` loader as a plain argument instead of calling
// `require` itself, so a test can hand it a fake — the same shape
// `native-voice-recorder.tsx`'s `buildVoiceRecorder` uses.
import type { Language } from "./i18n";
import { speechLanguageTag, splitForSpeech, voiceMatches } from "./speaker";
import type { SpeakOutcome, Speaker } from "./speaker";

// Declared locally, not imported from `@types/node` — see
// native-transport.ts's identical declaration and its comment.
declare function require(id: string): unknown;

const DEFAULT_MAX_SPEECH_INPUT_LENGTH = 4000;

export type Voice = { language: string };

export type SpeechOptions = {
  language?: string;
  onDone?: () => void;
  onStopped?: () => void;
  onError?: (error: Error) => void;
};

export type SpeechModule = {
  speak(text: string, options?: SpeechOptions): void;
  stop(): Promise<void>;
  getAvailableVoicesAsync(): Promise<Voice[]>;
  maxSpeechInputLength: number;
};

function loadSpeech(): SpeechModule {
  return require("expo-speech") as SpeechModule;
}

/** Builds the `Speaker` behaviour over an already-obtained `SpeechModule`
 * loader — see the file header for why this is separate from
 * `createNativeSpeaker`. */
export function buildSpeaker(getSpeech: () => SpeechModule): Speaker {
  let pendingResolve: ((outcome: SpeakOutcome) => void) | undefined;
  // Scoped to this Speaker instance, not the module — `createNativeSpeaker`
  // is expected to be called once per app session (Task 7's controller),
  // so this still caches `getAvailableVoicesAsync()` once per session
  // (behaviour rule 6) while giving each test its own cache.
  let voicesPromise: Promise<Voice[]> | undefined;

  // Cancels whatever is currently speaking. An overlapping `speak()` call
  // uses this too: `Speech.speak()` on its own would *queue* the new
  // utterance after the one in flight (Speech.d.ts's own jsdoc), but
  // `Speaker.speak()` promises one outcome per call — queueing would
  // leave the earlier call's promise waiting on a native callback for an
  // utterance the caller no longer holds a reference to. So a second
  // `speak()` cancels the first the same way an explicit `stop()` would
  // (fix round 1, Minor #4: overlapping calls cancel, they do not queue).
  function cancelPending(Speech: SpeechModule): void {
    void Speech.stop();
    if (pendingResolve) {
      const resolve = pendingResolve;
      pendingResolve = undefined;
      resolve("stopped");
    }
  }

  function getVoices(Speech: SpeechModule): Promise<Voice[]> {
    if (!voicesPromise) voicesPromise = Speech.getAvailableVoicesAsync();
    return voicesPromise;
  }

  return {
    speak(text: string, language: Language): Promise<SpeakOutcome> {
      const Speech = getSpeech();
      cancelPending(Speech);

      const max =
        Number.isFinite(Speech.maxSpeechInputLength) && Speech.maxSpeechInputLength > 0
          ? Speech.maxSpeechInputLength
          : DEFAULT_MAX_SPEECH_INPUT_LENGTH;
      const segments = splitForSpeech(text, max);

      return new Promise<SpeakOutcome>((resolve) => {
        if (segments.length === 0) {
          resolve("done");
          return;
        }

        pendingResolve = resolve;
        let index = 0;

        const speakNext = (): void => {
          try {
            Speech.speak(segments[index], {
              language: speechLanguageTag(language),
              onStopped: () => {
                pendingResolve = undefined;
                resolve("stopped");
              },
              onError: () => {
                pendingResolve = undefined;
                resolve("failed");
              },
              onDone: () => {
                index += 1;
                if (index >= segments.length) {
                  pendingResolve = undefined;
                  resolve("done");
                } else {
                  speakNext();
                }
              },
            });
          } catch {
            // `Speech.speak` can throw synchronously (for example, a
            // segment over `maxSpeechInputLength`). Called again here
            // from inside `onDone` — a native callback, not this
            // function's own initial (Promise-executor-wrapped) call —
            // an uncaught throw would leave the promise settled never:
            // "errors are values" instead (fix round 1, Minor #2).
            pendingResolve = undefined;
            resolve("failed");
          }
        };
        speakNext();
      });
    },

    stop(): void {
      cancelPending(getSpeech());
    },

    async hasVoice(language: Language): Promise<boolean> {
      const Speech = getSpeech();
      try {
        const voices = await getVoices(Speech);
        if (voices.length === 0) return true;
        return voices.some((voice) => voiceMatches(voice.language, language));
      } catch {
        // Do not cache a rejected lookup — a transient failure would
        // otherwise make every later `hasVoice` answer `true` forever
        // (fix round 1, Minor #3). A later call retries.
        voicesPromise = undefined;
        return true;
      }
    },
  };
}

export function createNativeSpeaker(): Speaker {
  return buildSpeaker(loadSpeech);
}
