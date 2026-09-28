// jarvisd's log: ~/.config/jarvis/logs/jarvisd.log, 0600 in a 0700 dir.
//
// Once a line would take the file past MAX_LOG_BYTES it is rotated to
// jarvisd.log.1 (replacing the previous .1) — the same one-rotation rule as
// the bridge's audit.log (packages/remote/src/audit.ts): recent history and
// one prior file, not a logrotate reimplementation.
//
// Writes are synchronous. A daemon's last lines are the ones written just
// before it exits or crashes, and an async queue would lose exactly those.
//
// No secrets. The core already logs no secret and no user content
// (conventions.md); as a backstop every line passes `scrubSecrets`, which
// masks what a token or key looks like — a long hex or base64url run, a
// bearer value, a password=… pair — before it reaches the disk.
//
// No electron here (core/no-electron.test.ts).
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;

export type LogFs = {
  mkdir(path: string): void;
  append(path: string, text: string): void;
  size(path: string): number | undefined;
  rename(from: string, to: string): void;
};

export const nodeLogFs: LogFs = {
  mkdir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  },
  append(path, text) {
    appendFileSync(path, text, { mode: 0o600 });
    chmodSync(path, 0o600);
  },
  size(path) {
    try {
      return statSync(path).size;
    } catch {
      return undefined;
    }
  },
  rename(from, to) {
    renameSync(from, to);
  },
};

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(bearer)\s+\S+/gi, "$1 [redacted]"],
  [/\b(password|passwd|secret|token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1$2[redacted]"],
  // A control secret, a session token, a refresh token: 32+ hex digits.
  [/\b[0-9a-f]{32,}\b/gi, "[redacted]"],
  // A base64url key or token: 40+ characters from that alphabet with at
  // least one digit (so a long plain word is left alone).
  [/\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g, "[redacted]"],
];

export function scrubSecrets(line: string): string {
  let out = line;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export type DaemonLog = {
  write(level: "info" | "error", message: string): void;
};

export function createDaemonLog(deps: {
  path: string;
  now(): number;
  fs?: LogFs;
  maxBytes?: number;
  /** Where a line goes when the file can't be written. */
  fallback?(line: string): void;
}): DaemonLog {
  const fs = deps.fs ?? nodeLogFs;
  const maxBytes = deps.maxBytes ?? MAX_LOG_BYTES;
  let size: number | undefined;
  let dirMade = false;
  return {
    write(level, message) {
      const line = `${new Date(deps.now()).toISOString()} ${level} ${scrubSecrets(message).replace(/\r?\n/g, "\\n")}\n`;
      const bytes = Buffer.byteLength(line, "utf8");
      try {
        if (!dirMade) {
          fs.mkdir(dirname(deps.path));
          dirMade = true;
        }
        size ??= fs.size(deps.path) ?? 0;
        if (size > 0 && size + bytes > maxBytes) {
          fs.rename(deps.path, `${deps.path}.1`);
          size = 0;
        }
        fs.append(deps.path, line);
        size += bytes;
      } catch {
        size = undefined;
        deps.fallback?.(line);
      }
    },
  };
}

/** Sends console.log/info/warn/error — which is where the core logs — to
 *  `log`. Returns the restore. */
export function redirectConsole(log: DaemonLog): () => void {
  const saved = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...args: unknown[]) => log.write("info", format(...args));
  console.info = console.log;
  console.warn = (...args: unknown[]) => log.write("error", format(...args));
  console.error = console.warn;
  return () => Object.assign(console, saved);
}
