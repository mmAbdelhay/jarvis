// Contracts §5: JARVIS_FAKE_PROVIDER=<script.json> replaces the model with a
// script, for Plan C's integration tests and Plan D's QEMU smoke tests. The
// daemon entry reads the file only when the variable is set; this module is
// pure. A turn starts whenever the request's last message is a user message
// (a new prompt); each chat call inside a turn plays the next reply.
import { type ModelEvent, type ModelProvider, ProviderError, isRecord } from "./types.js";

export type FakeReply = { text: string } | { toolCalls: { name: string; input: unknown }[] };
export type FakeTurn = { expectPromptContains?: string; replies: FakeReply[] };

function parseReply(raw: unknown, turn: number, index: number): FakeReply {
  const where = `fake provider script: turn ${turn} reply ${index}`;
  if (!isRecord(raw)) throw new Error(`${where} must be an object`);
  const { text, toolCalls } = raw;
  if (typeof text === "string") return { text };
  if (!Array.isArray(toolCalls)) throw new Error(`${where} needs "text" or "toolCalls"`);
  return {
    toolCalls: toolCalls.map((call) => {
      if (!isRecord(call) || typeof call["name"] !== "string") {
        throw new Error(`${where}: every tool call needs a "name"`);
      }
      return { name: call["name"], input: call["input"] ?? {} };
    }),
  };
}

export function parseFakeScript(raw: unknown): FakeTurn[] {
  if (!Array.isArray(raw)) throw new Error("fake provider script must be a JSON array of turns");
  return raw.map((turn, t) => {
    if (!isRecord(turn)) throw new Error(`fake provider script: turn ${t + 1} must be an object`);
    const { expectPromptContains, replies } = turn;
    if (expectPromptContains !== undefined && typeof expectPromptContains !== "string") {
      throw new Error(`fake provider script: turn ${t + 1} expectPromptContains must be a string`);
    }
    if (!Array.isArray(replies)) {
      throw new Error(`fake provider script: turn ${t + 1} replies must be an array`);
    }
    return {
      ...(expectPromptContains === undefined ? {} : { expectPromptContains }),
      replies: replies.map((reply, r) => parseReply(reply, t + 1, r + 1)),
    };
  });
}

const DONE: ModelEvent = { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };

export function createFakeProvider(script: readonly FakeTurn[]): ModelProvider {
  let turn = -1;
  let reply = 0;
  return {
    async *chat(request) {
      const last = request.messages[request.messages.length - 1];
      if (last?.role === "user") {
        turn += 1;
        reply = 0;
        const expected = script[turn]?.expectPromptContains;
        if (expected !== undefined && !last.text.includes(expected)) {
          throw new ProviderError(
            "bad-response",
            `fake provider: turn ${turn + 1} expected a prompt containing "${expected}"`,
          );
        }
      }
      const current = script[turn];
      if (current === undefined) {
        yield { type: "text", delta: "fake provider: script exhausted" };
        yield DONE;
        return;
      }
      const next = current.replies[reply];
      reply += 1;
      if (next !== undefined) {
        if ("text" in next) {
          yield { type: "text", delta: next.text };
        } else {
          for (const [k, call] of next.toolCalls.entries()) {
            yield {
              type: "tool_call",
              id: `fake-${turn + 1}-${reply}-${k + 1}`,
              name: call.name,
              input: call.input,
            };
          }
        }
      }
      yield DONE;
    },
    async probe() {
      return { ok: true, supportsTools: true, models: ["fake"] };
    },
    async listModels() {
      return ["fake"];
    },
    async reachable() {
      return { ok: true };
    },
  };
}
