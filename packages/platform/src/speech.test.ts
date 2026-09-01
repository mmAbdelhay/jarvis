import { describe, expect, it, vi } from "vitest";
import { bestVariant, parseVoiceList, MacSpeech } from "./speech.js";
import type { SpeechRunner } from "./speech.js";

function fakeRunner() {
  const calls: { command: string; args: string[] }[] = [];
  const kills: number[] = [];
  let index = 0;
  const runner: SpeechRunner = (command, args) => {
    const id = index++;
    calls.push({ command, args });
    return { kill: () => kills.push(id), done: Promise.resolve({ code: 0 }) };
  };
  return { runner, calls, kills };
}

// Unlike fakeRunner, each call's `done` stays pending until the matching
// resolver is invoked, so tests can put an utterance genuinely in flight
// (suspended on `await utterance.done`) before acting on it.
function deferredRunner() {
  const calls: { command: string; args: string[] }[] = [];
  const kills: number[] = [];
  const resolvers: ((result: { code: number }) => void)[] = [];
  let index = 0;
  const runner: SpeechRunner = (command, args) => {
    const id = index++;
    calls.push({ command, args });
    const done = new Promise<{ code: number }>((resolve) => {
      resolvers[id] = resolve;
    });
    return { kill: () => kills.push(id), done };
  };
  return { runner, calls, kills, resolvers };
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

  it("stops the previous utterance while it is still in flight when a second starts", async () => {
    const { runner, kills, resolvers } = deferredRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);

    const first = speech.speak("first", "en");
    const second = speech.speak("second", "en");

    // The first utterance must already have been killed by the time the
    // second is issued, proving it was genuinely in flight (suspended on
    // `await utterance.done`), not already completed.
    expect(kills).toEqual([0]);

    resolvers[1]?.({ code: 0 });
    await second;
    resolvers[0]?.({ code: 0 });
    await first;
  });

  it("stopSpeaking kills the current utterance while it is still in flight", async () => {
    const { runner, kills, resolvers } = deferredRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);

    const speaking = speech.speak("hello", "en");
    speech.stopSpeaking();
    expect(kills).toEqual([0]);

    resolvers[0]?.({ code: 0 });
    await speaking;
  });

  it("clears the current utterance after it completes naturally, so stopSpeaking afterward is a no-op", async () => {
    const { runner, kills } = fakeRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await speech.speak("hello", "en");
    speech.stopSpeaking();
    expect(kills).toHaveLength(0);
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
    const { runner, kills, resolvers } = deferredRunner();
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);

    const speaking = speech.speak("hello", "en");
    speech.stopSpeaking();
    speech.stopSpeaking();
    expect(kills).toEqual([0]);

    resolvers[0]?.({ code: 0 });
    await speaking;
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

  it("rejects when the runner reports a non-zero exit code", async () => {
    const runner: SpeechRunner = () => ({
      kill: () => {},
      done: Promise.resolve({ code: 1 }),
    });
    const speech = new MacSpeech({ arabicVoice: "Majed" }, runner);
    await expect(speech.speak("hello", "en")).rejects.toThrow();
  });
});

describe("defaultSpeechRunner", () => {
  it("spawns the given command with ignored stdio and resolves done with the exit code on close", async () => {
    vi.resetModules();
    const kill = vi.fn();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const spawnMock = vi.fn(() => ({
      kill,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      },
    }));
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { defaultSpeechRunner } = await import("./speech.js");
    const utterance = defaultSpeechRunner("say", ["-v", "Majed", "hi"]);

    expect(spawnMock).toHaveBeenCalledWith("say", ["-v", "Majed", "hi"], { stdio: "ignore" });

    utterance.kill();
    expect(kill).toHaveBeenCalledTimes(1);

    let result: { code: number } | undefined;
    void utterance.done.then((r) => {
      result = r;
    });
    expect(result).toBeUndefined();

    handlers.close?.(0);
    await utterance.done;
    expect(result).toEqual({ code: 0 });

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("settles exactly once when a failed spawn fires both 'error' and a trailing 'close'", async () => {
    vi.resetModules();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const spawnMock = vi.fn(() => ({
      kill: vi.fn(),
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      },
    }));
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { defaultSpeechRunner } = await import("./speech.js");
    const utterance = defaultSpeechRunner("does-not-exist", []);

    let resolutions = 0;
    void utterance.done.then(() => {
      resolutions++;
    });

    handlers.error?.(new Error("spawn ENOENT"));
    handlers.close?.(null);
    await utterance.done;

    expect(resolutions).toBe(1);

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("settles without an uncaught exception when the command cannot be spawned", async () => {
    const { defaultSpeechRunner } = await import("./speech.js");
    const utterance = defaultSpeechRunner("this-command-does-not-exist-jarvis-test", []);
    const result = await utterance.done;
    expect(result.code).not.toBe(0);
  });
});

describe("bestVariant", () => {
  // macOS ships every voice compact and offers Enhanced and Premium as
  // downloads. The compact one is the robotic original, and a config that
  // says "Daniel" would keep using it forever.
  it("prefers an installed Enhanced voice over the compact one", () => {
    expect(bestVariant("Daniel", ["Daniel", "Daniel (Enhanced)", "Karen"])).toBe(
      "Daniel (Enhanced)",
    );
  });

  it("prefers Premium over Enhanced, as macOS ranks them", () => {
    expect(bestVariant("Daniel", ["Daniel", "Daniel (Enhanced)", "Daniel (Premium)"])).toBe(
      "Daniel (Premium)",
    );
  });

  it("keeps the compact voice when nothing better is installed", () => {
    expect(bestVariant("Daniel", ["Daniel", "Karen"])).toBe("Daniel");
  });

  // A name that is not installed at all is passed through: `say` falls back
  // to the system default, and rewriting it here would hide the mistake.
  it("passes an unknown name through untouched", () => {
    expect(bestVariant("Oliver", ["Daniel"])).toBe("Oliver");
  });

  it("does not match a different voice that merely starts the same", () => {
    expect(bestVariant("Dan", ["Daniel (Enhanced)"])).toBe("Dan");
  });
});

describe("parseVoiceList", () => {
  it("reads the names out of say's own listing", () => {
    const output = [
      "Daniel              en_GB    # Hello! My name is Daniel.",
      "Daniel (Enhanced)   en_GB    # Hello! My name is Daniel.",
      "Majed               ar_001   # مرحبًا! اسمي ماجد.",
    ].join("\n");

    expect(parseVoiceList(output)).toEqual(["Daniel", "Daniel (Enhanced)", "Majed"]);
  });

  it("survives an empty listing", () => {
    expect(parseVoiceList("")).toEqual([]);
  });
});

describe("MacSpeech voice resolution", () => {
  function harness(installed: string[]) {
    const args: string[][] = [];
    const speech = new MacSpeech(
      { arabicVoice: "Majed", englishVoice: "Daniel" },
      (_command, given) => {
        args.push(given);
        return { kill: () => {}, done: Promise.resolve({ code: 0 }) };
      },
      async () => installed,
    );
    return { speech, args };
  }

  it("speaks with the best installed variant", async () => {
    const { speech, args } = harness(["Daniel", "Daniel (Enhanced)", "Majed"]);
    await speech.ready;

    await speech.speak("hello", "en");

    expect(args[0]).toEqual(["-v", "Daniel (Enhanced)", "hello"]);
  });

  it("resolves Arabic the same way", async () => {
    const { speech, args } = harness(["Majed", "Majed (Enhanced)"]);
    await speech.ready;

    await speech.speak("مرحبا", "ar");

    expect(args[0]).toEqual(["-v", "Majed (Enhanced)", "مرحبا"]);
  });

  // Listing voices is an optimisation, not a requirement.
  it("uses the configured name when the listing fails", async () => {
    const args: string[][] = [];
    const speech = new MacSpeech(
      { arabicVoice: "Majed", englishVoice: "Daniel" },
      (_command, given) => {
        args.push(given);
        return { kill: () => {}, done: Promise.resolve({ code: 0 }) };
      },
      async () => {
        throw new Error("say is missing");
      },
    );
    await speech.ready;

    await speech.speak("hello", "en");

    expect(args[0]).toEqual(["-v", "Daniel", "hello"]);
  });

  // Shelling out before every utterance would put a process spawn in front of
  // every spoken word.
  it("lists the voices once, however much it speaks", async () => {
    let listings = 0;
    const speech = new MacSpeech(
      { arabicVoice: "Majed", englishVoice: "Daniel" },
      () => ({ kill: () => {}, done: Promise.resolve({ code: 0 }) }),
      async () => {
        listings += 1;
        return ["Daniel (Enhanced)"];
      },
    );

    await speech.ready;
    await speech.speak("one", "en");
    await speech.speak("two", "en");
    await speech.speak("three", "ar");

    expect(listings).toBe(1);
  });
});
