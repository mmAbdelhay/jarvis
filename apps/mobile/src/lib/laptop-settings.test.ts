import { describe, expect, it, vi } from "vitest";
import {
  buildWorktreeDraft,
  parseLaptopSettings,
  parseSaveReply,
  saveWorktreeMode,
  worktreeDraft,
} from "./laptop-settings";

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

describe("saving the worktree mode", () => {
  it("sends only the sessions section, with worktrees changed", () => {
    const draft = buildWorktreeDraft(
      { remote: { enabled: true }, projects: { a: "/a" }, sessions: { worktrees: "off", keep: 1 } },
      "always",
    );
    expect(draft).toEqual({ sessions: { worktrees: "always", keep: 1 } });
    expect(buildWorktreeDraft(null, "parallel")).toEqual({ sessions: { worktrees: "parallel" } });
  });

  it("parses the save reply", () => {
    expect(parseSaveReply({ ok: true })).toEqual({ ok: true });
    expect(parseSaveReply({ ok: false, text: "Disk full", language: "en" })).toEqual({
      ok: false,
      text: "Disk full",
    });
    expect(parseSaveReply(undefined)).toEqual({ ok: false, text: "laptopSettings.saveFailed" });
  });

  it("re-reads, then saves the changed document", async () => {
    const call = vi.fn(async (channel: string) =>
      channel === "settings:read"
        ? { ok: true as const, value: { remote: { enabled: true }, sessions: {} } }
        : { ok: true as const, value: { ok: true } },
    );
    const client = { call } as unknown as Parameters<typeof saveWorktreeMode>[0];
    expect(await saveWorktreeMode(client, "parallel")).toEqual({ ok: true });
    expect(call).toHaveBeenLastCalledWith(
      "settings:save",
      [{ sessions: { worktrees: "parallel" } }],
      expect.anything(),
    );
  });

  it("does not save when the read fails", async () => {
    const call = vi.fn(async () => ({ ok: false as const, error: { kind: "offline" } }));
    const client = { call } as unknown as Parameters<typeof saveWorktreeMode>[0];
    expect(await saveWorktreeMode(client, "off")).toEqual({
      ok: false,
      text: "laptopSettings.saveFailed",
    });
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("worktreeDraft", () => {
  it("is clean while the chosen mode is the saved one", () => {
    expect(worktreeDraft("parallel", "parallel")).toEqual({ dirty: false });
  });

  it("is dirty once another mode is chosen", () => {
    expect(worktreeDraft("parallel", "always")).toEqual({ dirty: true });
  });
});
