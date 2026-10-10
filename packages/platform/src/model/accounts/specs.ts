// Plan Y §2.2, §2.3, §5: how jarvisd runs each official CLI. Everything on an
// argv is a fixed string, a path jarvisd built, or a model id from
// accounts.json — never user text (argv is world-readable in /proc). Each
// process gets HOME = its own account dir and a fixed environment; the
// sandbox (desktop/os/accounts/sandbox.ts) adds `env -i`. Pure.
import { posix } from "node:path";
import { ACCOUNT_IDS, type AccountId, isRecord, type ModelImage } from "@jarvis/core";

export type AccountModel = { id: string; vision: boolean };
export type AccountPin = {
  account: AccountId;
  package: string;
  version: string;
  integrity: string;
  bin: string;
  postinstall: string | null;
  omitOptional: boolean;
  platformPackage: { name: string; version: string; integrity: string } | null;
  models: AccountModel[];
};
export type AccountPins = Readonly<Record<AccountId, AccountPin>>;
export type AccountPaths = { home: string; configDir: string; cliDir: string; tmpDir: string };
export type CliPurpose =
  | "turn"
  | "login"
  | "logout"
  | "install"
  | "audit"
  | "postinstall"
  | "probe";
export type CliInvocation = {
  account: AccountId;
  purpose: CliPurpose;
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  network: boolean;
  /** Bind-mounted read-write / read-only; ProtectHome=tmpfs hides the rest of $HOME. */
  writable: string[];
  readOnly: string[];
  /** Written by jarvisd (0600) right before the process starts. */
  files: { path: string; content: string }[];
  stdin: string;
  tty: boolean;
  mergeStderr: boolean;
  timeoutMs: number;
};
export type TurnInput = { text: string; image?: ModelImage };

export const NODE_BIN = "/usr/lib/jarvis/node/bin/node";
export const NPM_CLI = "/usr/lib/jarvis/node/lib/node_modules/npm/bin/npm-cli.js";
export const ACCOUNT_SHIM_DIR = "/usr/lib/jarvis/accounts/bin";
export const ACCOUNT_PINS_PATH = "/usr/share/jarvis/accounts/accounts.json";
export const CLI_TURN_TIMEOUT_MS = 600_000;
export const LOGIN_TIMEOUT_MS = 600_000;
export const SHORT_TIMEOUT_MS = 60_000;
export const INSTALL_TIMEOUT_MS = 900_000;
/** Plan Y §1.1: the tile names. */
export const ACCOUNT_LABELS: Readonly<Record<AccountId, string>> = {
  claude: "Claude",
  chatgpt: "ChatGPT",
  gemini: "Google",
  copilot: "GitHub Copilot",
};
export const ACCOUNT_SYSTEM_PROMPT =
  "You are the language model behind Jarvis, the assistant of the Rafiq desktop. You have no tools of your own and must not try to use any. Everything you need is in the user message, including how to ask Jarvis to run one of its tools.";
/** Never passed to an account process (Global Constraints). */
export const FORBIDDEN_ENV = [
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "WAYLAND_DISPLAY",
  "DISPLAY",
  "SSH_AUTH_SOCK",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "COPILOT_GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

/** code.claude.com/docs/en/cli-reference: `--tools ""` disables every built-in tool,
 *  `--disallowedTools "*"` removes every tool, --strict-mcp-config with an empty
 *  config removes MCP, `--setting-sources ""` loads no user/project settings
 *  (what the Agent SDK passes for settingSources: []). */
export const CLAUDE_TOOL_FLAGS = [
  "--tools",
  "",
  "--disallowedTools",
  "*",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--setting-sources",
  "",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--no-chrome",
  "--permission-mode",
  "dontAsk",
  "--permission-prompts",
  "none",
  "--max-turns",
  "1",
] as const;
/** `-c key=value` overrides (TOML values), learn.chatgpt.com config sample. */
export const CODEX_CONFIG = [
  'approval_policy="never"',
  'web_search="disabled"',
  "tools.view_image=false",
  'cli_auth_credentials_store="file"',
  'forced_login_method="chatgpt"',
  "check_for_update_on_startup=false",
  'history.persistence="none"',
  "project_doc_max_bytes=0",
  "mcp_servers={}",
  'shell_environment_policy.inherit="none"',
  "analytics.enabled=false",
  "feedback.enabled=false",
] as const;
/** Every enabled tool-like feature in `codex features list` at 0.159.2. */
export const CODEX_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "code_mode_host",
  "computer_use",
  "daemon_auto_start",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "in_app_local_automation",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "shell_snapshot",
  "shell_tool",
  "skill_mcp_dependency_install",
  "skill_search",
  "sleep_tool",
  "tool_call_mcp_elicitation",
  "tool_suggest",
  "unified_exec",
  "view_image",
  "workspace_dependencies",
  "worktrees",
] as const;
/** `copilot help permissions`: --available-tools is an allowlist; deny beats allow. */
export const COPILOT_TOOL_FLAGS = [
  "--available-tools",
  "jarvis_no_tool",
  "--deny-tool",
  "shell",
  "--deny-tool",
  "write",
  "--deny-tool",
  "url",
  "--disable-builtin-mcps",
  "--no-custom-instructions",
  "--no-ask-user",
  "--no-auto-update",
  "--disallow-temp-dir",
  "--no-remote",
  "--no-experimental",
] as const;

/** Gemini's system settings file (highest precedence, GEMINI_CLI_SYSTEM_SETTINGS_PATH). */
export function geminiSystemSettings(): Record<string, unknown> {
  return {
    tools: {
      core: [],
      exclude: [
        "run_shell_command",
        "write_file",
        "replace",
        "read_file",
        "read_many_files",
        "list_directory",
        "glob",
        "search_file_content",
        "web_fetch",
        "google_web_search",
        "save_memory",
        "write_todos",
      ],
    },
    mcp: { allowed: [] },
    mcpServers: {},
    skills: { enabled: false },
    hooksConfig: { enabled: false },
    experimental: { enableAgents: false },
    general: { disableAutoUpdate: true, checkpointing: { enabled: false } },
    privacy: { usageStatisticsEnabled: false },
    telemetry: { enabled: false },
    security: { auth: { selectedType: "oauth-personal" } },
    admin: { secureModeEnabled: true, mcp: { enabled: false } },
  };
}

const SAFE_PATH = /^\/[A-Za-z0-9._@+/-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;
const BIN = /^[A-Za-z0-9._/-]{1,80}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9.:-]{0,63}$/;

export function accountPaths(home: string, account: AccountId): AccountPaths {
  if (!SAFE_PATH.test(home) || home.includes("/../") || home.endsWith("/.."))
    throw new Error(
      "Signing in with an account needs a home folder path made of plain characters.",
    );
  return {
    home,
    configDir: posix.join(home, ".config", "jarvis", "accounts", account),
    cliDir: posix.join(home, ".local", "share", "jarvis", "clis", account),
    tmpDir: posix.join(home, ".cache", "jarvis", "accounts", account),
  };
}

export function parseAccountPins(raw: unknown): AccountPins {
  if (!isRecord(raw) || raw["version"] !== 1 || !Array.isArray(raw["accounts"]))
    throw new Error("accounts.json: expected {version: 1, accounts: [...]}");
  const out: Partial<Record<AccountId, AccountPin>> = {};
  for (const row of raw["accounts"]) {
    if (!isRecord(row)) throw new Error("accounts.json: every row must be an object");
    const account = row["account"];
    if (typeof account !== "string" || !(ACCOUNT_IDS as readonly string[]).includes(account))
      throw new Error("accounts.json: unknown account");
    const where = `accounts.json ${account}`;
    const {
      package: pkg,
      version,
      integrity,
      bin,
      postinstall,
      omitOptional,
      platformPackage,
      models,
    } = row;
    if (typeof pkg !== "string" || !/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(pkg))
      throw new Error(`${where}: package`);
    if (typeof version !== "string" || !VERSION.test(version)) throw new Error(`${where}: version`);
    if (typeof integrity !== "string" || !INTEGRITY.test(integrity))
      throw new Error(`${where}: integrity`);
    if (typeof bin !== "string" || !BIN.test(bin) || bin.split("/").includes(".."))
      throw new Error(`${where}: bin`);
    if (postinstall !== null && postinstall !== "install.cjs")
      throw new Error(`${where}: postinstall`);
    if (typeof omitOptional !== "boolean") throw new Error(`${where}: omitOptional`);
    let platform: AccountPin["platformPackage"] = null;
    if (platformPackage !== null) {
      if (
        !isRecord(platformPackage) ||
        typeof platformPackage["name"] !== "string" ||
        !platformPackage["name"].startsWith(pkg) ||
        typeof platformPackage["version"] !== "string" ||
        typeof platformPackage["integrity"] !== "string" ||
        !INTEGRITY.test(platformPackage["integrity"])
      )
        throw new Error(`${where}: platformPackage`);
      platform = {
        name: platformPackage["name"],
        version: platformPackage["version"],
        integrity: platformPackage["integrity"],
      };
    }
    if (!Array.isArray(models) || models.length === 0) throw new Error(`${where}: models`);
    const parsedModels = models.map((model) => {
      if (
        !isRecord(model) ||
        typeof model["id"] !== "string" ||
        !MODEL_ID.test(model["id"]) ||
        typeof model["vision"] !== "boolean"
      )
        throw new Error(`${where}: models`);
      return { id: model["id"], vision: model["vision"] };
    });
    if (parsedModels[0]?.id !== "default")
      throw new Error(`${where}: the first model must be "default"`);
    out[account as AccountId] = {
      account: account as AccountId,
      package: pkg,
      version,
      integrity,
      bin,
      postinstall,
      omitOptional,
      platformPackage: platform,
      models: parsedModels,
    };
  }
  for (const account of ACCOUNT_IDS)
    if (out[account] === undefined) throw new Error(`accounts.json: ${account} is missing`);
  return out as AccountPins;
}

export function cliCommand(pin: AccountPin, paths: AccountPaths): string[] {
  const entry = posix.join(paths.cliDir, "node_modules", pin.package, pin.bin);
  return /\.(c|m)?js$/.test(pin.bin) ? [NODE_BIN, entry] : [entry];
}

const systemPromptPath = (paths: AccountPaths) => posix.join(paths.tmpDir, "jarvis-system.md");
const geminiSettingsPath = (paths: AccountPaths) =>
  posix.join(paths.tmpDir, "gemini-system-settings.json");

function accountEnv(account: AccountId, paths: AccountPaths): Record<string, string> {
  switch (account) {
    case "claude":
      return {
        CLAUDE_CONFIG_DIR: paths.configDir,
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      };
    case "chatgpt":
      return { CODEX_HOME: paths.configDir };
    case "gemini":
      return {
        GEMINI_CLI_HOME: paths.configDir,
        GEMINI_FORCE_FILE_STORAGE: "true",
        GEMINI_CLI_SYSTEM_SETTINGS_PATH: geminiSettingsPath(paths),
        GEMINI_SYSTEM_MD: systemPromptPath(paths),
      };
    case "copilot":
      return { COPILOT_HOME: paths.configDir, COPILOT_AUTO_UPDATE: "false" };
  }
}

function baseEnv(account: AccountId, paths: AccountPaths): Record<string, string> {
  return {
    PATH: `${ACCOUNT_SHIM_DIR}:/usr/bin:/bin`,
    HOME: paths.configDir,
    TMPDIR: paths.tmpDir,
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    TERM: "dumb",
    BROWSER: `${ACCOUNT_SHIM_DIR}/xdg-open`,
    JARVIS_OPEN_URL_FILE: posix.join(paths.tmpDir, "open-url"),
    XDG_CONFIG_HOME: posix.join(paths.configDir, ".config"),
    XDG_DATA_HOME: posix.join(paths.configDir, ".local", "share"),
    XDG_STATE_HOME: posix.join(paths.configDir, ".local", "state"),
    XDG_CACHE_HOME: posix.join(paths.tmpDir, "cache"),
    ...accountEnv(account, paths),
  };
}

function geminiFiles(paths: AccountPaths): CliInvocation["files"] {
  return [
    {
      path: geminiSettingsPath(paths),
      content: `${JSON.stringify(geminiSystemSettings(), null, 2)}\n`,
    },
    { path: systemPromptPath(paths), content: `${ACCOUNT_SYSTEM_PROMPT}\n` },
  ];
}

function modelArgs(pin: AccountPin, model: string, flag: string): string[] {
  if (!pin.models.some((offered) => offered.id === model))
    throw new Error(`model ${JSON.stringify(model)} is not offered for ${pin.account}`);
  return model === "default" ? [] : [flag, model];
}

function common(pin: AccountPin, paths: AccountPaths, purpose: CliPurpose, timeoutMs: number) {
  return {
    account: pin.account,
    purpose,
    env: baseEnv(pin.account, paths),
    cwd: paths.tmpDir,
    network: true,
    writable: [paths.configDir, paths.tmpDir],
    readOnly: [paths.cliDir],
    files: [] as CliInvocation["files"],
    stdin: "",
    tty: false,
    mergeStderr: false,
    timeoutMs,
  };
}

export function turnInvocation(
  pin: AccountPin,
  paths: AccountPaths,
  model: string,
  input: TurnInput,
): CliInvocation {
  const cmd = cliCommand(pin, paths);
  const base = common(pin, paths, "turn", CLI_TURN_TIMEOUT_MS);
  switch (pin.account) {
    case "claude": {
      const content: unknown[] = [{ type: "text", text: input.text }];
      if (input.image !== undefined) {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: input.image.mediaType,
            data: input.image.dataBase64,
          },
        });
      }
      return {
        ...base,
        argv: [
          ...cmd,
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--verbose",
          ...CLAUDE_TOOL_FLAGS,
          "--system-prompt",
          ACCOUNT_SYSTEM_PROMPT,
          ...modelArgs(pin, model, "--model"),
        ],
        stdin: `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`,
      };
    }
    case "chatgpt":
      return {
        ...base,
        argv: [
          ...cmd,
          "exec",
          "--json",
          "--skip-git-repo-check",
          "--ephemeral",
          "--ignore-user-config",
          "--ignore-rules",
          "--color",
          "never",
          "-s",
          "read-only",
          "-C",
          paths.tmpDir,
          ...CODEX_CONFIG.flatMap((setting) => ["-c", setting]),
          "-c",
          `model_instructions_file="${systemPromptPath(paths)}"`,
          ...CODEX_DISABLED_FEATURES.flatMap((feature) => ["--disable", feature]),
          ...modelArgs(pin, model, "-m"),
          "-",
        ],
        files: [{ path: systemPromptPath(paths), content: `${ACCOUNT_SYSTEM_PROMPT}\n` }],
        stdin: input.text,
      };
    case "gemini":
      return {
        ...base,
        argv: [
          ...cmd,
          "-p",
          "Reply to the request above.",
          "-o",
          "stream-json",
          "--approval-mode",
          "default",
          "--skip-trust",
          "-e",
          "none",
          "--allowed-mcp-server-names",
          "jarvis-none",
          ...modelArgs(pin, model, "-m"),
        ],
        files: geminiFiles(paths),
        stdin: input.text,
      };
    case "copilot":
      return {
        ...base,
        argv: [
          ...cmd,
          "-p",
          "Reply to the request on standard input.",
          "--output-format",
          "json",
          "--log-level",
          "none",
          "--log-dir",
          posix.join(paths.tmpDir, "logs"),
          "-C",
          paths.tmpDir,
          ...COPILOT_TOOL_FLAGS,
          ...modelArgs(pin, model, "--model"),
        ],
        stdin: input.text,
      };
  }
}

export function loginInvocation(pin: AccountPin, paths: AccountPaths): CliInvocation {
  const cmd = cliCommand(pin, paths);
  const base = { ...common(pin, paths, "login", LOGIN_TIMEOUT_MS), mergeStderr: true };
  switch (pin.account) {
    case "claude":
      // A terminal: `claude auth login` may prompt "Paste code here if prompted".
      return { ...base, argv: [...cmd, "auth", "login"], tty: true };
    case "chatgpt":
      return {
        ...base,
        argv: [
          ...cmd,
          "login",
          "-c",
          'cli_auth_credentials_store="file"',
          "-c",
          'forced_login_method="chatgpt"',
        ],
      };
    case "gemini":
      // No login command: the first headless prompt signs in (consent answered Y).
      return {
        ...base,
        argv: [
          ...cmd,
          "-p",
          "Reply with the single word OK.",
          "-o",
          "stream-json",
          "--approval-mode",
          "default",
          "--skip-trust",
          "-e",
          "none",
          "--allowed-mcp-server-names",
          "jarvis-none",
        ],
        files: geminiFiles(paths),
        stdin: "Y\n",
      };
    case "copilot":
      return { ...base, argv: [...cmd, "login", "--device-code"] };
  }
}

export function logoutInvocation(pin: AccountPin, paths: AccountPaths): CliInvocation | null {
  const cmd = cliCommand(pin, paths);
  const base = common(pin, paths, "logout", SHORT_TIMEOUT_MS);
  switch (pin.account) {
    case "claude":
      return { ...base, argv: [...cmd, "auth", "logout"] };
    case "chatgpt":
      return { ...base, argv: [...cmd, "logout"] };
    case "gemini":
    case "copilot":
      return null; // §5.6: no non-interactive logout; the dir is deleted.
  }
}
