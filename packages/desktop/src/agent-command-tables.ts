// The slash commands each vendor's installed CLI lists, as a table: name,
// first-sentence description, argument hint, aliases and the argument words
// the CLI documents. Read from `copilot help commands` (1.0.114), the slash
// command table of codex-cli 0.170.0 and the command objects of Claude Code
// 2.1.331, never from anybody's data. A name that could not be confirmed in
// the binary is left out; a newer command can still be typed and sent.

import type { AgentVendor } from "./pane-agent-session.js";

export type BuiltInCommand = {
  name: string;
  description: string;
  hint?: string;
  aliases?: readonly string[];
  /** Words the CLI documents for the argument (never a guess). */
  choices?: readonly string[];
};

const COPILOT: readonly BuiltInCommand[] = [
  { name: "init", description: "Initialize instructions in the project" },
  { name: "agent", description: "Browse and select agents", hint: "[name]" },
  { name: "skills", description: "Manage skills for enhanced capabilities" },
  { name: "mcp", description: "Manage MCP server configuration" },
  { name: "plugin", description: "Manage plugins and plugin marketplaces" },
  {
    name: "model",
    description:
      "Select the AI model for this session (use 'auto' to let Copilot pick automatically)",
    hint: "[model]",
    choices: ["auto"],
  },
  {
    name: "delegate",
    description:
      "Send this session to GitHub and Copilot will create a PR; use --base to choose the PR target branch",
  },
  { name: "fleet", description: "Enable fleet mode for parallel subagent execution" },
  {
    name: "autopilot",
    description:
      "Toggle autopilot mode, or set an autopilot objective with an optional AI-credit limit (--max-ai-credits)",
  },
  {
    name: "tasks",
    description:
      "View running subagents and background shell commands, check their status, and open their live transcript or recent output",
  },
  { name: "ide", description: "Connect to an IDE workspace" },
  { name: "diff", description: "Review the changes made in the current directory" },
  { name: "pr", description: "Operate on pull requests for the current branch" },
  { name: "review", description: "Run code review agent to analyze changes" },
  {
    name: "security-review",
    description:
      "Scan uncommitted changes (staged and unstaged) for security vulnerabilities, or the branch diff when the working tree is clean",
  },
  {
    name: "rubber-duck",
    description: "Get an independent critique of your current work from the rubber duck agent",
  },
  { name: "lsp", description: "Manage language server configuration" },
  {
    name: "terminal-setup",
    description: "Configure terminal for multiline input support (shift+enter)",
  },
  { name: "permissions", description: "Switch between permission modes" },
  { name: "allow-all", description: "Enable all permissions (tools, paths, and URLs)" },
  {
    name: "sandbox",
    description:
      "Manage sandbox settings, including file path permissions, network permissions, and more",
  },
  {
    name: "add-dir",
    description:
      "Allow file access to a directory and load its .github skills and agents as trusted configuration",
    hint: "<path>",
  },
  { name: "list-dirs", description: "Display allowed directories and exact session path grants" },
  {
    name: "cwd",
    description: "Change working directory or show current directory",
    hint: "[path]",
  },
  {
    name: "reset-allowed-tools",
    description:
      "Reset session tool and exact-path approvals, turn off allow-all, and clear saved approvals for this location",
  },
  {
    name: "resume",
    description: "Switch sessions by local or cloud history ID, task ID, or name",
    hint: "[id or name]",
  },
  {
    name: "rename",
    description: "Rename the current session, or auto-generate a name from conversation",
    hint: "[name]",
  },
  {
    name: "fork",
    description:
      "Fork the current session into a new session, optionally with a name, and switch to it; the original keeps running in the background",
  },
  {
    name: "worktree",
    description:
      "Create a new git worktree from your configured base ref and switch into it, leaving your uncommitted changes behind",
  },
  {
    name: "move",
    description: "Move your uncommitted changes into a new git worktree and switch into it",
  },
  { name: "context", description: "Show context window token usage for the current model" },
  { name: "usage", description: "Display session usage metrics and statistics" },
  { name: "session", description: "View and manage sessions" },
  { name: "compact", description: "Summarize conversation history to reduce context window usage" },
  {
    name: "share",
    description:
      "Open sharing actions for this session, or export with file, html, gist, research, or link",
    choices: ["file", "html", "gist", "research", "link"],
  },
  {
    name: "remote",
    description: "Show remote status or toggle remote control from GitHub web and mobile",
  },
  {
    name: "copy",
    description:
      "Copy the last response to the clipboard as markdown, plus formatted HTML in a local terminal (not over SSH or in tmux) so tables paste cleanly into Word, Outlook or Teams",
  },
  {
    name: "rewind",
    description:
      "Pick an earlier turn to rewind to: restore the conversation only, or also the files Copilot changed",
  },
  { name: "help", description: "Show help for interactive commands" },
  { name: "changelog", description: "Display changelog for CLI versions" },
  {
    name: "feedback",
    description:
      "Report a bug or feature request as a public github/copilot-cli issue, or send private feedback",
  },
  {
    name: "diagnose",
    description: "Analyze session logs, including why a permission request needed approval",
  },
  { name: "theme", description: "Open the color mode picker" },
  { name: "statusline", description: "Configure status line items" },
  { name: "footer", description: "Configure status line items" },
  { name: "update", description: "Update the CLI to the latest version" },
  { name: "version", description: "Display version information and check for updates" },
  { name: "experimental", description: "Show available experimental features" },
  { name: "memory", description: "Show memory status, or enable/disable memory across sessions" },
  { name: "clear", description: "Abandon this session and start fresh" },
  { name: "instructions", description: "View and toggle custom instruction files" },
  { name: "app", description: "Try out the GitHub Copilot desktop app" },
  {
    name: "ahp",
    description:
      "Agent Host Protocol: manage the hosts your sessions run on, and the sessions on them",
  },
  {
    name: "ask",
    description: "Ask a side question or reopen a recently cached answer without adding to history",
  },
  { name: "chronicle", description: "Session history tools and insights" },
  {
    name: "collect-debug-logs",
    description:
      "Collect debug logs to a local .tgz file, share with GitHub after consent, or create a secret GitHub gist",
  },
  { name: "computer", description: "Show or toggle Computer Use" },
  { name: "config", description: "Open the configuration screen, or one area of it" },
  {
    name: "env",
    description:
      "Show loaded environment details (instructions, MCP servers, skills, agents, hooks, plugins, LSPs, extensions)",
  },
  {
    name: "environments",
    description: "Open the Environments screen to manage incoming and outgoing connections",
  },
  {
    name: "exit",
    description: "Exit the CLI; use 'print' to print the session after exiting alt screen",
    choices: ["print"],
  },
  {
    name: "index",
    description: "Inspect and manage this worktree's shared search index (experimental)",
  },
  {
    name: "keep-alive",
    description: "Prevent sleep this run: on/off/busy (while working) or 30m/2h/1d (bare minutes)",
    choices: ["on", "off", "busy"],
  },
  { name: "limits", description: "View or edit session limits; the AI Credit limit is a soft cap" },
  { name: "login", description: "Log in to Copilot" },
  {
    name: "logout",
    description: "Sign out of an account you added with /login or `copilot login`",
  },
  { name: "new", description: "Start a new conversation" },
  { name: "plan", description: "Create an implementation plan before coding" },
  {
    name: "refine",
    description:
      "Rewrite a rough, stream-of-consciousness prompt into a clear one for review (Ctrl+X / then /refine cleans up your current input)",
  },
  {
    name: "research",
    description: "Run deep research investigation using GitHub search and web sources",
  },
  {
    name: "restart",
    description: "Restart the CLI, restoring supported live sessions in this process",
  },
  { name: "search", description: "Search the conversation timeline (experimental)" },
  {
    name: "settings",
    description:
      "Open the settings UI, show, set, or unset a single value ('/settings unset <key>' removes it)",
  },
  {
    name: "subagents",
    description: "Configure each subagent's model and settings, or turn it on or off",
  },
  { name: "user", description: "Manage signed-in accounts" },
  { name: "vim", description: "Toggle Vim mode for the input" },
  { name: "voice", description: "Manage voice mode (dictation transcription via Foundry Local)" },
];

const CODEX: readonly BuiltInCommand[] = [
  { name: "model", description: "Choose what model and reasoning effort to use" },
  { name: "daybreak", description: "Turn Daybreak on or off" },
  {
    name: "ide",
    description: "Include current selection, open files, and other context from your IDE",
  },
  { name: "permissions", description: "Choose what Codex is allowed to do" },
  { name: "keymap", description: "Remap TUI shortcuts" },
  { name: "vim", description: "Toggle Vim mode for the composer" },
  { name: "experimental", description: "Toggle experimental features" },
  { name: "skills", description: "Use skills to improve how Codex performs specific tasks" },
  { name: "import", description: "Import setup, this project, and recent chats from Claude Code" },
  { name: "hooks", description: "View and manage lifecycle hooks" },
  { name: "review", description: "Review my current changes and find issues" },
  { name: "rename", description: "Rename the current thread" },
  { name: "new", description: "Start a new chat during a conversation" },
  { name: "archive", description: "Archive this session" },
  { name: "delete", description: "Permanently delete this session" },
  { name: "resume", description: "Resume a saved chat" },
  { name: "fork", description: "Fork the current chat" },
  { name: "worktree", description: "Start or continue a conversation in a new worktree" },
  { name: "app", description: "Continue this session in the Desktop app" },
  { name: "init", description: "Create an AGENTS.md file with instructions for Codex" },
  { name: "compact", description: "Summarize conversation to prevent hitting the context limit" },
  { name: "recap", description: "Summarize the current conversation now" },
  {
    name: "voice",
    description: "Start or stop voice; use /voice settings to choose a voice",
    choices: ["settings"],
  },
  { name: "goal", description: "Set or view the goal for a long-running task" },
  { name: "side", description: "Start a side conversation", aliases: ["btw"] },
  { name: "copy", description: "Copy the last response or part of it" },
  { name: "export", description: "Export the conversation as markdown" },
  { name: "raw", description: "Toggle raw scrollback mode for copy-friendly terminal selection" },
  { name: "diff", description: "Show git diff (including untracked files)" },
  { name: "mention", description: "Mention a file" },
  { name: "status", description: "Show current session configuration and token usage" },
  { name: "daemon", description: "Manage the local background server" },
  { name: "cd", description: "Change the current working directory" },
  { name: "pwd", description: "Show the current working directory" },
  { name: "usage", description: "View account usage or use a usage limit reset" },
  { name: "title", description: "Configure which items appear in the terminal title" },
  { name: "statusline", description: "Configure which items appear in the status line" },
  { name: "theme", description: "Choose a syntax highlighting theme" },
  { name: "pets", description: "Choose or hide the terminal pet" },
  {
    name: "mcp",
    description: "List MCP tools; use /mcp verbose or /mcp login <name>",
    choices: ["verbose", "login"],
  },
  { name: "apps", description: "Manage apps" },
  { name: "plugins", description: "Browse plugins" },
  { name: "logout", description: "Log out of Codex" },
  { name: "feedback", description: "Send logs to maintainers or save a ZIP" },
  { name: "ps", description: "List background terminals" },
  { name: "stop", description: "Stop all background terminals" },
  { name: "subagents", description: "Switch between this session's subagents" },
];

const CLAUDE: readonly BuiltInCommand[] = [
  { name: "help", description: "Show help and available commands", hint: "[command]" },
  {
    name: "clear",
    description: "Start a new session with empty context; the old one stays in /resume",
    hint: "[name]",
    aliases: ["reset", "new"],
  },
  {
    name: "compact",
    description: "Free up context by summarizing the conversation so far",
    hint: "<optional custom summarization instructions>",
  },
  {
    name: "model",
    description: "Set the AI model for Claude Code",
    hint: "<model>",
    choices: ["opus", "sonnet", "haiku"],
  },
  { name: "config", description: "Open settings", hint: "[key=value]", aliases: ["settings"] },
  { name: "context", description: "Show what fills the context", hint: "[all]" },
  {
    name: "usage",
    description: "Show session cost, plan usage, and activity stats",
    aliases: ["cost", "stats"],
  },
  { name: "status", description: "Show version, account, model, MCP servers, and setup warnings" },
  { name: "resume", description: "Resume an earlier conversation", aliases: ["continue"] },
  {
    name: "rename",
    description: "Rename the current conversation",
    hint: "[name]",
    aliases: ["name"],
  },
  {
    name: "branch",
    description: "Create a branch of the current conversation at this point",
    hint: "[name]",
  },
  {
    name: "fork",
    description: "Start a background agent with the full conversation",
    hint: "<directive>",
  },
  {
    name: "rewind",
    description: "Restore earlier code, conversation, or both",
    aliases: ["checkpoint", "undo"],
  },
  { name: "export", description: "Export this session to a file or clipboard", hint: "[filename]" },
  { name: "copy", description: "Copy the last response to clipboard (/copy 2 for the one before)" },
  { name: "diff", description: "View uncommitted changes" },
  {
    name: "plan",
    description: "Turn on plan mode or view the plan",
    hint: "[open|<description>]",
    choices: ["open"],
  },
  {
    name: "goal",
    description: "Set a goal Claude checks before stopping",
    hint: "[<condition> | clear]",
    choices: ["clear"],
  },
  { name: "recap", description: "Generate a one-line session recap now" },
  {
    name: "btw",
    description: "Ask a side question without interrupting Claude",
    hint: "[question]",
  },
  { name: "cd", description: "Move this session to a new working directory", hint: "<path>" },
  { name: "add-dir", description: "Add a working directory", hint: "<path>" },
  { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation" },
  { name: "memory", description: "Edit CLAUDE.md files and memory settings" },
  {
    name: "permissions",
    description: "Manage allow and deny tool permission rules",
    aliases: ["allowed-tools"],
  },
  { name: "hooks", description: "View hook configurations for tool events" },
  {
    name: "mcp",
    description: "Manage MCP servers",
    hint: "[reconnect|enable|disable [<server>|all]]",
    choices: ["reconnect", "enable", "disable"],
  },
  {
    name: "ide",
    description: "Manage IDE integrations and show status",
    hint: "[open]",
    choices: ["open"],
  },
  { name: "skills", description: "List available skills" },
  { name: "skill-doctor", description: "Show which loaded skills are unused and costing context" },
  {
    name: "plugin",
    description: "Manage Claude Code plugins",
    aliases: ["plugins", "marketplace"],
  },
  {
    name: "reload-plugins",
    description: "Activate pending plugin changes in the current session",
    hint: "[--force]",
  },
  {
    name: "tasks",
    description: "View and manage this session's background work",
    aliases: ["bashes"],
  },
  {
    name: "background",
    description: "Send this session to the background and free the terminal",
    hint: "[prompt]",
    aliases: ["bg"],
  },
  { name: "workflows", description: "Browse running and completed workflows" },
  {
    name: "remote-control",
    description: "Control this session from your phone or claude.ai/code",
    aliases: ["rc"],
  },
  {
    name: "desktop",
    description: "Continue the current session in Claude Desktop",
    aliases: ["app"],
  },
  {
    name: "mobile",
    description: "Show QR code to download the Claude mobile app",
    aliases: ["ios", "android"],
  },
  { name: "chrome", description: "Open Claude in Chrome settings" },
  { name: "theme", description: "Change the theme" },
  {
    name: "tui",
    description: "Set the terminal UI renderer (classic | fullscreen)",
    hint: "[classic|fullscreen]",
    choices: ["classic", "fullscreen"],
  },
  { name: "focus", description: "Toggle focus view: just your prompt, summary, and response" },
  { name: "brief", description: "Toggle brief-only mode" },
  { name: "effort", description: "Set the model's effort level" },
  { name: "output-style", description: "List output styles or switch to one", hint: "[style]" },
  {
    name: "voice",
    description: "Toggle voice mode",
    hint: "[hold|tap|off]",
    choices: ["hold", "tap", "off"],
  },
  { name: "keybindings", description: "Open your keyboard shortcuts file" },
  { name: "statusline", description: "Set up the status line" },
  { name: "scroll-speed", description: "Adjust mouse wheel scroll speed" },
  {
    name: "autocompact",
    description: "Set how full the context gets before auto-summarizing",
    hint: "[auto|<tokens>]",
  },
  {
    name: "import",
    description: "Import config from another AI coding agent",
    hint: "[codex|gemini|cursor] [--dry-run]",
    choices: ["codex", "gemini", "cursor"],
  },
  { name: "doctor", description: "Health-check your setup and fix issues", aliases: ["checkup"] },
  { name: "insights", description: "Generate a report analyzing your Claude Code sessions" },
  { name: "powerup", description: "Learn Claude Code features in short lessons" },
  { name: "release-notes", description: "View release notes" },
  {
    name: "feedback",
    description: "Send feedback to Anthropic or report a bug",
    hint: "[report]",
    aliases: ["bug"],
  },
  { name: "privacy-settings", description: "View and update your privacy settings" },
  { name: "install-github-app", description: "Set up Claude GitHub Actions for a repository" },
  { name: "install-slack-app", description: "Install the Claude Slack app" },
  { name: "upgrade", description: "Upgrade your plan for higher rate limits and more Opus" },
  { name: "login", description: "Sign in with your Anthropic account" },
  { name: "logout", description: "Sign out from your Anthropic account" },
  { name: "version", description: "Show this session's version" },
  { name: "daemon", description: "Manage background services and routines" },
  {
    name: "list-agents",
    description: "List subagents, teammates, and other Claude sessions you can message",
    aliases: ["peers"],
  },
  {
    name: "schedule",
    description: "Create and manage scheduled remote Claude Code agents",
    aliases: ["routines"],
  },
  {
    name: "batch",
    description: "Plan a large change; background agents each open a PR",
    hint: "<instruction>",
  },
  {
    name: "debug",
    description: "Turn on debug logging and investigate problems",
    hint: "[issue description]",
  },
  { name: "claude-api", description: "Build and debug apps that use the Claude API" },
  { name: "run", description: "Launch this project's app to see your change working" },
  {
    name: "fewer-permission-prompts",
    description: "Pre-approve safe read-only commands based on your usage",
  },
  { name: "exit", description: "Exit Claude Code", aliases: ["quit"] },
];

export const BUILT_IN_COMMANDS: Record<AgentVendor, readonly BuiltInCommand[]> = {
  anthropic: CLAUDE,
  openai: CODEX,
  github: COPILOT,
};

/** Every built-in name and alias of a vendor. */
export function builtInNames(vendor: AgentVendor): ReadonlySet<string> {
  const names = new Set<string>();
  for (const command of BUILT_IN_COMMANDS[vendor]) {
    names.add(command.name);
    for (const alias of command.aliases ?? []) names.add(alias);
  }
  return names;
}

export function findBuiltIn(vendor: AgentVendor, name: string): BuiltInCommand | undefined {
  return BUILT_IN_COMMANDS[vendor].find(
    (command) => command.name === name || command.aliases?.includes(name) === true,
  );
}
