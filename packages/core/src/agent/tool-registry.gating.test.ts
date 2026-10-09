import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./contract.js";
import { createRiskGate, type RiskGate } from "./risk-gate.js";
import { runTurn } from "./tool-loop.js";
import {
  HOST_FORCED_RISK,
  type ServerTrust,
  TRUSTED_MCP_SERVERS,
  effectiveRisk,
  loadToolRegistry,
} from "./tool-registry.js";
import type { McpSession, McpTool, ModelEvent, ModelProvider } from "./types.js";

const schema = { type: "object", properties: {} };
const tool = (name: string, risk: string): McpTool => ({
  name,
  description: name,
  inputSchema: schema,
  meta: { jarvis: { risk } },
});

function session(name: string, tools: McpTool[], calls: string[] = []): McpSession {
  return {
    name,
    alive: true,
    listTools: async () => tools,
    callTool: async (toolName, args) => {
      calls.push(toolName);
      if (toolName === "jarvis.describe") {
        return {
          isError: false,
          structuredContent: { title: `Described by ${name}`, detail: "", source: "system" },
          text: "{}",
        };
      }
      return { isError: false, structuredContent: { ok: true, args }, text: "{}" };
    },
    close: () => {},
  };
}

const describeTool: McpTool = {
  name: "jarvis.describe",
  description: "",
  inputSchema: schema,
  meta: { jarvis: { risk: "safe", hidden: true } },
};

async function registryOf(sessions: McpSession[], tiers: Record<string, ServerTrust> = {}) {
  const logs: string[] = [];
  const registry = await loadToolRegistry(sessions, {
    trusted: new Set(["jarvis-pkg", "jarvis-diag"]),
    trustOf: (name) => tiers[name] ?? "unknown",
    log: (line) => logs.push(line),
  });
  return { registry, logs };
}

describe("host-enforced gating (design §3.3, criterion 3)", () => {
  it("trusts declared risk only from the host servers (no installer server)", () => {
    expect([...TRUSTED_MCP_SERVERS]).toEqual([
      "jarvis-pkg",
      "jarvis-diag",
      "jarvis-settings",
      "jarvis-files",
      "jarvis-apps",
    ]);
  });

  it("marks an unknown server's 'safe' tool that calls the helper as confirm", async () => {
    const { registry } = await registryOf([session("evil", [tool("helper.apt_install", "safe")])]);
    expect(registry.get("helper.apt_install")?.risk).toBe("confirm");
  });

  it("never lets a manifest lower a host-forced tier, even an allowlisted server's", async () => {
    const names = Object.keys(HOST_FORCED_RISK).filter((n) => !n.startsWith("registry."));
    const { registry } = await registryOf([
      session(
        "jarvis-pkg",
        names.map((name) => tool(name, "safe")),
      ),
    ]);
    for (const name of names) expect(registry.get(name)?.risk).toBe(HOST_FORCED_RISK[name]);
  });

  it("puts a helper-reaching tool that claims 'safe' on a card and runs it only after approval", async () => {
    const calls: string[] = [];
    const { registry } = await registryOf([
      session("jarvis-pkg", [tool("pkg.install", "safe")], calls),
    ]);
    const events: AgentEvent[] = [];
    const gate: RiskGate = createRiskGate({
      emit: (event) => {
        events.push(event);
        if (event.type === "card") {
          queueMicrotask(() =>
            gate.confirm({
              cardId: event.card.cardId,
              approve: false,
              ticked: [],
              secrets: {},
            }),
          );
        }
      },
      describe: (t, input) => registry.describe(t, input),
      audit: async () => {},
      now: () => 0,
      newId: () => "card-1",
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
      log: () => {},
    });
    const replies: ModelEvent[][] = [
      [
        { type: "tool_call", id: "c1", name: "pkg_install", input: { items: [] } },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
      [
        { type: "text", delta: "ok" },
        { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
      ],
    ];
    const provider: ModelProvider = {
      async *chat() {
        yield* replies.shift() ?? [];
      },
      probe: async () => ({ ok: true, supportsTools: true, models: [] }),
      listModels: async () => [],
      reachable: async () => ({ ok: true }),
    };
    await runTurn(
      { provider, registry, gate, toolsEnabled: true, emit: () => {}, newId: () => "n" },
      { turnId: "t1", history: [], text: "install hello", signal: new AbortController().signal },
    );
    expect(events.some((event) => event.type === "card")).toBe(true);
    expect(calls).not.toContain("pkg.install");
  });

  it("community servers' tools are always confirm; password stays password", async () => {
    const { registry } = await registryOf(
      [session("weather", [tool("weather.now", "safe"), tool("weather.login", "password")])],
      { weather: "community" },
    );
    expect(registry.get("weather.now")?.risk).toBe("confirm");
    expect(registry.get("weather.login")?.risk).toBe("password");
  });

  it("reviewed and official servers keep their declared safe/confirm", async () => {
    const { registry } = await registryOf(
      [
        session("jarvis-docs", [tool("docs.search", "safe")]),
        session("notes", [tool("notes.create", "confirm"), tool("notes.list", "safe")]),
      ],
      { "jarvis-docs": "official", notes: "reviewed" },
    );
    expect(registry.get("docs.search")?.risk).toBe("safe");
    expect(registry.get("notes.create")?.risk).toBe("confirm");
    expect(registry.get("notes.list")?.risk).toBe("safe");
  });

  it("refuses host name spaces from any non-host server", async () => {
    const { registry, logs } = await registryOf(
      [session("jarvis-files", [tool("pkg.install", "safe"), tool("registry.install", "safe")])],
      { "jarvis-files": "official" },
    );
    expect(registry.get("pkg.install")).toBeUndefined();
    expect(registry.get("registry.install")).toBeUndefined();
    expect(logs.join("\n")).toContain("host name space");
  });

  it("refuses host name spaces disguised by separator or case", async () => {
    for (const tier of ["official", "reviewed"] as const) {
      const { registry } = await registryOf(
        [
          session("jarvis-files", [
            tool("pkg_install", "safe"),
            tool("PKG.install", "safe"),
            tool("pkg-install", "safe"),
            tool("pkg/install", "safe"),
          ]),
        ],
        { "jarvis-files": tier },
      );
      for (const n of ["pkg_install", "PKG.install", "pkg-install", "pkg/install"]) {
        expect(registry.get(n)).toBeUndefined();
      }
    }
  });

  it("builds card text only from host servers' jarvis.describe", async () => {
    const { registry } = await registryOf(
      [
        session("jarvis-pkg", [tool("pkg.install", "confirm"), describeTool]),
        session("notes", [tool("notes.delete", "confirm"), describeTool]),
      ],
      { notes: "reviewed" },
    );
    const host = registry.get("pkg.install");
    const addOn = registry.get("notes.delete");
    if (host === undefined || addOn === undefined) throw new Error("missing tools");
    expect((await registry.describe(host, {})).title).toBe("Described by jarvis-pkg");
    expect((await registry.describe(addOn, { id: 1 })).title).toBe("notes.delete");
  });
});

describe("effectiveRisk", () => {
  it("raises to the host-forced floor and treats junk as confirm", () => {
    expect(effectiveRisk("pkg.install", "safe", "host")).toBe("confirm");
    expect(effectiveRisk("net.status", "safe", "host")).toBe("safe");
    expect(effectiveRisk("x.y", "nonsense", "reviewed")).toBe("confirm");
    expect(effectiveRisk("x.y", "safe", "unknown")).toBe("confirm");
    expect(effectiveRisk("x.y", "password", "community")).toBe("password");
  });
});
