// packages/platform/src/model/images.adapters.test.ts
import type { ModelMessage } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { toAnthropicMessages } from "./anthropic.js";
import { createThoughtSignatures, toGeminiContents } from "./gemini-format.js";
import { toOllamaMessages } from "./ollama.js";
import { toOpenAiMessages } from "./openai-compatible.js";

const history: ModelMessage[] = [
  { role: "user", text: "export the image" },
  { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "screen_look", input: {} }] },
  {
    role: "tool",
    results: [
      {
        callId: "c1",
        name: "screen_look",
        content: "windows: GIMP",
        isError: false,
        image: { mediaType: "image/png", dataBase64: "iVBORw0KGgoAAA" },
      },
    ],
  },
];

describe("screenshots in each provider's wire format (v1.1 §3.2)", () => {
  it("Anthropic: an image block inside the tool_result", () => {
    const out = toAnthropicMessages(history) as { role: string; content: unknown[] }[];
    expect(out[2]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "c1",
      content: [
        { type: "text", text: "windows: GIMP" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAA" },
        },
      ],
      is_error: false,
    });
  });

  it("Anthropic: text-only results keep their plain string content", () => {
    const text: ModelMessage[] = [
      { role: "tool", results: [{ callId: "c", name: "n", content: "t", isError: false }] },
    ];
    const out = toAnthropicMessages(text) as { content: { content: unknown }[] }[];
    expect(out[0]?.content[0]?.content).toBe("t");
  });

  it("OpenAI-compatible: the tool message, then a user message with image_url", () => {
    const out = toOpenAiMessages("sys", history);
    expect(out.slice(3)).toEqual([
      { role: "tool", tool_call_id: "c1", content: "windows: GIMP" },
      {
        role: "user",
        content: [
          { type: "text", text: "Screenshot returned by screen_look (call c1)." },
          { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAA" } },
        ],
      },
    ]);
  });

  it("Gemini: inlineData after the functionResponse", () => {
    const out = toGeminiContents(history, createThoughtSignatures(), {
      dummySignatures: false,
    }) as {
      role: string;
      parts: unknown[];
    }[];
    expect(out[2]).toEqual({
      role: "user",
      parts: [
        { functionResponse: { name: "screen_look", response: { output: "windows: GIMP" } } },
        { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAA" } },
      ],
    });
  });

  it("Ollama: the tool message, then a user message carrying images", () => {
    const out = toOllamaMessages("sys", history);
    expect(out.slice(3)).toEqual([
      { role: "tool", content: "windows: GIMP", tool_name: "screen_look" },
      {
        role: "user",
        content: "Screenshot returned by screen_look (call c1).",
        images: ["iVBORw0KGgoAAA"],
      },
    ]);
  });
});

describe("mixed tool results", () => {
  const results = [
    { callId: "c0", name: "read", content: "unavailable", isError: true },
    ...(history[2]?.role === "tool" ? history[2].results : []),
    { callId: "c2", name: "read", content: "done", isError: false },
  ];
  const mixed: ModelMessage[] = [{ role: "tool", results }];

  it("OpenAI keeps every tool response before the screenshot message", () => {
    expect(toOpenAiMessages("sys", mixed).slice(1)).toEqual([
      { role: "tool", tool_call_id: "c0", content: "ERROR: unavailable" },
      { role: "tool", tool_call_id: "c1", content: "windows: GIMP" },
      { role: "tool", tool_call_id: "c2", content: "done" },
      toOpenAiMessages("sys", history)[4],
    ]);
  });

  it("Ollama keeps every tool response before the screenshot message", () => {
    expect(toOllamaMessages("sys", mixed).slice(1)).toEqual([
      { role: "tool", tool_name: "read", content: "ERROR: unavailable" },
      { role: "tool", tool_name: "screen_look", content: "windows: GIMP" },
      { role: "tool", tool_name: "read", content: "done" },
      toOllamaMessages("sys", history)[4],
    ]);
  });

  it("Gemini keeps all function responses before inlineData", () => {
    expect(toGeminiContents(mixed, createThoughtSignatures(), { dummySignatures: false })).toEqual([
      {
        role: "user",
        parts: [
          { functionResponse: { name: "read", response: { error: "unavailable" } } },
          { functionResponse: { name: "screen_look", response: { output: "windows: GIMP" } } },
          { functionResponse: { name: "read", response: { output: "done" } } },
          { inlineData: { mimeType: "image/png", data: "iVBORw0KGgoAAA" } },
        ],
      },
    ]);
  });

  it("Anthropic preserves error flags and merges a following user prompt", () => {
    const out = toAnthropicMessages([...mixed, { role: "user", text: "continue" }]) as {
      content: unknown[];
    }[];
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual([
      { type: "tool_result", tool_use_id: "c0", content: "unavailable", is_error: true },
      (toAnthropicMessages(history)[2] as { content: unknown[] }).content[0],
      { type: "tool_result", tool_use_id: "c2", content: "done", is_error: false },
      { type: "text", text: "continue" },
    ]);
  });
});
