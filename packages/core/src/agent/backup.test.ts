import { describe, expect, it } from "vitest";
import {
  BACKUP_SYSTEM_NOTE,
  SIMPLE_PROFILE,
  SIMPLE_TOOLS,
  simpleToolSpecs,
  withSimpleProfile,
} from "./backup.js";
import { buildSystemPrompt, insertBeforeSafetyRules, SAFETY_RULES } from "./safety.js";
import { loadToolRegistry } from "./tool-registry.js";
import type { McpSession, ModelChatRequest, ModelProvider, ModelToolSpec } from "./types.js";

describe("the simple profile (M4 §1)", () => {
  it("is exactly the contract's 19 tools, at most 8 steps", () => {
    expect([...SIMPLE_TOOLS].sort()).toEqual(
      [
        "pkg.search",
        "pkg.info",
        "pkg.list_installed",
        "disk.usage",
        "sys.health",
        "svc.status",
        "svc.list_failed",
        "svc.restart",
        "net.status",
        "net.wifi_scan",
        "net.connection_up",
        "net.radio_on",
        "apps.list",
        "apps.open",
        "apps.open_path",
        "files.search",
        "files.preview",
        "settings.get",
        "updates.list",
      ].sort(),
    );
    expect(SIMPLE_PROFILE.maxSteps).toBe(8);
    expect(SIMPLE_PROFILE.allows("svc.restart")).toBe(true);
    expect(SIMPLE_PROFILE.allows("pkg.install")).toBe(false);
    expect(SIMPLE_PROFILE.allows("net.wifi_connect")).toBe(false);
  });

  it("offers only registered simple tools, by model name", async () => {
    const session: McpSession = {
      name: "jarvis-diag",
      alive: true,
      listTools: async () =>
        ["net.status", "logs.query", "svc.restart"].map((name) => ({
          name,
          description: name,
          inputSchema: { type: "object" },
          meta: { jarvis: { risk: name === "svc.restart" ? "confirm" : "safe" } },
        })),
      callTool: async () => ({ isError: false, structuredContent: {}, text: "" }),
      close: () => {},
    };
    const registry = await loadToolRegistry([session], {
      trusted: new Set(["jarvis-diag"]),
      log: () => {},
    });
    expect(simpleToolSpecs(registry).map((s) => s.name)).toEqual(["net_status", "svc_restart"]);
  });
});

describe("withSimpleProfile", () => {
  const seen: ModelChatRequest[] = [];
  const inner: ModelProvider = {
    async *chat(request) {
      seen.push(request);
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => ["qwen3:1.7b"],
    reachable: async () => ({ ok: true }),
  };
  const simple: ModelToolSpec[] = [{ name: "net_status", description: "s", inputSchema: {} }];

  it("replaces the tools and adds the backup note before the safety rules", async () => {
    const wrapped = withSimpleProfile(inner, () => simple);
    const system = buildSystemPrompt("base", []);
    const big: ModelToolSpec[] = [{ name: "pkg_install", description: "i", inputSchema: {} }];
    for await (const _ of wrapped.chat({
      system,
      messages: [],
      tools: big,
      signal: new AbortController().signal,
    })) {
      // drain
    }
    for await (const _ of wrapped.chat({
      system,
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // drain: the step-limit report sends no tools
    }
    expect(seen[0]?.tools).toEqual(simple);
    expect(seen[1]?.tools).toEqual([]);
    const text = seen[0]?.system ?? "";
    expect(text.indexOf(BACKUP_SYSTEM_NOTE)).toBeGreaterThan(text.indexOf("base"));
    expect(text.endsWith(SAFETY_RULES)).toBe(true);
  });

  it("keeps the rules last even when a system text lacks them", () => {
    expect(insertBeforeSafetyRules("x", "note").endsWith(SAFETY_RULES)).toBe(true);
  });
});
