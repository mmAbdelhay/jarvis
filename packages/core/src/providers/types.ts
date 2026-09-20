import type { ProviderVendor } from "../registry/types.js";

/**
 * Which accounts have a capacity source at all. All of them are free:
 *  - anthropic: the status-line snapshot in the account's config dir, so a
 *    Claude account needs a `configDir` to be read;
 *  - openai: Codex writes its own rate limits into every session log;
 *  - github: Copilot's quota endpoint, through the already-signed-in `gh`.
 * Anything else (no vendor) has nothing to read.
 */
export function capacitySupported(agent: { vendor?: ProviderVendor; configDir?: string }): boolean {
  if (agent.vendor === "anthropic") return agent.configDir !== undefined;
  return agent.vendor === "github" || agent.vendor === "openai";
}

/** What a capacity reader is handed: enough to pick the source. */
export type CapacityTarget = { id: string; vendor: ProviderVendor; configDir: string | undefined };

/** One rate-limit window as the provider reports it. */
export type RateWindow = {
  /** 0-100, as the provider reports utilization. Remaining is `100 - usedPercent`. */
  usedPercent: number;
  /** Absolute ISO-8601 instant the window resets. Absolute on purpose: it is
   *  what keeps a cached reading honest hours after it was taken. */
  resetsAt: string;
};

/**
 * The result of one capacity read. Deliberately narrow: the provider's real
 * response also carries per-model spend, behaviour flags and internal
 * codenames — the user's private telemetry — and this type is the choke
 * point where all of that is dropped and never travels further.
 */
export type CapacityReading =
  | {
      ok: true;
      /** The window the meter shows: Claude's and Codex's five-hour window, Copilot's monthly premium-request allowance. */
      primary: RateWindow;
      /** The longer window when the provider has one (Claude's and Codex's seven-day). */
      secondary: RateWindow | undefined;
      /** Epoch ms the figures were actually taken, when the source knows (a
       *  status-line snapshot carries its own write time). Absent means "just
       *  now" — the store then stamps its own clock. */
      readAt?: number;
    }
  | { ok: false; reason: "unavailable" };

/**
 * What the panel shows. The three unknown reasons are three different facts
 * and are never collapsed:
 *  - `unsupported`  the provider has no standalone quota query at all
 *                   (GitHub Copilot), so no amount of asking would help.
 *  - `unavailable`  we asked and could not get an answer — the experimental
 *                   API threw, timed out, changed shape, or the account is
 *                   API-key/Bedrock/Vertex auth where plan limits don't apply.
 *  - `never-read`   readable in principle, but no query has been spent on it
 *                   yet. Every capacity read costs a real, billed round trip.
 */
export type ProviderCapacity =
  | { state: "known"; primary: RateWindow; secondary: RateWindow | undefined; readAt: number }
  | { state: "unknown"; reason: "unsupported" | "unavailable" | "never-read" };

export type HealthState = "ok" | "degraded" | "outage" | "unknown";

export type HealthReading = {
  state: HealthState;
  /** The provider's own words ("All Systems Operational"), or "" when unknown. */
  detail: string;
};

export type ProviderHealth = HealthReading & { readAt: number | undefined };

export type ProviderStatus = {
  /** The agent id from the registry — the name the user calls this account. */
  id: string;
  vendor: ProviderVendor | undefined;
  capacity: ProviderCapacity;
  health: ProviderHealth;
};

// Ruling S11: floors rather than rounds. This is REMAINING capacity, so
// flooring never tells the user they have more left than they actually do
// — usedPercent 99.6 floors to "0%" ("none left" when a sliver remains),
// which is the safe direction to be wrong in. Clamped to 0-100 first so a
// provider-reported usedPercent outside 0-100 can't produce a negative or
// over-100 remaining value.
export function remainingPercent(window: RateWindow): number {
  return Math.floor(Math.max(0, Math.min(100, 100 - window.usedPercent)));
}
