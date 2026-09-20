import { describe, expect, it } from "vitest";
import { UPLOAD_CHUNK_BYTES, base64ByteLength, splitBase64 } from "./base64-chunks";

// No Buffer (apps/mobile has no @types/node, and production code must stay
// Buffer-free for React Native): a minimal base64 encoder built on the DOM
// `btoa` global (in scope via expo/tsconfig.base's `lib: ["DOM", ...]`),
// fed a manually-built binary string.
function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe("base64ByteLength", () => {
  it("computes the exact decoded byte length for well-formed base64", () => {
    expect(base64ByteLength("AA==")).toBe(1);
    expect(base64ByteLength("AAA=")).toBe(2);
    expect(base64ByteLength("AAAA")).toBe(3);
  });

  it("returns undefined for empty, non-multiple-of-4, and malformed strings", () => {
    expect(base64ByteLength("")).toBeUndefined();
    expect(base64ByteLength("AAA")).toBeUndefined();
    expect(base64ByteLength("A===")).toBeUndefined();
    expect(base64ByteLength("AA=A")).toBeUndefined();
    expect(base64ByteLength("AA-_")).toBeUndefined();
  });
});

describe("splitBase64", () => {
  it("splits a 1,000,000-byte payload's base64 into 4 parts of the expected lengths, each full part an exact chunk, and rejoins to the input", () => {
    const bytes = new Uint8Array(1_000_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;
    const b64 = encodeBase64(bytes);

    const parts = splitBase64(b64, UPLOAD_CHUNK_BYTES);
    // 1_333_336 total base64 chars (base64 of 1_000_000 bytes) / 349_524
    // chars per full chunk = 3 full chunks + a 284_764-char remainder —
    // asserted as a literal, not `parts[3]?.length`, so a regression that
    // drops or shortens the fourth part actually fails this line (vitest's
    // `toEqual` otherwise ignores a trailing `undefined` array element).
    expect(parts).toHaveLength(4);
    expect(parts.map((p) => p.length)).toEqual([349_524, 349_524, 349_524, 284_764]);
    expect(parts[0]?.length).toBe(349_524);
    expect(parts[1]?.length).toBe(349_524);
    expect(parts[2]?.length).toBe(349_524);

    expect(parts.join("")).toBe(b64);
    expect(base64ByteLength(parts[0] ?? "")).toBe(UPLOAD_CHUNK_BYTES);
    expect(base64ByteLength(parts[1] ?? "")).toBe(UPLOAD_CHUNK_BYTES);
    expect(base64ByteLength(parts[2] ?? "")).toBe(UPLOAD_CHUNK_BYTES);
  });

  it(
    "throws for a chunkBytes that isn't a positive multiple of 3 " +
      "[bite-proof: allow non-multiples of 3; slices end mid-quantum and a part decodes to the wrong length]",
    () => {
      expect(() => splitBase64("AAAA", 262_144)).toThrow();
    },
  );
});
