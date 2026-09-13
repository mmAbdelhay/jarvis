import { spawn } from "node:child_process";
import type { AgentConfig, ProcessHandle, Spawner } from "@jarvis/core";
import { spawnTarget } from "./executable.js";

/**
 * `platform` exists only for Windows, where a command name is not enough to
 * start anything: an npm-installed tool is a `.cmd` shim that CreateProcess
 * will not find and Node will not run. Optional, and absent means "spawn the
 * name as given", which is every POSIX caller and what this did before
 * Windows — see executable.ts.
 */
export function runCommand(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform?: NodeJS.Platform,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const target =
      platform === undefined
        ? { file: command, args: [...args] }
        : spawnTarget(command, args, env, platform);
    const child = spawn(target.file, target.args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      ...("windowsVerbatimArguments" in target ? { windowsVerbatimArguments: true } : {}),
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: exitCodeFor(code, signal), stdout, stderr });
    });
  });
}

export function createSpawner(
  env: NodeJS.ProcessEnv = process.env,
  platform?: NodeJS.Platform,
): Spawner {
  return (agent: AgentConfig, projectPath: string): ProcessHandle => {
    const target =
      platform === undefined
        ? { file: agent.command, args: [...(agent.args ?? [])] }
        : spawnTarget(agent.command, agent.args ?? [], env, platform);
    const child = spawn(target.file, target.args, {
      cwd: projectPath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      ...("windowsVerbatimArguments" in target ? { windowsVerbatimArguments: true } : {}),
    });

    const outputListeners: ((chunk: string) => void)[] = [];
    const exitListeners: ((code: number) => void)[] = [];

    // Latches so a failed spawn (which fires both "error" and a
    // trailing "close") notifies exit listeners exactly once, and so a
    // listener registered after the process has already exited still
    // gets replayed the terminal code instead of waiting forever.
    let exited = false;
    let exitCode: number | undefined;

    const dispatchExit = (code: number) => {
      if (exited) return;
      exited = true;
      exitCode = code;
      for (const listener of exitListeners) listener(code);
    };

    // Each stream is buffered independently so a chunk boundary on one
    // pipe can never splice into a partial line still pending on the
    // other. Only complete lines (newline-terminated) are forwarded;
    // any trailing partial line is flushed when its stream closes.
    const stdoutBuffer = { text: "" };
    const stderrBuffer = { text: "" };

    const makeLineForwarder = (buffer: { text: string }) => (data: Buffer) => {
      const combined = buffer.text + data.toString();
      const lines = combined.split("\n");
      buffer.text = lines.pop() ?? "";
      for (const line of lines) {
        for (const listener of outputListeners) listener(`${line}\n`);
      }
    };

    const flushBuffer = (buffer: { text: string }) => {
      if (buffer.text.length === 0) return;
      const remainder = buffer.text;
      buffer.text = "";
      for (const listener of outputListeners) listener(remainder);
    };

    child.stdout.on("data", makeLineForwarder(stdoutBuffer));
    child.stderr.on("data", makeLineForwarder(stderrBuffer));
    child.on("close", (code, signal) => {
      flushBuffer(stdoutBuffer);
      flushBuffer(stderrBuffer);
      dispatchExit(exitCodeFor(code, signal));
    });
    child.on("error", (error) => {
      for (const listener of outputListeners) listener(`${error.message}\n`);
      dispatchExit(1);
    });

    // Writing to a child that has already exited emits an "error" on
    // stdin; without a listener Node throws it as an uncaught
    // exception. Swallow it here so a late write can't crash the host.
    child.stdin.on("error", () => {});

    return {
      write: (data: string) => {
        child.stdin.write(data);
      },
      kill: () => {
        child.kill();
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

/**
 * Maps a child_process "close" event's (code, signal) pair to a single exit
 * code. When a process exits normally, `code` is a number and `signal` is
 * null. When a process is killed by a signal (e.g. `handle.kill()` sending
 * SIGTERM), `code` is null and `signal` carries the signal name — collapsing
 * that to 0 would misreport a killed process as having succeeded.
 */
function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal !== null) return 128 + signalNumber(signal);
  return 1;
}

/**
 * Unmapped-signal fallback for {@link signalNumber}. POSIX signal numbers
 * start at 1, so 128 + 0 = 128 can never collide with a real `128 + n`
 * mapped signal code (e.g. SIGHUP = 128 + 1 = 129, SIGTERM = 128 + 15 =
 * 143) while still landing outside the normal 0-127 exit-code range.
 */
const UNMAPPED_SIGNAL_NUMBER = 0;

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

function signalNumber(signal: NodeJS.Signals): number {
  return SIGNAL_NUMBERS[signal] ?? UNMAPPED_SIGNAL_NUMBER;
}
