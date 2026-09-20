// A thin hook over `expo-audio`'s `useAudioRecorder` and `AudioModule`
// permission functions — behaviour rule 3 in task-6-brief.md. All the
// decisions (option values, the fallback retry, the permission mapping)
// live in `voice-recorder.ts`; this file only wires them to the native
// module. Names used from the installed `expo-audio@57.0.5`:
//   `useAudioRecorder(options, statusListener?)` (ExpoAudio.d.ts) — the
//     hook that creates and owns the native `AudioRecorder`.
//   `AudioRecorder#prepareToRecordAsync(options?)`, `#record()`,
//     `#stop()`, `#uri`, `#getStatus()` returning `RecorderState` with
//     `durationMillis` (AudioModule.types.d.ts).
//   `AudioModule.requestRecordingPermissionsAsync()` and
//     `.getRecordingPermissionsAsync()`, both resolving a
//     `PermissionResponse` (AudioModule.types.d.ts / PermissionsInterface.d.ts).
//   `setAudioModeAsync(mode)` (ExpoAudio.d.ts).
//
// `useNativeVoiceRecorder` itself is not exercised by any test here (no
// simulator, no React Native renderer — global constraint): `expo-audio` is
// loaded lazily with `require` inside this function, as `native-transport.ts`
// does, so a static `import` never reaches Vitest. `buildVoiceRecorder`
// below is exported separately and IS unit-tested (native-voice-recorder.test.ts,
// fix round 1): it takes already-obtained native handles as plain
// arguments, contains no hook and no `require`, so a test can hand it
// fakes directly — the same shape `native-transport.ts`'s injectable
// `NativeSocketModule` uses.
import { useMemo } from "react";
import type { RecordingOptions, RecordingStatus } from "expo-audio";
import { FALLBACK_RECORDING_OPTIONS, RECORDING_OPTIONS, toMicPermission } from "./voice-recorder";
import type { Recording, VoiceRecorder } from "./voice-recorder";

// Declared locally, not imported from `@types/node` — see
// native-transport.ts's identical declaration and its comment.
declare function require(id: string): unknown;

export type PermissionResponse = { granted: boolean; canAskAgain: boolean; status: string };

export type AudioModuleShape = {
  requestRecordingPermissionsAsync(): Promise<PermissionResponse>;
  getRecordingPermissionsAsync(): Promise<PermissionResponse>;
};

export type RecorderState = { durationMillis: number };

export type AudioRecorderShape = {
  uri: string | null;
  prepareToRecordAsync(options?: Partial<RecordingOptions>): Promise<void>;
  record(): void;
  stop(): Promise<void>;
  getStatus(): RecorderState;
};

export type SetAudioModeAsync = (mode: {
  allowsRecording?: boolean;
  playsInSilentMode?: boolean;
}) => Promise<void>;

type ExpoAudioShape = {
  useAudioRecorder(
    options: RecordingOptions,
    statusListener?: (status: RecordingStatus) => void,
  ): AudioRecorderShape;
  AudioModule: AudioModuleShape;
  setAudioModeAsync: SetAudioModeAsync;
};

function loadExpoAudio(): ExpoAudioShape {
  return require("expo-audio") as ExpoAudioShape;
}

/** Builds the `VoiceRecorder` behaviour over already-obtained native
 * handles — see the file header for why this is separate from the hook. */
export function buildVoiceRecorder(
  recorder: AudioRecorderShape,
  audioModule: AudioModuleShape,
  setAudioModeAsync: SetAudioModeAsync,
): VoiceRecorder {
  return {
    async permission() {
      return toMicPermission(await audioModule.getRecordingPermissionsAsync());
    },
    async requestPermission() {
      return toMicPermission(await audioModule.requestRecordingPermissionsAsync());
    },
    async start() {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      try {
        try {
          await recorder.prepareToRecordAsync();
        } catch {
          // One retry at the fallback rate/bit rate (ruling 3). A second
          // rejection propagates to the outer catch below.
          await recorder.prepareToRecordAsync(FALLBACK_RECORDING_OPTIONS);
        }
        recorder.record();
      } catch (error) {
        // A failed start must not leave iOS routed through the earpiece
        // (ruling 15) with no recording in progress to ever stop it and
        // restore the mode. Fix round 1, Important #2.
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        throw error;
      }
    },
    async stop(): Promise<Recording | undefined> {
      // Snapshotted *before* `stop()`: both native recorders zero
      // `durationMillis` once stopped (iOS resets duration tracking on
      // entering `.stopped`; Android's `reset()` clears it), so reading
      // it after `await recorder.stop()` always returns 0 and every
      // recording would be discarded below. `uri` survives stop on both
      // platforms, so it is still read after. Fix round 1, Critical #1.
      const durationMs = recorder.getStatus().durationMillis;
      try {
        await recorder.stop();
      } finally {
        // Leaves recording mode even when `stop()` above threw (ruling 15).
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
      }
      const { uri } = recorder;
      // No logging of `uri` here or anywhere in this file.
      if (!uri || !durationMs) return undefined;
      return { uri, durationMs };
    },
    elapsedMs() {
      return recorder.getStatus().durationMillis;
    },
  };
}

export function useNativeVoiceRecorder(): VoiceRecorder {
  const { useAudioRecorder, AudioModule, setAudioModeAsync } = loadExpoAudio();
  const recorder = useAudioRecorder(RECORDING_OPTIONS);

  return useMemo(
    () => buildVoiceRecorder(recorder, AudioModule, setAudioModeAsync),
    [recorder, AudioModule, setAudioModeAsync],
  );
}
