import { describe, expect, it, vi } from "vitest";
import type { CapacityTarget } from "./types.js";
import type { AgentConfig, ProviderVendor } from "../registry/types.js";
import { ProviderStatusStore } from "./store.js";
import type { ProviderMonitorDeps } from "./monitor.js";
import { MIN_CAPACITY_REFRESH_MS, ProviderMonitor } from "./monitor.js";

const AGENTS: AgentConfig[] = [
  { id: "claude-main", command: "claude-main", configDir: "/c/mm", vendor: "anthropic" },
  { id: "claude-acme", command: "claude-acme", configDir: "/c/sd", vendor: "anthropic" },
  { id: "copilot", command: "copilot", vendor: "github" },
  // No vendor: no capacity source and no health page.
  { id: "local", command: "ollama" },
];

const OK = {
  ok: true as const,
  primary: { usedPercent: 10, resetsAt: "2026-08-31T14:30:00Z" },
  secondary: undefined,
};

function build(overrides: Partial<ProviderMonitorDeps> = {}) {
  const store = new ProviderStatusStore(AGENTS);
  let clock = 1_000_000;
  const readCapacity = vi.fn(async (_target: CapacityTarget) => OK);
  const readHealth = vi.fn(async (_vendor: ProviderVendor) => ({
    state: "ok" as const,
    detail: "All Systems Operational",
  }));
  const monitor = new ProviderMonitor({
    agents: AGENTS,
    store,
    readCapacity,
    readHealth,
    now: () => clock,
    ...overrides,
  });
  return { monitor, store, readCapacity, readHealth, advance: (ms: number) => (clock += ms) };
}

describe("ProviderMonitor.refreshCapacity", () => {
  it("refreshes newly replaced agents instead of the startup registry", async () => {
    const { monitor, store, readCapacity } = build();
    monitor.replaceAgents([{ id: "new", command: "new", configDir: "/new", vendor: "openai" }]);
    await monitor.refreshCapacity({ force: true });
    expect(readCapacity).toHaveBeenCalledTimes(1);
    expect(readCapacity).toHaveBeenCalledWith({ id: "new", vendor: "openai", configDir: "/new" });
    expect(store.snapshot().map((status) => status.id)).toEqual(["new"]);
  });
  it("reads exactly one query per account that has a capacity source, and none for the rest", async () => {
    const { monitor, readCapacity } = build();
    await monitor.refreshCapacity();

    expect(readCapacity).toHaveBeenCalledTimes(3);
    expect(readCapacity.mock.calls.map((call) => call[0].id)).toEqual([
      "claude-main",
      "claude-acme",
      "copilot",
    ]);
  });

  it("does not spend a second query inside the minimum interval", async () => {
    const { monitor, readCapacity, advance } = build();
    await monitor.refreshCapacity();
    advance(MIN_CAPACITY_REFRESH_MS - 1);
    await monitor.refreshCapacity();

    // Every read is billed and consumes the very capacity it reports.
    expect(readCapacity).toHaveBeenCalledTimes(3);
  });

  it("reads again once the minimum interval has passed", async () => {
    const { monitor, readCapacity, advance } = build();
    await monitor.refreshCapacity();
    advance(MIN_CAPACITY_REFRESH_MS);
    await monitor.refreshCapacity();
    expect(readCapacity).toHaveBeenCalledTimes(6);
  });

  it("honours an explicit force, because the user asked", async () => {
    const { monitor, readCapacity } = build();
    await monitor.refreshCapacity();
    await monitor.refreshCapacity({ force: true });
    expect(readCapacity).toHaveBeenCalledTimes(6);
  });

  it("never runs two refreshes concurrently", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const readCapacity = vi.fn(async () => {
      await gate;
      return OK;
    });
    const { monitor } = build({ readCapacity });

    const first = monitor.refreshCapacity({ force: true });
    const second = monitor.refreshCapacity({ force: true });
    release();
    await Promise.all([first, second]);

    expect(readCapacity).toHaveBeenCalledTimes(3);
  });

  it("lets an explicit force outrun an unforced pass and refresh what it left stale", async () => {
    let gate: Promise<void> = Promise.resolve();
    const readCapacity = vi.fn(async (_target: CapacityTarget) => {
      await gate;
      return OK;
    });
    const { monitor, advance } = build({ readCapacity });

    // Baseline: all three readable accounts read and become fresh.
    await monitor.refreshCapacity();
    expect(readCapacity).toHaveBeenCalledTimes(3);

    // Push past the throttle window, then re-freshen just "sd" via a
    // piggyback (a real reading, so it resets that account's clock without
    // billing) — leaving only "mm" due for a routine, unforced refresh.
    advance(MIN_CAPACITY_REFRESH_MS);
    monitor.recordPiggyback("claude-acme", OK);

    // Gate the next reads so the unforced pass stays in flight while the
    // forced call races in.
    let release: () => void = () => {};
    gate = new Promise((resolve) => (release = resolve));

    const unforced = monitor.refreshCapacity(); // due: mm and copilot
    const forced = monitor.refreshCapacity({ force: true }); // must await, then force both
    release();
    await Promise.all([unforced, forced]);

    // The unforced pass reads mm and copilot; the forced pass, after
    // awaiting it, runs its own pass over all three — "sd", which the
    // unforced pass judged not due, is not silently left stale for the
    // caller who explicitly asked for fresh data.
    expect(readCapacity).toHaveBeenCalledTimes(3 + 2 + 3);
    expect(
      readCapacity.mock.calls
        .slice(5)
        .map((call) => call[0].id)
        .sort(),
    ).toEqual(["claude-acme", "claude-main", "copilot"]);
  });

  it("records one account's failure without losing the other's reading", async () => {
    const readCapacity = vi.fn(async (target: CapacityTarget) =>
      target.configDir === "/c/mm" ? { ok: false as const, reason: "unavailable" as const } : OK,
    );
    const { monitor, store } = build({ readCapacity });
    await monitor.refreshCapacity();

    expect(store.snapshot()[0]?.capacity).toEqual({ state: "unknown", reason: "unavailable" });
    expect(store.snapshot()[1]?.capacity.state).toBe("known");
  });

  it("survives a reader that rejects outright", async () => {
    const readCapacity = vi.fn(async () => {
      throw new Error("boom");
    });
    const { monitor, store } = build({ readCapacity });

    await expect(monitor.refreshCapacity()).resolves.toBeUndefined();
    expect(store.snapshot()[0]?.capacity).toEqual({ state: "unknown", reason: "unavailable" });
  });
});

describe("ProviderMonitor.onChange", () => {
  it("passes subscriptions through to the store", () => {
    const { monitor, store } = build();
    const listener = vi.fn();
    const off = monitor.onChange(listener);

    store.recordCapacity("claude-main", { ok: false, reason: "unavailable" }, 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(store.snapshot());

    off();
    store.recordCapacity("claude-acme", { ok: false, reason: "unavailable" }, 2);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe("ProviderMonitor.refreshHealth", () => {
  it("asks each distinct vendor once, not once per account", async () => {
    const { monitor, readHealth } = build();
    await monitor.refreshHealth();
    expect(readHealth.mock.calls.map((call) => call[0]).sort()).toEqual(["anthropic", "github"]);
  });

  it("applies a vendor's reading to every account of that vendor", async () => {
    const { monitor, store } = build();
    await monitor.refreshHealth();
    expect(store.snapshot()[0]?.health.state).toBe("ok");
    expect(store.snapshot()[1]?.health.state).toBe("ok");
  });

  it("survives a rejecting health reader without throwing", async () => {
    const readHealth = vi.fn(async () => {
      throw new Error("offline");
    });
    const { monitor, store } = build({ readHealth });
    await expect(monitor.refreshHealth()).resolves.toBeUndefined();
    expect(store.snapshot()[0]?.health.state).toBe("unknown");
  });
});

describe("ProviderMonitor.recordPiggyback", () => {
  it("records a free reading and resets the paid-refresh clock with it", async () => {
    const { monitor, store, readCapacity } = build();
    monitor.recordPiggyback("claude-main", OK);

    expect(store.snapshot()[0]?.capacity.state).toBe("known");

    // The piggyback is a real reading, so a refresh right after it must not
    // pay for the same number twice.
    await monitor.refreshCapacity();
    expect(readCapacity.mock.calls.map((call) => call[0].id)).toEqual(["claude-acme", "copilot"]);
  });

  it("ignores a piggyback for an account it does not know", () => {
    const { monitor, store } = build();
    expect(() => monitor.recordPiggyback("ghost", OK)).not.toThrow();
    expect(store.snapshot()).toHaveLength(4);
  });
});
