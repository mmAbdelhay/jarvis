// packages/core/src/agent/context-fit.images.test.ts
import { describe, expect, it } from "vitest";
import { ELIDED_TOOL_OUTPUT, fitHistory, messageTokens } from "./context-fit.js";
import { IMAGE_TOKENS } from "./images.js";
import type { ModelMessage } from "./types.js";

const image = { mediaType: "image/png" as const, dataBase64: "A".repeat(400_000) };

describe("context fitting with screenshots", () => {
  it("counts a screenshot as IMAGE_TOKENS, not as its base64 length", () => {
    const withImage: ModelMessage = {
      role: "tool",
      results: [{ callId: "c", name: "screen_look", content: "", isError: false, image }],
    };
    const without: ModelMessage = {
      role: "tool",
      results: [{ callId: "c", name: "screen_look", content: "", isError: false }],
    };
    expect(messageTokens(withImage) - messageTokens(without)).toBe(IMAGE_TOKENS);
  });

  it("drops the image of an elided older tool output", () => {
    const turn: ModelMessage[] = [
      { role: "user", text: "go" },
      { role: "assistant", text: "", toolCalls: [{ id: "a", name: "screen_look", input: {} }] },
      {
        role: "tool",
        results: [
          { callId: "a", name: "screen_look", content: "x".repeat(4_000), isError: false, image },
        ],
      },
      { role: "assistant", text: "", toolCalls: [{ id: "b", name: "screen_look", input: {} }] },
      {
        role: "tool",
        results: [{ callId: "b", name: "screen_look", content: "y", isError: false, image }],
      },
    ];
    const fitted = fitHistory(turn, 2_400);
    const first = fitted[2];
    expect(first?.role === "tool" && first.results[0]?.content).toBe(ELIDED_TOOL_OUTPUT);
    expect(first?.role === "tool" && "image" in (first.results[0] ?? {})).toBe(false);
    const last = fitted[4];
    expect(last?.role === "tool" && last.results[0]?.image).toBeDefined();
  });

  it("reserves the latest screenshot's token cost when cutting its text", () => {
    const turn: ModelMessage[] = [
      { role: "user", text: "go" },
      { role: "assistant", text: "", toolCalls: [{ id: "a", name: "screen_look", input: {} }] },
      {
        role: "tool",
        results: [
          { callId: "a", name: "screen_look", content: "x".repeat(8_000), isError: false, image },
        ],
      },
    ];
    const fitted = fitHistory(turn, 2_400);
    expect(fitted.reduce((sum, message) => sum + messageTokens(message), 0)).toBeLessThanOrEqual(
      2_400,
    );
    const latest = fitted[2];
    expect(latest?.role === "tool" && latest.results[0]?.image).toEqual(image);
    expect(turn[2]?.role === "tool" && turn[2].results[0]?.content).toBe("x".repeat(8_000));
  });
});
