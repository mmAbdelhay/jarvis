import type { CapacityReading, RateWindow } from "@jarvis/core";

/**
 * The shape of the Agent SDK's experimental usage reading, parsed into a
 * CapacityReading. Only the brain calls this now, on a query it has already
 * paid for (ProviderMonitor.recordPiggyback): the standalone reader that
 * used to live here spent one billed one-word query per account per
 * refresh, and the panel's own readings come from capacity-snapshot.ts,
 * which costs nothing. A throw or a changed shape must degrade to
 * "unavailable" — never to a guess.
 */

function freshUnavailable(): CapacityReading {
  // A fresh object literal on every call rather than a shared singleton: a
  // shared UNAVAILABLE constant returned to every caller means one
  // downstream mutation of a reading could poison every future reading.
  return { ok: false, reason: "unavailable" };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function parseWindow(value: unknown): RateWindow | undefined {
  const window = asRecord(value);
  if (window === undefined) return undefined;

  const utilization = window["utilization"];
  const resetsAt = window["resets_at"];
  // Both fields are typed `| null` by the SDK and both are optional in
  // practice; a partial window is no window at all.
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined;
  if (typeof resetsAt !== "string" || Number.isNaN(Date.parse(resetsAt))) return undefined;

  // Out of [0, 100] means the shape has changed underneath us — a fraction
  // (0.42), a raw token count (4200), something else. Clamping would turn
  // that shape change into a confident, wrong percentage; abstaining is the
  // only honest response, same as every other unrecognised shape in this
  // module.
  if (utilization < 0 || utilization > 100) return undefined;

  return {
    usedPercent: Math.round(utilization),
    resetsAt,
  };
}

/**
 * The choke point. The raw response — session cost, per-model usage,
 * behaviour flags, internal codenames — dies here; only the two windows
 * continue. Nothing downstream, in a log, an error message or an IPC
 * payload, ever sees the rest.
 *
 * CORRECTION 1 from the controller's verification, pinned by test: the
 * fields live under `rate_limits`, NOT at the top level. Reading
 * `usage.five_hour` returns undefined and would ship a permanently blank
 * panel.
 */
export function parseUsage(raw: unknown): CapacityReading {
  const usage = asRecord(raw);
  if (usage === undefined) return freshUnavailable();

  // False for API-key / Bedrock / Vertex auth, where plan limits do not
  // apply at all and `rate_limits` is null.
  if (usage["rate_limits_available"] === false) return freshUnavailable();

  const limits = asRecord(usage["rate_limits"]);
  if (limits === undefined) return freshUnavailable();

  const primary = parseWindow(limits["five_hour"]);
  if (primary === undefined) return freshUnavailable();

  return { ok: true, primary, secondary: parseWindow(limits["seven_day"]) };
}
