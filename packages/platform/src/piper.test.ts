import { describe, expect, it } from "vitest";
import { PiperSpeech, RoutedSpeech, type ProcessRunner } from "./piper.js";

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
    { binary: "/opt/piper", model: "/voices/alan.onnx" },
    {
      run,
      makeTempDir: async () => "/tmp/utterance",
      writeFile: async () => undefined,
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
      args: ["-m", "/voices/alan.onnx", "-i", "/tmp/utterance/line.txt", "-f", "/tmp/utterance/line.wav"],
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
