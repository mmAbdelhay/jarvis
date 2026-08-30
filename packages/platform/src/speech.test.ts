import { describe, expect, it, vi } from "vitest";
import { MacSpeech } from "./speech.js";
import type { SpeechRunner } from "./speech.js";

function fakeRunner() {
  const calls: { command: string; args: string[] }[] = [];
  const kills: number[] = [];
  let index = 0;
  const runner: SpeechRunner = (command, args) => {
    const id = index++;
    calls.push({ command, args });
    return { kill: () => kills.push(id), done: Promise.resolve() };
  };
  return { runner, calls, kills };
}

describe("MacSpeech", () => {
  it("speaks Arabic with the Arabic voice", async () => {
    const { runner, calls } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await speech.speak("تمام", "ar");
    expect(calls[0]?.command).toBe("say");
    expect(calls[0]?.args).toEqual(["-v", "Majed", "تمام"]);
  });

  it("speaks English without forcing a voice when none is configured", async () => {
    const { runner, calls } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await speech.speak("done", "en");
    expect(calls[0]?.args).toEqual(["done"]);
  });

  it("uses the configured English voice when given one", async () => {
    const { runner, calls } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed", englishVoice: "Samantha" }, runner);
    await speech.speak("done", "en");
    expect(calls[0]?.args).toEqual(["-v", "Samantha", "done"]);
  });

  it("stops the previous utterance before starting a new one", async () => {
    const { runner, kills } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await speech.speak("first", "en");
    await speech.speak("second", "en");
    expect(kills).toContain(0);
  });

  it("stopSpeaking kills the current utterance", async () => {
    const { runner, kills } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await speech.speak("hello", "en");
    speech.stopSpeaking();
    expect(kills).toEqual([0]);
  });

  it("ignores empty text", async () => {
    const { runner, calls } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await speech.speak("   ", "en");
    expect(calls).toHaveLength(0);
  });

  it("ignores empty text without killing any in-flight utterance", async () => {
    const { runner, calls, kills } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await speech.speak("hello", "en");
    await speech.speak("", "en");
    expect(calls).toHaveLength(1);
    expect(kills).toHaveLength(0);
  });

  it("stopSpeaking is a no-op when nothing is currently speaking", () => {
    const { runner, kills } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    expect(() => speech.stopSpeaking()).not.toThrow();
    expect(kills).toHaveLength(0);
  });

  it("stopSpeaking twice in a row only kills once", async () => {
    const { runner, kills } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await speech.speak("hello", "en");
    speech.stopSpeaking();
    speech.stopSpeaking();
    expect(kills).toEqual([0]);
  });

  it("passes text through to the runner without trimming it", async () => {
    const { runner, calls } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await speech.speak("  hello there  ", "en");
    expect(calls[0]?.args).toEqual(["  hello there  "]);
  });

  it("does not use the Arabic voice for English or vice versa", async () => {
    const { runner, calls } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed", englishVoice: "Samantha" }, runner);
    await speech.speak("تمام", "ar");
    await speech.speak("done", "en");
    expect(calls[0]?.args).toEqual(["-v", "Majed", "تمام"]);
    expect(calls[1]?.args).toEqual(["-v", "Samantha", "done"]);
  });
});

describe("defaultSpeechRunner", () => {
  it("spawns the given command with ignored stdio and resolves done on close", async () => {
    vi.resetModules();
    const kill = vi.fn();
    const handlers: Record<string, () => void> = {};
    const spawnMock = vi.fn(() => ({
      kill,
      on: (event: string, handler: () => void) => {
        handlers[event] = handler;
      },
    }));
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { defaultSpeechRunner } = await import("./speech.js");
    const utterance = defaultSpeechRunner("say", ["-v", "Majed", "hi"]);

    expect(spawnMock).toHaveBeenCalledWith("say", ["-v", "Majed", "hi"], { stdio: "ignore" });

    utterance.kill();
    expect(kill).toHaveBeenCalledTimes(1);

    let resolved = false;
    void utterance.done.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);

    handlers.close?.();
    await utterance.done;
    expect(resolved).toBe(true);

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });
});
