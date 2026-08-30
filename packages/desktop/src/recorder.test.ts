import { describe, expect, it, vi } from "vitest";
import { Recorder } from "./recorder.js";

function deps() {
  const kill = vi.fn();
  const spawnRecorder = vi.fn((path: string) => ({ kill, done: Promise.resolve({}) }));
  const deleteFile = vi.fn(() => Promise.resolve());
  return { kill, spawnRecorder, deleteFile, tmpDir: "/tmp/jarvis-test" };
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

  // Important 8: a missing ffmpeg (or any recorder-start failure) must be
  // reported as its own distinct error, not silently produce a path to a
  // wav that was never written — which previously surfaced downstream as
  // an opaque "whisper-cli exited with code N".
  it("rejects with a message naming the recorder when the recording process failed to start", async () => {
    const kill = vi.fn();
    const spawnRecorder = vi.fn(() => ({
      kill,
      done: Promise.resolve({ error: "Could not start the microphone recorder: spawn ffmpeg ENOENT" }),
    }));
    const recorder = new Recorder({ spawnRecorder, deleteFile: vi.fn(async () => {}), tmpDir: "/tmp/jarvis-test" });

    recorder.start();
    await expect(recorder.stop()).rejects.toThrow(/microphone recorder/i);
  });

  it("ignores a second start while already recording", () => {
    const d = deps();
    const recorder = new Recorder(d);
    recorder.start();
    recorder.start();
    expect(d.spawnRecorder).toHaveBeenCalledTimes(1);
  });

  describe("abort", () => {
    it("kills the active recording and deletes its file once the process exits", async () => {
      const d = deps();
      const recorder = new Recorder(d);
      recorder.start();
      recorder.abort();
      expect(d.kill).toHaveBeenCalledTimes(1);

      // deleteFile runs after the killed process's `done` settles, which
      // for this fake deps is already-resolved — flush microtasks so the
      // `.then` chain in `abort()` gets a turn to run.
      await Promise.resolve();
      await Promise.resolve();
      expect(d.deleteFile).toHaveBeenCalledTimes(1);
      expect(d.deleteFile.mock.calls[0]?.[0]).toMatch(/\.wav$/);
    });

    it("is a no-op when nothing is recording", () => {
      const d = deps();
      const recorder = new Recorder(d);
      expect(() => recorder.abort()).not.toThrow();
      expect(d.kill).not.toHaveBeenCalled();
      expect(d.deleteFile).not.toHaveBeenCalled();
    });

    it("leaves the recorder free to start again immediately", () => {
      const d = deps();
      const recorder = new Recorder(d);
      recorder.start();
      recorder.abort();
      recorder.start();
      expect(d.spawnRecorder).toHaveBeenCalledTimes(2);
      expect(d.spawnRecorder.mock.calls[0]?.[0]).not.toBe(d.spawnRecorder.mock.calls[1]?.[0]);
    });

    it("does not wait for the killed process before returning", () => {
      const kill = vi.fn();
      let resolveDone: (() => void) | undefined;
      const spawnRecorder = vi.fn(() => ({
        kill,
        done: new Promise<{ error?: string }>((resolve) => {
          resolveDone = () => resolve({});
        }),
      }));
      const deleteFile = vi.fn(() => Promise.resolve());
      const recorder = new Recorder({ spawnRecorder, deleteFile, tmpDir: "/tmp/jarvis-test" });

      recorder.start();
      recorder.abort();

      // abort() returns synchronously even though the underlying process
      // has not exited yet (`done` is still pending) — the mic is
      // considered released the moment kill() is called, not after ffmpeg
      // actually flushes and closes.
      expect(kill).toHaveBeenCalledTimes(1);
      expect(deleteFile).not.toHaveBeenCalled();

      resolveDone?.();
    });
  });

  describe("cleanup", () => {
    it("deletes the given path via deps.deleteFile", async () => {
      const d = deps();
      const recorder = new Recorder(d);
      await recorder.cleanup("/tmp/jarvis-test/jarvis-abc.wav");
      expect(d.deleteFile).toHaveBeenCalledWith("/tmp/jarvis-test/jarvis-abc.wav");
    });
  });
});

describe("defaultRecorderDeps", () => {
  it("spawns ffmpeg with 16kHz mono args targeting the given output path", async () => {
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

    const { defaultRecorderDeps } = await import("./recorder.js");
    const recording = defaultRecorderDeps.spawnRecorder("/tmp/out.wav");

    expect(spawnMock).toHaveBeenCalledWith(
      "ffmpeg",
      ["-f", "avfoundation", "-i", ":default", "-ar", "16000", "-ac", "1", "-y", "/tmp/out.wav"],
      { stdio: "ignore" },
    );

    recording.kill();
    expect(kill).toHaveBeenCalledWith("SIGINT");

    let settled: { error?: string } | undefined;
    void recording.done.then((result) => {
      settled = result;
    });
    expect(settled).toBeUndefined();

    // A normal stop kills ffmpeg with SIGINT, which ffmpeg reports as a
    // non-zero close code even though the recording is perfectly usable —
    // so a non-zero code here must still settle `done` with no error.
    handlers.close?.(255);
    await recording.done;
    expect(settled).toEqual({});

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

    const { defaultRecorderDeps } = await import("./recorder.js");
    const recording = defaultRecorderDeps.spawnRecorder("/tmp/out.wav");

    let resolutions = 0;
    void recording.done.then(() => {
      resolutions++;
    });

    handlers.error?.(new Error("spawn ENOENT"));
    handlers.close?.(null);
    const result = await recording.done;

    expect(resolutions).toBe(1);
    expect(result.error).toContain("spawn ENOENT");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("resolves `done` with an error naming the recorder when the spawn only fires 'error', with no listener throwing", async () => {
    vi.resetModules();
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const spawnMock = vi.fn(() => ({
      kill: vi.fn(),
      on: (event: string, handler: (...args: unknown[]) => void) => {
        handlers[event] = handler;
      },
    }));
    vi.doMock("node:child_process", () => ({ spawn: spawnMock }));

    const { defaultRecorderDeps } = await import("./recorder.js");
    const recording = defaultRecorderDeps.spawnRecorder("/tmp/out.wav");

    // Before the fix, this "error" event had no listener, so Node would
    // throw it as an uncaught exception right here and crash the process
    // instead of letting `done` settle.
    handlers.error?.(new Error("spawn ENOENT"));
    const result = await recording.done;

    expect(result.error).toContain("microphone recorder");
    expect(result.error).toContain("spawn ENOENT");

    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("deleteFile removes a file that exists", async () => {
    const { writeFile, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { defaultRecorderDeps } = await import("./recorder.js");

    const path = join(tmpdir(), `jarvis-recorder-test-${Date.now()}.wav`);
    await writeFile(path, "not really a wav");
    await defaultRecorderDeps.deleteFile(path);

    await expect(readFile(path)).rejects.toThrow();
  });

  it("deleteFile resolves without throwing when the file does not exist", async () => {
    const { defaultRecorderDeps } = await import("./recorder.js");
    await expect(
      defaultRecorderDeps.deleteFile("/tmp/jarvis-recorder-test-does-not-exist.wav"),
    ).resolves.toBeUndefined();
  });
});
