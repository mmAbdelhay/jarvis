// Base64 slicing for the blob upload lane (M8 ruling 2): base64 crosses
// only the React Native bridge — the network carries raw bytes, via
// `TransportSocket.sendBinary`. This file has no native, network or
// wire-protocol dependency of its own; it only knows how to measure and
// slice a base64 string exactly.

// The largest multiple of 3 (decoded bytes) at or under
// MAX_BLOB_CHUNK_BYTES (262_144, @jarvis/wire) — a chunk this size decodes
// to an exact byte count with no partial base64 quantum at either end.
export const UPLOAD_CHUNK_BYTES = 262_143;

const BASE64_SHAPE_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The exact decoded byte length of a base64 string, or `undefined` if it
 * isn't well-formed base64: non-empty, a length that's a multiple of 4,
 * built only from the base64 alphabet with 0-2 `=` padding characters that
 * appear only at the very end.
 */
export function base64ByteLength(base64: string): number | undefined {
  if (base64.length === 0) return undefined;
  if (base64.length % 4 !== 0) return undefined;
  if (!BASE64_SHAPE_PATTERN.test(base64)) return undefined;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

/**
 * Slices `base64` into consecutive parts, each decoding to exactly
 * `chunkBytes` bytes except possibly the last, which may be shorter. Slices
 * fall on 4-character (one base64 quantum) boundaries only, so every full
 * part decodes cleanly with no padding in the middle. The returned parts,
 * joined, equal `base64` exactly.
 */
export function splitBase64(base64: string, chunkBytes: number): string[] {
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes % 3 !== 0) {
    throw new Error("chunkBytes must be a positive multiple of 3");
  }
  const chunkChars = (chunkBytes / 3) * 4;
  const parts: string[] = [];
  for (let i = 0; i < base64.length; i += chunkChars) {
    parts.push(base64.slice(i, i + chunkChars));
  }
  return parts;
}
