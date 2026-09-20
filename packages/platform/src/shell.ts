import { existsSync } from "node:fs";
import { resolveWindowsExecutable } from "./executable.js";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import type { StreamSnapshot } from "@jarvis/core";
import { DEFAULT_COLS, DEFAULT_ROWS, sanitizedShellEnv } from "./pty.js";
import { powerShellLaunchArgs } from "./powershell-integration.js";
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

// `offset` is the count of UTF-16 code units emitted for this pane before
// `chunk` (ruling 10) — a client uses it with snapshot()'s `end` to tell
// whether a push it just received is one it already has.
export type ShellOutput = { paneKey: string; chunk: string; offset: number };
export type ShellExit = { paneKey: string; code: number };
export type TerminalPaneInfo = { paneKey: string; exited: boolean };

// How much of an exited pane's log survives after its process is gone —
// same figure as SessionManager's DEAD_LOG_CHARS (48 KiB): the reason to
// reopen a dead pane is to see how it ended, and that is at the tail.
export const EXITED_LOG_CHARS = 49_152;

export type ShellManager = {
  /** Starts the shell for `tabId`, rooted at `cwd`. Starting a tab that
   *  already has one is a no-op, not a second shell. */
  start(tabId: string, cwd: string, cols?: number, rows?: number): void;
  /** Every subscriber sees every pane's output, filtered by `paneKey` on the
   *  consuming side. One stream rather than a per-pane subscription, for the
   *  same reason SessionManager.onOutput is one stream: the consumer forwards
   *  everything to a single channel anyway, and a per-pane subscription would
   *  need its own teardown on every pane exit. Returns an unsubscribe. */
  onOutput(listener: (output: ShellOutput) => void): () => void;
  /** As onOutput, for the exit. Separate from `kill`: this fires when the
   *  shell goes away for any reason, including the user typing `exit`. */
  onShellExit(listener: (exit: ShellExit) => void): () => void;
  /** What this pane has printed, up to the retained cap, as one string.
   *  **Non-destructive** — reading it twice returns it twice, which is what
   *  lets a second client open the same pane and see what is on it. An
   *  unknown pane returns "" rather than throwing: the renderer asks for
   *  this the moment a tab appears, routinely before the shell has printed
   *  anything. */
  log(tabId: string): string;
  /** A cursor onto this pane's retained output: `text` is `log(tabId)`,
   *  `end` is the true count of UTF-16 code units emitted since the pane
   *  started (ruling 10), even once retention has trimmed `text` below
   *  that. An unknown pane returns `{ text: "", end: 0 }`, same as `log`. */
  snapshot(tabId: string): StreamSnapshot;
  /** Whether `tabId` names a pane this manager still knows about — a live
   *  shell, or one that exited but kept its retained log (ruling 12). False
   *  once `kill` or `stopAll` has forgotten it. */
  has(tabId: string): boolean;
  /** Every live or retained-exited pane the manager still knows about,
   *  without cwd, process handles or retained output. */
  panes(): readonly TerminalPaneInfo[];
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
  /** How much of each pane's output is retained so a client opening the pane
   *  partway through sees what is on the screen. A cap in characters rather
   *  than lines because a single line has no bounded length — one enormous
   *  JSON blob must not grow this without limit. */
  maxLogChars?: number;
};

const DEFAULT_MAX_LOG_CHARS = 256 * 1024;

type Session = {
  process: ShellProcess;
  /** What this pane has printed, capped at maxLogChars (or EXITED_LOG_CHARS
   *  once exited), oldest chunk first. Never emptied by a read — see
   *  ShellManager.log. An array rather than one accumulated string so a
   *  long-lived pane trims by dropping whole chunks from the front, not by
   *  reslicing the full retained string on every incoming chunk. */
  chunks: string[];
  /** Sum of `chunks[*].length`, kept alongside so appendChunk never has to
   *  re-join the array just to check whether it is over the cap. */
  size: number;
  /** UTF-16 code units emitted for this pane since it started (ruling 10).
   *  Never trimmed by retention — `snapshot().end` must stay the true total
   *  even once `chunks` has been cut down to the cap. */
  emitted: number;
  /** True once the process has exited and this entry is being kept for its
   *  retained tail (ruling 12) — `write`/`resize` no-op, and `start` on this
   *  key spawns a new process rather than treating it as already running. */
  exited: boolean;
};

/** Appends `chunk` to `session`, trimming from the front (SessionManager's
 *  #appendLog shape: drop whole chunks off the front, then cut the
 *  remaining front chunk's own start) so the retained tail is always
 *  identical to `(old + chunk).slice(-cap)`.
 *
 *  The front chunk is only ever dropped *whole* when it lies entirely
 *  outside the retained window — i.e. `size` stays at or above `cap` once
 *  it is removed. Dropping it otherwise would undershoot the cap: it is
 *  the boundary chunk, and the tail window cuts through the middle of it,
 *  which the final `slice` below handles. */
function appendChunk(session: Pick<Session, "chunks" | "size">, chunk: string, cap: number): void {
  session.chunks.push(chunk);
  session.size += chunk.length;
  while (session.chunks.length > 1 && session.size - (session.chunks[0]?.length ?? 0) >= cap) {
    session.size -= session.chunks.shift()?.length ?? 0;
  }
  if (session.size > cap) {
    // The tail window cuts through this (now-front) chunk: drop exactly the
    // overshoot from its start, not its whole self — other chunks after it,
    // if any, are already entirely inside the window.
    const excess = session.size - cap;
    const front = session.chunks[0] ?? "";
    session.chunks[0] = front.slice(excess);
    session.size = cap;
  }
}

/** Trims a session's log to its last `cap` characters — mirrors
 *  SessionManager's #compactLog, used once on exit (see EXITED_LOG_CHARS). */
function compactChunks(session: Pick<Session, "chunks" | "size">, cap: number): void {
  const joined = session.chunks.join("");
  if (joined.length <= cap) return;
  const tail = joined.slice(joined.length - cap);
  session.chunks = [tail];
  session.size = tail.length;
}

/**
 * One shell per terminal tab, keyed by tab id rather than by project: two
 * terminals in the same project is an ordinary thing to want, and they are
 * separate shells with separate state.
 *
 * The retained log exists because a shell prints its prompt the instant it
 * starts, which is before the renderer has seen the new tab in a workspace
 * update and built an xterm for it. Without it a fresh Terminal tab looks
 * blank until the first keystroke.
 */
export function createShellManager(deps: ShellManagerDeps): ShellManager {
  const sessions = new Map<string, Session>();
  const outputListeners = new Set<(output: ShellOutput) => void>();
  const exitListeners = new Set<(exit: ShellExit) => void>();
  const maxLogChars = deps.maxLogChars ?? DEFAULT_MAX_LOG_CHARS;

  return {
    start(tabId, cwd, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
      // A live pane stays a no-op; an exited one (ruling 11) spawns a new
      // process but keeps its retained chunks and offset counter — the
      // pane's history did not end just because the process did.
      const existing = sessions.get(tabId);
      if (existing !== undefined && !existing.exited) return;

      const process = deps.spawn({ cwd, cols, rows });
      const session: Session =
        existing === undefined
          ? { process, chunks: [], size: 0, emitted: 0, exited: false }
          : {
              process,
              // Copied, not aliased: a stale onData from the dead process
              // (node-pty never fires one after exit, but nothing enforces
              // that here) must not be able to write into the restarted
              // session's own array.
              chunks: [...existing.chunks],
              size: existing.size,
              emitted: existing.emitted,
              exited: false,
            };
      sessions.set(tabId, session);

      process.onData((chunk) => {
        // `offset` is the count before this chunk, so the log append (and
        // the counter update) must happen before any listener runs — the
        // M1 invariant a listener reading snapshot().end relies on.
        const offset = session.emitted;
        appendChunk(session, chunk, maxLogChars);
        session.emitted += chunk.length;
        // Copied, because a listener may unsubscribe from inside its own call.
        for (const listener of [...outputListeners]) listener({ paneKey: tabId, chunk, offset });
      });

      process.onExit((code) => {
        // Only retain this entry as "exited" if the map still holds this
        // exact session object — a stale exit from a process that was
        // already killed (kill() deleted the entry) or superseded (a
        // restart replaced it with a new session) does nothing but notify.
        if (sessions.get(tabId) === session) {
          session.exited = true;
          compactChunks(session, EXITED_LOG_CHARS);
        }
        for (const listener of [...exitListeners]) listener({ paneKey: tabId, code });
      });
    },

    onOutput(listener) {
      outputListeners.add(listener);
      return () => outputListeners.delete(listener);
    },

    onShellExit(listener) {
      exitListeners.add(listener);
      return () => exitListeners.delete(listener);
    },

    log(tabId) {
      return (sessions.get(tabId)?.chunks ?? []).join("");
    },

    snapshot(tabId) {
      const session = sessions.get(tabId);
      return { text: (session?.chunks ?? []).join(""), end: session?.emitted ?? 0 };
    },

    has(tabId) {
      return sessions.has(tabId);
    },

    panes() {
      return [...sessions.entries()].map(([paneKey, session]) => ({
        paneKey,
        exited: session.exited,
      }));
    },

    write(tabId, data) {
      const session = sessions.get(tabId);
      if (session === undefined || session.exited) return;
      session.process.write(data);
    },

    resize(tabId, cols, rows) {
      const session = sessions.get(tabId);
      if (session === undefined || session.exited) return;
      session.process.resize(cols, rows);
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

/**
 * The user's own login shell, or the platform's default.
 *
 * The fallback is not cosmetic. macOS has shipped zsh since Catalina, but a
 * great many Linux installs have no /bin/zsh at all — and a shell binary that
 * does not exist is not a degraded terminal, it is a pty that fails to spawn
 * and a tab that shows nothing.
 */
export function shellCommand(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  fromPasswd: () => string | undefined = passwdShell,
): string {
  const shell = env["SHELL"];
  if (shell !== undefined && shell !== "") return shell;

  // $SHELL is not always set. A process started by a desktop launcher, a
  // .desktop entry or Finder frequently has no SHELL at all — it is exported
  // by the shell, and no shell was involved in starting it. The user still
  // has a login shell; it is in their passwd entry, which is where this looks
  // before falling back to a platform guess.
  const passwd = fromPasswd();
  if (passwd !== undefined && passwd !== "") return passwd;

  // Windows has no passwd database to consult, so `fromPasswd` has no part
  // in this branch.
  if (platform === "win32") return windowsShell(env);
  return platform === "darwin" ? "/bin/zsh" : "/bin/bash";
}

/**
 * The shell a Terminal tab runs on Windows.
 *
 * `$SHELL` is honoured only when it names a real Windows path. A Jarvis
 * launched from Git Bash inherits `SHELL=/usr/bin/bash`, which is a path
 * inside MSYS's virtual filesystem that ConPTY cannot start — treating it as
 * the answer would mean every Terminal tab dying on open for anyone who
 * develops from that terminal.
 *
 * PowerShell 7 when it is installed, because a user who has it wants it; the
 * Windows PowerShell every machine ships otherwise.
 */
function windowsShell(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
): string {
  const configured = env["SHELL"];
  if (configured !== undefined && /^[A-Za-z]:[\\/]/.test(configured) && exists(configured)) {
    return configured;
  }
  const pwsh = resolveWindowsExecutable("pwsh", env, exists);
  if (pwsh !== undefined) return pwsh;
  const systemRoot = env["SystemRoot"] ?? env["SYSTEMROOT"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** The current user's login shell from the passwd database, or undefined if
 *  it cannot be read. Node reads this without spawning anything. */
export function passwdShell(): string | undefined {
  try {
    const shell = userInfo().shell;
    return shell === null ? undefined : shell;
  } catch {
    return undefined;
  }
}

export type ShellIntegration = {
  /** The Jarvis-owned ZDOTDIR wrapper, when one was installed for zsh. */
  zdotdir?: string | undefined;
  /** The Jarvis-owned rcfile, when one was installed for bash. */
  rcfile?: string | undefined;
  /** The Jarvis-owned script, when one was installed for PowerShell. */
  powerShellScript?: string | undefined;
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
export function shellEnv(env: NodeJS.ProcessEnv, integration: ShellIntegration): NodeJS.ProcessEnv {
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
 * How the shell is asked to start.
 *
 * `-l` is the default, and it is the reason the terminal is the one the user
 * actually has: their profile, their PATH, their aliases, their prompt. A GUI
 * app inherits none of that from the environment it was launched in.
 *
 * bash is the exception, and not by preference. It honours `--rcfile` only
 * for an interactive *non-login* shell — a login bash ignores it entirely and
 * reads the profile files, so the hook would silently never install. So the
 * wrapper takes over the login shell's own reading (see bash-integration.ts)
 * and the shell is started interactive instead.
 */
export function shellArgs(integration: ShellIntegration): string[] {
  // PowerShell takes neither a login flag nor an rcfile: the profile loads on
  // its own, and the integration is dot-sourced after it. See
  // powershell-integration.ts.
  if (integration.powerShellScript !== undefined) {
    return powerShellLaunchArgs(integration.powerShellScript);
  }
  if (integration.rcfile !== undefined) return ["--rcfile", integration.rcfile, "-i"];
  return ["-l"];
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
 * `integration` carries whichever wrapper the completion feature installed —
 * zsh's ZDOTDIR directory or bash's rcfile, see shellEnv and shellArgs. An
 * empty one is the terminal as it was before autocomplete existed.
 *
 * `platform` decides only the fallback shell for a user with no $SHELL; see
 * shellCommand.
 */
export function createRealShellSpawner(
  env: NodeJS.ProcessEnv = process.env,
  integration: ShellIntegration = {},
  platform: NodeJS.Platform = "darwin",
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
    const child = pty.spawn(shellCommand(env, platform), shellArgs(integration), {
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
