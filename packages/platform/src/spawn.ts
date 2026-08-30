import { spawn } from "node:child_process";
import type { AgentConfig, ProcessHandle, Spawner } from "@jarvis/core";

export function runCommand(
  command: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: exitCodeFor(code, signal), stdout, stderr });
    });
  });
}

export function createSpawner(env: NodeJS.ProcessEnv = process.env): Spawner {
  return (agent: AgentConfig, projectPath: string): ProcessHandle => {
    const child = spawn(agent.command, agent.args ?? [], {
      cwd: projectPath,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const outputListeners: ((chunk: string) => void)[] = [];
    const exitListeners: ((code: number) => void)[] = [];

    const forward = (data: Buffer) => {
      const text = data.toString();
      for (const listener of outputListeners) listener(text);
    };

    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    child.on("close", (code, signal) => {
      const exitCode = exitCodeFor(code, signal);
      for (const listener of exitListeners) listener(exitCode);
    });
    child.on("error", (error) => {
      for (const listener of outputListeners) listener(`${error.message}\n`);
      for (const listener of exitListeners) listener(1);
    });

    return {
      write: (data: string) => { child.stdin.write(data); },
      kill: () => { child.kill(); },
      onOutput: (listener) => { outputListeners.push(listener); },
      onExit: (listener) => { exitListeners.push(listener); },
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
  return SIGNAL_NUMBERS[signal] ?? 1;
}
