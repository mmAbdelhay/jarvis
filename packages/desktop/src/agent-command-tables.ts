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
  {
    name: "add-dir",
    description:
      "Allow file access to a directory and load its .github skills and agents as trusted configuration",
    hint: "<path>",
  },
  { name: "agent", description: "Browse and select agents", hint: "[name]" },
  {
    name: "ahp",
    description:
      "Agent Host Protocol: manage the hosts your sessions run on, and the sessions on them",
  },
  { name: "allow-all", description: "Enable all permissions (tools, paths, and URLs)" },
  { name: "app", description: "Try out the GitHub Copilot desktop app" },
  {
    name: "ask",
    description: "Ask a side question or reopen a recently cached answer without adding to history",
  },
  {
    name: "autopilot",
    description:
      "Toggle autopilot mode, or set an autopilot objective with an optional AI-credit limit (--max-ai-credits)",
  },
  { name: "changelog", description: "Display changelog for CLI versions" },
  { name: "chronicle", description: "Session history tools and insights" },
  { name: "clear", description: "Abandon this session and start fresh" },
  {
    name: "collect-debug-logs",
    description:
      "Collect debug logs to a local .tgz file, share with GitHub after consent, or create a secret GitHub gist",
  },
  { name: "compact", description: "Summarize conversation history to reduce context window usage" },
  { name: "computer", description: "Show or toggle Computer Use" },
  { name: "config", description: "Open the configuration screen, or one area of it" },
  { name: "context", description: "Show context window token usage for the current model" },
  {
    name: "copy",
    description:
      "Copy the last response to the clipboard as markdown, plus formatted HTML in a local terminal (not over SSH or in tmux) so tables paste cleanly into Word, Outlook or Teams",
  },
  {
    name: "cwd",
    description: "Change working directory or show current directory",
    hint: "[path]",
  },
  {
    name: "delegate",
    description:
      "Send this session to GitHub and Copilot will create a PR; use --base to choose the PR target branch",
  },
  {
    name: "diagnose",
    description: "Analyze session logs, including why a permission request needed approval",
  },
  { name: "diff", description: "Review the changes made in the current directory" },
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
  { name: "experimental", description: "Show available experimental features" },
  {
    name: "feedback",
    description:
      "Report a bug or feature request as a public github/copilot-cli issue, or send private feedback",
  },
  { name: "fleet", description: "Enable fleet mode for parallel subagent execution" },
  {
    name: "fork",
    description:
      "Fork the current session into a new session, optionally with a name, and switch to it; the original keeps running in the background",
  },
  { name: "help", description: "Show help for interactive commands" },
  { name: "ide", description: "Connect to an IDE workspace" },
  {
    name: "index",
    description: "Inspect and manage this worktree's shared search index (experimental)",
  },
  { name: "init", description: "Initialize instructions in the project" },
  { name: "instructions", description: "View and toggle custom instruction files" },
  {
    name: "keep-alive",
    description: "Prevent sleep this run: on/off/busy (while working) or 30m/2h/1d (bare minutes)",
    choices: ["on", "off", "busy"],
  },
  { name: "limits", description: "View or edit session limits; the AI Credit limit is a soft cap" },
  { name: "list-dirs", description: "Display allowed directories and exact session path grants" },
  { name: "login", description: "Log in to Copilot" },
  {
    name: "logout",
    description: "Sign out of an account you added with /login or `copilot login`",
  },
  { name: "lsp", description: "Manage language server configuration" },
  { name: "mcp", description: "Manage MCP server configuration" },
  { name: "memory", description: "Show memory status, or enable/disable memory across sessions" },
  {
    name: "model",
    description:
      "Select the AI model for this session (use 'auto' to let Copilot pick automatically)",
    hint: "[model]",
    choices: ["auto"],
  },
  {
    name: "move",
    description: "Move your uncommitted changes into a new git worktree and switch into it",
  },
  { name: "new", description: "Start a new conversation" },
  { name: "permissions", description: "Switch between permission modes" },
  { name: "plan", description: "Create an implementation plan before coding" },
  { name: "plugin", description: "Manage plugins and plugin marketplaces" },
  { name: "pr", description: "Operate on pull requests for the current branch" },
  {
    name: "refine",
    description:
      "Rewrite a rough, stream-of-consciousness prompt into a clear one for review (Ctrl+X / then /refine cleans up your current input)",
  },
  {
    name: "remote",
    description: "Show remote status or toggle remote control from GitHub web and mobile",
  },
  {
    name: "rename",
    description: "Rename the current session, or auto-generate a name from conversation",
    hint: "[name]",
  },
  {
    name: "research",
    description: "Run deep research investigation using GitHub search and web sources",
  },
  {
    name: "reset-allowed-tools",
    description:
      "Reset session tool and exact-path approvals, turn off allow-all, and clear saved approvals for this location",
  },
  {
    name: "restart",
    description: "Restart the CLI, restoring supported live sessions in this process",
  },
  {
    name: "resume",
    description: "Switch sessions by local or cloud history ID, task ID, or name",
    hint: "[id or name]",
  },
  { name: "review", description: "Run code review agent to analyze changes" },
  {
    name: "sandbox",
    description:
      "Manage sandbox settings, including file path permissions, network permissions, and more",
  },
  { name: "search", description: "Search the conversation timeline (experimental)" },
  {
    name: "security-review",
    description:
      "Scan uncommitted changes (staged and unstaged) for security vulnerabilities, or the branch diff when the working tree is clean",
  },
  { name: "session", description: "View and manage sessions" },
  {
    name: "settings",
    description:
      "Open the settings UI, show, set, or unset a single value ('/settings unset <key>' removes it)",
  },
  {
    name: "share",
    description:
      "Open sharing actions for this session, or export with file, html, gist, research, or link",
    choices: ["file", "html", "gist", "research", "link"],
  },
  { name: "skills", description: "Manage skills for enhanced capabilities" },
  { name: "statusline", description: "Configure status line items", aliases: ["footer"] },
  {
    name: "subagents",
    description: "Configure each subagent's model and settings, or turn it on or off",
  },
  {
    name: "tasks",
    description:
      "View running subagents and background shell commands, check their status, and open their live transcript or recent output",
  },
  {
    name: "terminal-setup",
    description: "Configure terminal for multiline input support (shift+enter)",
  },
  { name: "theme", description: "Open the color mode picker" },
  { name: "undo", description: "Undo the last change" },
  { name: "update", description: "Update the CLI to the latest version" },
  { name: "usage", description: "Display session usage metrics and statistics" },
  { name: "user", description: "Manage signed-in accounts" },
  { name: "version", description: "Display version information and check for updates" },
  { name: "vim", description: "Toggle Vim mode for the input" },
  { name: "voice", description: "Manage voice mode (dictation transcription via Foundry Local)" },
  {
    name: "worktree",
    description:
      "Create a new git worktree from your configured base ref and switch into it, leaving your uncommitted changes behind",
  },
  {
    name: "rewind",
    description:
      "Pick an earlier turn to rewind to: restore the conversation only, or also the files Copilot changed",
  },
  {
    name: "rubber-duck",
    description: "Get an independent critique of your current work from the rubber duck agent",
  },
];

const CODEX: readonly BuiltInCommand[] = [
  { name: "init", description: "create an AGENTS.md file with instructions for Codex" },
  { name: "status", description: "show current session configuration" },
  { name: "permissions", description: "choose what Codex is allowed to do" },
  { name: "model", description: "Switch model" },
  { name: "review", description: "review any changes and find issues" },
  { name: "presets", description: "run or save reusable prompts and slash commands" },
  { name: "daybreak", description: "Learn about broader access for cybersecurity work" },
  {
    name: "ide",
    description: "include current selection, open files, and other context from your IDE",
  },
  { name: "keymap", description: "remap TUI shortcuts" },
  { name: "vim", description: "toggle Vim mode for the composer" },
  { name: "experimental", description: "toggle experimental features" },
  { name: "approve", description: "approve one retry of a recent auto-review denial" },
  { name: "memories", description: "configure memory use and generation" },
  { name: "skills", description: "use skills to improve how Codex performs specific tasks" },
  { name: "import", description: "import setup, this project, and recent chats from Claude Code" },
  { name: "hooks", description: "view and manage lifecycle hooks" },
  { name: "rename", description: "rename the current thread" },
  { name: "new", description: "start a new chat during a conversation" },
  { name: "archive", description: "archive this session" },
  { name: "delete", description: "permanently delete this session" },
  { name: "resume", description: "resume a saved chat" },
  { name: "fork", description: "fork the current chat" },
  { name: "worktree", description: "start or continue a conversation in a new worktree" },
  { name: "app", description: "continue this session in the Desktop app" },
  { name: "compact", description: "summarize conversation to prevent hitting the context limit" },
  { name: "config", description: "configure Codex preferences" },
  { name: "recap", description: "summarize the current conversation now" },
  { name: "plan", description: "switch to Plan mode" },
  {
    name: "voice",
    description: "start or stop voice; use /voice settings to choose a voice",
    choices: ["settings"],
  },
  { name: "goal", description: "set or view the goal for a long-running task" },
  { name: "agents", description: "open the agent command center" },
  { name: "side", description: "start a side conversation", aliases: ["btw"] },
  { name: "copy", description: "copy the last response or part of it" },
  { name: "export", description: "export the conversation as markdown" },
  { name: "raw", description: "toggle raw scrollback mode for copy-friendly terminal selection" },
  { name: "tui", description: "choose the TUI mode for the next launch" },
  { name: "diff", description: "show git diff (including untracked files)" },
  { name: "mention", description: "mention a file" },
  { name: "daemon", description: "Manage the local background server" },
  { name: "warnings", description: "view retained warnings and diagnostic details" },
  { name: "cd", description: "change the current working directory" },
  { name: "pwd", description: "show the current working directory" },
  { name: "usage", description: "view account usage or use a usage limit reset" },
  { name: "title", description: "configure which items appear in the terminal title" },
  { name: "statusline", description: "configure which items appear in the status line" },
  { name: "theme", description: "choose a syntax highlighting theme" },
  { name: "pets", description: "choose or hide the terminal pet" },
  {
    name: "mcp",
    description: "list MCP tools; use /mcp verbose or /mcp login <name>",
    choices: ["verbose", "login"],
  },
  { name: "plugins", description: "browse plugins" },
  { name: "logout", description: "log out of Codex" },
  { name: "exit", description: "exit Codex" },
  { name: "feedback", description: "send logs to maintainers or save a ZIP" },
  { name: "ps", description: "list background terminals" },
  { name: "stop", description: "stop all background terminals" },
  { name: "clear", description: "clear the terminal and start a new chat" },
  { name: "subagents", description: "switch between this session's subagents" },
];

const CLAUDE: readonly BuiltInCommand[] = [
  { name: "add-dir", description: "Add a working directory", hint: "<path>" },
  { name: "advisor", description: "Let Claude consult a stronger model at key moments" },
  { name: "artifacts", description: "Browse your published and shared artifacts" },
  { name: "auto-mode-setup", description: "Teach auto mode about your environment" },
  {
    name: "autocompact",
    description: "Set how full the context gets before auto-summarizing",
    hint: "[auto|<tokens>]",
  },
  { name: "autofix-pr", description: "Monitor and autofix any issues with the current PR" },
  {
    name: "background",
    description: "Send this session to the background and free the terminal",
    hint: "[prompt]",
    aliases: ["bg"],
  },
  {
    name: "branch",
    description: "Create a branch of the current conversation at this point",
    hint: "[name]",
  },
  {
    name: "btw",
    description: "Ask a side question without interrupting Claude",
    hint: "[question]",
  },
  { name: "bug", description: "Report a bug or share your session" },
  { name: "cd", description: "Move this session to a new working directory", hint: "<path>" },
  { name: "chrome", description: "Open Claude in Chrome settings" },
  {
    name: "clear",
    description:
      "Start a new session with empty context; loops carry over, and the old one stays in /resume",
    hint: "[name]",
    aliases: ["reset", "new"],
  },
  { name: "color", description: "Set the prompt bar color for this session" },
  {
    name: "compact",
    description: "Free up context by summarizing the conversation so far",
    hint: "<optional custom summarization instructions>",
  },
  { name: "config", description: "Open settings", hint: "[key=value]", aliases: ["settings"] },
  { name: "context", description: "Show what fills the context", hint: "[all]" },
  { name: "copy", description: "Copy the last response to clipboard (/copy 2 for the one before)" },
  {
    name: "design-login",
    description: "Authorize design-system access for /design-sync with your claude.ai account",
  },
  {
    name: "desktop",
    description: "Continue the current session in Claude Desktop",
    aliases: ["app"],
  },
  { name: "diff", description: "Toggle the diff panel showing uncommitted changes" },
  { name: "effort", description: "Set the model's effort level" },
  { name: "exit", description: "Exit the CLI", aliases: ["quit"] },
  { name: "export", description: "Export this session to a file or clipboard", hint: "[filename]" },
  { name: "fast", description: "Toggle fast mode" },
  {
    name: "feedback",
    description: "Send feedback to Anthropic or report a bug",
    hint: "[report]",
  },
  { name: "focus", description: "Toggle focus view: just your prompt, summary, and response" },
  {
    name: "fork",
    description: "Copy this conversation into a new background session and keep working here",
    hint: "<directive>",
  },
  {
    name: "goal",
    description: "Set a goal Claude checks before stopping",
    hint: "[<condition> | clear]",
    choices: ["clear"],
  },
  { name: "help", description: "Show help and available commands", hint: "[command]" },
  { name: "hooks", description: "View hook configurations for tool events" },
  {
    name: "ide",
    description: "Manage IDE integrations and show status",
    hint: "[open]",
    choices: ["open"],
  },
  {
    name: "import",
    description: "Import config from another AI coding agent",
    hint: "[codex|gemini|cursor] [--dry-run]",
    choices: ["codex", "gemini", "cursor"],
  },
  { name: "install-github-app", description: "Set up Claude GitHub Actions for a repository" },
  { name: "install-slack-app", description: "Install the Claude Slack app" },
  { name: "keybindings", description: "Open your keyboard shortcuts file" },
  {
    name: "list-agents",
    description: "List subagents, teammates, and other Claude sessions you can message",
    aliases: ["peers"],
  },
  { name: "login", description: "Sign in with your Anthropic account" },
  { name: "logout", description: "Sign out from your Anthropic account" },
  {
    name: "mcp",
    description: "Manage MCP servers",
    hint: "[reconnect|enable|disable [<server>|all]]",
    choices: ["reconnect", "enable", "disable"],
  },
  { name: "memory", description: "Edit CLAUDE.md files and memory settings" },
  {
    name: "mobile",
    description: "Show QR code to download the Claude mobile app",
    aliases: ["ios", "android"],
  },
  {
    name: "model",
    description: "Switch model",
    hint: "<model>",
    choices: ["opus", "sonnet", "haiku"],
  },
  { name: "output-style", description: "List output styles or switch to one", hint: "[style]" },
  {
    name: "passes",
    description: "Share a free week of Claude Code with friends and earn usage credits",
  },
  {
    name: "permissions",
    description: "Manage allow and deny tool permission rules",
    aliases: ["allowed-tools"],
  },
  {
    name: "plan",
    description: "Turn on plan mode or view the plan",
    hint: "[open|<description>]",
    choices: ["open"],
  },
  {
    name: "plugin",
    description: "Manage Claude Code plugins",
    aliases: ["plugins", "marketplace"],
  },
  { name: "powerup", description: "Learn Claude Code features in short lessons" },
  { name: "privacy-settings", description: "View and update your privacy settings" },
  { name: "radio", description: "Listen to Claude FM lo-fi radio" },
  { name: "rate-limit-options", description: "Manage usage limits and upgrade options" },
  { name: "recap", description: "Generate a one-line session recap now" },
  { name: "release-notes", description: "View release notes" },
  {
    name: "reload-plugins",
    description: "Activate pending plugin changes in the current session",
    hint: "[--force]",
  },
  {
    name: "reload-skills",
    description: "Pick up skills added or changed on disk during this session",
  },
  {
    name: "remote-control",
    description: "Control this session from your phone or claude.ai/code",
    aliases: ["rc"],
  },
  { name: "remote-env", description: "Choose the default environment for cloud agents" },
  {
    name: "rename",
    description: "Rename the current conversation",
    hint: "[name]",
    aliases: ["name"],
  },
  { name: "resume", description: "Resume a previous session", aliases: ["continue"] },
  {
    name: "rewind",
    description: "Restore earlier code, conversation, or both",
    aliases: ["checkpoint", "undo"],
  },
  { name: "sandbox", description: "Configure the sandbox" },
  { name: "scroll-speed", description: "Adjust mouse wheel scroll speed" },
  { name: "skill-doctor", description: "Show which loaded skills are unused and costing context" },
  { name: "skills", description: "List available skills" },
  { name: "status", description: "Show version, account, model, MCP servers, and setup warnings" },
  { name: "stickers", description: "Check Claude Code sticker availability" },
  {
    name: "subtask",
    description: "Send a subagent off with your full context; its result comes back here",
  },
  {
    name: "tasks",
    description: "View and manage this session's background work",
    aliases: ["bashes"],
  },
  { name: "teleport", description: "Resume a cloud session here" },
  { name: "terminal-setup", description: "Set up Shift+Enter for newlines" },
  { name: "theme", description: "Change the theme" },
  {
    name: "tui",
    description: "Set the terminal UI renderer (classic | fullscreen)",
    hint: "[classic|fullscreen]",
    choices: ["classic", "fullscreen"],
  },
  {
    name: "ultrareview",
    description: "Start a cloud agent that finds and verifies bugs in your branch",
  },
  { name: "upgrade", description: "Upgrade your plan for higher rate limits and more Opus" },
  {
    name: "usage",
    description: "Show session cost, plan usage, and activity stats",
    aliases: ["cost", "stats"],
  },
  {
    name: "usage-credits",
    description: "Configure usage credits or request them from your admin when you hit a limit",
  },
  {
    name: "voice",
    description: "Toggle voice mode",
    hint: "[hold|tap|off]",
    choices: ["hold", "tap", "off"],
  },
  { name: "web-setup", description: "Set up cloud sessions with your GitHub account" },
  { name: "artifact-capabilities", description: "Runtime capabilities for published Artifacts" },
  { name: "artifact-diagramming", description: "Diagramming guidance for Artifacts" },
  {
    name: "batch",
    description: "Plan a large change; background agents each open a PR",
    hint: "<instruction>",
  },
  { name: "claude-api", description: "Build and debug apps that use the Claude API" },
  {
    name: "claude-approvals",
    description: "Edit, explain, or tune a Claude Approvals policy file or classifier",
  },
  {
    name: "claude-in-chrome",
    description: "Let Claude browse and interact with pages in your Chrome",
  },
  { name: "code-review", description: "Review the current diff or a PR for bugs" },
  { name: "dataviz", description: "Chart and dashboard design guidance" },
  {
    name: "debug",
    description: "Turn on debug logging and investigate problems",
    hint: "[issue description]",
  },
  { name: "design", description: "Make a new Design artifact from a brief" },
  { name: "design-sync", description: "Sync your design system to Claude Design" },
  {
    name: "doctor",
    description:
      "Health-check your setup and fix issues: installation, unused extensions, duplicated or bloated memory",
    aliases: ["checkup"],
  },
  {
    name: "fewer-permission-prompts",
    description: "Pre-approve safe read-only commands based on your usage",
  },
  { name: "init", description: "Initialize a new CLAUDE.md file with codebase documentation" },
  { name: "insights", description: "Generate a report analyzing your Claude Code sessions" },
  { name: "loop", description: "Repeat a prompt or command on an interval (e.g. /loop 5m /foo)" },
  {
    name: "plugin-authoring",
    description: "Write a mod: a live pane, view or behaviour change in Claude Code",
  },
  { name: "run", description: "Launch this project’s app to see your change working" },
  {
    name: "run-skill-generator",
    description: "Create a skill that knows how to run this project’s app",
  },
  {
    name: "schedule",
    description: "Create and manage routines: cloud agents on a schedule",
    aliases: ["routines"],
  },
  {
    name: "security-review",
    description: "Complete a security review of the pending changes on the current branch",
  },
  { name: "send-to-project", description: "Send this session's work to a Claude Project" },
  {
    name: "ship",
    description: "Open a pull request if there is none, review it here, then watch it",
  },
  { name: "simplify", description: "Clean up the changed code without changing behavior" },
  { name: "slides", description: "Make a new Slides deck artifact from a brief" },
  { name: "statusline", description: "Set up the status line" },
  {
    name: "steward",
    description: "Watch your open pull request in this session and fix what comes up",
  },
  {
    name: "team-onboarding",
    description: "Help teammates ramp on Claude Code with a guide from your usage",
  },
  {
    name: "update-config",
    description: "Change settings: hooks, permissions, environment variables",
  },
  { name: "verify", description: "Try your change and report if it works" },
  { name: "whiteboard", description: "Make a new Whiteboard artifact from a brief" },
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
