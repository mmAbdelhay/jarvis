import { describe, expect, it, vi } from "vitest";
import { Recorder } from "./recorder.js";

function deps() {
  const kill = vi.fn();
  const spawnRecorder = vi.fn((path: string) => ({ kill, done: Promise.resolve() }));
  return { kill, spawnRecorder, tmpDir: "/tmp/jarvis-test" };
}

describe("Recorder", () => {
  it("writes to a wav path inside the temp directory", async () => {
    const d = deps();
    const recorder = new Recorder(d);
    recorder.start();
    const path = await recorder.stop();
    expect(path.startsWith("/tmp/jarvis-test")).toBe(true);
    expect(path.endsWith(".wav")).toBe(true);
  });

  it("kills the recording process on stop", async () => {
    const d = deps();
    const recorder = new Recorder(d);
    recorder.start();
    await recorder.stop();
    expect(d.kill).toHaveBeenCalled();
  });

  it("uses a distinct file per recording", async () => {
    const d = deps();
    const recorder = new Recorder(d);
    recorder.start();
    const first = await recorder.stop();
    recorder.start();
    const second = await recorder.stop();
    expect(first).not.toBe(second);
  });

  it("throws when stop is called without start", async () => {
    const recorder = new Recorder(deps());
    await expect(recorder.stop()).rejects.toThrow(/not recording/i);
  });

  it("ignores a second start while already recording", () => {
    const d = deps();
    const recorder = new Recorder(d);
    recorder.start();
    recorder.start();
    expect(d.spawnRecorder).toHaveBeenCalledTimes(1);
  });
});
