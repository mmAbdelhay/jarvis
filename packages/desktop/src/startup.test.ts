import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@jarvis/core";
import { startupReport } from "./startup.js";

const registry = new AgentRegistry({
  agents: {
    "claude-mm": { command: "claude-mm", default: true },
    copilot: { command: "copilot" },
  },
});

describe("startupReport", () => {
  it("reports all agents healthy", async () => {
    const report = await startupReport(registry, async () => ({
      code: 0, stdout: "1.0.0", stderr: "",
    }));
    expect(report.broken).toHaveLength(0);
    expect(report.message).toContain("2 agents ready");
  });

  it("names the broken agent and the repair command", async () => {
    const report = await startupReport(registry, async (command) =>
      command === "claude-mm"
        ? { code: 0, stdout: "", stderr: "Error: claude native binary not installed." }
        : { code: 0, stdout: "1.0.0", stderr: "" },
    );
    expect(report.broken.map((b) => b.id)).toEqual(["claude-mm"]);
    expect(report.message).toContain("claude-mm");
    expect(report.message).toContain("install.cjs");
  });

  it("reports when every agent is broken", async () => {
    const report = await startupReport(registry, async () => ({
      code: 127, stdout: "", stderr: "command not found",
    }));
    expect(report.healthy).toHaveLength(0);
    expect(report.message).toContain("No agents");
  });
});
