import { describe, expect, it } from "vitest";
import { checkAgent, checkAll } from "./health.js";
import type { CommandRunner } from "./health.js";
import type { AgentConfig } from "./types.js";

const agent: AgentConfig = { id: "claude-mm", command: "claude-mm", model: "opus" };

const runner = (result: { code: number; stdout: string; stderr: string }): CommandRunner =>
  async () => result;

describe("checkAgent", () => {
  it("reports healthy when the command prints a version", async () => {
    const health = await checkAgent(agent, runner({ code: 0, stdout: "2.1.251 (Claude Code)", stderr: "" }));
    expect(health).toEqual({ id: "claude-mm", ok: true, detail: "2.1.251 (Claude Code)" });
  });

  it("detects the native-binary stub even though it exits zero", async () => {
    const stub = {
      code: 0,
      stdout: "",
      stderr: "Error: claude native binary not installed.\n\nEither postinstall did not run",
    };
    const health = await checkAgent(agent, runner(stub));
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("native binary not installed");
  });

  it("reports unhealthy on a non-zero exit", async () => {
    const health = await checkAgent(agent, runner({ code: 127, stdout: "", stderr: "command not found" }));
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("command not found");
  });

  it("reports unhealthy when the runner throws", async () => {
    const health = await checkAgent(agent, async () => {
      throw new Error("spawn ENOENT");
    });
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("spawn ENOENT");
  });

  it("reports unhealthy when the command prints nothing at all", async () => {
    const health = await checkAgent(agent, runner({ code: 0, stdout: "   ", stderr: "" }));
    expect(health.ok).toBe(false);
    expect(health.detail).toContain("no output");
  });
});

describe("checkAll", () => {
  it("checks every agent and preserves order", async () => {
    const agents: AgentConfig[] = [
      { id: "a", command: "a" },
      { id: "b", command: "b" },
    ];
    const results = await checkAll(agents, runner({ code: 0, stdout: "1.0.0", stderr: "" }));
    expect(results.map((r) => r.id)).toEqual(["a", "b"]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});
