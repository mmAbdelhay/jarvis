// Pure parts of the vision probe (v1.1 contracts §3): no Ollama needed.
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  PROBE_HEIGHT,
  PROBE_TARGETS,
  PROBE_WIDTH,
  TOLERANCE,
  hits,
  readClick,
  contextSize,
  targetPng,
  verdict,
} from "./vision-fixture";

/** RGB of one pixel: targetPng writes one IDAT right after IHDR (offset 33). */
function pixel(png: Buffer, x: number, y: number): number[] {
  const width = png.readUInt32BE(16);
  const length = png.readUInt32BE(33);
  const raw = inflateSync(png.subarray(41, 41 + length));
  const o = y * (width * 3 + 1) + 1 + x * 3;
  return [raw[o] ?? -1, raw[o + 1] ?? -1, raw[o + 2] ?? -1];
}

describe("vision probe fixture", () => {
  it("draws a 1280x800 RGB PNG with the red button only at the target", () => {
    const t = PROBE_TARGETS[0]!;
    const png = targetPng(t);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(PROBE_WIDTH);
    expect(png.readUInt32BE(20)).toBe(PROBE_HEIGHT);
    expect(pixel(png, t.x + t.w / 2, t.y + t.h / 2)).toEqual([220, 30, 30]);
    expect(pixel(png, t.x - 1, t.y + 1)).not.toEqual([220, 30, 30]);
    expect(pixel(png, t.x + t.w, t.y + 1)).not.toEqual([220, 30, 30]);
  });

  it("uses distinct targets inside the image, none at the centre", () => {
    const keys = new Set(PROBE_TARGETS.map((t) => `${t.x},${t.y}`));
    expect(keys.size).toBe(PROBE_TARGETS.length);
    for (const t of PROBE_TARGETS) {
      expect(t.x + t.w).toBeLessThanOrEqual(PROBE_WIDTH);
      expect(t.y + t.h).toBeLessThanOrEqual(PROBE_HEIGHT);
      expect(hits({ x: PROBE_WIDTH / 2, y: PROBE_HEIGHT / 2 }, t)).toBe(false);
    }
  });

  it("grades a click with a small tolerance", () => {
    const t = PROBE_TARGETS[1]!;
    expect(hits({ x: t.x + 5, y: t.y + 5 }, t)).toBe(true);
    expect(hits({ x: t.x - TOLERANCE, y: t.y }, t)).toBe(true);
    expect(hits({ x: t.x - TOLERANCE - 1, y: t.y }, t)).toBe(false);
    expect(hits({ x: t.x + t.w + TOLERANCE + 1, y: t.y }, t)).toBe(false);
    expect(hits(null, t)).toBe(false);
  });

  it("reads clicks from tool arguments, numbers or numeric strings only", () => {
    expect(readClick({ x: "12", y: 3 })).toEqual({ x: 12, y: 3 });
    expect(readClick({ x: "", y: 3 })).toBeNull();
    expect(readClick({ x: null, y: 3 })).toBeNull();
    expect(readClick("x=1,y=2")).toBeNull();
    expect(readClick(undefined)).toBeNull();
  });

  it("passes on two hits out of three", () => {
    expect(verdict([true, true, false])).toBe("passed");
    expect(verdict([true, false, false])).toBe("failed");
    expect(verdict([])).toBe("failed");
  });
});

// The probe must use the selected model's configured context, not a fixed 8192.
describe("vision probe context", () => {
  it("reads num_ctx from Ollama model parameters", () => {
    expect(contextSize("temperature 0\nnum_ctx 16384\n")).toBe(16384);
  });
  it("accepts an explicit catalog context size", () => {
    expect(contextSize("num_ctx 2048", "32768")).toBe(32768);
  });
  it("refuses absent or invalid context sizes", () => {
    for (const value of ["", "0", "-1", "2.5", "Infinity", "oops"]) {
      expect(contextSize("", value)).toBeNull();
    }
    expect(contextSize(undefined)).toBeNull();
    expect(contextSize("num_ctx 8192", "oops")).toBeNull();
  });
});
