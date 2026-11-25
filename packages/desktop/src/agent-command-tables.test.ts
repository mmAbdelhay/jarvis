import { describe, expect, it } from "vitest";
import { BUILT_IN_COMMANDS, builtInNames, findBuiltIn } from "./agent-command-tables.js";

// The names the live `/` menus of the installed CLIs listed (Claude Code 2.1.331, codex-cli 0.170.0,
// Copilot CLI 1.0.114), in the menu's order; custom and personal entries are not in them.
const CLAUDE_MENU = [
  "add-dir",
  "advisor",
  "artifacts",
  "auto-mode-setup",
  "autocompact",
  "autofix-pr",
  "background",
  "branch",
  "btw",
  "bug",
  "cd",
  "chrome",
  "clear",
  "color",
  "compact",
  "config",
  "context",
  "copy",
  "design-login",
  "desktop",
  "diff",
  "effort",
  "exit",
  "export",
  "fast",
  "feedback",
  "focus",
  "fork",
  "goal",
  "help",
  "hooks",
  "ide",
  "import",
  "install-github-app",
  "install-slack-app",
  "keybindings",
  "list-agents",
  "login",
  "logout",
  "mcp",
  "memory",
  "mobile",
  "model",
  "output-style",
  "passes",
  "permissions",
  "plan",
  "plugin",
  "powerup",
  "privacy-settings",
  "radio",
  "rate-limit-options",
  "recap",
  "release-notes",
  "reload-plugins",
  "reload-skills",
  "remote-control",
  "remote-env",
  "rename",
  "resume",
  "rewind",
  "sandbox",
  "scroll-speed",
  "skill-doctor",
  "skills",
  "status",
  "stickers",
  "subtask",
  "tasks",
  "teleport",
  "terminal-setup",
  "theme",
  "tui",
  "ultrareview",
  "upgrade",
  "usage",
  "usage-credits",
  "voice",
  "web-setup",
  "artifact-capabilities",
  "artifact-diagramming",
  "batch",
  "claude-api",
  "claude-approvals",
  "claude-in-chrome",
  "code-review",
  "dataviz",
  "debug",
  "design",
  "design-sync",
  "doctor",
  "fewer-permission-prompts",
  "init",
  "insights",
  "loop",
  "plugin-authoring",
  "run",
  "run-skill-generator",
  "schedule",
  "security-review",
  "send-to-project",
  "ship",
  "simplify",
  "slides",
  "statusline",
  "steward",
  "team-onboarding",
  "update-config",
  "verify",
  "whiteboard",
];
const CODEX_MENU = [
  "init",
  "status",
  "permissions",
  "model",
  "review",
  "presets",
  "daybreak",
  "ide",
  "keymap",
  "vim",
  "experimental",
  "approve",
  "memories",
  "skills",
  "import",
  "hooks",
  "rename",
  "new",
  "archive",
  "delete",
  "resume",
  "fork",
  "worktree",
  "app",
  "compact",
  "config",
  "recap",
  "plan",
  "voice",
  "goal",
  "agents",
  "side",
  "copy",
  "export",
  "raw",
  "tui",
  "diff",
  "mention",
  "daemon",
  "warnings",
  "cd",
  "pwd",
  "usage",
  "title",
  "statusline",
  "theme",
  "pets",
  "mcp",
  "plugins",
  "logout",
  "exit",
  "feedback",
  "ps",
  "stop",
  "clear",
  "subagents",
];
const COPILOT_MENU = [
  "add-dir",
  "agent",
  "ahp",
  "allow-all",
  "app",
  "ask",
  "autopilot",
  "changelog",
  "chronicle",
  "clear",
  "collect-debug-logs",
  "compact",
  "computer",
  "config",
  "context",
  "copy",
  "cwd",
  "delegate",
  "diagnose",
  "diff",
  "env",
  "environments",
  "exit",
  "experimental",
  "feedback",
  "fleet",
  "fork",
  "help",
  "ide",
  "index",
  "init",
  "instructions",
  "keep-alive",
  "limits",
  "list-dirs",
  "login",
  "logout",
  "lsp",
  "mcp",
  "memory",
  "model",
  "move",
  "new",
  "permissions",
  "plan",
  "plugin",
  "pr",
  "refine",
  "remote",
  "rename",
  "research",
  "reset-allowed-tools",
  "restart",
  "resume",
  "review",
  "sandbox",
  "search",
  "security-review",
  "session",
  "settings",
  "share",
  "skills",
  "statusline",
  "subagents",
  "tasks",
  "terminal-setup",
  "theme",
  "undo",
  "update",
  "usage",
  "user",
  "version",
  "vim",
  "voice",
  "worktree",
];
const COPILOT_HELP_ONLY = ["rewind", "rubber-duck"];

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

  it("lists every name of the live menus, in the menu's order", () => {
    const names = (vendor: (typeof VENDORS)[number]) =>
      BUILT_IN_COMMANDS[vendor].map((c) => c.name);
    expect(names("openai")).toEqual(CODEX_MENU);
    expect(names("github")).toEqual([...COPILOT_MENU, ...COPILOT_HELP_ONLY]);
    expect(names("anthropic")).toEqual(CLAUDE_MENU);
    expect(CODEX_MENU).toHaveLength(56);
    expect(COPILOT_MENU).toHaveLength(75);
    expect(CLAUDE_MENU).toHaveLength(110);
  });

  it("has no entry that is neither in a menu nor an alias of one (Copilot's help-only ones aside)", () => {
    const allowed = {
      anthropic: new Set(CLAUDE_MENU),
      openai: new Set(CODEX_MENU),
      github: new Set([...COPILOT_MENU, ...COPILOT_HELP_ONLY]),
    };
    for (const vendor of VENDORS) {
      for (const c of BUILT_IN_COMMANDS[vendor])
        expect(allowed[vendor].has(c.name), c.name).toBe(true);
    }
    expect(findBuiltIn("github", "footer")?.name).toBe("statusline");
  });

  it("has no leading dash, no model name and no state in a description", () => {
    for (const vendor of VENDORS) {
      for (const c of BUILT_IN_COMMANDS[vendor]) {
        expect(c.description, c.name).not.toMatch(/^[-\u2022]\s/);
        expect(c.description, c.name).not.toMatch(/Opus 5\.5|sandbox disabled|\u25ef/);
      }
    }
    expect(findBuiltIn("anthropic", "model")?.description).toBe("Switch model");
    for (const name of ["init", "status", "permissions", "model", "review"]) {
      expect(findBuiltIn("openai", name)?.description.startsWith("-"), name).toBe(false);
    }
  });

  it("includes the bundled Claude entries", () => {
    for (const name of [
      "security-review",
      "simplify",
      "loop",
      "code-review",
      "ship",
      "steward",
      "verify",
    ]) {
      expect(builtInNames("anthropic").has(name), name).toBe(true);
    }
  });

  it("finds a command by alias and gives its documented choices", () => {
    expect(findBuiltIn("anthropic", "cost")?.name).toBe("usage");
    expect(findBuiltIn("anthropic", "model")?.choices).toEqual(["opus", "sonnet", "haiku"]);
    expect(findBuiltIn("anthropic", "nope")).toBeUndefined();
  });
});
