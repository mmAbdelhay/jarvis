// Tests `buildVoiceRecorder` — the pure-handles builder extracted from
// `useNativeVoiceRecorder` in fix round 1 so the stop-ordering fix
// (Critical #1) and the failed-start mode restore (Important #2) have
// regression coverage without a simulator. It takes plain fakes, no hook,
// no `require` of `expo-audio`.
import { describe, expect, test } from "vitest";
import {
  buildVoiceRecorder,
  type AudioModuleShape,
  type AudioRecorderShape,
  type SetAudioModeAsync,
} from "./native-voice-recorder";

type SetAudioModeCall = { allowsRecording?: boolean; playsInSilentMode?: boolean };

function createFakeSetAudioModeAsync(): SetAudioModeAsync & { calls: SetAudioModeCall[] } {
  const calls: SetAudioModeCall[] = [];
  const fn = async (mode: SetAudioModeCall) => {
    calls.push(mode);
  };
  return Object.assign(fn, { calls });
}

function createFakeAudioModule(): AudioModuleShape {
  return {
    async requestRecordingPermissionsAsync() {
      return { granted: true, canAskAgain: true, status: "granted" };
    },
    async getRecordingPermissionsAsync() {
      return { granted: true, canAskAgain: true, status: "granted" };
    },
  };
}

function createFakeRecorder(options: {
  uri?: string | null;
  initialDurationMs?: number;
  // Mirrors both real platforms: stop() zeroes durationMillis.
  zeroDurationOnStop?: boolean;
  prepareRejects?: boolean;
  fallbackPrepareRejects?: boolean;
}): AudioRecorderShape & { recordCalls: number; prepareCalls: number } {
  const {
    uri = "file:///rec.m4a",
    initialDurationMs = 5000,
    zeroDurationOnStop = true,
    prepareRejects = false,
    fallbackPrepareRejects = false,
  } = options;

  let durationMillis = initialDurationMs;
  let prepareCalls = 0;
  let recordCalls = 0;

  return {
    uri,
    get recordCalls() {
      return recordCalls;
    },
    get prepareCalls() {
      return prepareCalls;
    },
    async prepareToRecordAsync() {
      prepareCalls += 1;
      const isFallbackAttempt = prepareCalls > 1;
      if (isFallbackAttempt ? fallbackPrepareRejects : prepareRejects) {
        throw new Error("prepare rejected");
      }
    },
    record() {
      recordCalls += 1;
    },
    async stop() {
      if (zeroDurationOnStop) durationMillis = 0;
    },
    getStatus() {
      return { durationMillis };
    },
  };
}

describe("buildVoiceRecorder: start()", () => {
  test("sets recording mode, prepares, and records", async () => {
    const recorder = createFakeRecorder({});
    const setAudioModeAsync = createFakeSetAudioModeAsync();
    const voiceRecorder = buildVoiceRecorder(recorder, createFakeAudioModule(), setAudioModeAsync);

    await voiceRecorder.start();

    expect(setAudioModeAsync.calls).toEqual([{ allowsRecording: true, playsInSilentMode: true }]);
    expect(recorder.prepareCalls).toBe(1);
    expect(recorder.recordCalls).toBe(1);
  });

  test("retries once with the fallback options when the first prepare rejects", async () => {
    const recorder = createFakeRecorder({ prepareRejects: true, fallbackPrepareRejects: false });
    const setAudioModeAsync = createFakeSetAudioModeAsync();
    const voiceRecorder = buildVoiceRecorder(recorder, createFakeAudioModule(), setAudioModeAsync);

    await voiceRecorder.start();

    expect(recorder.prepareCalls).toBe(2);
    expect(recorder.recordCalls).toBe(1);
  });

  // Important #2 (fix round 1): a failed start() must not leave iOS
  // routed through the earpiece with nothing left to stop it.
  test("a second prepare rejection restores the audio mode and rethrows", async () => {
    const recorder = createFakeRecorder({ prepareRejects: true, fallbackPrepareRejects: true });
    const setAudioModeAsync = createFakeSetAudioModeAsync();
    const voiceRecorder = buildVoiceRecorder(recorder, createFakeAudioModule(), setAudioModeAsync);

    await expect(voiceRecorder.start()).rejects.toThrow("prepare rejected");

    expect(setAudioModeAsync.calls).toEqual([
      { allowsRecording: true, playsInSilentMode: true },
      { allowsRecording: false, playsInSilentMode: true },
    ]);
    expect(recorder.recordCalls).toBe(0);
  });
});

describe("buildVoiceRecorder: stop()", () => {
  // Critical #1 (fix round 1) [bite-proof: read durationMillis after
  // `await recorder.stop()`]: both native recorders zero the duration
  // once stopped, so it must be snapshotted before `stop()` is called.
  test("returns the duration measured before the native stop() zeroed it", async () => {
    const recorder = createFakeRecorder({
      uri: "file:///rec.m4a",
      initialDurationMs: 5000,
      zeroDurationOnStop: true,
    });
    const setAudioModeAsync = createFakeSetAudioModeAsync();
    const voiceRecorder = buildVoiceRecorder(recorder, createFakeAudioModule(), setAudioModeAsync);

    const result = await voiceRecorder.stop();

    expect(result).toEqual({ uri: "file:///rec.m4a", durationMs: 5000 });
    // The native stop() really did zero it afterwards — proves the fix
    // reads the value at the right time, not that the fake never zeroes it.
    expect(recorder.getStatus().durationMillis).toBe(0);
  });

  test("restores the audio mode even when the native stop() throws", async () => {
    const recorder = createFakeRecorder({});
    recorder.stop = async () => {
      throw new Error("native stop failed");
    };
    const setAudioModeAsync = createFakeSetAudioModeAsync();
    const voiceRecorder = buildVoiceRecorder(recorder, createFakeAudioModule(), setAudioModeAsync);

    await expect(voiceRecorder.stop()).rejects.toThrow("native stop failed");

    expect(setAudioModeAsync.calls).toEqual([{ allowsRecording: false, playsInSilentMode: true }]);
  });
});
