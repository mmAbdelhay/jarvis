// packages/core/src/agent/vision.test.ts
import { describe, expect, it } from "vitest";
import { modelSupportsVision, normalizeOllamaTag } from "./vision.js";

describe("modelSupportsVision", () => {
  it("knows Claude 3+ sees images, except 3.5 Haiku and older models", () => {
    for (const m of [
      "claude-sonnet-4-5",
      "claude-opus-4-1",
      "claude-3-5-sonnet-latest",
      "claude-haiku-4-5",
      "claude-sonnet-5-5",
    ]) {
      expect(modelSupportsVision("anthropic", m), m).toBe(true);
    }
    for (const m of ["claude-3-5-haiku-latest", "claude-2.1", "claude-instant-1.2", ""]) {
      expect(modelSupportsVision("anthropic", m), m).toBe(false);
    }
  });

  it("knows the OpenAI-compatible vision families and refuses text-only ones", () => {
    for (const m of [
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-5",
      "o3",
      "o4-mini",
      "qwen/qwen2.5-vl-72b-instruct",
      "pixtral-large-latest",
      "llava-v1.6",
      "google/gemma-3-27b-it",
      "meta-llama/llama-4-scout",
    ]) {
      expect(modelSupportsVision("openai-compatible", m), m).toBe(true);
    }
    for (const m of [
      "gpt-3.5-turbo",
      "deepseek-chat",
      "mistral-large-latest",
      "llama-3.1-70b",
      "qwen3:8b",
    ]) {
      expect(modelSupportsVision("openai-compatible", m), m).toBe(false);
    }
  });

  it("treats every Gemini chat model as vision-capable, not embeddings", () => {
    expect(modelSupportsVision("gemini", "gemini-2.5-flash")).toBe(true);
    expect(modelSupportsVision("gemini", "models/gemini-3-pro")).toBe(true);
    expect(modelSupportsVision("gemini", "gemini-embedding-001")).toBe(false);
  });

  it("requires catalog evidence for Ollama rather than model names", () => {
    const tags = new Set([normalizeOllamaTag("acme-vl:3b")]);
    expect(modelSupportsVision("ollama", "acme-vl:3b", tags)).toBe(true);
    for (const m of ["llava:7b", "gemma3:4b", "qwen3:8b", "gemma3:1b"]) {
      expect(modelSupportsVision("ollama", m), m).toBe(false);
    }
  });

  it("normalises Ollama tags", () => {
    expect(normalizeOllamaTag("LLaVA")).toBe("llava:latest");
    expect(normalizeOllamaTag("llava:7b")).toBe("llava:7b");
  });
});
