import { describe, expect, it } from "vitest";
import { AgentRegistry, UnknownAgentError } from "./registry.js";
import type { RegistryConfig } from "./types.js";

const config: RegistryConfig = {
  agents: {
    "claude-mm": { command: "claude-mm", model: "opus", default: true },
    "claude-acme": { command: "claude-acme", model: "sonnet" },
    copilot: { command: "copilot", args: ["-p"] },
  },
  routing: [
    { match: { project: "acme" }, agent: "claude-acme" },
    { match: { intent: "quick-question" }, agent: "copilot" },
  ],
};

describe("AgentRegistry.resolve", () => {
  it("prefers an explicit agent over every rule", () => {
    const registry = new AgentRegistry(config);
    const agent = registry.resolve({
      explicitAgent: "copilot",
      project: "acme",
    });
    expect(agent.id).toBe("copilot");
  });

  it("falls back to a routing rule matching the project", () => {
    const registry = new AgentRegistry(config);
    expect(registry.resolve({ project: "acme" }).id).toBe("claude-acme");
  });

  it("falls back to a routing rule matching the intent", () => {
    const registry = new AgentRegistry(config);
    expect(registry.resolve({ intent: "quick-question" }).id).toBe("copilot");
  });

  it("uses the default agent when nothing matches", () => {
    const registry = new AgentRegistry(config);
    expect(registry.resolve({ project: "unknown-project" }).id).toBe("claude-mm");
  });

  it("takes the first matching rule when several match", () => {
    const registry = new AgentRegistry(config);
    const agent = registry.resolve({ project: "acme", intent: "quick-question" });
    expect(agent.id).toBe("claude-acme");
  });

  it("throws when the explicit agent does not exist", () => {
    const registry = new AgentRegistry(config);
    expect(() => registry.resolve({ explicitAgent: "gemini" })).toThrow(UnknownAgentError);
  });

  it("throws when no agent is marked default and nothing matches", () => {
    const registry = new AgentRegistry({ agents: { a: { command: "a" } } });
    expect(() => registry.resolve({})).toThrow(UnknownAgentError);
  });

  it("carries command and args through to the resolved agent", () => {
    const registry = new AgentRegistry(config);
    const agent = registry.resolve({ explicitAgent: "copilot" });
    expect(agent.command).toBe("copilot");
    expect(agent.args).toEqual(["-p"]);
  });
});
