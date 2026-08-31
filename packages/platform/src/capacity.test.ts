import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    const read = createCapacityReader({ cwd: "/tmp/brain", query: () => query });

    const reading = await read("/c/mm");

    expect(reading.ok).toBe(true);
    expect(query.calledAt).toEqual(["yield:system", "yield:assistant", "usage", "yield:result"]);
  });

  it("drains the stream to the end so the child process is not left running", async () => {
    const query = fakeQuery({ usage: LIVE_SHAPE });
    await createCapacityReader({ cwd: "/tmp/brain", query: () => query })("/c/mm");
    expect(query.drained).toBe(true);
  });

  it("opens the query against the account's own config dir", async () => {
    const query = vi.fn(() => fakeQuery({ usage: LIVE_SHAPE }));
    await createCapacityReader({ cwd: "/tmp/brain", query })("/c/acme");
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "ok",
        options: expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: "/c/acme" }) }),
      }),
    );
  });

  it("is unavailable, not a rejection, when the experimental method throws", async () => {
    const query = fakeQuery({ usage: LIVE_SHAPE, throwBefore: true });
    const reading = await createCapacityReader({ cwd: "/tmp/brain", query: () => query })("/c/mm");
    expect(reading).toEqual({ ok: false, reason: "unavailable" });
  });

  it("is unavailable when the stream ends without ever producing an assistant message", async () => {
    const query = fakeQuery({ usage: LIVE_SHAPE, messages: ["system", "result"] });
    const reading = await createCapacityReader({ cwd: "/tmp/brain", query: () => query })("/c/mm");
    expect(reading).toEqual({ ok: false, reason: "unavailable" });
  });

  it("is unavailable, not a rejection, when opening the query throws outright", async () => {
    const read = createCapacityReader({
      cwd: "/tmp/brain",
      query: () => {
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
        query: () => ({
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
      const read = createCapacityReader({ cwd: "/tmp/brain", query: () => query, timeoutMs: 1_000 });
      const pending = read("/c/mm");
      await vi.runAllTimersAsync();
      await pending;
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts the SDK query on the timeout path, so the billed subprocess is not left running", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const read = createCapacityReader({
        cwd: "/tmp/brain",
        timeoutMs: 1_000,
        query: (params) => {
          capturedSignal = params.options.abortController?.signal;
          return {
            async *[Symbol.asyncIterator]() {
              await new Promise(() => {});
            },
            async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
              return LIVE_SHAPE;
            },
          };
        },
      });
      const pending = read("/c/mm");
      expect(capturedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
      expect(capturedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes an AbortController via options.abortController on every read", async () => {
    let capturedOptions: { abortController?: AbortController } | undefined;
    const query = fakeQuery({ usage: LIVE_SHAPE });
    const read = createCapacityReader({
      cwd: "/tmp/brain",
      query: (params) => {
        capturedOptions = params.options;
        return query;
      },
    });
    await read("/c/mm");
    expect(capturedOptions?.abortController).toBeInstanceOf(AbortController);
  });

  describe("options built for the SDK subprocess", () => {
    let capturedOptions: Record<string, unknown> | undefined;

    beforeEach(() => {
      capturedOptions = undefined;
    });

    it("sets cwd to the configured brain directory, isolation options, and no built-in tools", async () => {
      const query = fakeQuery({ usage: LIVE_SHAPE });
      const read = createCapacityReader({
        cwd: "/tmp/isolated-brain-dir",
        query: (params) => {
          capturedOptions = params.options as unknown as Record<string, unknown>;
          return query;
        },
      });
      await read("/c/mm");
      expect(capturedOptions?.["cwd"]).toBe("/tmp/isolated-brain-dir");
      // R9: a headless SDK session inherits hooks and skills from its cwd
      // unless project/user/local settings are explicitly excluded.
      expect(capturedOptions?.["settingSources"]).toEqual([]);
      expect(capturedOptions?.["tools"]).toEqual([]);
    });

    it("sets CLAUDE_CONFIG_DIR to the account's own config dir", async () => {
      const query = fakeQuery({ usage: LIVE_SHAPE });
      const read = createCapacityReader({
        cwd: "/tmp/brain",
        query: (params) => {
          capturedOptions = params.options as unknown as Record<string, unknown>;
          return query;
        },
      });
      await read("/c/acme");
      const env = capturedOptions?.["env"] as Record<string, string>;
      expect(env["CLAUDE_CONFIG_DIR"]).toBe("/c/acme");
    });

    describe("with an inherited CLAUDE_CONFIG_DIR already set in process.env", () => {
      const originalConfigDir = process.env["CLAUDE_CONFIG_DIR"];

      beforeEach(() => {
        process.env["CLAUDE_CONFIG_DIR"] = "/should-never-win";
      });

      afterEach(() => {
        if (originalConfigDir === undefined) {
          delete process.env["CLAUDE_CONFIG_DIR"];
        } else {
          process.env["CLAUDE_CONFIG_DIR"] = originalConfigDir;
        }
      });

      it("overrides the inherited value — the account's own config dir wins", async () => {
        const query = fakeQuery({ usage: LIVE_SHAPE });
        const read = createCapacityReader({
          cwd: "/tmp/brain",
          query: (params) => {
            capturedOptions = params.options as unknown as Record<string, unknown>;
            return query;
          },
        });
        await read("/c/acme");
        const env = capturedOptions?.["env"] as Record<string, string>;
        expect(env["CLAUDE_CONFIG_DIR"]).toBe("/c/acme");
        expect(env["CLAUDE_CONFIG_DIR"]).not.toBe("/should-never-win");
      });
    });
  });
});
