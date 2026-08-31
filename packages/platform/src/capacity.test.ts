import { describe, expect, it, vi } from "vitest";
import type { UsageQuery } from "./capacity.js";
import { createCapacityReader, parseUsage } from "./capacity.js";

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
      fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00.405466+00:00" },
      sevenDay: { usedPercent: 33, resetsAt: "2026-09-02T11:00:00.405492+00:00" },
    });
  });

  it("carries none of the telemetry block through", () => {
    const reading = parseUsage(LIVE_SHAPE);
    expect(JSON.stringify(reading)).not.toContain("total_cost_usd");
    expect(JSON.stringify(reading)).not.toContain("codename");
    expect(Object.keys(reading)).toEqual(["ok", "fiveHour", "sevenDay"]);
  });

  it("reads the five-hour window even when the seven-day one is absent", () => {
    const reading = parseUsage({ ...LIVE_SHAPE, rate_limits: { five_hour: LIVE_SHAPE.rate_limits.five_hour } });
    expect(reading.ok && reading.sevenDay).toBeUndefined();
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
      { rate_limits_available: true, five_hour: { utilization: 9, resets_at: "2026-08-31T14:30:00Z" } },
      { rate_limits_available: true, rate_limits: { five_hour: { utilization: "9", resets_at: "x" } } },
      { rate_limits_available: true, rate_limits: { five_hour: { utilization: 9, resets_at: "not a date" } } },
      { rate_limits_available: true, rate_limits: { five_hour: { utilization: null, resets_at: null } } },
    ];
    for (const raw of changed) {
      expect(parseUsage(raw)).toEqual({ ok: false, reason: "unavailable" });
    }
  });

  it("clamps a utilization outside 0-100 rather than propagating it", () => {
    const reading = parseUsage({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 140, resets_at: "2026-08-31T14:30:00Z" } },
    });
    expect(reading.ok && reading.fiveHour.usedPercent).toBe(100);
  });
});

// A stand-in for the SDK's Query: an async iterable that also exposes the
// experimental usage method, with the real one's timing rules enforced.
function fakeQuery(options: {
  usage: unknown;
  throwBefore?: boolean;
  messages?: string[];
}): UsageQuery & { calledAt: string[]; drained: boolean } {
  const messages = options.messages ?? ["system", "assistant", "result"];
  const state = { seen: [] as string[], drained: false };
  return {
    calledAt: state.seen,
    get drained() {
      return state.drained;
    },
    async *[Symbol.asyncIterator]() {
      for (const type of messages) {
        state.seen.push(`yield:${type}`);
        yield { type };
      }
      state.drained = true;
    },
    async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
      state.seen.push("usage");
      // The real method throws when called after the query closes.
      if (state.drained) throw new Error("Query closed before response received");
      if (options.throwBefore === true) throw new Error("ProcessTransport is not ready for writing");
      return options.usage;
    },
  };
}

describe("createCapacityReader", () => {
  it("calls usage at the first assistant message, before the stream ends", async () => {
    const query = fakeQuery({ usage: LIVE_SHAPE });
    const read = createCapacityReader({ cwd: "/tmp/brain", open: () => query });

    const reading = await read("/c/mm");

    expect(reading.ok).toBe(true);
    expect(query.calledAt).toEqual(["yield:system", "yield:assistant", "usage", "yield:result"]);
  });

  it("drains the stream to the end so the child process is not left running", async () => {
    const query = fakeQuery({ usage: LIVE_SHAPE });
    await createCapacityReader({ cwd: "/tmp/brain", open: () => query })("/c/mm");
    expect(query.drained).toBe(true);
  });

  it("opens the query against the account's own config dir", async () => {
    const open = vi.fn(() => fakeQuery({ usage: LIVE_SHAPE }));
    await createCapacityReader({ cwd: "/tmp/brain", open })("/c/acme");
    expect(open).toHaveBeenCalledWith("/c/acme");
  });

  it("is unavailable, not a rejection, when the experimental method throws", async () => {
    const query = fakeQuery({ usage: LIVE_SHAPE, throwBefore: true });
    const reading = await createCapacityReader({ cwd: "/tmp/brain", open: () => query })("/c/mm");
    expect(reading).toEqual({ ok: false, reason: "unavailable" });
  });

  it("is unavailable when the stream ends without ever producing an assistant message", async () => {
    const query = fakeQuery({ usage: LIVE_SHAPE, messages: ["system", "result"] });
    const reading = await createCapacityReader({ cwd: "/tmp/brain", open: () => query })("/c/mm");
    expect(reading).toEqual({ ok: false, reason: "unavailable" });
  });

  it("is unavailable, not a rejection, when opening the query throws outright", async () => {
    const read = createCapacityReader({
      cwd: "/tmp/brain",
      open: () => {
        throw new Error("spawn ENOENT");
      },
    });
    await expect(read("/c/mm")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("is bounded: a query that never settles resolves as unavailable", async () => {
    vi.useFakeTimers();
    try {
      const read = createCapacityReader({
        cwd: "/tmp/brain",
        timeoutMs: 1_000,
        open: () => ({
          async *[Symbol.asyncIterator]() {
            await new Promise(() => {});
          },
          async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
            return LIVE_SHAPE;
          },
        }),
      });
      const pending = read("/c/mm");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ ok: false, reason: "unavailable" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout timer on the success path (no leaked timer)", async () => {
    vi.useFakeTimers();
    try {
      const before = vi.getTimerCount();
      const query = fakeQuery({ usage: LIVE_SHAPE });
      const read = createCapacityReader({ cwd: "/tmp/brain", open: () => query, timeoutMs: 1_000 });
      const pending = read("/c/mm");
      await vi.runAllTimersAsync();
      await pending;
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});
