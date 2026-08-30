import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const valid = {
  agents: { "claude-mm": { command: "claude-mm", model: "opus", default: true } },
  routing: [{ match: { project: "acme" }, agent: "claude-acme" }],
  projects: { acme: "~/projects/acme" },
  brain: { systemPrompt: "You are Jarvis.", cwd: "/tmp/jarvis-brain" },
};

describe("parseConfig", () => {
  it("maps agents and routing into a registry config", () => {
    const config = parseConfig(valid);
    expect(config.registry.agents["claude-mm"]?.command).toBe("claude-mm");
    expect(config.registry.routing?.[0]?.agent).toBe("claude-acme");
  });

  it("expands a leading tilde in project paths", () => {
    const config = parseConfig(valid);
    expect(config.projects["acme"]?.startsWith("~")).toBe(false);
    expect(config.projects["acme"]).toContain("/projects/acme");
  });

  it("leaves absolute project paths untouched", () => {
    const config = parseConfig({ ...valid, projects: { a: "/tmp/a" } });
    expect(config.projects["a"]).toBe("/tmp/a");
  });

  it("throws when agents is missing", () => {
    expect(() => parseConfig({ projects: {}, brain: valid.brain })).toThrow(/agents/);
  });

  it("throws when brain is missing or not an object", () => {
    expect(() => parseConfig({ ...valid, brain: undefined })).toThrow(/brain/);
    expect(() => parseConfig({ ...valid, brain: "nope" })).toThrow(/brain/);
  });

  it("defaults routing to an empty list", () => {
    const config = parseConfig({ ...valid, routing: undefined });
    expect(config.registry.routing).toEqual([]);
  });

  it("throws when a routing entry is missing agent", () => {
    expect(() =>
      parseConfig({ ...valid, routing: [{ match: { project: "x" } }] }),
    ).toThrow(/routing\[0\]\.agent/);
  });

  it("throws when an agent entry is not an object", () => {
    expect(() => parseConfig({ ...valid, agents: { foo: "not-an-object" } })).toThrow(
      /agents\.foo/,
    );
  });

  it("throws when a projects value is not a string", () => {
    expect(() => parseConfig({ ...valid, projects: { acme: 123 } })).toThrow(
      /projects\.acme/,
    );
  });

  it("throws when agents is an array", () => {
    expect(() => parseConfig({ ...valid, agents: [] })).toThrow(/agents/);
  });
});
