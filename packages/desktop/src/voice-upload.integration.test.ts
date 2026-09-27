import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCommandWithLimits,
  transcodeToWhisperWavCommand,
  type AudioDemuxer,
} from "@jarvis/platform";
import type { VoiceUploadMeta, VoiceUploadResult } from "@jarvis/wire";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteOrigin } from "./remote-blob.js";
import { createVoiceUploadHandler, type VoiceUploadDeps } from "./voice-upload.js";

const ffmpegOnPath = spawnSync("ffmpeg", ["-version"]).status === 0;
const origin: RemoteOrigin = { kind: "remote", deviceId: "device-1", deviceName: "Phone" };
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function assertWhisperWav(wav: Buffer): void {
  expect(wav.subarray(0, 4).toString("latin1")).toBe("RIFF");
  expect(wav.subarray(8, 12).toString("latin1")).toBe("WAVE");
  expect(wav.subarray(12, 16).toString("latin1")).toBe("fmt ");
  expect(wav.readUInt16LE(20)).toBe(1);
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(16_000);
  expect(wav.readUInt16LE(34)).toBe(16);
}

describe.skipIf(!ffmpegOnPath)("voice upload real transcoding", () => {
  for (const fixture of [
    { format: "m4a" as const, extension: "m4a", codec: "aac", demuxer: "mov" as const },
    { format: "webm" as const, extension: "webm", codec: "libopus", demuxer: "webm" as const },
  ]) {
    it(`transcodes a real ${fixture.format} upload to a 16 kHz mono WAV`, async () => {
      const fixtureDir = await mkdtemp(join(tmpdir(), "jarvis-voice-fixture-"));
      const uploadDir = await mkdtemp(join(tmpdir(), "jarvis-voice-upload-"));
      tempDirs.push(fixtureDir, uploadDir);
      const source = join(fixtureDir, `source.${fixture.extension}`);
      const generated = spawnSync("ffmpeg", [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-c:a",
        fixture.codec,
        source,
      ]);
      expect(generated.status).toBe(0);

      let wav: Buffer | undefined;
      const deps: VoiceUploadDeps = {
        now: Date.now,
        makeTempDir: async () => uploadDir,
        writeFileExclusive: async (path, bytes) => writeFile(path, bytes, { flag: "wx" }),
        removeDir: async () => undefined,
        transcode: async (input, output, demuxer: AudioDemuxer) => {
          expect(demuxer).toBe(fixture.demuxer);
          const command = transcodeToWhisperWavCommand(input, output, demuxer);
          const result = await runCommandWithLimits(command.command, command.args, {
            timeoutMs: 30_000,
            maxOutputBytes: 65_536,
          });
          return result.code === 0 && !result.timedOut
            ? { ok: true }
            : { ok: false, detail: `code=${result.code}` };
        },
        utterance: async ({ wavPath }) => {
          wav = await readFile(wavPath);
          return {
            outcome: { kind: "brain", transcript: "ok", language: "en" },
            answered: Promise.resolve(),
          };
        },
        language: "en",
        log: () => undefined,
      };
      const meta: VoiceUploadMeta = {
        turnId: fixture.format === "m4a" ? "1".repeat(32) : "2".repeat(32),
        format: fixture.format,
        durationMs: 1000,
      };
      const handler = createVoiceUploadHandler(deps);
      const result = (await handler(
        [meta],
        new Uint8Array(await readFile(source)),
        origin,
      )) as VoiceUploadResult;

      expect(result.kind).toBe("heard");
      expect(wav).toBeDefined();
      assertWhisperWav(wav as Buffer);
    }, 30_000);
  }
});
