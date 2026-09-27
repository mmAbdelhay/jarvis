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
import type { Speaker } from "./speaker";
import { buildSpeaker, type SpeechModule } from "./speech-speaker";

export { buildSpeaker } from "./speech-speaker";
export type { SpeechModule, SpeechOptions, Voice } from "./speech-speaker";

// Declared locally, not imported from `@types/node` — see
// native-transport.ts's identical declaration and its comment.
declare function require(id: string): unknown;

function loadSpeech(): SpeechModule {
  return require("expo-speech") as SpeechModule;
}

export function createNativeSpeaker(): Speaker {
  return buildSpeaker(loadSpeech);
}
