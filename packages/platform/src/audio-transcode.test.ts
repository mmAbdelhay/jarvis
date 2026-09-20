import { describe, expect, it } from "vitest";
import { MP4_AUDIO_BRANDS, isMp4Audio, transcodeToWhisperWavCommand } from "./audio-transcode.js";

describe("transcodeToWhisperWavCommand", () => {
  it("returns the exact pinned argv", () => {
    const { command, args } = transcodeToWhisperWavCommand("/tmp/a/audio.m4a", "/tmp/a/audio.wav");

    expect(command).toBe("ffmpeg");
    expect(args).toEqual([
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-protocol_whitelist",
      "file",
      "-enable_drefs",
      "0",
      "-f",
      "mov",
      "-i",
      "/tmp/a/audio.m4a",
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-t",
      "120",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "-y",
      "/tmp/a/audio.wav",
    ]);
  });

  it("puts -protocol_whitelist file and -enable_drefs 0 before -i", () => {
    const { args } = transcodeToWhisperWavCommand("/tmp/a/audio.m4a", "/tmp/a/audio.wav");

    const iIndex = args.indexOf("-i");
    const whitelistIndex = args.indexOf("-protocol_whitelist");
    const drefsIndex = args.indexOf("-enable_drefs");

    expect(whitelistIndex).toBeGreaterThanOrEqual(0);
    expect(drefsIndex).toBeGreaterThanOrEqual(0);
    expect(whitelistIndex).toBeLessThan(iIndex);
    expect(drefsIndex).toBeLessThan(iIndex);
  });

  it("throws for a relative input path", () => {
    expect(() => transcodeToWhisperWavCommand("audio.m4a", "/tmp/a/audio.wav")).toThrow();
  });

  it("throws for a relative output path", () => {
    expect(() => transcodeToWhisperWavCommand("/tmp/a/audio.m4a", "audio.wav")).toThrow();
  });

  it("throws when a path starts with -", () => {
    expect(() => transcodeToWhisperWavCommand("-i", "/tmp/a/audio.wav")).toThrow();
    expect(() => transcodeToWhisperWavCommand("/tmp/a/audio.m4a", "-i")).toThrow();
  });

  it("throws when input and output are equal", () => {
    expect(() => transcodeToWhisperWavCommand("/tmp/a/audio.m4a", "/tmp/a/audio.m4a")).toThrow();
  });
});

describe("isMp4Audio", () => {
  const header = (brand: string, prefix = [0x00, 0x00, 0x00, 0x1c]) => {
    const bytes = [...prefix, ...Buffer.from("ftyp", "latin1"), ...Buffer.from(brand, "latin1")];
    return new Uint8Array(bytes);
  };

  it("is true for an M4A brand", () => {
    expect(isMp4Audio(header("M4A "))).toBe(true);
  });

  it("is true for an mp42 brand", () => {
    expect(isMp4Audio(header("mp42"))).toBe(true);
  });

  it("is true for an isom brand", () => {
    expect(isMp4Audio(header("isom"))).toBe(true);
  });

  it("is true for every brand in MP4_AUDIO_BRANDS", () => {
    for (const brand of MP4_AUDIO_BRANDS) {
      expect(isMp4Audio(header(brand))).toBe(true);
    }
  });

  it("is false for a RIFF/WAVE header", () => {
    const bytes = new Uint8Array([
      ...Buffer.from("RIFF", "latin1"),
      0x00,
      0x00,
      0x00,
      0x00,
      ...Buffer.from("WAVE", "latin1"),
    ]);
    expect(isMp4Audio(bytes)).toBe(false);
  });

  it("is false for an HLS playlist header", () => {
    const bytes = new Uint8Array(Buffer.from("#EXTM3U\n#EXT-X-VERSION:3\n", "latin1"));
    expect(isMp4Audio(bytes)).toBe(false);
  });

  it("is false for a brand not in the whitelist", () => {
    expect(isMp4Audio(header("qt  "))).toBe(false);
  });

  it("is false for an 11-byte array", () => {
    expect(isMp4Audio(new Uint8Array(11))).toBe(false);
  });

  it("is false for an empty array", () => {
    expect(isMp4Audio(new Uint8Array(0))).toBe(false);
  });
});
