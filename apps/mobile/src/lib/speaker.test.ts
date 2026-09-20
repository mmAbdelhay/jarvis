import { describe, expect, test } from "vitest";
import { speechLanguageTag, splitForSpeech, voiceMatches } from "./speaker";

describe("speechLanguageTag", () => {
  test("ar", () => {
    expect(speechLanguageTag("ar")).toBe("ar-SA");
  });

  test("en", () => {
    expect(speechLanguageTag("en")).toBe("en-US");
  });
});

describe("splitForSpeech", () => {
  test("empty text returns []", () => {
    expect(splitForSpeech("   ", 4000)).toEqual([]);
    expect(splitForSpeech("", 4000)).toEqual([]);
  });

  test("text no longer than max returns [text], trimmed", () => {
    expect(splitForSpeech("  hello  ", 4000)).toEqual(["hello"]);
  });

  // Fix round 1, Minor #1: max < 1 has no meaningful cut point.
  test("max < 1 returns the whole trimmed text unsplit instead of looping", () => {
    expect(splitForSpeech("hello world", 0)).toEqual(["hello world"]);
    expect(splitForSpeech("hello world", -5)).toEqual(["hello world"]);
    expect(splitForSpeech("hello world", Number.NaN)).toEqual(["hello world"]);
  });

  // Fix round 1, Minor #1: at max === 1, a leading surrogate pair's
  // back-off would otherwise produce a cut of 0 and never shrink `rest`.
  test("max === 1 with a leading surrogate pair terminates and makes progress", () => {
    const emoji = "\u{1F600}"; // 😀 — two UTF-16 units
    const text = `${emoji}bb`;

    const parts = splitForSpeech(text, 1);

    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.length).toBeGreaterThan(0);
    }
    expect(parts.join("")).toBe(text);
  });

  test("a 9000-char English paragraph splits at sentence ends within max", () => {
    const sentence = "This is a short sentence about Jarvis.";
    const sentences = Array.from({ length: 250 }, () => sentence);
    const text = sentences.join(" ");
    expect(text.length).toBeGreaterThan(9000 - 200);

    const max = 4000;
    const parts = splitForSpeech(text, max);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(max);
    }
    // Every part but possibly the last ends at a sentence end, since one
    // exists well within range of every cut.
    for (const part of parts.slice(0, -1)) {
      expect(part.endsWith(".")).toBe(true);
    }
    // Rejoining with a single space reconstructs the (already
    // single-spaced) input.
    expect(parts.join(" ")).toBe(text);
  });

  test("an Arabic text is cut at ؟", () => {
    const question = "هل يمكن أن يساعدني جارفيس في هذه المهمة؟";
    const questions = Array.from({ length: 150 }, () => question);
    const text = questions.join(" ");

    const max = 4000;
    const parts = splitForSpeech(text, max);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(max);
    }
    for (const part of parts.slice(0, -1)) {
      expect(part.endsWith("؟")).toBe(true);
    }
  });

  test("a 5000-char single word cuts at exactly max", () => {
    const max = 4000;
    const text = "a".repeat(5000);
    const parts = splitForSpeech(text, max);

    expect(parts).toEqual(["a".repeat(4000), "a".repeat(1000)]);
  });

  test("a surrogate pair at position 4000 is not split", () => {
    const max = 4000;
    const emoji = "\u{1F600}"; // 😀 — a single astral code point, two UTF-16 units
    const text = `${"a".repeat(3999)}${emoji}${"b".repeat(10)}`;
    expect(text.length).toBeGreaterThan(max);

    const parts = splitForSpeech(text, max);

    // No part boundary falls inside the surrogate pair: no part ends with
    // a lone high surrogate, and none starts with a lone low surrogate.
    for (const part of parts) {
      const lastCode = part.charCodeAt(part.length - 1);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
      const firstCode = part.charCodeAt(0);
      expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
    }
    // Concatenating every part (no whitespace was involved) reconstructs
    // the original text exactly, and the emoji appears whole in one part.
    expect(parts.join("")).toBe(text);
    expect(parts.some((part) => part.includes(emoji))).toBe(true);
  });

  test("avoids a mid-word cut when a space was available", () => {
    // [bite-proof: cut at exactly `max` always; a word is split]
    const word = "abcde";
    const max = 4000;
    const text = Array.from({ length: 1000 }, () => word).join(" ");
    expect(text.length).toBeGreaterThan(max);

    const parts = splitForSpeech(text, max);

    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(max);
      for (const token of part.split(" ")) {
        expect(token.length).toBe(word.length);
      }
    }
    expect(parts.join(" ")).toBe(text);
  });
});

describe("voiceMatches", () => {
  test("ar matches ar-SA, ar_EG, AR", () => {
    expect(voiceMatches("ar-SA", "ar")).toBe(true);
    expect(voiceMatches("ar_EG", "ar")).toBe(true);
    expect(voiceMatches("AR", "ar")).toBe(true);
  });

  test("ar does not match arn, en-GB", () => {
    expect(voiceMatches("arn", "ar")).toBe(false);
    expect(voiceMatches("en-GB", "ar")).toBe(false);
  });

  test("en matches en-GB", () => {
    expect(voiceMatches("en-GB", "en")).toBe(true);
  });
});
