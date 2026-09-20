// Codex's capacity, for free: the Codex CLI writes its own rate limits into
// every session log it keeps under `~/.codex/sessions/YYYY/MM/DD/
// rollout-<timestamp>-<id>.jsonl`, as `token_count` events carrying
// `"rate_limits": { primary: { used_percent, window_minutes, resets_at },
// secondary: {...} }` — the same figures its `/status` screen shows. The
// newest such line across the newest logs is the account's latest reading.
// Nothing here talks to OpenAI, so nothing here costs anything.
//
// Only the newest few logs are opened (a session that never reached the
// model has no `rate_limits` line) and each is scanned from its end, so a
// long-running session's multi-megabyte log costs one read, not a parse of
// every line.

import { readdir, readFile as fsReadFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CapacityReading, RateWindow } from "@jarvis/core";

/** How many of the newest session logs to look in before giving up. */
export const CODEX_LOGS_TO_SCAN = 6;

export function codexSessionsDir(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const codexHome = env["CODEX_HOME"];
  return join(
    codexHome !== undefined && codexHome !== "" ? codexHome : join(home, ".codex"),
    "sessions",
  );
}

function unavailable(): CapacityReading {
  return { ok: false, reason: "unavailable" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function parseWindow(value: unknown): RateWindow | undefined {
  const window = asRecord(value);
  if (window === undefined) return undefined;
  const used = window["used_percent"];
  const resetsAt = window["resets_at"];
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100)
    return undefined;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  return { usedPercent: Math.round(used), resetsAt: new Date(resetsAt * 1000).toISOString() };
}

/**
 * The newest `rate_limits` in one log's text, or undefined when the log has
 * none. Pure. Lines are scanned from the end; a line that mentions
 * `rate_limits` but fails to parse is skipped, not fatal.
 */
export function parseCodexRateLimits(text: string): CapacityReading | undefined {
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (!line.includes('"rate_limits"')) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const limits = findRateLimits(event, 0);
    if (limits === undefined) continue;
    const primary = parseWindow(limits["primary"]);
    if (primary === undefined) continue;
    const secondary = parseWindow(limits["secondary"]);
    const readAt = lineTimestamp(event);
    return { ok: true, primary, secondary, ...(readAt === undefined ? {} : { readAt }) };
  }
  return undefined;
}

// The event's shape has moved between Codex releases (`payload.rate_limits`,
// `payload.info.rate_limits`); a bounded walk finds it wherever it sits.
function findRateLimits(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  const direct = asRecord(record["rate_limits"]);
  if (direct !== undefined) return direct;
  for (const nested of Object.values(record)) {
    const found = findRateLimits(nested, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function lineTimestamp(event: unknown): number | undefined {
  const record = asRecord(event);
  const raw = record?.["timestamp"];
  if (typeof raw !== "string") return undefined;
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : at;
}

/** Newest first: the directory layout is `YYYY/MM/DD/rollout-<ISO timestamp>-…`, so lexical order is time order. */
async function newestLogs(sessionsDir: string, limit: number): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length >= limit) return;
    let entries: string[];
    try {
      entries = (await readdir(dir)).sort().reverse();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const path = join(dir, entry);
      if (depth < 3) {
        await walk(path, depth + 1);
      } else if (entry.startsWith("rollout-") && entry.endsWith(".jsonl")) {
        found.push(path);
      }
    }
  }
  await walk(sessionsDir, 0);
  return found;
}

/**
 * The reader ProviderMonitor is handed for an openai account: the newest
 * reading in the newest logs, or "unavailable" when Codex has not written
 * one yet (never a rejection).
 */
export function createCodexCapacityReader(
  deps: {
    sessionsDir?: string;
    listLogs?: (sessionsDir: string, limit: number) => Promise<string[]>;
    readFile?: (path: string) => Promise<string>;
  } = {},
): () => Promise<CapacityReading> {
  const sessionsDir = deps.sessionsDir ?? codexSessionsDir(process.env);
  const listLogs = deps.listLogs ?? newestLogs;
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  return async (): Promise<CapacityReading> => {
    try {
      for (const path of await listLogs(sessionsDir, CODEX_LOGS_TO_SCAN)) {
        const reading = parseCodexRateLimits(await readFile(path));
        if (reading !== undefined) return reading;
      }
    } catch {
      // A vanished log, an unreadable one: fall through to "unavailable".
    }
    return unavailable();
  };
}
