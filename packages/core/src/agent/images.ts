// packages/core/src/agent/images.ts
// Screenshots in the agent vocabulary (Rafiq v1.1 §3.2). A tool result may
// carry one PNG; the provider adapters turn it into their own image block.
// Every request keeps only the newest screenshot (older ones become a short
// note), and a screenshot is counted as a fixed token cost, never as the
// length of its base64. Pure.
import type { ModelMessage, ModelToolResult } from "./types.js";

/** What one ≤1280-px screenshot costs in context (Anthropic: w*h/750 ≈ 1 400). */
export const IMAGE_TOKENS = 1_600;
export const IMAGE_DROPPED = "[An earlier screenshot was removed.]";

/** The text that introduces a screenshot where a provider needs a separate
 *  user message for it (OpenAI-compatible, Ollama). */
export function screenshotCaption(name: string, callId: string): string {
  return `Screenshot returned by ${name} (call ${callId}).`;
}

/** The result without its image; `note` is appended only if one was removed. */
export function withoutImage(result: ModelToolResult, note?: string): ModelToolResult {
  const { image, ...rest } = result;
  if (image === undefined || note === undefined) return rest;
  return { ...rest, content: `${rest.content}\n${note}` };
}

/** A copy where only the newest `keep` screenshots remain. */
export function keepLatestImages(messages: readonly ModelMessage[], keep = 1): ModelMessage[] {
  let seen = 0;
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i];
    if (message?.role !== "tool" || !message.results.some((r) => r.image !== undefined)) continue;
    const results = [...message.results];
    for (let j = results.length - 1; j >= 0; j--) {
      const result = results[j] as ModelToolResult;
      if (result.image === undefined) continue;
      seen++;
      if (seen > keep) results[j] = withoutImage(result, IMAGE_DROPPED);
    }
    out[i] = { role: "tool", results };
  }
  return out;
}
