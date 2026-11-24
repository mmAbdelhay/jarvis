import { describe, expect, it } from "vitest";
import { BUILT_IN_COMMANDS, builtInNames, findBuiltIn } from "./agent-command-tables.js";

const VENDORS = ["anthropic", "openai", "github"] as const;
const NAME = /^[A-Za-z][A-Za-z0-9:._-]{0,60}$/;

describe("built-in command tables", () => {
  it.each(VENDORS)("%s: valid, unique names and aliases, bounded descriptions", (vendor) => {
    const seen = new Set<string>();
    for (const command of BUILT_IN_COMMANDS[vendor]) {
      for (const name of [command.name, ...(command.aliases ?? [])]) {
        expect(name, name).toMatch(NAME);
        expect(seen.has(name), `duplicate ${name}`).toBe(false);
        seen.add(name);
      }
      expect(command.description.length).toBeGreaterThan(3);
      expect(command.description.length).toBeLessThanOrEqual(200);
      for (const choice of command.choices ?? []) expect(choice).toMatch(/^[\w.-]{1,32}$/);
    }
  });

  it("has the counts read from the installed CLIs", () => {
    expect(BUILT_IN_COMMANDS.github).toHaveLength(77);
    expect(BUILT_IN_COMMANDS.openai.length).toBeGreaterThanOrEqual(40);
    expect(BUILT_IN_COMMANDS.anthropic.length).toBeGreaterThanOrEqual(60);
  });

  it("Copilot lists every command `copilot help commands` printed", () => {
    const names = builtInNames("github");
    for (const name of [
      "init",
      "agent",
      "skills",
      "mcp",
      "model",
      "diff",
      "review",
      "security-review",
      "permissions",
      "allow-all",
      "resume",
      "compact",
      "help",
      "clear",
      "vim",
      "voice",
      "exit",
      "login",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("Codex has no debug, test or removed entries", () => {
    const names = builtInNames("openai");
    for (const name of [
      "approvals",
      "test-approval",
      "debug-config",
      "debug-m-drop",
      "debug-m-update",
      "rollout",
    ]) {
      expect(names.has(name), name).toBe(false);
    }
    for (const name of [
      "model",
      "permissions",
      "review",
      "resume",
      "mcp",
      "diff",
      "mention",
      "status",
      "compact",
      "init",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("Claude has its user-facing commands, not hidden or removed ones", () => {
    const names = builtInNames("anthropic");
    for (const name of [
      "help",
      "clear",
      "compact",
      "model",
      "config",
      "mcp",
      "permissions",
      "resume",
      "memory",
      "init",
      "hooks",
      "add-dir",
      "status",
      "usage",
      "plan",
      "rewind",
      "doctor",
      "schedule",
      "settings",
      "cost",
      "undo",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    for (const name of [
      "agents",
      "heapdump",
      "extra-usage",
      "design-consent",
      "workflow-launch-exec",
      "access",
    ]) {
      expect(names.has(name), name).toBe(false);
    }
  });

  it("finds a command by alias and gives its documented choices", () => {
    expect(findBuiltIn("anthropic", "cost")?.name).toBe("usage");
    expect(findBuiltIn("anthropic", "model")?.choices).toEqual(["opus", "sonnet", "haiku"]);
    expect(findBuiltIn("anthropic", "nope")).toBeUndefined();
  });
});
