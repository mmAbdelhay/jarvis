// The pure decision layer behind native audio recording (M8 Task 6:
// `expo-audio`). `native-voice-recorder.tsx` is a thin hook over
// `expo-audio`'s `useAudioRecorder`/`AudioModule` and the values below —
// everything here is plain data and pure functions, so it is unit-tested
// without a simulator (global constraint: native adapters carry no logic
// of their own to test).
//
// `RecordingOptions` is imported type-only from `expo-audio`: erased at
// transform time, so this file never touches the real package (see
// native-transport.ts's identical note on `import type`). The iOS
// `outputFormat`/`audioQuality` values below are therefore written as the
// literal values of `expo-audio`'s real enums, not as a value import of
// those enums — verified against the installed `expo-audio` d.ts:
//   RecordingConstants.d.ts: `IOSOutputFormat.MPEG4AAC = "aac "`,
//   `AudioQuality.MEDIUM = 64`.
import type { RecordingOptions } from "expo-audio";

export type MicPermission = "granted" | "undetermined" | "denied" | "blocked";

/** The container a recording is in — sent as the upload meta's `format`
 * so the laptop knows what it is decoding. Native always records m4a; the
 * browser build may record webm/opus (Task 13). */
export type RecordingFormat = "m4a" | "webm";

export type Recording = { uri: string; durationMs: number; format: RecordingFormat };

export type VoiceRecorder = {
  permission(): Promise<MicPermission>;
  requestPermission(): Promise<MicPermission>;
  start(): Promise<void>;
  stop(): Promise<Recording | undefined>;
  elapsedMs(): number;
};

/** Maps `expo-audio`'s `PermissionResponse` shape (also `AudioModule`'s
 * `requestRecordingPermissionsAsync`/`getRecordingPermissionsAsync` return
 * type) to this app's four-state permission. */
export function toMicPermission(response: {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
}): MicPermission {
  if (response.granted) return "granted";
  if (response.status === "undetermined") return "undetermined";
  if (!response.canAskAgain) return "blocked";
  return "denied";
}

export const RECORDING_OPTIONS: RecordingOptions = Object.freeze({
  extension: ".m4a",
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: Object.freeze({
    outputFormat: "mpeg4",
    audioEncoder: "aac",
  }),
  ios: Object.freeze({
    outputFormat: "aac ", // IOSOutputFormat.MPEG4AAC
    audioQuality: 64, // AudioQuality.MEDIUM
  }),
  web: Object.freeze({}),
}) as RecordingOptions;

export const FALLBACK_RECORDING_OPTIONS: RecordingOptions = Object.freeze({
  ...RECORDING_OPTIONS,
  sampleRate: 44100,
  bitRate: 64000,
}) as RecordingOptions;

/** One MediaRecorder configuration the browser build may try (Task 13). */
export type WebRecordingCandidate = { mimeType: string; format: RecordingFormat };

const WEB_RECORDING_PREFERENCES: ReadonlyArray<WebRecordingCandidate> = Object.freeze([
  Object.freeze({ mimeType: "audio/mp4", format: "m4a" as const }),
  Object.freeze({ mimeType: "audio/webm;codecs=opus", format: "webm" as const }),
]);

/** The same bit rate as the native recording (`RECORDING_OPTIONS`), so a
 * full 120 s recording stays far below the 4 MiB upload limit. */
export const WEB_RECORDING_BITS_PER_SECOND = 32000;

/** The configurations to try, in order: `audio/mp4` first, then
 * `audio/webm;codecs=opus` — each only if `isTypeSupported` says so (a
 * throw counts as "no"). The web recorder tries the first, and retries
 * once with the next if the first constructor fails — the native
 * recorder's one-retry rule. */
export function webRecordingCandidates(
  isTypeSupported: (mimeType: string) => boolean,
): WebRecordingCandidate[] {
  return WEB_RECORDING_PREFERENCES.filter((candidate) => {
    try {
      return isTypeSupported(candidate.mimeType);
    } catch {
      return false;
    }
  }).map((candidate) => ({ ...candidate }));
}

/** The Permissions API's microphone state → this app's permission. A
 * browser remembers a denial until the user changes it in site settings,
 * so `denied` is `blocked`, never re-askable. An unknown state (no
 * Permissions API, or it refused the query) is `undetermined`. */
export function webMicPermission(state: string | undefined): MicPermission {
  if (state === "granted") return "granted";
  if (state === "denied") return "blocked";
  return "undetermined";
}
