import { describe, expect, it } from "vitest";
import { historyBudget, messageTokens } from "./context-fit.js";
import { createRiskGate } from "./risk-gate.js";
import { SAFETY_RULES } from "./safety.js";
import { type ToolLoopDeps, runTurn, trimHistory } from "./tool-loop.js";
import { loadToolRegistry } from "./tool-registry.js";
import { RESPONSE_RESERVE_TOKENS } from "./context-fit.js";
import { estimateTokens } from "./safety.js";
import type { RegisteredTool, ToolRegistry } from "./tool-registry.js";
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

describe("one huge latest tool output (review: 8k local model, 30 KB logs)", () => {
  it("keeps every request of a 15-step turn inside num_ctx", async () => {
    const tool: RegisteredTool = {
      name: "logs.query",
      modelName: "logs_query",
      server: "jarvis-diag",
      description: "Read logs",
      risk: "safe",
      hidden: false,
      secrets: [],
      batchItems: false,
      inputSchema: {},
      modelSchema: {},
    };
    const registry: ToolRegistry = {
      modelTools: () => [{ name: "logs_query", description: "Read logs", inputSchema: {} }],
      resolve: () => tool,
      get: () => tool,
      sanitizeInput: (_tool, input) => (input ?? {}) as Record<string, unknown>,
      call: async () => ({ ok: true, data: null, text: "line of log output\n".repeat(1_600) }),
      describe: async (t) => ({ title: t.name, detail: "", source: "system" }),
    };
    const requests: ModelChatRequest[] = [];
    let step = 0;
    const provider: ModelProvider = {
      async *chat(request) {
        requests.push({ ...request, messages: [...request.messages] });
        step++;
        if (step <= 15) {
          yield { type: "tool_call", id: `c${step}`, name: "logs_query", input: {} };
        } else {
          yield { type: "text", delta: "done" };
        }
        yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
      },
      probe: async () => ({ ok: true, supportsTools: true, models: [] }),
      listModels: async () => [],
      reachable: async () => ({ ok: true }),
    };
    const deps = { ...(await loopDeps(provider, 8_192)), registry };
    const result = await runTurn(deps, {
      turnId: "t1",
      history: [],
      text: `check the logs ${"z".repeat(60_000)}`,
      signal: new AbortController().signal,
    });
    expect(result.reason).toBe("done");
    expect(requests.length).toBeGreaterThan(15);
    for (const request of requests) {
      const total =
        request.messages.reduce((sum, message) => sum + messageTokens(message), 0) +
        estimateTokens(request.system) +
        estimateTokens(JSON.stringify(request.tools));
      expect(total).toBeLessThanOrEqual(8_192 - RESPONSE_RESERVE_TOKENS);
      expect(request.system.endsWith(SAFETY_RULES)).toBe(true);
    }
  });
});
