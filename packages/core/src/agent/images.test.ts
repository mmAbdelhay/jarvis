// packages/core/src/agent/images.test.ts
import { describe, expect, it } from "vitest";
import { IMAGE_DROPPED, keepLatestImages, screenshotCaption, withoutImage } from "./images.js";
import type { ModelMessage, ModelToolResult } from "./types.js";

const shot = (n: number): ModelToolResult => ({
  callId: `c${n}`,
  name: "screen_look",
  content: `look ${n}`,
  isError: false,
  image: { mediaType: "image/png", dataBase64: `PNG${n}` },
});

describe("keepLatestImages", () => {
  it("keeps only the newest screenshot and notes the removed ones", () => {
    const messages: ModelMessage[] = [
      { role: "user", text: "export it" },
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "screen_look", input: {} }] },
      { role: "tool", results: [shot(1)] },
      { role: "assistant", text: "", toolCalls: [{ id: "c2", name: "screen_look", input: {} }] },
      { role: "tool", results: [shot(2), shot(3)] },
    ];
    const kept = keepLatestImages(messages);
    const results = kept.flatMap((m) => (m.role === "tool" ? m.results : []));
    expect(results.map((r) => r.image?.dataBase64)).toEqual([undefined, undefined, "PNG3"]);
    expect(results[0]?.content).toBe(`look 1\n${IMAGE_DROPPED}`);
    expect(results[1]?.content).toBe(`look 2\n${IMAGE_DROPPED}`);
    expect(results[2]?.content).toBe("look 3");
    // The input is not changed.
    expect(messages[2]?.role === "tool" && messages[2].results[0]?.image).toBeDefined();
  });

  it("leaves text-only histories alone", () => {
    const messages: ModelMessage[] = [{ role: "user", text: "hi" }];
    expect(keepLatestImages(messages)).toEqual(messages);
  });
});

describe("withoutImage", () => {
  it("drops the image field entirely and appends a note only when there was one", () => {
    const plain = withoutImage(shot(1));
    expect("image" in plain).toBe(false);
    expect(plain.content).toBe("look 1");
    expect(withoutImage(shot(1), "[gone]").content).toBe("look 1\n[gone]");
    const textOnly: ModelToolResult = { callId: "x", name: "n", content: "t", isError: false };
    expect(withoutImage(textOnly, "[gone]").content).toBe("t");
  });
});

describe("screenshotCaption", () => {
  it("names the tool and the call", () => {
    expect(screenshotCaption("screen_look", "c9")).toBe(
      "Screenshot returned by screen_look (call c9).",
    );
  });
});
