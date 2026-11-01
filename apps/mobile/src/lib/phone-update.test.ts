import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, test } from "vitest";
import { cachePath, isUpdateFileName, progressFraction, sha256Hex } from "./phone-update";

async function* chunksOf(bytes: Uint8Array, size: number): AsyncIterable<Uint8Array> {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size);
}

describe("phone-update helpers", () => {
  test("sha256Hex over chunks equals the whole-file hash", async () => {
    const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
    const expected = bytesToHex(sha256(bytes));
    expect(await sha256Hex(chunksOf(bytes, 1024))).toBe(expected);
    expect(await sha256Hex(chunksOf(bytes, 7))).toBe(expected);
  });

  test('sha256Hex matches the published SHA-256 of "abc"', async () => {
    const abc = new TextEncoder().encode("abc");
    expect(await sha256Hex(chunksOf(abc, 1))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("only jarvis-mobile-*.apk names are update files", () => {
    expect(isUpdateFileName("jarvis-mobile-0.1.12.apk")).toBe(true);
    expect(isUpdateFileName("jarvis-mobile-.apk")).toBe(false);
    expect(isUpdateFileName("prefs.json")).toBe(false);
    expect(isUpdateFileName("other-0.1.12.apk")).toBe(false);
  });

  test("cachePath joins with one slash", () => {
    expect(cachePath("file:///c/", "a.apk")).toBe("file:///c/a.apk");
    expect(cachePath("file:///c", "a.apk")).toBe("file:///c/a.apk");
  });

  test("progressFraction uses the asset size when the length is unknown, clamps to 1", () => {
    expect(progressFraction(50, 200, 999)).toBe(0.25);
    expect(progressFraction(50, -1, 100)).toBe(0.5);
    expect(progressFraction(300, 200, 0)).toBe(1);
    expect(progressFraction(50, -1, 0)).toBe(0);
    expect(progressFraction(-5, 100, 100)).toBe(0);
  });
});
