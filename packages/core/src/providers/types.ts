import type { ProviderVendor } from "../registry/types.js";

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
  | { ok: true; fiveHour: RateWindow; sevenDay: RateWindow | undefined }
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
  | { state: "known"; fiveHour: RateWindow; sevenDay: RateWindow | undefined; readAt: number }
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

export function remainingPercent(window: RateWindow): number {
  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}
