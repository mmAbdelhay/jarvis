import { describe, expect, it } from "vitest";
import { SIMPLE_PROFILE } from "./backup.js";
import type { AgentEvent } from "./contract.js";
import { AGENT_TEXT, USER_TEXT } from "./messages.js";
import { createRiskGate } from "./risk-gate.js";
import { FULL_PROFILE, runTurn } from "./tool-loop.js";
import { loadToolRegistry } from "./tool-registry.js";
import type { McpSession, ModelChatRequest, ModelEvent, ModelProvider } from "./types.js";

const done: ModelEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };

async function setup(options: { backupFrom: number; replies: ModelEvent[][] }) {
  const requests: ModelChatRequest[] = [];
  const called: string[] = [];
  let backup = false;
  const provider: ModelProvider = {
    async *chat(request) {
      requests.push(request);
      // The failover switches inside chat(), before the backup's first event.
      if (requests.length > options.backupFrom) backup = true;
      yield* options.replies.shift() ?? [{ type: "text", delta: "bye" }, done];
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => [],
    reachable: async () => ({ ok: true }),
  };
  const session: McpSession = {
    name: "jarvis-pkg",
    alive: true,
    listTools: async () =>
      ["net.status", "logs.query", "pkg.install"].map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
        meta: { jarvis: { risk: name === "pkg.install" ? "confirm" : "safe" } },
      })),
    callTool: async (tool) => {
      called.push(tool);
      return { isError: false, structuredContent: {}, text: "{}" };
    },
    close: () => {},
  };
  const registry = await loadToolRegistry([session], {
    trusted: new Set(["jarvis-pkg"]),
    log: () => {},
  });
  const events: AgentEvent[] = [];
  const cards: unknown[] = [];
  const gate = createRiskGate({
    emit: (event) => {
      if (event.type === "card") cards.push(event.card);
    },
    describe: async (tool) => ({ title: tool.name, detail: "", source: "system" }),
    audit: async () => {},
    now: () => 0,
    newId: () => "card",
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    log: () => {},
  });
  const result = await runTurn(
    {
      provider,
      registry,
      gate,
      toolsEnabled: true,
      emit: (event) => events.push(event),
      newId: () => "g",
      profile: () => (backup ? SIMPLE_PROFILE : FULL_PROFILE),
    },
    { turnId: "t1", history: [], text: "x", signal: new AbortController().signal, lang: "ar" },
  );
  return { result, requests, called, events, cards };
}

const call = (name: string, id = "c1"): ModelEvent[] => [
  { type: "tool_call", id, name, input: {} },
  done,
];

describe("the backup model's turn (M4 §1)", () => {
  it("says once, before the backup's first words, that the backup is answering", async () => {
    const { events } = await setup({
      backupFrom: 0,
      replies: [call("net_status"), [{ type: "text", delta: "الشبكة تعمل" }, done]],
    });
    const texts = events.flatMap((e) => (e.type === "text" ? [e.delta] : []));
    expect(texts).toEqual([`${USER_TEXT.ar.backupNotice}\n\n`, "الشبكة تعمل"]);
  });

  it("says nothing while the usual model answers", async () => {
    const { events } = await setup({
      backupFrom: 99,
      replies: [[{ type: "text", delta: "hi" }, done]],
    });
    expect(events.flatMap((e) => (e.type === "text" ? [e.delta] : []))).toEqual(["hi"]);
  });

  it("refuses a tool outside the simple profile even when the model names it", async () => {
    const { called, cards, requests } = await setup({
      backupFrom: 0,
      replies: [[...call("pkg_install", "a").slice(0, 1), ...call("logs_query", "b")]],
    });
    expect(called).toEqual([]);
    expect(cards).toEqual([]);
    const results = requests[1]?.messages.at(-1);
    expect(results?.role).toBe("tool");
    if (results?.role === "tool") {
      expect(results.results.map((r) => r.content)).toEqual([
        AGENT_TEXT.unknownTool("pkg_install"),
        AGENT_TEXT.unknownTool("logs_query"),
      ]);
    }
  });

  it("stops after 8 steps on the backup and asks for a summary without tools", async () => {
    const replies = Array.from({ length: 12 }, (_, i) => call("net_status", `c${i}`));
    const { result, requests, called } = await setup({ backupFrom: 0, replies });
    expect(result.reason).toBe("step-limit");
    expect(called).toHaveLength(8);
    expect(requests).toHaveLength(9);
    expect(requests[8]?.tools).toEqual([]);
    const last = requests[8]?.messages.at(-1);
    expect(last).toEqual({ role: "user", text: AGENT_TEXT.stepLimitNote(8) });
  });

  it("counts only the backup's steps when it takes over mid-turn", async () => {
    const replies = Array.from({ length: 20 }, (_, i) => call("net_status", `c${i}`));
    const { result, called } = await setup({ backupFrom: 3, replies });
    expect(result.reason).toBe("step-limit");
    expect(called).toHaveLength(3 + 8);
  });
});
