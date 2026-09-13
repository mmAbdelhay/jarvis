import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { AgentConfig, ProcessHandle, Spawner } from "@jarvis/core";
import { ptySpawnTarget } from "./executable.js";

/**
 * Spawns coding agents inside a real pseudo-terminal.
 *
 * The piped spawner in spawn.ts cannot host an interactive agent, and the
 * failure is silent rather than obvious: Claude Code (and every other CLI
 * with a terminal UI) checks whether stdin is a TTY, and a pipe is not one.
 * It concludes it is being fed a single prompt non-interactively, waits
 * three seconds for that prompt, and exits with
 *
 *   Error: Input must be provided either through stdin or as a prompt
 *   argument when using --print
 *
 * A pty makes stdin a genuine terminal, so the agent starts the same
 * interactive session it would in a terminal window — slash commands,
 * permission prompts, plan mode and all. That is also why output here is
 * raw bytes carrying ANSI escape sequences rather than tidy lines: it is a
 * terminal's screen, and it is meant to be handed to a terminal emulator,
 * not read as text. spawn.ts's line buffering is deliberately absent —
 * splitting a redraw on newlines would tear escape sequences in half.
 */

// node-pty is a native module. It is loaded through createRequire rather
// than imported so that it is resolved lazily, at the moment a pty spawner
// is actually constructed: the unit tests inject fake spawners and must
// never pull a native binding into a plain-Node vitest worker.
const require = createRequire(import.meta.url);

type PtyProcess = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
};

type PtyModule = {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cols: number;
      rows: number;
      cwd: string;
      env: NodeJS.ProcessEnv;
    },
  ): PtyProcess;
};

/**
 * The size a session's terminal is assumed to be until the renderer has
 * measured its own pane and sent a real one. An agent draws its opening
 * banner immediately on start, before any resize can arrive, so this is
 * the width that banner is laid out at — 80x24 is the historical default
 * every terminal UI is designed to survive.
 */
export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

/**
 * `xterm-256color` rather than plain `xterm`: agents choose their colour
 * palette from TERM, and the dashboard's design language assumes the
 * 256-colour output the real terminal gives.
 */
const TERM = "xterm-256color";

/**
 * Environment markers a Claude Code session sets for processes it starts,
 * so they know they are its children. They must not reach a Jarvis
 * session: these are the user's own top-level sessions, and a session that
 * inherits the marker runs degraded — it disables transcript saving and
 * announces so in its own banner ("Transcript saving is off — inherited
 * CLAUDE_CODE_CHILD_SESSION marker"). They only appear at all when Jarvis
 * itself was launched from inside a Claude Code session, which is exactly
 * how it gets launched during development, so the bug would be invisible
 * in production and constant in testing.
 */
const INHERITED_AGENT_MARKERS = [
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ID",
];

/**
 * Removed for the same reason capacity.ts and brain.ts remove it: an
 * ambient ANTHROPIC_API_KEY silently outranks the OAuth credentials the
 * account wrapper's CLAUDE_CONFIG_DIR points at, so a session the dashboard
 * labels `claude-acme` would quietly bill API credits instead of that
 * subscription. Jarvis exists to make which account is paying legible, and
 * every other path that spends money already strips it.
 */
const BILLING_OVERRIDE = "ANTHROPIC_API_KEY";

/**
 * The args an agent is launched with: whatever the config specifies, plus
 * `--model` when the config names one and `--session-id` with the id
 * SessionManager already minted for this session.
 *
 * `--session-id` is what makes a Jarvis session and its transcript one
 * record rather than two. SessionManager mints its own uuid, unrelated to
 * the id Claude Code would choose for itself, so without this flag the
 * transcript importer finds a session it has no way to recognise as one
 * Jarvis started and files it a second time under a second id. Verified
 * against the real CLI rather than taken from --help: the transcript is
 * written under the supplied id even when the run itself fails.
 *
 * Exported and pinned by its own test, the same as headlampArgs, because
 * the flag list is the whole contract with the CLI and a real-pty test
 * proves the pty rather than the arguments.
 *
 * Without the model half of this, `model:` in
 * jarvis.yaml is decorative — it is recorded on the session row and shown
 * in the UI, but the agent is launched with no model flag and quietly uses
 * whatever its own account default is, so the dashboard says "sonnet"
 * while an Opus session runs. Config-supplied args win by coming first:
 * an explicit `--model` in `args` leaves this one as a later duplicate,
 * and every CLI here takes the first occurrence.
 */
export function argsFor(agent: AgentConfig, sessionId?: string): string[] {
  const configured = agent.args ?? [];
  const withModel =
    agent.model === undefined || configured.includes("--model") || configured.includes("-m")
      ? configured
      : [...configured, "--model", agent.model];
  if (sessionId === undefined || withModel.includes("--session-id")) return withModel;
  // Only where the flag means what we need it to mean. Claude Code reads
  // --session-id as "use this id for the new session"; the Copilot CLI reads
  // it as "resume the session with this id", so passing a just-minted id
  // there asks it to resume something that does not exist. The flag serves
  // the transcript importer, and the importer reads anthropic agents only,
  // so the two share one predicate rather than drifting apart. An agent that
  // declares no vendor keeps the flag: losing dedup is a duplicated row,
  // while a wrong flag is a session that will not start.
  if (agent.vendor !== undefined && agent.vendor !== "anthropic") return withModel;
  return [...withModel, "--session-id", sessionId];
}

/**
 * node-pty ships prebuilt binaries plus a `spawn-helper` executable that
 * the darwin build execs to hand the child its controlling terminal. The
 * execute bit is normally restored by node-pty's own install script — but
 * this machine sets `ignore-scripts=true` globally, so the helper lands
 * unreadable-as-a-program and every spawn fails with a bare
 * "posix_spawnp failed" that names nothing.
 *
 * Restoring the bit here makes the failure self-healing across reinstalls
 * instead of a mystery that has to be rediagnosed each time. Exported
 * because shell.ts spawns under the same node-pty and hits the same wall:
 * a Terminal tab opened before any agent session would otherwise be the
 * first thing to fail after a reinstall. Best-effort
 * on purpose: if the file is missing (another platform's build) or the
 * chmod is refused, the spawn below will raise the real error, and
 * masking that with an error of our own would be worse.
 */
export function ensureSpawnHelperExecutable(): void {
  try {
    const entry = require.resolve("node-pty");
    const helper = join(
      dirname(dirname(entry)),
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    if (!existsSync(helper)) return;
    const mode = statSync(helper).mode;
    // 0o111 — the three execute bits. Already set is the common case.
    if ((mode & 0o111) === 0o111) return;
    chmodSync(helper, mode | 0o111);
  } catch {
    // Deliberately silent; see the doc comment above.
  }
}

/**
 * An environment, or a way to get one when it is next needed.
 *
 * The function form exists because the PATH a GUI-launched app inherits is
 * not the user's: a Finder or desktop-launcher process gets
 * `/usr/bin:/bin:/usr/sbin:/sbin`, which is not where Homebrew, npm, nvm or
 * ~/.local/bin put anything. The real PATH costs a login shell to ask for
 * (see loginShellPath), so Jarvis asks once at startup and lets the answer
 * arrive late.
 *
 * "Late" is the whole point. Anything that captures the environment as a
 * value at construction time captures whatever was there *before* that answer
 * came back — and then resolves every binary against the stripped-down GUI
 * PATH for the rest of the session. Taking a getter instead means the lookup
 * happens when something is actually spawned, long after the shell replied.
 */
export type EnvSource = NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv);

/** The environment an EnvSource stands for, read now. */
export function resolveEnv(source: EnvSource): NodeJS.ProcessEnv {
  return typeof source === "function" ? source() : source;
}

/**
 * A copy of `env` with the two classes of variable above removed: the
 * markers a Claude Code session leaves for its children, and the ambient
 * API key that would outrank an account wrapper's own credentials.
 *
 * Shared by the agent spawner and the Terminal tab's shell spawner
 * (shell.ts), because the reasoning is identical for both: a shell the user
 * opens in Jarvis is a top-level shell, and running `claude` in it must not
 * produce a session degraded by a marker Jarvis happened to inherit from
 * the terminal it was launched from.
 */
export function sanitizedShellEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const marker of INHERITED_AGENT_MARKERS) delete clean[marker];
  delete clean[BILLING_OVERRIDE];
  return clean;
}

/**
 * Creates a Spawner that runs each agent under its own pty.
 *
 * `env` defaults to the Electron main process's environment, which is what
 * carries each account's wrapper script and PATH. TERM is forced rather
 * than inherited: a GUI app is not launched from a terminal, so it has no
 * TERM of its own, and an agent that finds none falls back to a dumb
 * terminal with no colour and no cursor addressing.
 */
export function createPtySpawner(
  /**
   * The environment a child gets — or a function returning it, read at
   * spawn time rather than when the spawner is built.
   *
   * The function form exists for PATH. An agent's command is resolved on
   * it, and a Finder-launched app's PATH is `/usr/bin:/bin:/usr/sbin:/sbin`
   * — not where Homebrew or npm put `claude`, so every agent was reported
   * broken at startup and no session could start, in installed builds only.
   * The login shell's PATH is the answer, but asking for it costs a shell
   * start and a heavy .zshrc would then sit between app-ready and the
   * window. Resolving late costs nothing: a child is spawned when somebody
   * starts a session, long after that lookup has finished.
   */
  env: NodeJS.ProcessEnv | (() => NodeJS.ProcessEnv) = process.env,
): Spawner {
  ensureSpawnHelperExecutable();
  const pty = require("node-pty") as PtyModule;

  return (agent: AgentConfig, projectPath: string, sessionId?: string): ProcessHandle => {
    const resolved = typeof env === "function" ? env() : env;
    const childEnv: NodeJS.ProcessEnv = { ...sanitizedShellEnv(resolved), TERM };

    // Resolved on Windows so a bare `claude` finds claude.exe, or an npm
    // shim's claude.cmd: ConPTY resolves nothing itself and reports the miss
    // as "File not found: " with the name left blank. Untouched elsewhere —
    // see executable.ts. This file is one of the three the platform
    // convention allows to read process.platform.
    const target = ptySpawnTarget(
      agent.command,
      argsFor(agent, sessionId),
      childEnv,
      process.platform,
    );
    const child = pty.spawn(target.file, target.args, {
      name: TERM,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: projectPath,
      env: childEnv,
    });

    const outputListeners: ((chunk: string) => void)[] = [];
    const exitListeners: ((code: number) => void)[] = [];

    // Same latches as the piped spawner: a terminal that has already exited
    // must still deliver its code to a listener registered afterwards, and
    // must deliver it exactly once.
    let exited = false;
    let exitCode: number | undefined;

    child.onData((data) => {
      for (const listener of outputListeners) listener(data);
    });

    child.onExit(({ exitCode: code, signal }) => {
      if (exited) return;
      exited = true;
      // A pty reports a signalled child as exitCode 0 with a signal set,
      // which would otherwise read as "finished successfully" — the same
      // conflation exitCodeFor() exists to prevent in spawn.ts.
      exitCode = signal !== undefined && signal !== 0 ? 128 + signal : code;
      for (const listener of exitListeners) listener(exitCode);
    });

    return {
      write: (data: string) => {
        // Writing to a pty whose child is gone throws EIO rather than
        // emitting an error event. Swallowed so a keystroke that loses the
        // race with an exiting session cannot take down the main process.
        if (exited) return;
        try {
          child.write(data);
        } catch {
          // The session is gone; its exit has already been dispatched.
        }
      },
      kill: () => {
        if (exited) return;
        try {
          child.kill();
        } catch {
          // Already reaped.
        }
      },
      resize: (cols: number, rows: number) => {
        if (exited) return;
        try {
          child.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
        } catch {
          // A resize racing an exit is not worth surfacing.
        }
      },
      onOutput: (listener) => {
        outputListeners.push(listener);
      },
      onExit: (listener) => {
        if (exited && exitCode !== undefined) {
          listener(exitCode);
          return;
        }
        exitListeners.push(listener);
      },
    };
  };
}
