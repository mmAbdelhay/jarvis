import { describe, expect, it } from "vitest";
import type { AgentEvent, Card } from "./contract.js";
import { languageRule } from "./i18n.js";
import { TOOL_ACTIVITY, USER_TEXT } from "./messages.js";
import { createRiskGate, type RiskGate } from "./risk-gate.js";
import { runTurn } from "./tool-loop.js";
import { loadToolRegistry } from "./tool-registry.js";
import type { McpSession, ModelChatRequest, ModelEvent, ModelProvider } from "./types.js";

const done: ModelEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };

async function setup(replies: ModelEvent[][]) {
  const requests: ModelChatRequest[] = [];
  const provider: ModelProvider = {
    async *chat(request) {
      requests.push(request);
      yield* replies.shift() ?? [{ type: "text", delta: "ok" }, done];
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => [],
    reachable: async () => ({ ok: true }),
  };
  const session: McpSession = {
    name: "jarvis-diag",
    alive: true,
    listTools: async () => [
      {
        name: "net.status",
        description: "s",
        inputSchema: { type: "object" },
        meta: { jarvis: { risk: "safe" } },
      },
      {
        name: "svc.restart",
        description: "r",
        inputSchema: { type: "object" },
        meta: { jarvis: { risk: "confirm" } },
      },
    ],
    callTool: async (tool) => ({
      isError: tool === "net.status",
      structuredContent: {},
      text: "x",
    }),
    close: () => {},
  };
  const registry = await loadToolRegistry([session], {
    trusted: new Set(["jarvis-diag"]),
    log: () => {},
  });
  const events: AgentEvent[] = [];
  const describedIn: string[] = [];
  let gate: RiskGate | undefined;
  gate = createRiskGate({
    emit: (event) => {
      events.push(event);
      if (event.type === "card") {
        const card: Card = event.card;
        queueMicrotask(() =>
          gate?.confirm({ cardId: card.cardId, approve: false, ticked: [], secrets: {} }),
        );
      }
    },
    describe: async (tool, _input, lang) => {
      describedIn.push(lang);
      return { title: tool.name, detail: "", source: "system" };
    },
    audit: async () => {},
    now: () => 0,
    newId: () => "card1",
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    log: () => {},
  });
  const run = (lang?: "en" | "ar") =>
    runTurn(
      {
        provider,
        registry,
        gate: gate as RiskGate,
        toolsEnabled: true,
        emit: (e) => events.push(e),
        newId: () => "g1",
      },
      {
        turnId: "t1",
        history: [],
        text: "x",
        signal: new AbortController().signal,
        ...(lang === undefined ? {} : { lang }),
      },
    );
  return { run, requests, events, describedIn };
}

describe("a turn's language (M4 §3)", () => {
  it("tells the model to answer in the turn language, before the safety rules", async () => {
    const { run, requests } = await setup([]);
    await run("ar");
    const system = requests[0]?.system ?? "";
    expect(system).toContain(languageRule("ar"));
    expect(system.indexOf(languageRule("ar"))).toBeLessThan(system.indexOf("<safety-rules>"));
  });

  it("writes activity lines and the failure line in the turn language", async () => {
    const { run, events } = await setup([
      [{ type: "tool_call", id: "c1", name: "net_status", input: {} }, done],
    ]);
    await run("ar");
    const summaries = events.flatMap((e) => (e.type === "tool" ? [e.summary] : []));
    expect(summaries).toContain(TOOL_ACTIVITY.ar["net.status"]);
    expect(summaries).toContain(
      USER_TEXT.ar.toolFailed(TOOL_ACTIVITY.ar["net.status"] as string, "failed"),
    );
  });

  it("describes card items in the turn language", async () => {
    const { run, describedIn } = await setup([
      [{ type: "tool_call", id: "c1", name: "svc_restart", input: {} }, done],
    ]);
    await run("ar");
    expect(describedIn).toEqual(["ar"]);
  });

  it("defaults to English", async () => {
    const { run, requests, describedIn } = await setup([
      [{ type: "tool_call", id: "c1", name: "svc_restart", input: {} }, done],
    ]);
    await run();
    expect(requests[0]?.system).toContain(languageRule("en"));
    expect(describedIn).toEqual(["en"]);
  });
});
