import { describe, expect, it, vi } from "vitest";
import type { AgentConfig, ProviderVendor } from "../registry/types.js";
import { ProviderStatusStore } from "./store.js";
import type { ProviderMonitorDeps } from "./monitor.js";
import { MIN_CAPACITY_REFRESH_MS, ProviderMonitor } from "./monitor.js";

const AGENTS: AgentConfig[] = [
  { id: "claude-mm", command: "claude-mm", configDir: "/c/mm", vendor: "anthropic" },
  { id: "claude-acme", command: "claude-acme", configDir: "/c/sd", vendor: "anthropic" },
  { id: "copilot", command: "copilot", vendor: "github" },
];

const OK = {
  ok: true as const,
  fiveHour: { usedPercent: 10, resetsAt: "2026-08-31T14:30:00Z" },
  sevenDay: undefined,
};

function build(overrides: Partial<ProviderMonitorDeps> = {}) {
  const store = new ProviderStatusStore(AGENTS);
  let clock = 1_000_000;
  const readCapacity = vi.fn(async (_configDir: string) => OK);
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
  it("reads exactly one query per account that has a config dir, and none for the rest", async () => {
    const { monitor, readCapacity } = build();
    await monitor.refreshCapacity();

    expect(readCapacity).toHaveBeenCalledTimes(2);
    expect(readCapacity.mock.calls.map((call) => call[0])).toEqual(["/c/mm", "/c/sd"]);
  });

  it("does not spend a second query inside the minimum interval", async () => {
    const { monitor, readCapacity, advance } = build();
    await monitor.refreshCapacity();
    advance(MIN_CAPACITY_REFRESH_MS - 1);
    await monitor.refreshCapacity();

    // Every read is billed and consumes the very capacity it reports.
    expect(readCapacity).toHaveBeenCalledTimes(2);
  });

  it("reads again once the minimum interval has passed", async () => {
    const { monitor, readCapacity, advance } = build();
    await monitor.refreshCapacity();
    advance(MIN_CAPACITY_REFRESH_MS);
    await monitor.refreshCapacity();
    expect(readCapacity).toHaveBeenCalledTimes(4);
  });

  it("honours an explicit force, because the user asked", async () => {
    const { monitor, readCapacity } = build();
    await monitor.refreshCapacity();
    await monitor.refreshCapacity({ force: true });
    expect(readCapacity).toHaveBeenCalledTimes(4);
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

    expect(readCapacity).toHaveBeenCalledTimes(2);
  });

  it("records one account's failure without losing the other's reading", async () => {
    const readCapacity = vi.fn(async (configDir: string) =>
      configDir === "/c/mm" ? { ok: false as const, reason: "unavailable" as const } : OK,
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
    monitor.recordPiggyback("claude-mm", OK);

    expect(store.snapshot()[0]?.capacity.state).toBe("known");

    // The piggyback is a real reading, so a refresh right after it must not
    // pay for the same number twice.
    await monitor.refreshCapacity();
    expect(readCapacity.mock.calls.map((call) => call[0])).toEqual(["/c/sd"]);
  });

  it("ignores a piggyback for an account it does not know", () => {
    const { monitor, store } = build();
    expect(() => monitor.recordPiggyback("ghost", OK)).not.toThrow();
    expect(store.snapshot()).toHaveLength(3);
  });
});
