// Tests `buildSpeaker` — the pure-loader builder extracted from
// `createNativeSpeaker` in fix round 1 so the throw-safety fix, the
// no-cache-on-rejection fix, and the overlapping-`speak()` decision have
// regression coverage without a simulator. It takes a `SpeechModule`
// loader, no `require` of `expo-speech`.
import { describe, expect, test, vi } from "vitest";
import { buildSpeaker, type SpeechModule, type Voice } from "./native-speaker";

function createFakeSpeech(overrides: Partial<SpeechModule> = {}): SpeechModule {
  return {
    maxSpeechInputLength: 4000,
    speak: vi.fn(),
    stop: vi.fn(async () => {}),
    getAvailableVoicesAsync: vi.fn(async () => []),
    ...overrides,
  };
}

describe("buildSpeaker: speak()", () => {
  test("resolves done after the last segment's onDone", async () => {
    const Speech = createFakeSpeech({
      speak: (_text, options) => queueMicrotask(() => options?.onDone?.()),
    });
    const speaker = buildSpeaker(() => Speech);

    await expect(speaker.speak("hello", "en")).resolves.toBe("done");
  });

  test("resolves failed on onError", async () => {
    const Speech = createFakeSpeech({
      speak: (_text, options) => queueMicrotask(() => options?.onError?.(new Error("tts error"))),
    });
    const speaker = buildSpeaker(() => Speech);

    await expect(speaker.speak("hello", "en")).resolves.toBe("failed");
  });

  // Minor #2 (fix round 1): a throw from `Speech.speak` reached through
  // `onDone` (i.e. not the initial synchronous call) must not escape
  // `speakNext` and leave the promise unsettled.
  test("a throw from Speech.speak inside onDone resolves failed instead of hanging", async () => {
    const Speech = createFakeSpeech({
      maxSpeechInputLength: 5, // forces "hello world" to split into 2 segments
      speak: (text, options) => {
        if (text === "hello") {
          queueMicrotask(() => options?.onDone?.());
        } else {
          throw new Error("segment too long");
        }
      },
    });
    const speaker = buildSpeaker(() => Speech);

    await expect(speaker.speak("hello world", "en")).resolves.toBe("failed");
  });

  // Minor #4 (fix round 1): an overlapping speak() call cancels the one
  // in flight rather than letting expo-speech queue it.
  test("an overlapping speak() call cancels the in-flight one, it does not queue", async () => {
    const stop = vi.fn(async () => {});
    // Never calls onDone/onStopped/onError on its own — simulates an
    // utterance still in flight when the second call arrives.
    const Speech = createFakeSpeech({ speak: () => {}, stop });
    const speaker = buildSpeaker(() => Speech);

    const first = speaker.speak("first", "en");
    const second = speaker.speak("second", "en");

    await expect(first).resolves.toBe("stopped");
    expect(stop).toHaveBeenCalled();

    // The second call is still in flight; an explicit stop() resolves it.
    speaker.stop();
    await expect(second).resolves.toBe("stopped");
  });
});

describe("buildSpeaker: stop()", () => {
  test("calls Speech.stop() and resolves a pending speak() as stopped", async () => {
    const stop = vi.fn(async () => {});
    const Speech = createFakeSpeech({ speak: () => {}, stop });
    const speaker = buildSpeaker(() => Speech);

    const pending = speaker.speak("hello", "en");
    speaker.stop();

    await expect(pending).resolves.toBe("stopped");
    expect(stop).toHaveBeenCalled();
  });
});

describe("buildSpeaker: hasVoice()", () => {
  test("caches a successful voices lookup across calls and languages", async () => {
    const getAvailableVoicesAsync = vi.fn(async (): Promise<Voice[]> => [{ language: "en-US" }]);
    const Speech = createFakeSpeech({ getAvailableVoicesAsync });
    const speaker = buildSpeaker(() => Speech);

    await speaker.hasVoice("en");
    await speaker.hasVoice("ar");

    expect(getAvailableVoicesAsync).toHaveBeenCalledTimes(1);
  });

  test("an empty voice list resolves true", async () => {
    const Speech = createFakeSpeech({ getAvailableVoicesAsync: vi.fn(async () => []) });
    const speaker = buildSpeaker(() => Speech);

    await expect(speaker.hasVoice("ar")).resolves.toBe(true);
  });

  // Minor #3 (fix round 1): a rejected lookup must not be cached, so a
  // later call can retry instead of answering `true` forever.
  test("does not cache a rejected voices lookup — a later call retries", async () => {
    let call = 0;
    const getAvailableVoicesAsync = vi.fn(async (): Promise<Voice[]> => {
      call += 1;
      if (call === 1) throw new Error("native failure");
      return [{ language: "en-US" }];
    });
    const Speech = createFakeSpeech({ getAvailableVoicesAsync });
    const speaker = buildSpeaker(() => Speech);

    await expect(speaker.hasVoice("en")).resolves.toBe(true); // rejection -> true
    await expect(speaker.hasVoice("en")).resolves.toBe(true); // retried, found -> true
    expect(getAvailableVoicesAsync).toHaveBeenCalledTimes(2);
  });
});
