import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./contract.js";
import { AGENT_TEXT } from "./messages.js";
import { createRiskGate } from "./risk-gate.js";
import { SAFE_CALL_CONCURRENCY, type TurnResult, runTurn } from "./tool-loop.js";
import { loadToolRegistry } from "./tool-registry.js";
import type { McpSession, McpTool, ModelEvent, ModelProvider, ModelToolResult } from "./types.js";

const schema = { type: "object", properties: {} };
const DONE: ModelEvent = { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition never became true");
}

function holdingSession(safe: string[], confirm: string[] = []) {
  const pending: { id: string; resolve(): void }[] = [];
  const started: string[] = [];
  let inflight = 0;
  let peak = 0;
  const tools: McpTool[] = [
    ...safe.map((name) => ({
      name,
      description: name,
      inputSchema: schema,
      meta: { jarvis: { risk: "safe" } },
    })),
    ...confirm.map((name) => ({
      name,
      description: name,
      inputSchema: schema,
      meta: { jarvis: { risk: "confirm" } },
    })),
  ];
  const session: McpSession = {
    name: "jarvis-diag",
    alive: true,
    listTools: async () => tools,
    callTool: async (tool, args) => {
      const id = String(args["id"] ?? tool);
      started.push(id);
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise<void>((resolve) => pending.push({ id, resolve }));
      inflight--;
      return { isError: false, structuredContent: { id }, text: `result ${id}` };
    },
    close: () => {},
  };
  return {
    session,
    started,
    peak: () => peak,
    pendingIds: () => pending.map((p) => p.id),
    release(id: string) {
      const index = pending.findIndex((p) => p.id === id);
      if (index >= 0) pending.splice(index, 1)[0]?.resolve();
    },
  };
}

async function start(
  held: ReturnType<typeof holdingSession>,
  calls: { name: string; id: string }[],
  controller = new AbortController(),
) {
  const registry = await loadToolRegistry([held.session], {
    trusted: new Set(["jarvis-diag"]),
    log: () => {},
  });
  const events: AgentEvent[] = [];
  const gate = createRiskGate({
    emit: (event) => {
      events.push(event);
      if (event.type === "card") {
        queueMicrotask(() =>
          gate.confirm({
            cardId: event.card.cardId,
            approve: true,
            ticked: event.card.items.map((item) => item.itemId),
            secrets: {},
          }),
        );
      }
    },
    describe: async (tool) => ({ title: tool.name, detail: "", source: "system" }),
    audit: async () => {},
    now: () => 0,
    newId: () => "card-1",
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    log: () => {},
  });
  const replies: ModelEvent[][] = [
    [
      ...calls.map((call, i) => ({
        type: "tool_call" as const,
        id: `call${i + 1}`,
        name: call.name,
        input: { id: call.id },
      })),
      DONE,
    ],
    [{ type: "text", delta: "done" }, DONE],
  ];
  const provider: ModelProvider = {
    async *chat() {
      yield* replies.shift() ?? [DONE];
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => [],
    reachable: async () => ({ ok: true }),
  };
  let ids = 0;
  const result: Promise<TurnResult> = runTurn(
    {
      provider,
      registry,
      gate,
      toolsEnabled: true,
      emit: (event) => events.push(event),
      newId: () => `n${++ids}`,
    },
    { turnId: "t1", history: [], text: "check", signal: controller.signal },
  );
  return { result, events };
}

const toolResults = (result: TurnResult): ModelToolResult[] => {
  const message = result.messages.find((m) => m.role === "tool");
  return message?.role === "tool" ? message.results : [];
};

describe("parallel safe calls (design §3.4, criterion 4)", () => {
  it("runs three safe calls of one step at once and answers in call order", async () => {
    const held = holdingSession(["net.status", "logs.query", "sys.health"]);
    const { result } = await start(held, [
      { name: "net_status", id: "a" },
      { name: "logs_query", id: "b" },
      { name: "sys_health", id: "c" },
    ]);
    await until(() => held.started.length === 3);
    expect(held.peak()).toBe(3);
    held.release("c");
    held.release("b");
    held.release("a");
    const done = await result;
    const results = toolResults(done);
    expect(results.map((r) => r.callId)).toEqual(["call1", "call2", "call3"]);
    expect(results[0]?.content).toContain("result a");
    expect(results[2]?.content).toContain("result c");
  });

  it("never runs more than four at once", async () => {
    expect(SAFE_CALL_CONCURRENCY).toBe(4);
    const held = holdingSession(["logs.query"]);
    const { result } = await start(
      held,
      ["1", "2", "3", "4", "5", "6"].map((id) => ({ name: "logs_query", id })),
    );
    await until(() => held.started.length === 4);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(held.started).toHaveLength(4);
    while (held.started.length < 6 || held.pendingIds().length > 0) {
      for (const id of held.pendingIds()) held.release(id);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await result;
    expect(held.peak()).toBe(4);
  });

  it("shows the step's card only after its safe calls finished", async () => {
    const held = holdingSession(["net.status"], ["svc.restart"]);
    const { result, events } = await start(held, [
      { name: "net_status", id: "a" },
      { name: "svc_restart", id: "r" },
      { name: "net_status", id: "b" },
    ]);
    await until(() => held.started.includes("a") && held.started.includes("b"));
    expect(events.some((e) => e.type === "card")).toBe(false);
    held.release("a");
    held.release("b");
    await until(() => held.started.includes("r"));
    held.release("r");
    await result;
    const cardAt = events.findIndex((e) => e.type === "card");
    const lastSafeOk = events
      .map((e) => e.type === "tool" && e.name === "net.status" && e.status === "ok")
      .lastIndexOf(true);
    expect(cardAt).toBeGreaterThan(lastSafeOk);
  });

  it("does not start safe calls after Stop; started ones finish", async () => {
    const held = holdingSession(["logs.query"]);
    const controller = new AbortController();
    const { result } = await start(
      held,
      ["1", "2", "3", "4", "5", "6"].map((id) => ({ name: "logs_query", id })),
      controller,
    );
    await until(() => held.started.length === 4);
    controller.abort();
    for (const id of ["1", "2", "3", "4"]) held.release(id);
    const done = await result;
    expect(done.reason).toBe("stopped");
    expect(held.started).toEqual(["1", "2", "3", "4"]);
    const results = toolResults(done);
    expect(results[4]?.content).toBe(AGENT_TEXT.stopped);
    expect(results[5]?.content).toBe(AGENT_TEXT.stopped);
  });
});

describe("per-turn tool selection hook (design §3.8)", () => {
  it("offers only the selected tools, and a call to an unoffered tool still runs gated", async () => {
    const held = holdingSession(["net.status", "logs.query"]);
    const registry = await loadToolRegistry([held.session], {
      trusted: new Set(["jarvis-diag"]),
      log: () => {},
    });
    const offered: string[][] = [];
    const replies: ModelEvent[][] = [
      [{ type: "tool_call", id: "c1", name: "logs_query", input: { id: "L" } }, DONE],
      [{ type: "text", delta: "ok" }, DONE],
    ];
    const provider: ModelProvider = {
      async *chat(request) {
        offered.push(request.tools.map((t) => t.name));
        yield* replies.shift() ?? [DONE];
      },
      probe: async () => ({ ok: true, supportsTools: true, models: [] }),
      listModels: async () => [],
      reachable: async () => ({ ok: true }),
    };
    const gate = createRiskGate({
      emit: () => {},
      describe: async (tool) => ({ title: tool.name, detail: "", source: "system" }),
      audit: async () => {},
      now: () => 0,
      newId: () => "card",
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
      log: () => {},
    });
    const done = runTurn(
      {
        provider,
        registry,
        gate,
        toolsEnabled: true,
        emit: () => {},
        newId: () => "n",
        selectTools: async (_text, tools) => tools.filter((t) => t.name === "net_status"),
      },
      { turnId: "t", history: [], text: "network?", signal: new AbortController().signal },
    );
    await until(() => held.started.includes("L"));
    held.release("L");
    await done;
    expect(offered[0]).toEqual(["net_status"]);
  });
});
