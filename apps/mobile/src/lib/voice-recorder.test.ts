import { describe, expect, test } from "vitest";
import { FALLBACK_RECORDING_OPTIONS, RECORDING_OPTIONS, toMicPermission } from "./voice-recorder";

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
