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

export type Recording = { uri: string; durationMs: number };

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
