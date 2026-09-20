import { describe, expect, it } from "vitest";
import { AgentRegistry } from "@jarvis/core";
import type { ProviderStatus } from "@jarvis/core";
import { capacityReport, startupReport } from "./startup.js";

const registry = new AgentRegistry({
  agents: {
    "claude-main": { command: "claude-main", default: true },
    copilot: { command: "copilot" },
  },
});

describe("startupReport", () => {
  it("reports all agents healthy", async () => {
    const report = await startupReport(registry, async () => ({
      code: 0,
      stdout: "1.0.0",
      stderr: "",
    }));
    expect(report.broken).toHaveLength(0);
    expect(report.message).toContain("2 agents ready");
  });

  it("names the broken agent and the repair command", async () => {
    const report = await startupReport(registry, async (command) =>
      command === "claude-main"
        ? { code: 0, stdout: "", stderr: "Error: claude native binary not installed." }
        : { code: 0, stdout: "1.0.0", stderr: "" },
    );
    expect(report.broken.map((b) => b.id)).toEqual(["claude-main"]);
    expect(report.message).toContain("claude-main");
    expect(report.message).toContain("install.cjs");
  });

  it("reports when every agent is broken", async () => {
    const report = await startupReport(registry, async () => ({
      code: 127,
      stdout: "",
      stderr: "command not found",
    }));
    expect(report.healthy).toHaveLength(0);
    expect(report.message).toContain("No agents");
  });
});

describe("capacityReport", () => {
  const known: ProviderStatus = {
    id: "claude-main",
    vendor: "anthropic",
    capacity: {
      state: "known",
      primary: { usedPercent: 62, resetsAt: "2026-08-31T14:30:00Z" },
      secondary: undefined,
      readAt: Date.parse("2026-08-31T12:12:00Z"),
    },
    health: { state: "ok", detail: "ok", readAt: 1 },
  };

  it("returns the capacity lines in the user's own language", () => {
    const message = capacityReport([known], "ar");
    expect(message).toContain("claude-main");
    expect(message).toContain("المتبقي 38%");
  });

  it("returns an empty string when nothing was read, so no turn is sent", () => {
    expect(
      capacityReport([{ ...known, capacity: { state: "unknown", reason: "never-read" } }], "ar"),
    ).toBe("");
  });

  it("leaves the existing health message untouched", async () => {
    const report = await startupReport(registry, async () => ({
      code: 0,
      stdout: "1.0.0",
      stderr: "",
    }));
    // The health half must still arrive first and fast: it is bounded at 5s
    // and opens no session, while a capacity read is a ~3.3s billed query per
    // account. Merging them would delay the report the user relies on today.
    expect(report.message).toContain("2 agents ready");
  });
});
