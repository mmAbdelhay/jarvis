import { describe, expect, it } from "vitest";
import { parseUsage } from "./capacity.js";

const LIVE_SHAPE = {
  // The real response also carries session cost, per-model usage, behaviours
  // and internal codenames — the user's private telemetry. Included here
  // exactly so the test can prove none of it survives parseUsage.
  session: { total_cost_usd: 0.0077, model_usage: { "some-codename": { input: 1 } } },
  subscription_type: "max",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 9, resets_at: "2026-08-31T14:30:00.405466+00:00" },
    seven_day: { utilization: 33, resets_at: "2026-09-02T11:00:00.405492+00:00" },
  },
};

describe("parseUsage", () => {
  it("reads the two windows from rate_limits, not from the top level", () => {
    expect(parseUsage(LIVE_SHAPE)).toEqual({
      ok: true,
      primary: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00.405466+00:00" },
      secondary: { usedPercent: 33, resetsAt: "2026-09-02T11:00:00.405492+00:00" },
    });
  });

  it("carries none of the telemetry block through", () => {
    const reading = parseUsage(LIVE_SHAPE);
    expect(JSON.stringify(reading)).not.toContain("total_cost_usd");
    expect(JSON.stringify(reading)).not.toContain("codename");
    expect(Object.keys(reading)).toEqual(["ok", "primary", "secondary"]);
  });

  it("reads the five-hour window even when the seven-day one is absent", () => {
    const reading = parseUsage({
      ...LIVE_SHAPE,
      rate_limits: { five_hour: LIVE_SHAPE.rate_limits.five_hour },
    });
    expect(reading.ok && reading.secondary).toBeUndefined();
    expect(reading.ok).toBe(true);
  });

  it("is unavailable when the account has no plan limits (API key, Bedrock, Vertex)", () => {
    expect(parseUsage({ rate_limits_available: false, rate_limits: null })).toEqual({
      ok: false,
      reason: "unavailable",
    });
  });

  it("is unavailable — never a guess — when the experimental shape changes", () => {
    const changed = [
      undefined,
      null,
      {},
      { rate_limits_available: true, rate_limits: {} },
      // The exact mistake the spike's own report would have caused:
      {
        rate_limits_available: true,
        five_hour: { utilization: 9, resets_at: "2026-08-31T14:30:00Z" },
      },
      {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: "9", resets_at: "x" } },
      },
      {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: 9, resets_at: "not a date" } },
      },
      {
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: null, resets_at: null } },
      },
      // Payload is a string, not an object.
      "not an object",
      // Payload is an array, not a record.
      [{ rate_limits_available: true }],
    ];
    for (const raw of changed) {
      expect(parseUsage(raw)).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("rejects a non-finite utilization (NaN, Infinity)", () => {
    expect(
      parseUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: NaN, resets_at: "2026-08-31T14:30:00Z" } },
      }),
    ).toEqual({ ok: false, reason: "unavailable" });

    expect(
      parseUsage({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: Infinity, resets_at: "2026-08-31T14:30:00Z" } },
      }),
    ).toEqual({ ok: false, reason: "unavailable" });
  });

  it("still reports ok:true with secondary absent when seven_day is malformed but five_hour is good", () => {
    const reading = parseUsage({
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 9, resets_at: "2026-08-31T14:30:00Z" },
        seven_day: { utilization: "not a number", resets_at: "2026-09-02T11:00:00Z" },
      },
    });
    expect(reading.ok).toBe(true);
    expect(reading.ok && reading.secondary).toBeUndefined();
  });

  it("rejects a utilization outside 0-100 rather than clamping it", () => {
    const tooHigh = parseUsage({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 140, resets_at: "2026-08-31T14:30:00Z" } },
    });
    expect(tooHigh).toEqual({ ok: false, reason: "unavailable" });

    const negative = parseUsage({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: -1, resets_at: "2026-08-31T14:30:00Z" } },
    });
    expect(negative).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns an independent reading each time (no shared mutable singleton)", () => {
    const a = parseUsage(undefined);
    const b = parseUsage(undefined);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    // Mutating one must never poison a later reading.
    (a as { reason: string }).reason = "poisoned";
    expect(parseUsage(undefined)).toEqual({ ok: false, reason: "unavailable" });
  });
});
