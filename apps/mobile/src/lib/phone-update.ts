// The phone updater's pure pieces: where releases are listed, which cache
// files are ours, how a download's progress becomes a fraction, and the
// streamed SHA-256 that gates the installer. No platform imports here —
// phone-update-store.ts drives these through injected deps.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

export const RELEASES_URL = "https://api.github.com/repos/mmAbdelhay/jarvis/releases?per_page=10";
export const RELEASES_HEADERS: Record<string, string> = {
  accept: "application/vnd.github+json",
};

/** Check at start, then once a day; foreground re-checks after a day too. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** A release-list or SUMS request that takes longer than this has failed. */
export const FETCH_TIMEOUT_MS = 30_000;
/** A download with no progress event for this long has stalled. */
export const DOWNLOAD_STALL_MS = 60_000;
/** Hash this many bytes per read: never the whole APK in memory. */
export const HASH_CHUNK_BYTES = 1024 * 1024;

const UPDATE_FILE = /^jarvis-mobile-.+\.apk$/;

/** A downloaded (or half-downloaded) update file in the cache dir. */
export function isUpdateFileName(name: string): boolean {
  return UPDATE_FILE.test(name);
}

/** `cacheDir` + name, with exactly one slash between them. */
export function cachePath(cacheDir: string, name: string): string {
  return cacheDir.endsWith("/") ? `${cacheDir}${name}` : `${cacheDir}/${name}`;
}

/** Bytes written → 0..1. Falls back to the release's asset size when the
 *  server sent no length; anything unusable reads as 0. */
export function progressFraction(written: number, total: number, assetSize: number): number {
  const whole = total > 0 ? total : assetSize;
  if (!(whole > 0) || !Number.isFinite(written) || written <= 0) return 0;
  return Math.min(1, written / whole);
}

/** Lowercase hex SHA-256 of a stream of chunks, hashed incrementally.
 *  `onBytes` hears the running byte count after each chunk. */
export async function sha256Hex(
  chunks: AsyncIterable<Uint8Array>,
  onBytes?: (hashed: number) => void,
): Promise<string> {
  const hash = sha256.create();
  let hashed = 0;
  for await (const chunk of chunks) {
    hash.update(chunk);
    hashed += chunk.length;
    onBytes?.(hashed);
  }
  return bytesToHex(hash.digest());
}

/** Whether `next` is at least one whole percent past `shown`: progress
 *  is only emitted then, so a download re-renders the UI ≤ 100 times. */
export function risesWholePercent(shown: number, next: number): boolean {
  return Math.floor(next * 100) > Math.floor(shown * 100);
}
