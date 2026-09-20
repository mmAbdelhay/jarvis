import { isAbsolute } from "node:path";

/** ruling 4: the output is bounded to this many seconds whatever the input claims. */
export const TRANSCODE_MAX_SECONDS = 120;

/**
 * ISO-BMFF major brands the recorders this app ships (ruling 3: AAC in
 * MPEG-4 on both iOS and Android, with a 44.1 kHz fallback) can produce, or
 * that a compliant MP4/M4A muxer commonly writes. Anything else — including
 * a brand ffmpeg would happily demux, like `qt  ` (QuickTime) — is refused
 * by {@link isMp4Audio} before a phone-supplied file ever reaches ffmpeg.
 */
export const MP4_AUDIO_BRANDS: readonly string[] = [
  "M4A ",
  "mp42",
  "mp41",
  "isom",
  "iso2",
  "iso5",
  "3gp4",
  "3gp5",
  "3gp6",
];

/**
 * True iff `header` is at least 12 bytes, bytes 4-7 spell `ftyp` (the
 * ISO-BMFF file-type box every MP4/M4A file starts with), and bytes 8-11 —
 * the box's major brand, read as latin1 like every other 4-byte FourCC in
 * this format — are one of {@link MP4_AUDIO_BRANDS}.
 *
 * This is the only gate between a phone-supplied file and
 * `transcodeToWhisperWavCommand`'s forced `-f mov` demuxer: it never reads
 * past the header it was given.
 */
export function isMp4Audio(header: Uint8Array): boolean {
  if (header.length < 12) return false;

  const ftyp = Buffer.from(header.buffer, header.byteOffset + 4, 4).toString("latin1");
  if (ftyp !== "ftyp") return false;

  const brand = Buffer.from(header.buffer, header.byteOffset + 8, 4).toString("latin1");
  return MP4_AUDIO_BRANDS.includes(brand);
}

/**
 * The exact, pinned ffmpeg invocation that turns a phone-recorded m4a into
 * a whisper-ready wav. There is no platform parameter and no caller-chosen
 * flag: every element here exists because ruling 4 requires it.
 *
 * - `-nostdin`: a decoder given attacker-influenced bytes must never wait
 *   on, or read from, this process's stdin.
 * - `-hide_banner -loglevel error`: keeps ffmpeg's own build/config banner
 *   and progress noise off stderr, so the 64 KiB cap (ruling 4) holds real
 *   diagnostics, not boilerplate.
 * - `-protocol_whitelist file`: a crafted MOV can reference other
 *   locations by protocol (`http:`, `tcp:`, `concat:`, …); this stops the
 *   demuxer from ever opening anything but the local input file.
 * - `-enable_drefs 0`: keeps MOV external data references off (ffmpeg's
 *   default, stated explicitly so a future ffmpeg default change can't
 *   silently re-enable it).
 * - `-f mov`: forces the MOV/MP4 demuxer. Without this, ffmpeg probes the
 *   bytes and picks a demuxer itself — a file merely renamed to `.m4a`
 *   could steer it into a playlist, concat or image demuxer, several of
 *   which can themselves open other files or URLs.
 * - `-i <input>`: the one file this process reads.
 * - `-map 0:a:0 -vn -sn -dn`: takes only the first audio stream and
 *   explicitly drops video, subtitle and data streams, so an m4a with an
 *   embedded cover-art video track can't smuggle anything through.
 * - `-t 120`: bounds the output to {@link TRANSCODE_MAX_SECONDS} whatever
 *   duration the container claims.
 * - `-ar 16000 -ac 1 -c:a pcm_s16le`: whisper's expected input format.
 * - `-f wav -y <output>`: writes (overwriting) exactly the wav this
 *   process created the temp directory for.
 */
export function transcodeToWhisperWavCommand(
  input: string,
  output: string,
): { command: string; args: string[] } {
  if (!isAbsolute(input) || !isAbsolute(output)) {
    throw new Error("transcodeToWhisperWavCommand: input and output must be absolute paths");
  }
  if (input.startsWith("-") || output.startsWith("-")) {
    throw new Error("transcodeToWhisperWavCommand: input and output must not start with '-'");
  }
  if (input === output) {
    throw new Error("transcodeToWhisperWavCommand: input and output must not be equal");
  }

  return {
    command: "ffmpeg",
    args: [
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
      input,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-t",
      String(TRANSCODE_MAX_SECONDS),
      "-ar",
      "16000",
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "-y",
      output,
    ],
  };
}
