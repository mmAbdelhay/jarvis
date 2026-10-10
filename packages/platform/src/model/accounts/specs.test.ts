import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AccountPins,
  accountPaths,
  CLAUDE_TOOL_FLAGS,
  CODEX_DISABLED_FEATURES,
  COPILOT_TOOL_FLAGS,
  FORBIDDEN_ENV,
  loginInvocation,
  logoutInvocation,
  parseAccountPins,
  turnInvocation,
} from "./specs.js";

const PINS: AccountPins = parseAccountPins(
  JSON.parse(
    readFileSync(new URL("../../../../../os/models/accounts.json", import.meta.url), "utf8"),
  ),
);
const HOME = "/home/rafiq";
const SECRET = "SECRET-TRANSCRIPT-7d1f";
const ACCOUNTS = ["claude", "chatgpt", "gemini", "copilot"] as const;

describe("account specs", () => {
  it("puts every account in its own 0700 tree under $HOME", () => {
    expect(accountPaths(HOME, "gemini")).toEqual({
      home: HOME,
      configDir: "/home/rafiq/.config/jarvis/accounts/gemini",
      cliDir: "/home/rafiq/.local/share/jarvis/clis/gemini",
      tmpDir: "/home/rafiq/.cache/jarvis/accounts/gemini",
    });
    expect(() => accountPaths("/home/a b", "claude")).toThrow(/home/);
    expect(() => accountPaths('/home/x"y', "claude")).toThrow(/home/);
  });

  for (const account of ACCOUNTS) {
    it(`${account}: the transcript goes through stdin only, with a clean environment`, () => {
      const paths = accountPaths(HOME, account);
      const inv = turnInvocation(PINS[account], paths, "default", { text: SECRET });
      expect(inv.argv.join("\u0000")).not.toContain(SECRET);
      expect(Object.values(inv.env).join("\u0000")).not.toContain(SECRET);
      expect(inv.stdin).toContain(SECRET);
      for (const key of FORBIDDEN_ENV) expect(inv.env).not.toHaveProperty(key);
      expect(inv.env["HOME"]).toBe(paths.configDir);
      expect(inv.env["PATH"]).toBe("/usr/lib/jarvis/accounts/bin:/usr/bin:/bin");
      expect(inv.writable).toEqual([paths.configDir, paths.tmpDir]);
      expect(inv.readOnly).toEqual([paths.cliDir]);
      expect(inv.network).toBe(true);
      expect(inv.tty).toBe(false);
      expect(inv.argv[0]?.startsWith("/")).toBe(true);
    });
  }

  it("claude: every built-in tool off, stream-json both ways, the config dir", () => {
    const paths = accountPaths(HOME, "claude");
    const inv = turnInvocation(PINS.claude, paths, "opus", {
      text: "hi",
      image: { mediaType: "image/png", dataBase64: "iVBORw0K" },
    });
    expect(inv.argv[0]).toBe(
      "/home/rafiq/.local/share/jarvis/clis/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
    );
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
      ]),
    );
    const at = inv.argv.indexOf("--tools");
    expect(inv.argv.slice(at, at + CLAUDE_TOOL_FLAGS.length)).toEqual([...CLAUDE_TOOL_FLAGS]);
    expect(CLAUDE_TOOL_FLAGS).toEqual(
      expect.arrayContaining([
        "--tools",
        "",
        "--disallowedTools",
        "*",
        "--strict-mcp-config",
        "--setting-sources",
        "--permission-prompts",
        "none",
      ]),
    );
    expect(inv.argv).not.toContain("--bare");
    expect(inv.argv.slice(-2)).toEqual(["--model", "opus"]);
    expect(inv.env["CLAUDE_CONFIG_DIR"]).toBe(paths.configDir);
    expect(inv.env["DISABLE_AUTOUPDATER"]).toBe("1");
    const message = JSON.parse(inv.stdin.trim());
    expect(message).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0K" } },
        ],
      },
    });
  });

  it("chatgpt: read-only, approvals never, no web, every tool feature disabled, prompt from stdin", () => {
    const paths = accountPaths(HOME, "chatgpt");
    const inv = turnInvocation(PINS.chatgpt, paths, "default", { text: "hi" });
    expect(inv.argv.slice(0, 3)).toEqual([
      "/usr/lib/jarvis/node/bin/node",
      "/home/rafiq/.local/share/jarvis/clis/chatgpt/node_modules/@openai/codex/bin/codex.js",
      "exec",
    ]);
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        "--json",
        "--ignore-user-config",
        "--ignore-rules",
        "-s",
        "read-only",
        "--ephemeral",
        "--skip-git-repo-check",
      ]),
    );
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        "-c",
        'approval_policy="never"',
        "-c",
        'web_search="disabled"',
        "-c",
        "mcp_servers={}",
        "-c",
        'cli_auth_credentials_store="file"',
      ]),
    );
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "apps",
      "plugins",
      "multi_agent",
      "browser_use",
      "computer_use",
      "image_generation",
      "view_image",
      "sleep_tool",
    ]) {
      expect(CODEX_DISABLED_FEATURES).toContain(feature);
      expect(inv.argv.join(" ")).toContain(`--disable ${feature}`);
    }
    expect(inv.argv.at(-1)).toBe("-");
    expect(inv.stdin).toBe("hi");
    expect(inv.env["CODEX_HOME"]).toBe(paths.configDir);
    expect(inv.files).toEqual([
      {
        path: "/home/rafiq/.cache/jarvis/accounts/chatgpt/jarvis-system.md",
        content: expect.stringContaining("no tools of your own"),
      },
    ]);
  });

  it("gemini: core tools empty through system settings, oauth-personal, file storage", () => {
    const paths = accountPaths(HOME, "gemini");
    const inv = turnInvocation(PINS.gemini, paths, "gemini-2.5-pro", { text: "hi" });
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        "-o",
        "stream-json",
        "-e",
        "none",
        "--allowed-mcp-server-names",
        "jarvis-none",
        "--approval-mode",
        "default",
        "-m",
        "gemini-2.5-pro",
      ]),
    );
    expect(inv.argv).not.toContain("--yolo");
    expect(inv.env["GEMINI_CLI_HOME"]).toBe(paths.configDir);
    expect(inv.env["GEMINI_FORCE_FILE_STORAGE"]).toBe("true");
    const settingsFile = inv.files.find(
      (f) => f.path === inv.env["GEMINI_CLI_SYSTEM_SETTINGS_PATH"],
    );
    const settings = JSON.parse(settingsFile?.content ?? "{}");
    expect(settings.tools.core).toEqual([]);
    expect(settings.mcp.allowed).toEqual([]);
    expect(settings.security.auth.selectedType).toBe("oauth-personal");
    expect(settings.skills.enabled).toBe(false);
    expect(settings.experimental.enableAgents).toBe(false);
    expect(inv.files.map((f) => f.path).every((p) => p.startsWith(paths.tmpDir))).toBe(true);
  });

  it("copilot: only a non-existent tool is available, deny rules, no auto-update", () => {
    const paths = accountPaths(HOME, "copilot");
    const inv = turnInvocation(PINS.copilot, paths, "default", { text: "hi" });
    const at = inv.argv.indexOf("--available-tools");
    expect(inv.argv.slice(at, at + COPILOT_TOOL_FLAGS.length)).toEqual([...COPILOT_TOOL_FLAGS]);
    expect(inv.argv).toEqual(
      expect.arrayContaining([
        "--output-format",
        "json",
        "--disable-builtin-mcps",
        "--no-auto-update",
      ]),
    );
    expect(inv.argv).not.toContain("--allow-all-tools");
    expect(inv.argv).not.toContain("--yolo");
    expect(inv.env["COPILOT_HOME"]).toBe(paths.configDir);
    expect(inv.env["COPILOT_AUTO_UPDATE"]).toBe("false");
  });

  it("refuses a model that accounts.json does not offer (no flag injection)", () => {
    const paths = accountPaths(HOME, "claude");
    expect(() =>
      turnInvocation(PINS.claude, paths, "--dangerously-skip-permissions", { text: "x" }),
    ).toThrow(/model/);
    expect(() =>
      turnInvocation(PINS.copilot, accountPaths(HOME, "copilot"), "gpt-x", { text: "x" }),
    ).toThrow(/model/);
  });

  it("signs in with each CLI's own flow", () => {
    const claude = loginInvocation(PINS.claude, accountPaths(HOME, "claude"));
    expect(claude.argv.slice(1)).toEqual(["auth", "login"]);
    expect(claude.tty).toBe(true);
    expect(loginInvocation(PINS.chatgpt, accountPaths(HOME, "chatgpt")).argv.slice(2)).toEqual([
      "login",
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      'forced_login_method="chatgpt"',
    ]);
    const gemini = loginInvocation(PINS.gemini, accountPaths(HOME, "gemini"));
    expect(gemini.stdin).toBe("Y\n");
    expect(gemini.argv).toEqual(expect.arrayContaining(["-o", "stream-json", "-e", "none"]));
    expect(loginInvocation(PINS.copilot, accountPaths(HOME, "copilot")).argv.slice(2)).toEqual([
      "login",
      "--device-code",
    ]);
    for (const account of ACCOUNTS) {
      const inv = loginInvocation(PINS[account], accountPaths(HOME, account));
      expect(inv.mergeStderr).toBe(true);
      expect(inv.timeoutMs).toBe(600_000);
      expect(inv.env["BROWSER"]).toBe("/usr/lib/jarvis/accounts/bin/xdg-open");
      expect(inv.env["JARVIS_OPEN_URL_FILE"]).toBe(
        `/home/rafiq/.cache/jarvis/accounts/${account}/open-url`,
      );
    }
  });

  it("signs out with the CLI where it has a command", () => {
    expect(logoutInvocation(PINS.claude, accountPaths(HOME, "claude"))?.argv.slice(1)).toEqual([
      "auth",
      "logout",
    ]);
    expect(logoutInvocation(PINS.chatgpt, accountPaths(HOME, "chatgpt"))?.argv.slice(2)).toEqual([
      "logout",
    ]);
    expect(logoutInvocation(PINS.gemini, accountPaths(HOME, "gemini"))).toBeNull();
    expect(logoutInvocation(PINS.copilot, accountPaths(HOME, "copilot"))).toBeNull();
  });

  it("refuses a malformed pins file", () => {
    expect(() => parseAccountPins({ version: 1, accounts: [] })).toThrow(/claude/);
    const doc = JSON.parse(
      readFileSync(new URL("../../../../../os/models/accounts.json", import.meta.url), "utf8"),
    );
    doc.accounts[0].bin = "../../../../usr/bin/sh";
    expect(() => parseAccountPins(doc)).toThrow(/bin/);
  });
});
