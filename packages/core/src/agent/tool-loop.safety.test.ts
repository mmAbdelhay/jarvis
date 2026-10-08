import { describe, expect, it } from "vitest";
import { historyBudget, messageTokens } from "./context-fit.js";
import { createRiskGate } from "./risk-gate.js";
import { SAFETY_RULES } from "./safety.js";
import { type ToolLoopDeps, runTurn, trimHistory } from "./tool-loop.js";
import { loadToolRegistry } from "./tool-registry.js";
import type { ModelChatRequest, ModelMessage, ModelProvider } from "./types.js";

function recordingProvider(requests: ModelChatRequest[]): ModelProvider {
  return {
    async *chat(request) {
      requests.push({ ...request, messages: [...request.messages] });
      yield { type: "text", delta: `answer ${requests.length} ${"x".repeat(300)}` };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => [],
    reachable: async () => ({ ok: true }),
  };
}

async function loopDeps(provider: ModelProvider, contextTokens: number): Promise<ToolLoopDeps> {
  const registry = await loadToolRegistry([], { trusted: new Set(), log: () => {} });
  const gate = createRiskGate({
    emit: () => {},
    describe: async (tool) => ({ title: tool.name, detail: "", source: "system" }),
    audit: async () => {},
    now: () => 0,
    newId: () => "card",
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    log: () => {},
  });
  let ids = 0;
  return {
    provider,
    registry,
    gate,
    toolsEnabled: true,
    emit: () => {},
    newId: () => `n${++ids}`,
    contextTokens,
  };
}

describe("safety rules on every request (design §3.1, criterion 1)", () => {
  it("closes request 200 of one session with the rules and fits the history", async () => {
    const requests: ModelChatRequest[] = [];
    const deps = await loopDeps(recordingProvider(requests), 6_000);
    let history: ModelMessage[] = [];
    for (let turn = 1; turn <= 200; turn++) {
      const result = await runTurn(deps, {
        turnId: `t${turn}`,
        history,
        text: `question ${turn} ${"y".repeat(400)}`,
        signal: new AbortController().signal,
      });
      expect(result.reason).toBe("done");
      history = trimHistory(result.messages);
    }
    expect(requests).toHaveLength(200);
    for (const request of requests) expect(request.system.endsWith(SAFETY_RULES)).toBe(true);
    const last = requests[199] as ModelChatRequest;
    const lastMessage = last.messages.at(-1);
    expect(lastMessage?.role === "user" && lastMessage.text.startsWith("question 200")).toBe(true);
    const used = last.messages.reduce((sum, message) => sum + messageTokens(message), 0);
    expect(used).toBeLessThanOrEqual(historyBudget(6_000, last.system, last.tools));
  });

  it("places memory notes before the rules", async () => {
    const requests: ModelChatRequest[] = [];
    const deps = await loopDeps(recordingProvider(requests), 32_000);
    await runTurn(deps, {
      turnId: "t1",
      history: [],
      text: "hello",
      notes: ["<memory-notes>\n- prefers Flatpak\n</memory-notes>"],
      signal: new AbortController().signal,
    });
    const system = requests[0]?.system ?? "";
    expect(system.indexOf("prefers Flatpak")).toBeGreaterThan(0);
    expect(system.indexOf("prefers Flatpak")).toBeLessThan(system.indexOf(SAFETY_RULES));
    expect(system.endsWith(SAFETY_RULES)).toBe(true);
  });
});
