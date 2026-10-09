import { describe, expect, it } from "vitest";
import { cosine, createBm25Index, stem, tokenize } from "./text-index.js";

describe("tokenize", () => {
  it("lower-cases, splits on non-letters, drops stop words and one-letter words, stems", () => {
    expect(tokenize("What did I install last week?")).toEqual(["install", "last", "week"]);
    expect(tokenize("pkg_install: Install apps")).toEqual(["pkg", "install", "install", "app"]);
    expect(tokenize("Wi-Fi networks")).toEqual(["wi", "fi", "network"]);
  });

  it("keeps Arabic words", () => {
    expect(tokenize("ثبّت متصفح")).toHaveLength(2);
  });
});

describe("stem", () => {
  it("folds simple English endings so forms meet", () => {
    for (const [a, b] of [
      ["installed", "install"],
      ["installing", "install"],
      ["updates", "updated"],
      ["services", "service"],
      ["batteries", "battery"],
      ["boxes", "box"],
    ]) {
      expect(stem(a as string)).toBe(stem(b as string));
    }
    expect(stem("class")).toBe("class");
  });
});

describe("createBm25Index", () => {
  const index = createBm25Index([
    { id: "weather", text: "weather forecast for a city: temperature, rain" },
    { id: "music", text: "play music: a song or playlist" },
    { id: "timer", text: "set a countdown timer in minutes" },
  ]);

  it("ranks the matching document first and reports coverage", () => {
    const hits = index.search("set a timer for ten minutes");
    // Query terms: set, timer, ten, minut — the timer doc has three of them.
    expect(hits[0]).toMatchObject({ id: "timer", matched: 3, of: 4 });
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });

  it("returns nothing for no overlap and for an empty query", () => {
    expect(index.search("bluetooth headphones")).toEqual([]);
    expect(index.search("")).toEqual([]);
  });

  it("accepts pre-tokenised terms", () => {
    expect(index.search(["song"])[0]?.id).toBe("music");
  });

  it("handles an empty corpus", () => {
    expect(createBm25Index([]).search("anything")).toEqual([]);
  });
});

describe("cosine", () => {
  it("is 1 for the same direction, 0 for orthogonal, mismatched or zero vectors", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 0], [1, 0, 0])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine(new Float32Array([1, 1]), new Float32Array([1, 0]))).toBeCloseTo(Math.SQRT1_2);
  });
});
