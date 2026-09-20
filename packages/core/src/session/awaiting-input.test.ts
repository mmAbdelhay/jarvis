import { describe, expect, it } from "vitest";
import { looksLikePrompt, PROMPT_MARKERS, PROMPT_TAIL_CHARS, stripAnsi } from "./awaiting-input.js";

describe("stripAnsi", () => {
  it("removes SGR (CSI) sequences", () => {
    expect(stripAnsi("\x1b[1mBold\x1b[0m")).toBe("Bold");
  });

  it("removes an OSC 8 hyperlink wrapper", () => {
    expect(stripAnsi("\x1b]8;;http://x\x07link\x1b]8;;\x07")).toBe("link");
  });

  it("drops \\r", () => {
    expect(stripAnsi("a\r\nb")).toBe("a\nb");
  });

  it("does not throw on a lone trailing ESC", () => {
    expect(() => stripAnsi("hello\x1b")).not.toThrow();
    expect(stripAnsi("hello\x1b")).toBe("hello");
  });

  it("removes single-character escapes", () => {
    expect(stripAnsi("a\x1bcb")).toBe("ab");
  });
});

describe("PROMPT_MARKERS", () => {
  it("has no duplicates", () => {
    expect(new Set(PROMPT_MARKERS).size).toBe(PROMPT_MARKERS.length);
  });

  it("has no entry shorter than 5 characters", () => {
    for (const marker of PROMPT_MARKERS) {
      expect(marker.length).toBeGreaterThanOrEqual(5);
    }
  });
});

describe("looksLikePrompt", () => {
  const PERMISSION_BLOCK = ["Do you want to proceed?", "\x1b[36m❯\x1b[0m 1. Yes", "  2. No"].join(
    "\n",
  );

  it("is true for a Claude Code permission block wrapped in ANSI", () => {
    expect(looksLikePrompt(PERMISSION_BLOCK)).toBe(true);
  });

  // bite-proof: skip stripAnsi; the fixture's \x1b[36m❯\x1b[0m 1. Yes does
  // not match a plain (un-stripped) substring test against the marker.
  it("bite-proof: an un-stripped ANSI-wrapped marker line fails a plain substring test", () => {
    const ansiYesLine = "\x1b[36m❯\x1b[0m 1. Yes";
    expect(ansiYesLine.toLowerCase().includes("❯ 1. yes")).toBe(false);
    expect(looksLikePrompt(ansiYesLine)).toBe(true);
  });

  it("is false once the block is pushed out of the last 20 lines", () => {
    const noise = Array.from({ length: 30 }, () => "compiling…").join("\n");
    expect(looksLikePrompt(`${PERMISSION_BLOCK}\n${noise}`)).toBe(false);
  });

  it('is true for "(y/n) " alone', () => {
    expect(looksLikePrompt("(y/n) ")).toBe(true);
  });

  it('is false for "$ " alone', () => {
    expect(looksLikePrompt("$ ")).toBe(false);
  });

  it("is false for an empty tail", () => {
    expect(looksLikePrompt("")).toBe(false);
  });

  it("is true when a marker sits at the end of 10,000 characters (only the tail is scanned)", () => {
    expect(looksLikePrompt(`${"x".repeat(10_000)}\n(y/n) `)).toBe(true);
  });

  it("is true case-insensitively", () => {
    expect(looksLikePrompt("DO YOU WANT TO")).toBe(true);
  });
});

describe("PROMPT_TAIL_CHARS", () => {
  it("is 2048", () => {
    expect(PROMPT_TAIL_CHARS).toBe(2_048);
  });
});
