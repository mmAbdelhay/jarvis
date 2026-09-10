import { describe, expect, it } from "vitest";
import {
  audioPlayer,
  onPath,
  PiperSpeech,
  RoutedSpeech,
  silentSpeech,
  type ProcessRunner,
} from "./piper.js";

type Spawned = { command: string; args: string[]; kill(): void; settle(code: number): void };

function harness(options: { autoSettle?: boolean } = {}) {
  const spawned: Spawned[] = [];
  const killed: string[] = [];
  const removed: string[] = [];

  const run: ProcessRunner = (command, args) => {
    let settle: (value: { code: number }) => void = () => {};
    const done = new Promise<{ code: number }>((resolve) => {
      settle = resolve;
    });
    const record: Spawned = {
      command,
      args,
      kill: () => killed.push(command),
      settle: (code) => settle({ code }),
    };
    spawned.push(record);
    // Most tests want the happy path without choreographing each process.
    if (options.autoSettle !== false) queueMicrotask(() => settle({ code: 0 }));
    return { kill: record.kill, done };
  };

  const speech = new PiperSpeech(
    { binary: "/opt/piper", model: "/voices/alan.onnx", player: "afplay" },
    {
      run,
      makeTempDir: async () => "/tmp/utterance",
      removeDir: async (path) => {
        removed.push(path);
      },
    },
  );

  return { speech, spawned, killed, removed };
}

/** speak() awaits a temp dir and a file write before it spawns anything, so a
 *  test that wants to control the processes has to let those settle first. */
async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

describe("PiperSpeech", () => {
  it("synthesises to a file and then plays it", async () => {
    const { speech, spawned } = harness();

    await speech.speak("hello", "en");

    expect(spawned[0]).toMatchObject({
      command: "/opt/piper",
      args: ["-m", "/voices/alan.onnx", "-f", "/tmp/utterance/line.wav"],
    });
    expect(spawned[1]).toMatchObject({ command: "afplay", args: ["/tmp/utterance/line.wav"] });
  });

  it("says nothing at all for empty text", async () => {
    const { speech, spawned } = harness();

    await speech.speak("   ", "en");

    expect(spawned).toEqual([]);
  });

  it("cleans up the temporary directory", async () => {
    const { speech, removed } = harness();

    await speech.speak("hello", "en");

    expect(removed).toEqual(["/tmp/utterance"]);
  });

  it("cleans up even when synthesis fails", async () => {
    const { speech, removed, spawned } = harness({ autoSettle: false });

    const speaking = speech.speak("hello", "en");
    await tick();
    spawned[0]?.settle(1);

    await expect(speaking).rejects.toThrow("piper exited with code 1");
    expect(removed).toEqual(["/tmp/utterance"]);
  });

  it("reports a playback failure", async () => {
    const { speech, spawned } = harness({ autoSettle: false });

    const speaking = speech.speak("hello", "en");
    await tick();
    spawned[0]?.settle(0);
    await tick();
    spawned[1]?.settle(1);

    await expect(speaking).rejects.toThrow("afplay exited with code 1");
  });

  it("kills what is playing when told to stop", async () => {
    const { speech, spawned, killed } = harness({ autoSettle: false });

    const speaking = speech.speak("hello", "en");
    await tick();
    spawned[0]?.settle(0);
    await tick();
    speech.stopSpeaking();
    spawned[1]?.settle(0);

    await speaking;
    expect(killed).toContain("afplay");
  });

  // A stop that lands between synthesis and playback used to be ignored, and
  // the old line would be spoken over the new one.
  it("does not start playing an utterance that was stopped mid-synthesis", async () => {
    const { speech, spawned } = harness({ autoSettle: false });

    const speaking = speech.speak("hello", "en");
    await tick();
    speech.stopSpeaking();
    spawned[0]?.settle(0);

    await speaking;
    expect(spawned.filter((process) => process.command === "afplay")).toEqual([]);
  });
});

describe("RoutedSpeech", () => {
  function double() {
    const said: string[] = [];
    let stops = 0;
    return {
      said,
      stops: () => stops,
      speaker: {
        speak: async (text: string) => {
          said.push(text);
        },
        stopSpeaking: () => {
          stops += 1;
        },
      },
    };
  }

  it("sends English to the first speaker", async () => {
    const english = double();
    const other = double();

    await new RoutedSpeech(english.speaker, other.speaker).speak("hello", "en");

    expect(english.said).toEqual(["hello"]);
    expect(other.said).toEqual([]);
  });

  // A Piper model speaks one language; Arabic has to keep working, or a
  // better English voice would have made the app mute in Arabic.
  it("sends Arabic to the fallback", async () => {
    const english = double();
    const other = double();

    await new RoutedSpeech(english.speaker, other.speaker).speak("مرحبا", "ar");

    expect(other.said).toEqual(["مرحبا"]);
    expect(english.said).toEqual([]);
  });

  it("stops both, so a barge-in in either language silences what is playing", async () => {
    const english = double();
    const other = double();

    await new RoutedSpeech(english.speaker, other.speaker).speak("hello", "en");

    expect(english.stops()).toBe(1);
    expect(other.stops()).toBe(1);
  });
});

describe("audioPlayer", () => {
  const all = (): boolean => true;
  const none = (): boolean => false;

  it("plays with afplay on macOS", () => {
    expect(audioPlayer("darwin", all)).toBe("afplay");
    expect(audioPlayer("darwin", none)).toBe("afplay");
  });

  it("prefers pw-play on Linux when PipeWire is there", () => {
    expect(audioPlayer("linux", all)).toBe("pw-play");
  });

  it("falls back to paplay, then aplay", () => {
    expect(audioPlayer("linux", (c) => c !== "pw-play")).toBe("paplay");
    expect(audioPlayer("linux", (c) => c === "aplay")).toBe("aplay");
  });

  it("still names a player when none is installed, so the failure names itself", () => {
    // Returning undefined would make every caller grow a second "no audio"
    // branch. Spawning aplay and failing produces an error with a binary name
    // in it, which is what the user needs to read.
    expect(audioPlayer("linux", none)).toBe("aplay");
  });
});

describe("onPath", () => {
  it("finds an executable on PATH", () => {
    expect(onPath("sh", { PATH: "/usr/bin:/bin" })).toBe(true);
  });

  it("does not find one that is not there", () => {
    expect(onPath("definitely-not-a-real-binary", { PATH: "/usr/bin:/bin" })).toBe(false);
  });

  it("survives an unset or empty PATH", () => {
    expect(onPath("sh", {})).toBe(false);
    expect(onPath("sh", { PATH: "" })).toBe(false);
  });

  it("ignores an empty PATH entry rather than testing the working directory", () => {
    expect(onPath("definitely-not-a-real-binary", { PATH: "::" })).toBe(false);
  });
});

describe("silentSpeech", () => {
  it("says nothing and reports the language it could not speak", async () => {
    const asked: string[] = [];
    const speech = silentSpeech((language) => asked.push(language));

    await speech.speak("مرحبا", "ar");

    expect(asked).toEqual(["ar"]);
  });

  it("does not report an empty utterance", async () => {
    // Nothing was going to be said anyway, and a notice for it would be noise
    // in the panel.
    const asked: string[] = [];
    const speech = silentSpeech((language) => asked.push(language));

    await speech.speak("   ", "ar");

    expect(asked).toEqual([]);
  });

  it("has a stopSpeaking that does nothing and does not throw", () => {
    expect(() => silentSpeech(() => undefined).stopSpeaking()).not.toThrow();
  });
});

describe("RoutedSpeech with a Piper voice on each side", () => {
  it("sends each language to its own model", async () => {
    // A Piper model speaks one language, so bilingual means two models. On a
    // platform with no system voices this is the only way Arabic is spoken
    // at all.
    const spawned: { command: string; args: string[] }[] = [];
    const run = (command: string, args: string[]) => {
      spawned.push({ command, args });
      return { kill: () => undefined, done: Promise.resolve({ code: 0 }) };
    };
    const deps = {
      run,
      makeTempDir: async () => "/tmp/utterance",
      removeDir: async () => undefined,
    };
    const speech = new RoutedSpeech(
      new PiperSpeech({ binary: "/opt/piper", model: "/voices/en.onnx", player: "aplay" }, deps),
      new PiperSpeech({ binary: "/opt/piper", model: "/voices/ar.onnx", player: "aplay" }, deps),
    );

    await speech.speak("hello", "en");
    await speech.speak("مرحبا", "ar");

    const models = spawned.filter((p) => p.command === "/opt/piper").map((p) => p.args[1]);
    expect(models).toEqual(["/voices/en.onnx", "/voices/ar.onnx"]);
  });
});

describe("how the text reaches piper", () => {
  function recording() {
    const calls: { command: string; args: string[]; stdin?: string }[] = [];
    const run: ProcessRunner = (command, args, stdin) => {
      calls.push({ command, args, stdin });
      return { kill: () => undefined, done: Promise.resolve({ code: 0 }) };
    };
    const speech = new PiperSpeech(
      { binary: "/opt/piper", model: "/voices/alan.onnx", player: "aplay" },
      {
        run,
        makeTempDir: async () => "/tmp/utterance",
        removeDir: async () => undefined,
      },
    );
    return { speech, calls };
  }

  it("writes the line to piper's stdin", async () => {
    const { speech, calls } = recording();
    await speech.speak("hello there", "en");
    expect(calls[0]?.stdin).toBe("hello there");
  });

  it("passes no input-file flag, because piper has none", async () => {
    // `-i <path>` was accepted silently, ignored, and left piper reading an
    // empty stdin: it logged "Initialized piper", logged "Terminated piper",
    // wrote no file and exited 0. Every utterance then failed at the player,
    // complaining about a wav that had never been created.
    const { speech, calls } = recording();
    await speech.speak("hello there", "en");
    expect(calls[0]?.args).not.toContain("-i");
    expect(calls[0]?.args).toEqual(["-m", "/voices/alan.onnx", "-f", "/tmp/utterance/line.wav"]);
  });

  it("sends no stdin to the player, which takes a path", async () => {
    const { speech, calls } = recording();
    await speech.speak("hello there", "en");
    expect(calls[1]?.command).toBe("aplay");
    expect(calls[1]?.stdin).toBeUndefined();
  });
});
