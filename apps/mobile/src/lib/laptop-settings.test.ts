import { describe, expect, it } from "vitest";
import { parseLaptopSettings } from "./laptop-settings";

describe("parseLaptopSettings", () => {
  it("keeps agent names and kinds, project names and the worktree mode — nothing else", () => {
    const parsed = parseLaptopSettings({
      registry: {
        agents: {
          "claude-main": { vendor: "anthropic", command: "claude", configDir: "/x" },
          copilot: { vendor: "github", command: "copilot" },
          bare: { command: "x" },
        },
      },
      projects: { web: "/code/web", api: "/code/api" },
      sessions: { worktrees: "parallel" },
      remote: { enabled: true },
    });
    expect(parsed).toEqual({
      agents: [
        { id: "bare", vendor: undefined },
        { id: "claude-main", vendor: "anthropic" },
        { id: "copilot", vendor: "github" },
      ],
      projects: ["api", "web"],
      worktrees: "parallel",
    });
    expect(JSON.stringify(parsed)).not.toContain("command");
  });

  it("reads an unknown or missing worktree mode as off, and nothing from a non-object", () => {
    expect(parseLaptopSettings({ sessions: { worktrees: "sometimes" } })?.worktrees).toBe("off");
    expect(parseLaptopSettings({})).toEqual({ agents: [], projects: [], worktrees: "off" });
    expect(parseLaptopSettings(null)).toBeUndefined();
  });
});
