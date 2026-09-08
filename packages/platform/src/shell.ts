import { createRequire } from "node:module";
import { DEFAULT_COLS, DEFAULT_ROWS, ensureSpawnHelperExecutable, sanitizedShellEnv } from "./pty.js";
import { JARVIS_COMMAND_LOG_ENV } from "./zsh-integration.js";

// node-pty is a native module, loaded lazily through createRequire for the
// same reason pty.ts does it: the unit tests inject a fake spawner and must
// never pull a native binding into a plain-Node vitest worker.
const require = createRequire(import.meta.url);

export type ShellProcess = {
  onData(listener: (chunk: string) => void): void;
  onExit(listener: (code: number) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type ShellSpawner = (args: { cwd: string; cols: number; rows: number }) => ShellProcess;

export type ShellManager = {
  /** Starts the shell for `tabId`, rooted at `cwd`. Starting a tab that
   *  already has one is a no-op, not a second shell. */
  start(tabId: string, cwd: string, cols?: number, rows?: number): void;
  /** Connects a listener to a tab's shell and returns whatever the shell
   *  printed before anyone was listening — the prompt, usually. The buffer
   *  is drained by this call: a later attach replays nothing. */
  attach(tabId: string, onData: (chunk: string) => void, onExit?: (code: number) => void): string;
  write(tabId: string, data: string): void;
  resize(tabId: string, cols: number, rows: number): void;
  /** Kills a tab's shell and forgets it — for a closed tab. */
  kill(tabId: string): void;
  /** Kills every shell; called on quit. Each one is a live child process
   *  and does not go away with the window on its own. */
  stopAll(): void;
};

export type ShellManagerDeps = {
  spawn: ShellSpawner;
  /** How much pre-attach output to keep per tab. A shell's opening prompt is
   *  a few hundred bytes; this only has to survive the milliseconds before
   *  the renderer builds an xterm for the new tab. */
  maxBufferBytes?: number;
};

const DEFAULT_MAX_BUFFER_BYTES = 64 * 1024;

type Session = {
  process: ShellProcess;
  /** Output that arrived before anything attached. Emptied by attach(). */
  buffer: string;
  onData: ((chunk: string) => void) | undefined;
  onExit: ((code: number) => void) | undefined;
};

/**
 * One shell per terminal tab, keyed by tab id rather than by project: two
 * terminals in the same project is an ordinary thing to want, and they are
 * separate shells with separate state.
 *
 * The buffer exists because a shell prints its prompt the instant it
 * starts, which is before the renderer has seen the new tab in a workspace
 * update and built an xterm for it. Without it a fresh Terminal tab looks
 * blank until the first keystroke.
 */
export function createShellManager(deps: ShellManagerDeps): ShellManager {
  const sessions = new Map<string, Session>();
  const maxBufferBytes = deps.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  return {
    start(tabId, cwd, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
      if (sessions.has(tabId)) return;

      const process = deps.spawn({ cwd, cols, rows });
      const session: Session = { process, buffer: "", onData: undefined, onExit: undefined };
      sessions.set(tabId, session);

      process.onData((chunk) => {
        if (session.onData !== undefined) {
          session.onData(chunk);
          return;
        }
        // Keep the tail, not the head: what matters to a terminal that has
        // not drawn yet is the most recent screen state.
        session.buffer = (session.buffer + chunk).slice(-maxBufferBytes);
      });

      process.onExit((code) => {
        sessions.delete(tabId);
        session.onExit?.(code);
      });
    },

    attach(tabId, onData, onExit) {
      const session = sessions.get(tabId);
      if (session === undefined) return "";
      session.onData = onData;
      session.onExit = onExit;
      const buffered = session.buffer;
      session.buffer = "";
      return buffered;
    },

    write(tabId, data) {
      sessions.get(tabId)?.process.write(data);
    },

    resize(tabId, cols, rows) {
      sessions.get(tabId)?.process.resize(cols, rows);
    },

    kill(tabId) {
      const session = sessions.get(tabId);
      if (session === undefined) return;
      sessions.delete(tabId);
      session.process.kill();
    },

    stopAll() {
      for (const session of sessions.values()) session.process.kill();
      sessions.clear();
    },
  };
}

/** The user's own login shell, or zsh — macOS's default since Catalina. */
function shellCommand(env: NodeJS.ProcessEnv): string {
  const shell = env["SHELL"];
  return shell === undefined || shell === "" ? "/bin/zsh" : shell;
}

export type ShellIntegration = {
  /** The Jarvis-owned ZDOTDIR wrapper, when one was installed. */
  zdotdir?: string | undefined;
  /** Where the wrapper's preexec hook appends `<epoch>\t<cwd>\t<command>`. */
  commandLog?: string | undefined;
};

/**
 * The environment a Terminal tab's shell is started with.
 *
 * COLORTERM is set beside TERM because modern prompts (starship,
 * powerlevel) check it to decide whether they may use 24-bit colour;
 * xterm.js renders it fine, and without the marker they fall back to a
 * duller palette.
 *
 * ZDOTDIR is set only when a wrapper was actually installed. An absent
 * integration must leave no trace: pointing ZDOTDIR anywhere changes which
 * startup files the shell reads, and a half-installed redirection is the
 * one failure that could cost the user their PATH. Whatever ZDOTDIR the
 * user had set passes through untouched.
 */
export function shellEnv(
  env: NodeJS.ProcessEnv,
  integration: ShellIntegration,
): NodeJS.ProcessEnv {
  return {
    ...sanitizedShellEnv(env),
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    // Fig, Amazon Q and Kiro CLI ship one and the same zsh integration, and
    // the first thing it does is re-exec the shell under its own pty
    // wrapper (figterm) — unless Q_TERM says the session is already inside
    // one. It is: node-pty below, xterm.js above. Saying so is honest, and
    // it is the difference between a working terminal and a dead one.
    //
    // Unsaid, the wrapper launched inside the shell Jarvis spawns and
    // panicked outright ("index out of bounds" in its bundled alacritty
    // grid). With it went the ZDOTDIR hooks below: no OSC 133, so no block
    // boundaries, no file sidebar (it opens on the shell's first directory
    // report) and no chips — a plain terminal, with nothing said about why.
    //
    // Only ever in the installed build, which is what made it puzzling: a
    // Jarvis started from a terminal inherits that session's own Q_TERM and
    // so never triggered the wrapper. Same shape as the sidecars inheriting
    // a GUI PATH rather than a login shell's.
    Q_TERM: "1",
    ...(integration.zdotdir === undefined ? {} : { ZDOTDIR: integration.zdotdir }),
    ...(integration.commandLog === undefined
      ? {}
      : { [JARVIS_COMMAND_LOG_ENV]: integration.commandLog }),
  };
}

/**
 * The real spawner: the user's login shell under a pty, rooted at the
 * project.
 *
 * `-l` (a login shell) is what makes this the terminal the user actually
 * has: their .zprofile/.zshrc, their PATH, their aliases, their prompt. A
 * GUI app inherits none of that from the environment it was launched in,
 * so a non-login shell here would be a stripped-down impostor of the one
 * they get in a terminal window.
 *
 * `integration` carries the completion feature's ZDOTDIR wrapper, when one
 * was installed — see shellEnv and zsh-integration.ts. An empty one is the
 * terminal as it was before autocomplete existed.
 */
export function createRealShellSpawner(
  env: NodeJS.ProcessEnv = process.env,
  integration: ShellIntegration = {},
): ShellSpawner {
  // node-pty's own shape: onExit hands over an event object, not a bare
  // code, which is the one place it differs from ShellProcess.
  type NodePtyProcess = {
    onData(listener: (data: string) => void): void;
    onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
  const pty = require("node-pty") as {
    spawn(
      file: string,
      args: string[],
      options: { name: string; cols: number; rows: number; cwd: string; env: NodeJS.ProcessEnv },
    ): NodePtyProcess;
  };

  return ({ cwd, cols, rows }) => {
    const child = pty.spawn(shellCommand(env), ["-l"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: shellEnv(env, integration),
    });

    return {
      onData: (listener) => child.onData(listener),
      // A pty reports a signalled child as exitCode 0 with a signal set,
      // which would otherwise read as "the shell finished successfully" —
      // the same conflation pty.ts guards against for agent sessions.
      onExit: (listener) =>
        child.onExit(({ exitCode, signal }) =>
          listener(signal !== undefined && signal !== 0 ? 128 + signal : exitCode),
        ),
      write: (data) => {
        // Writing to a pty whose child is gone throws EIO rather than
        // emitting an error event — same guard the agent spawner uses.
        try {
          child.write(data);
        } catch {
          // The shell is gone; its exit has already been dispatched.
        }
      },
      resize: (cols, rows) => {
        try {
          child.resize(Math.max(1, Math.floor(cols)), Math.max(1, Math.floor(rows)));
        } catch {
          // Same race as write().
        }
      },
      kill: () => {
        try {
          child.kill();
        } catch {
          // Already reaped.
        }
      },
    };
  };
}
