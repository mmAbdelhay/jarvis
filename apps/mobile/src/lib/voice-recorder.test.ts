import { describe, expect, test } from "vitest";
import {
  FALLBACK_RECORDING_OPTIONS,
  RECORDING_OPTIONS,
  toMicPermission,
  webMicPermission,
  webRecordingCandidates,
} from "./voice-recorder";

describe("toMicPermission", () => {
  test("granted", () => {
    expect(toMicPermission({ granted: true, canAskAgain: true, status: "granted" })).toBe(
      "granted",
    );
  });

  test("undetermined", () => {
    expect(toMicPermission({ granted: false, canAskAgain: true, status: "undetermined" })).toBe(
      "undetermined",
    );
  });

  test("not granted and canAskAgain false is blocked", () => {
    expect(toMicPermission({ granted: false, canAskAgain: false, status: "denied" })).toBe(
      "blocked",
    );
  });

  test("otherwise denied", () => {
    expect(toMicPermission({ granted: false, canAskAgain: true, status: "denied" })).toBe("denied");
  });
});

describe("RECORDING_OPTIONS", () => {
  // [bite-proof: `.wav`]
  test("has extension .m4a, 16 kHz mono, 32 kbps, android mpeg4/aac", () => {
    expect(RECORDING_OPTIONS.extension).toBe(".m4a");
    expect(RECORDING_OPTIONS.sampleRate).toBe(16000);
    expect(RECORDING_OPTIONS.numberOfChannels).toBe(1);
    expect(RECORDING_OPTIONS.bitRate).toBe(32000);
    expect(RECORDING_OPTIONS.android.outputFormat).toBe("mpeg4");
    expect(RECORDING_OPTIONS.android.audioEncoder).toBe("aac");
  });

  test("the fallback differs only in sampleRate and bitRate", () => {
    expect(FALLBACK_RECORDING_OPTIONS.sampleRate).toBe(44100);
    expect(FALLBACK_RECORDING_OPTIONS.bitRate).toBe(64000);
    expect(FALLBACK_RECORDING_OPTIONS.extension).toBe(RECORDING_OPTIONS.extension);
    expect(FALLBACK_RECORDING_OPTIONS.numberOfChannels).toBe(RECORDING_OPTIONS.numberOfChannels);
    expect(FALLBACK_RECORDING_OPTIONS.android).toEqual(RECORDING_OPTIONS.android);
    expect(FALLBACK_RECORDING_OPTIONS.ios).toEqual(RECORDING_OPTIONS.ios);
    expect(FALLBACK_RECORDING_OPTIONS.web).toEqual(RECORDING_OPTIONS.web);
  });

  test("both objects are frozen", () => {
    expect(Object.isFrozen(RECORDING_OPTIONS)).toBe(true);
    expect(Object.isFrozen(FALLBACK_RECORDING_OPTIONS)).toBe(true);
  });
});

describe("webRecordingCandidates (MediaRecorder, Task 13)", () => {
  test("prefers audio/mp4 (m4a), then webm/opus, when both are supported", () => {
    expect(webRecordingCandidates(() => true)).toEqual([
      { mimeType: "audio/mp4", format: "m4a" },
      { mimeType: "audio/webm;codecs=opus", format: "webm" },
    ]);
  });

  test("falls back to webm/opus alone when mp4 is unsupported (Firefox)", () => {
    expect(webRecordingCandidates((mime) => mime.startsWith("audio/webm"))).toEqual([
      { mimeType: "audio/webm;codecs=opus", format: "webm" },
    ]);
  });

  test("answers an empty list when neither is supported", () => {
    expect(webRecordingCandidates(() => false)).toEqual([]);
  });

  test("a throwing isTypeSupported counts as unsupported", () => {
    expect(
      webRecordingCandidates(() => {
        throw new Error("no");
      }),
    ).toEqual([]);
  });
});

describe("webMicPermission (Permissions API state)", () => {
  test("maps granted/prompt/denied and an unknown state", () => {
    expect(webMicPermission("granted")).toBe("granted");
    expect(webMicPermission("prompt")).toBe("undetermined");
    // A browser remembers a denial; only its own site settings undo it.
    expect(webMicPermission("denied")).toBe("blocked");
    expect(webMicPermission(undefined)).toBe("undetermined");
  });
});
