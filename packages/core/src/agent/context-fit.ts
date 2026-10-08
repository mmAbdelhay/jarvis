// History fitting (design §3.1): per request, the oldest whole exchanges go
// first, cut only at a user message so a tool call is never separated from
// its results. If the current turn alone is too big, its older tool outputs
// are replaced by a one-line note; the latest output and every message's
// order stay. The system text (and so the safety rules) is never touched.
// Pure.
import type { ProviderKind } from "./contract.js";
import { estimateTokens } from "./safety.js";
import type { ModelMessage, ModelToolSpec } from "./types.js";

export const DEFAULT_CONTEXT_TOKENS = 32_000;
/** What jarvisd assumes each provider kind accepts. Ollama gets exactly this
 *  as num_ctx (ollama.ts); the others are below their documented limits. */
export const CONTEXT_TOKENS: Readonly<Record<ProviderKind, number>> = {
  anthropic: 180_000,
  "openai-compatible": 32_000,
  ollama: 8_192,
  gemini: 900_000,
};
export const RESPONSE_RESERVE_TOKENS = 2_048;
export const MIN_HISTORY_TOKENS = 1_024;
export const ELIDED_TOOL_OUTPUT = "[Earlier tool output removed to fit the model's context.]";
export const CUT_NOTE = "\n[Cut to fit the model's context.]";
const PER_MESSAGE_TOKENS = 4;
/** What the latest tool output keeps at least, before the prompt is cut too. */
const MIN_LATEST_OUTPUT_TOKENS = 256;

/** `text` cut (from the end) so it is at most `maxTokens`, with a note. */
function cutToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const room = Math.max(0, maxTokens - estimateTokens(CUT_NOTE));
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, mid)) <= room) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}${CUT_NOTE}`;
}

function cutToolMessage(message: ModelMessage, maxTokens: number): ModelMessage {
  if (message.role !== "tool") return message;
  const each = Math.max(1, Math.floor((maxTokens - PER_MESSAGE_TOKENS) / message.results.length));
  return {
    role: "tool",
    results: message.results.map((result) => ({
      ...result,
      content: cutToTokens(result.content, each),
    })),
  };
}

export function messageTokens(message: ModelMessage): number {
  switch (message.role) {
    case "user":
      return estimateTokens(message.text) + PER_MESSAGE_TOKENS;
    case "assistant":
      return (
        estimateTokens(message.text) +
        message.toolCalls.reduce(
          (sum, call) => sum + estimateTokens(`${call.name}${JSON.stringify(call.input) ?? ""}`),
          0,
        ) +
        PER_MESSAGE_TOKENS
      );
    case "tool":
      return (
        message.results.reduce((sum, result) => sum + estimateTokens(result.content), 0) +
        PER_MESSAGE_TOKENS
      );
  }
}

export function historyBudget(
  contextTokens: number,
  system: string,
  tools: readonly ModelToolSpec[],
): number {
  return Math.max(
    MIN_HISTORY_TOKENS,
    contextTokens -
      estimateTokens(system) -
      estimateTokens(JSON.stringify(tools)) -
      RESPONSE_RESERVE_TOKENS,
  );
}

export function fitHistory(messages: readonly ModelMessage[], budget: number): ModelMessage[] {
  const sizes = messages.map(messageTokens);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= budget) return [...messages];

  let lastUser = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  for (let start = 0; start <= lastUser; start++) {
    if (start > 0) total -= sizes[start - 1] ?? 0;
    if (messages[start]?.role !== "user") continue;
    if (total <= budget) return messages.slice(start);
  }

  // The current turn alone is too big: keep it whole, shortening older outputs.
  const turn = messages.slice(lastUser);
  let size = turn.reduce((sum, message) => sum + messageTokens(message), 0);
  let lastTool = -1;
  for (let i = turn.length - 1; i >= 0; i--) {
    if (turn[i]?.role === "tool") {
      lastTool = i;
      break;
    }
  }
  for (let i = 0; i < turn.length && size > budget; i++) {
    const message = turn[i];
    if (message?.role !== "tool" || i === lastTool) continue;
    const shorter: ModelMessage = {
      role: "tool",
      results: message.results.map((result) => ({ ...result, content: ELIDED_TOOL_OUTPUT })),
    };
    size -= messageTokens(message) - messageTokens(shorter);
    turn[i] = shorter;
  }

  // Still too big: the latest output, then the prompt itself, are cut so the
  // request never overflows the context (the model would drop the rules).
  if (size > budget && lastTool >= 0) {
    const current = turn[lastTool] as ModelMessage;
    const allowed = Math.max(MIN_LATEST_OUTPUT_TOKENS, messageTokens(current) - (size - budget));
    const shorter = cutToolMessage(current, allowed);
    size -= messageTokens(current) - messageTokens(shorter);
    turn[lastTool] = shorter;
  }
  const first = turn[0];
  if (size > budget && first?.role === "user") {
    const allowed = Math.max(MIN_LATEST_OUTPUT_TOKENS, messageTokens(first) - (size - budget));
    turn[0] = { role: "user", text: cutToTokens(first.text, allowed - PER_MESSAGE_TOKENS) };
  }
  return turn;
}
