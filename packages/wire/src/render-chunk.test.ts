import { describe, expect, it } from "vitest";
import { renderChunk } from "./render-chunk.js";

describe("renderChunk (the ruling-10 client rule)", () => {
  it.each([
    [10, 8, "abcd", "cd"],
    [10, 12, "ab", "ab"],
    [10, 4, "abc", ""],
  ] as const)("renderChunk(end=%d, offset=%d, %j) is %j", (end, offset, chunk, expected) => {
    expect(renderChunk(end, offset, chunk)).toBe(expected);
  });
});
