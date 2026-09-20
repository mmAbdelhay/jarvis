import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
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
    // One decoder per stream, kept across every "data" event: `Buffer#
    // toString()` per chunk decodes each chunk in isolation, so a
    // multi-byte UTF-8 character split across two reads (a real,
    // pipe-buffering-dependent occurrence, not a hypothetical one) turns
    // into two U+FFFD replacement characters instead of the one character
    // it actually was. `StringDecoder` holds a split sequence's leading
    // bytes back until the rest arrives.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    child.stdout.on("data", (data: Buffer) => {
      stdout += stdoutDecoder.write(data);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += stderrDecoder.write(data);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      resolve({ code: exitCodeFor(code, signal), stdout, stderr });
    });
  });
}

export type LimitedRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};

/**
 * Like {@link runCommand} — no shell, `stdio: ["ignore", "pipe", "pipe"]`,
 * no `platform` resolution — but for spawning a decoder on
 * attacker-influenced input (ruling 4): a hung process is killed after
 * `timeoutMs`, and each stream is capped at `maxOutputBytes` so a chatty or
 * hostile child can't grow an in-memory buffer without bound.
 */
export function runCommandWithLimits(
  command: string,
  args: string[],
  limits: { timeoutMs: number; maxOutputBytes: number },
  env: NodeJS.ProcessEnv = process.env,
): Promise<LimitedRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let stdout = "";
    let stderr = "";
    // Running UTF-8 byte totals, maintained incrementally alongside stdout/
    // stderr rather than recomputed from the full string on every chunk —
    // Buffer.byteLength(current, "utf8") on the whole accumulated string
    // would be O(n) per chunk, O(n²) over a long stream.
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let settled = false;

    // Same StringDecoder discipline as runCommand above — one persistent
    // decoder per stream, so a multi-byte UTF-8 character split across two
    // "data" events decodes correctly instead of each half's own
    // `Buffer#toString()` turning into its own U+FFFD.
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    // maxOutputBytes is a byte cap, not a code-unit cap: comparing
    // `current.length` against it (as this once did) lets a stream of
    // multi-byte UTF-8 characters retain up to 4x the cap, since a single
    // UTF-16 code unit can encode a character that is up to 4 bytes on the
    // wire. Truncation cuts on a code-point boundary — iterating `text` with
    // `for...of` walks whole code points (surrogate pairs included), so the
    // cut never splits one across the boundary the way a raw index slice
    // could. `text` is already decoded (the caller runs it through this
    // stream's own StringDecoder first) rather than a raw chunk, so this
    // never has to decide the encoding for itself.
    const appendCapped = (
      current: string,
      currentBytes: number,
      text: string,
      truncated: boolean,
    ): [string, number, boolean] => {
      if (truncated || currentBytes >= limits.maxOutputBytes) {
        return [current, currentBytes, true];
      }
      if (text.length === 0) return [current, currentBytes, truncated];
      const textBytes = Buffer.byteLength(text, "utf8");
      if (currentBytes + textBytes <= limits.maxOutputBytes) {
        return [current + text, currentBytes + textBytes, false];
      }
      const remaining = limits.maxOutputBytes - currentBytes;
      let kept = "";
      let keptBytes = 0;
      for (const codePoint of text) {
        const codePointBytes = Buffer.byteLength(codePoint, "utf8");
        if (keptBytes + codePointBytes > remaining) break;
        kept += codePoint;
        keptBytes += codePointBytes;
      }
      return [current + kept, currentBytes + keptBytes, true];
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limits.timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      [stdout, stdoutBytes, stdoutTruncated] = appendCapped(
        stdout,
        stdoutBytes,
        stdoutDecoder.write(data),
        stdoutTruncated,
      );
    });
    child.stderr.on("data", (data: Buffer) => {
      [stderr, stderrBytes, stderrTruncated] = appendCapped(
        stderr,
        stderrBytes,
        stderrDecoder.write(data),
        stderrTruncated,
      );
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Flushes each decoder's own trailing bytes — a genuinely incomplete
      // sequence at end-of-stream (the process closed mid-character, not
      // split across two events this stream already reassembled above)
      // still goes through the same cap.
      [stdout, stdoutBytes, stdoutTruncated] = appendCapped(
        stdout,
        stdoutBytes,
        stdoutDecoder.end(),
        stdoutTruncated,
      );
      [stderr, stderrBytes, stderrTruncated] = appendCapped(
        stderr,
        stderrBytes,
        stderrDecoder.end(),
        stderrTruncated,
      );
      resolve({
        code: exitCodeFor(code, signal),
        stdout,
        stderr,
        timedOut,
        truncated: stdoutTruncated || stderrTruncated,
      });
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

    // One StringDecoder per stream (closed over by its own forwarder
    // below), so a multi-byte UTF-8 character split across two "data"
    // events decodes correctly instead of each half's own
    // `Buffer#toString()` turning into its own U+FFFD — same discipline as
    // runCommand/runCommandWithLimits above.
    const makeLineForwarder = (buffer: { text: string }) => {
      const decoder = new StringDecoder("utf8");
      const forward = (data: Buffer) => {
        const combined = buffer.text + decoder.write(data);
        const lines = combined.split("\n");
        buffer.text = lines.pop() ?? "";
        for (const line of lines) {
          for (const listener of outputListeners) listener(`${line}\n`);
        }
      };
      const end = () => {
        buffer.text += decoder.end();
      };
      return { forward, end };
    };

    const flushBuffer = (buffer: { text: string }) => {
      if (buffer.text.length === 0) return;
      const remainder = buffer.text;
      buffer.text = "";
      for (const listener of outputListeners) listener(remainder);
    };

    const stdoutForwarder = makeLineForwarder(stdoutBuffer);
    const stderrForwarder = makeLineForwarder(stderrBuffer);
    child.stdout.on("data", stdoutForwarder.forward);
    child.stderr.on("data", stderrForwarder.forward);
    child.on("close", (code, signal) => {
      stdoutForwarder.end();
      stderrForwarder.end();
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
