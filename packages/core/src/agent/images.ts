// packages/core/src/agent/images.ts
// Screenshots in the agent vocabulary (Rafiq v1.1 §3.2). A tool result may
// carry one PNG; the provider adapters turn it into their own image block.
// Every request keeps only the newest screenshot (older ones become a short
// note), and a screenshot is counted as a fixed token cost, never as the
// length of its base64. Pure.
import type { ModelMessage, ModelProvider, ModelToolResult } from "./types.js";

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

export const IMAGE_WITHHELD = "[Screenshot withheld: this model may not see the screen.]";

export function hasImages(messages: readonly ModelMessage[]): boolean {
  return messages.some((m) => m.role === "tool" && m.results.some((r) => r.image !== undefined));
}

/** A copy with no image anywhere (history kept after a turn, memory, other providers). */
export function stripImages(
  messages: readonly ModelMessage[],
  note: string = IMAGE_DROPPED,
): ModelMessage[] {
  return messages.map((message) =>
    message.role === "tool" && message.results.some((r) => r.image !== undefined)
      ? { role: "tool", results: message.results.map((r) => withoutImage(r, note)) }
      : message,
  );
}

/** Design §2.6: a screenshot reaches only a provider allowed to see the
 *  screen (enabled, vision, local or consented), asked at every request so a
 *  mid-turn failover can never carry one to another provider. */
export function withImagePolicy(
  provider: ModelProvider,
  allowImages: () => boolean,
): ModelProvider {
  return {
    chat(request) {
      if (!hasImages(request.messages) || allowImages()) return provider.chat(request);
      return provider.chat({ ...request, messages: stripImages(request.messages, IMAGE_WITHHELD) });
    },
    probe: () => provider.probe(),
    listModels: (signal) => provider.listModels(signal),
    reachable: (signal) => provider.reachable(signal),
  };
}
