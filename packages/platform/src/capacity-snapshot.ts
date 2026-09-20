// The free capacity reading: Claude Code hands its status line the account's
// real rate-limit figures (`rate_limits.five_hour` / `seven_day`, as
// `used_percentage` + `resets_at`) on every render, and a status-line hook
// can write them to `<config dir>/usage/rate-limits.json` — see
// `scripts/claude-usage-snapshot.sh` and SETUP.md §5. Reading that file
// costs nothing, which is the whole point: the previous reader spent one
// billed one-word query per account per refresh just to see the same two
// numbers (the user's words: "the API will charge me"). No Jarvis code
// polls the model for capacity any more.
//
// The snapshot is only as fresh as the last Claude Code render in that
// account, so the reading carries its own `readAt` (the file's
// `updated_at`) and the panel shows "as of HH:MM" honestly rather than
// pretending the number is live.

import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import type { CapacityReading, RateWindow } from "@jarvis/core";

/** Where the status-line hook writes the account's snapshot. */
export function rateLimitSnapshotPath(configDir: string): string {
  return join(configDir, "usage", "rate-limits.json");
}

function unavailable(): CapacityReading {
  return { ok: false, reason: "unavailable" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

/** Epoch seconds (what `date +%s` writes) → ISO instant; anything else → undefined. */
function epochSecondsToIso(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return new Date(value * 1000).toISOString();
}

function parseWindow(pct: unknown, resetsAt: unknown): RateWindow | undefined {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return undefined;
  // Out of [0, 100] means the writer changed shape (a fraction, a token
  // count); abstain rather than clamp a wrong number into a confident one.
  if (pct < 0 || pct > 100) return undefined;
  const iso = epochSecondsToIso(resetsAt);
  if (iso === undefined) return undefined;
  return { usedPercent: Math.round(pct), resetsAt: iso };
}

/**
 * Parses one snapshot file's text. Pure. A missing or malformed five-hour
 * window is "unavailable" (never a guess); a malformed seven-day window is
 * simply absent, the five-hour figure still stands.
 */
export function parseRateLimitSnapshot(text: string): CapacityReading {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unavailable();
  }
  const snapshot = asRecord(raw);
  if (snapshot === undefined) return unavailable();

  const primary = parseWindow(snapshot["five_hour_pct"], snapshot["five_hour_resets_at"]);
  if (primary === undefined) return unavailable();
  const secondary = parseWindow(snapshot["seven_day_pct"], snapshot["seven_day_resets_at"]);

  const updatedAt = snapshot["updated_at"];
  const readAt =
    typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0
      ? Math.round(updatedAt * 1000)
      : undefined;

  return { ok: true, primary, secondary, ...(readAt === undefined ? {} : { readAt }) };
}

/**
 * The reader ProviderMonitor is handed: one file read per account, no
 * network, no subprocess, no cost. A missing file (the hook has not run in
 * that account yet) is "unavailable", never a rejection.
 */
export function createSnapshotCapacityReader(
  deps: { readFile?: (path: string) => Promise<string> } = {},
): (configDir: string) => Promise<CapacityReading> {
  const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, "utf8"));
  return async (configDir: string): Promise<CapacityReading> => {
    try {
      return parseRateLimitSnapshot(await readFile(rateLimitSnapshotPath(configDir)));
    } catch {
      return unavailable();
    }
  };
}
