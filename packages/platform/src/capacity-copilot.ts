// Copilot's capacity, for free: GitHub's `/copilot_internal/user` endpoint
// (the one the Copilot CLI's own `/usage` screen and the VS Code extension
// read) returns the account's quota snapshots. The meter shows the
// premium-request allowance (`quota_snapshots.premium_interactions`), the
// one figure that actually runs out on a Copilot plan; chat and completions
// are unlimited on every plan and would only ever read 100%.
//
// WHICH account matters: the Copilot agent Jarvis runs is the Copilot CLI's
// signed-in account, and that is routinely a different login from `gh`'s
// (found live: the CLI on a work account at 88% used, gh on a personal one
// at 0%). So the reader asks as the CLI's own account first — its OAuth
// token sits in the macOS keychain under the service `copilot-cli`, read
// with `security find-generic-password -w` and sent straight to the one
// HTTPS call, never logged, never stored — and only falls back to `gh api`
// (the user's own signed-in gh, still their token, still their machine)
// when there is no CLI token to use.
//
// The window is monthly: `quota_reset_date` is a calendar day (`2026-10-01`)
// rather than an instant, and it becomes midnight UTC of that day.

import type { CapacityReading } from "@jarvis/core";
import type { CommandRunner } from "./docker.js";

export const COPILOT_QUOTA_ARGS = ["api", "/copilot_internal/user"] as const;
export const COPILOT_QUOTA_URL = "https://api.github.com/copilot_internal/user";
/** The macOS keychain service the Copilot CLI stores its OAuth token under. */
export const COPILOT_KEYCHAIN_ARGS = ["find-generic-password", "-s", "copilot-cli", "-w"] as const;

function unavailable(): CapacityReading {
  return { ok: false, reason: "unavailable" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

/** `YYYY-MM-DD` → the ISO instant of that day's start, UTC; anything else → undefined. */
function resetDayToIso(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const at = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

/**
 * Parses the endpoint's JSON text. Pure. "Unavailable" — never a guess — for
 * anything but a finite premium-request percentage and a reset date; an
 * unlimited premium allowance (some enterprise plans) has no meter to show
 * and is unavailable too.
 */
export function parseCopilotQuota(text: string): CapacityReading {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return unavailable();
  }
  const user = asRecord(raw);
  const snapshots = asRecord(user?.["quota_snapshots"]);
  const premium = asRecord(snapshots?.["premium_interactions"]);
  if (premium === undefined) return unavailable();
  if (premium["unlimited"] === true) return unavailable();

  const remaining = premium["percent_remaining"];
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) return unavailable();
  if (remaining < 0 || remaining > 100) return unavailable();
  const resetsAt = resetDayToIso(user?.["quota_reset_date"]);
  if (resetsAt === undefined) return unavailable();

  const stamp = premium["timestamp_utc"];
  const readAt = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;

  return {
    ok: true,
    primary: { usedPercent: Math.round(100 - remaining), resetsAt },
    secondary: undefined,
    ...(Number.isNaN(readAt) ? {} : { readAt }),
  };
}

/**
 * The reader ProviderMonitor is handed for a github account. Order:
 *  1. the Copilot CLI's own token (macOS keychain, see the header) — the
 *     account Jarvis's copilot agent actually consumes;
 *  2. `gh api` through the caller's runner (which carries the login-shell
 *     PATH, so `gh` is found where the user installed it).
 * A missing token, a missing or signed-out `gh`, a failed request: all
 * "unavailable", never a rejection. `platform` is a parameter (the
 * platform-convention rule); the keychain path only exists on darwin.
 */
export function createCopilotCapacityReader(deps: {
  run: CommandRunner;
  platform?: string;
  /** Injected for tests; defaults to a real fetch of COPILOT_QUOTA_URL. */
  fetchQuota?: (token: string) => Promise<string>;
}): () => Promise<CapacityReading> {
  const fetchQuota = deps.fetchQuota ?? defaultFetchQuota;
  return async (): Promise<CapacityReading> => {
    if (deps.platform === "darwin") {
      try {
        const keychain = await deps.run("security", [...COPILOT_KEYCHAIN_ARGS]);
        const token = keychain.stdout.trim();
        if (keychain.code === 0 && token !== "") {
          const reading = parseCopilotQuota(await fetchQuota(token));
          if (reading.ok) return reading;
        }
      } catch {
        // Fall through to gh.
      }
    }
    try {
      const result = await deps.run("gh", [...COPILOT_QUOTA_ARGS]);
      if (result.code !== 0) return unavailable();
      return parseCopilotQuota(result.stdout);
    } catch {
      return unavailable();
    }
  };
}

async function defaultFetchQuota(token: string): Promise<string> {
  const response = await fetch(COPILOT_QUOTA_URL, {
    headers: {
      // The CLI's own scheme for this endpoint.
      authorization: `token ${token}`,
      accept: "application/json",
      "user-agent": "jarvis-desktop",
    },
  });
  if (!response.ok) throw new Error(`copilot quota: HTTP ${response.status}`);
  return response.text();
}
