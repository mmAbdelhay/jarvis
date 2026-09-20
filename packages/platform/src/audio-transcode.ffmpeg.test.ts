import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isMp4Audio, transcodeToWhisperWavCommand } from "./audio-transcode.js";
import { runCommandWithLimits } from "./spawn.js";

const ffmpegOnPath = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.skipIf(!ffmpegOnPath)("transcodeToWhisperWavCommand (ffmpeg integration)", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-audio-transcode-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("transcodes a real m4a to 16 kHz mono 16-bit PCM wav", async () => {
    const input = join(dir, "in.m4a");
    const output = join(dir, "out.wav");

    const gen = spawnSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-c:a",
      "aac",
      "-b:a",
      "32k",
      "-ar",
      "16000",
      "-ac",
      "1",
      input,
    ]);
    expect(gen.status).toBe(0);

    const { command, args } = transcodeToWhisperWavCommand(input, output);
    const result = await runCommandWithLimits(command, args, {
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    });

    expect(result.code).toBe(0);

    const wav = await readFile(output);
    expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("latin1")).toBe("WAVE");

    // Locate the fmt chunk (immediately follows the 12-byte RIFF header
    // for a file ffmpeg writes with no extra leading chunks).
    expect(wav.subarray(12, 16).toString("latin1")).toBe("fmt ");
    const audioFormat = wav.readUInt16LE(20);
    const numChannels = wav.readUInt16LE(22);
    const sampleRate = wav.readUInt32LE(24);
    const bitsPerSample = wav.readUInt16LE(34);

    expect(audioFormat).toBe(1); // PCM
    expect(numChannels).toBe(1);
    expect(sampleRate).toBe(16000);
    expect(bitsPerSample).toBe(16);

    const header = await readFile(input);
    expect(isMp4Audio(new Uint8Array(header.subarray(0, 12)))).toBe(true);
  }, 30_000);

  it("fails a WAV file renamed to .m4a instead of silently accepting it", async () => {
    const realWav = join(dir, "real.wav");
    const input = join(dir, "fake.m4a");
    const output = join(dir, "fake-out.wav");

    // Generate a genuine WAV (RIFF/WAVE, not an ISO-BMFF/AAC file), then
    // copy its exact bytes to a path with an .m4a extension — the
    // container format, which -f mov inspects, is unrelated to the
    // filename.
    const gen = spawnSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      "-ar",
      "16000",
      "-ac",
      "1",
      realWav,
    ]);
    expect(gen.status).toBe(0);
    await copyFile(realWav, input);

    const { command, args } = transcodeToWhisperWavCommand(input, output);
    const result = await runCommandWithLimits(command, args, {
      timeoutMs: 30_000,
      maxOutputBytes: 65_536,
    });

    expect(result.code).not.toBe(0);
    await expect(readFile(output)).rejects.toThrow();
  }, 30_000);

  it("caps the output at TRANSCODE_MAX_SECONDS even for a longer input", async () => {
    const input = join(dir, "long.m4a");
    const output = join(dir, "long-out.wav");

    const gen = spawnSync("ffmpeg", [
      "-y",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=150",
      "-c:a",
      "aac",
      "-b:a",
      "32k",
      "-ar",
      "16000",
      "-ac",
      "1",
      input,
    ]);
    expect(gen.status).toBe(0);

    const { command, args } = transcodeToWhisperWavCommand(input, output);
    const result = await runCommandWithLimits(command, args, {
      timeoutMs: 60_000,
      maxOutputBytes: 65_536,
    });

    expect(result.code).toBe(0);

    const wav = await readFile(output);
    expect(dataChunkSize(wav)).toBeLessThanOrEqual(120 * 32_000);
  }, 60_000);
});

/**
 * Walks a WAV's RIFF chunk list to find the `data` chunk's declared size.
 * A fixed offset is not reliable here: ffmpeg writes an extra `LIST`
 * chunk between `fmt ` and `data`, so `data` does not start at a constant
 * byte position.
 */
function dataChunkSize(wav: Buffer): number {
  let pos = 12;
  while (pos + 8 <= wav.length) {
    const id = wav.subarray(pos, pos + 4).toString("latin1");
    const size = wav.readUInt32LE(pos + 4);
    if (id === "data") return size;
    pos += 8 + size + (size % 2);
  }
  throw new Error("no data chunk found in wav");
}
