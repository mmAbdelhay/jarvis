import { describe, expect, it } from "vitest";
import {
  ELIDED_TOOL_OUTPUT,
  MIN_HISTORY_TOKENS,
  fitHistory,
  historyBudget,
  messageTokens,
} from "./context-fit.js";
import type { ModelMessage } from "./types.js";

const user = (text: string): ModelMessage => ({ role: "user", text });
const answer = (text: string): ModelMessage => ({ role: "assistant", text, toolCalls: [] });
const call = (id: string): ModelMessage => ({
  role: "assistant",
  text: "",
  toolCalls: [{ id, name: "logs_query", input: {} }],
});
const result = (id: string, content: string): ModelMessage => ({
  role: "tool",
  results: [{ callId: id, name: "logs_query", content, isError: false }],
});
const total = (messages: readonly ModelMessage[]) =>
  messages.reduce((sum, message) => sum + messageTokens(message), 0);

describe("fitHistory", () => {
  it("returns a copy when everything fits", () => {
    const messages = [user("hi"), answer("hello")];
    const fitted = fitHistory(messages, 1_000);
    expect(fitted).toEqual(messages);
    expect(fitted).not.toBe(messages);
  });

  it("drops whole earlier exchanges from the front, starting at a user message", () => {
    const messages = [
      user("a".repeat(400)),
      call("c1"),
      result("c1", "x".repeat(400)),
      answer("b".repeat(400)),
      user("now"),
    ];
    const fitted = fitHistory(messages, 50);
    expect(fitted).toEqual([user("now")]);
  });

  it("never starts with a tool result or an assistant tool call", () => {
    const messages = [
      user("first"),
      call("c1"),
      result("c1", "y".repeat(2_000)),
      answer("done"),
      user("second"),
      answer("ok"),
      user("third"),
    ];
    const fitted = fitHistory(messages, total(messages.slice(4)) + 1);
    expect(fitted[0]).toEqual(user("second"));
  });

  it("keeps the current turn and elides its older tool outputs, never the latest", () => {
    const messages = [
      user("old question"),
      answer("old answer"),
      user("check the logs"),
      call("c1"),
      result("c1", "z".repeat(30_000)),
      call("c2"),
      result("c2", "w".repeat(30_000)),
    ];
    const fitted = fitHistory(messages, 9_000);
    expect(fitted[0]).toEqual(user("check the logs"));
    expect(fitted[2]).toEqual(result("c1", ELIDED_TOOL_OUTPUT));
    expect(fitted[4]).toEqual(result("c2", "w".repeat(30_000)));
  });
});

describe("fitHistory with an oversized latest output or prompt", () => {
  it("cuts the latest tool output and the prompt to the budget", () => {
    const messages: ModelMessage[] = [
      { role: "user", text: "p".repeat(40_000) },
      { role: "assistant", text: "", toolCalls: [{ id: "a", name: "t", input: {} }] },
      {
        role: "tool",
        results: [{ callId: "a", name: "t", content: "l".repeat(32_000), isError: false }],
      },
    ];
    const fitted = fitHistory(messages, 3_000);
    expect(fitted.reduce((sum, m) => sum + messageTokens(m), 0)).toBeLessThanOrEqual(3_000);
    expect(fitted).toHaveLength(3);
    const tool = fitted[2];
    expect(tool?.role === "tool" && tool.results[0]?.callId).toBe("a");
  });
});

describe("historyBudget", () => {
  it("subtracts the system text, the tool schemas and a reply reserve, with a floor", () => {
    expect(historyBudget(8_192, "s".repeat(4_000), [])).toBe(8_192 - 1_000 - 1 - 2_048);
    expect(historyBudget(2_000, "s".repeat(40_000), [])).toBe(MIN_HISTORY_TOKENS);
  });
});
