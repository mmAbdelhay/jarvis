import { describe, expect, it } from "vitest";
import { PYTHON } from "./__fixtures__/recipes.js";
import type { AuditEntry, Card } from "./contract.js";
import { createRecipeEngine } from "./recipe-engine.js";
import { createRiskGate, type RiskGate } from "./risk-gate.js";
import { runTurn } from "./tool-loop.js";
import { loadToolRegistry } from "./tool-registry.js";
import type { McpSession, McpTool, ModelChatRequest, ModelEvent, ModelProvider } from "./types.js";

const done: ModelEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
const tool = (name: string, jarvis: Record<string, unknown>): McpTool => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: { items: { type: "array", maxItems: 200 } } },
  meta: { jarvis },
});

async function setup(options: { tick: number[]; failInstall?: boolean }) {
  const calls: { server: string; tool: string; args: Record<string, unknown> }[] = [];
  const session = (name: string, tools: McpTool[]): McpSession => ({
    name,
    alive: true,
    listTools: async () => tools,
    callTool: async (called, args) => {
      if (called === "jarvis.describe") {
        return {
          isError: false,
          structuredContent: {
            title: `Install ${JSON.stringify(args)}`,
            detail: "",
            source: "debian",
          },
          text: "",
        };
      }
      calls.push({ server: name, tool: called, args });
      const fail = options.failInstall === true && called === "pkg.install";
      return {
        isError: fail,
        structuredContent: fail ? { code: "failed" } : {},
        text: fail ? "dpkg error" : "{}",
      };
    },
    close: () => {},
  });
  const registry = await loadToolRegistry(
    [
      session("jarvis-pkg", [
        tool("jarvis.describe", {}),
        tool("pkg.install", { risk: "confirm", batch: "items" }),
        tool("recipes.run", { risk: "confirm" }),
      ]),
      session("jarvis-diag", [tool("svc.restart", { risk: "confirm" })]),
    ],
    { trusted: new Set(["jarvis-pkg", "jarvis-diag"]), log: () => {} },
  );
  const audit: AuditEntry[] = [];
  const cards: Card[] = [];
  let gate: RiskGate | undefined;
  gate = createRiskGate({
    emit: (event) => {
      if (event.type !== "card") return;
      cards.push(event.card);
      const ticked = options.tick.map((i) => event.card.items[i]?.itemId ?? "");
      queueMicrotask(() =>
        gate?.confirm({ cardId: event.card.cardId, approve: true, ticked, secrets: {} }),
      );
    },
    describe: (t, input, lang) => registry.describe(t, input, lang),
    audit: async (entry) => {
      audit.push(entry);
    },
    now: () => 0,
    newId: () => "card1",
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    log: () => {},
  });
  const requests: ModelChatRequest[] = [];
  const replies: ModelEvent[][] = [
    [{ type: "tool_call", id: "c1", name: "recipes_run", input: { id: "python-dev" } }, done],
  ];
  const provider: ModelProvider = {
    async *chat(request) {
      requests.push(request);
      yield* replies.shift() ?? [{ type: "text", delta: "done" }, done];
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => [],
    reachable: async () => ({ ok: true }),
  };
  const recipes = createRecipeEngine({
    load: async () => [PYTHON],
    machine: async () => ({ osId: "rafiq", memTotalBytes: 16 * 1024 ** 3 }),
    hostServers: new Set(["jarvis-pkg", "jarvis-diag"]),
    log: () => {},
  });
  await runTurn(
    {
      provider,
      registry,
      gate: gate as RiskGate,
      toolsEnabled: true,
      emit: () => {},
      newId: () => "g",
      recipes,
    },
    { turnId: "t1", history: [], text: "set up python", signal: new AbortController().signal },
  );
  return { calls, audit, cards, requests };
}

describe("recipes.run end to end (M4 §4)", () => {
  it("one card, one item per step; unticked steps never run; recipes.run never reaches a server", async () => {
    const { calls, audit, cards } = await setup({ tick: [0, 2] });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.items.map((i) => i.title)).toEqual([
      "Install Python",
      "Install venv",
      "Restart SSH",
    ]);
    expect(cards[0]?.items.map((i) => i.tool)).toEqual([
      "pkg.install",
      "pkg.install",
      "svc.restart",
    ]);
    expect(calls).toEqual([
      { server: "jarvis-pkg", tool: "pkg.install", args: PYTHON.steps[0]?.input },
      { server: "jarvis-diag", tool: "svc.restart", args: { unit: "ssh" } },
    ]);
    expect(audit.map((a) => [a.tool, a.title, a.decision, a.result])).toEqual([
      ["recipes.run", "Install Python", "approved", "ok"],
      ["recipes.run", "Install venv", "denied", "skipped"],
      ["recipes.run", "Restart SSH", "approved", "ok"],
    ]);
  });

  it("audits each step with its own result and tells the model which step failed", async () => {
    const { calls, audit, requests } = await setup({ tick: [0, 1, 2], failInstall: true });
    expect(calls.map((c) => c.tool)).toEqual(["pkg.install"]);
    expect(audit.map((a) => a.result)).toEqual(["failed", "skipped", "skipped"]);
    expect(audit[0]?.message).toContain("dpkg error");
    const toolMessage = requests[1]?.messages.at(-1);
    expect(toolMessage?.role === "tool" ? toolMessage.results[0]?.content : "").toContain(
      '"status":"not-run"',
    );
  });
});
