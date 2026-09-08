import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../registry/types.js";
import { ProviderStatusStore } from "./store.js";

const AGENTS: AgentConfig[] = [
  { id: "claude-main", command: "claude-main", configDir: "/c/mm", vendor: "anthropic" },
  { id: "copilot", command: "copilot", vendor: "github" },
];

// The user's real configuration: three accounts share the anthropic vendor.
// A fixture with only one account per vendor can prove cross-vendor
// isolation but structurally cannot prove fan-out to siblings — this one can.
const MULTI_ANTHROPIC_AGENTS: AgentConfig[] = [
  { id: "claude-main", command: "claude-main", configDir: "/c/mm", vendor: "anthropic" },
  { id: "claude-acme", command: "claude-acme", configDir: "/c/acme", vendor: "anthropic" },
  { id: "copilot", command: "copilot", vendor: "github" },
];

describe("ProviderStatusStore", () => {
  it("starts every account unknown, distinguishing never-read from unsupported", () => {
    const store = new ProviderStatusStore(AGENTS);
    const [mm, copilot] = store.snapshot();

    expect(mm?.capacity).toEqual({ state: "unknown", reason: "never-read" });
    // No configDir means there is no way to ask at all — a different fact
    // from "we haven't asked yet", and the panel says so differently.
    expect(copilot?.capacity).toEqual({ state: "unknown", reason: "unsupported" });
    expect(mm?.health).toEqual({ state: "unknown", detail: "", readAt: undefined });
  });

  it("keeps the account list and its order from the registry", () => {
    expect(new ProviderStatusStore(AGENTS).snapshot().map((s) => s.id)).toEqual([
      "claude-main",
      "copilot",
    ]);
  });

  it("records a successful capacity reading with the time it was read", () => {
    const store = new ProviderStatusStore(AGENTS);
    store.recordCapacity(
      "claude-main",
      { ok: true, fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00Z" }, sevenDay: undefined },
      1_000,
    );

    expect(store.snapshot()[0]?.capacity).toEqual({
      state: "known",
      fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00Z" },
      sevenDay: undefined,
      readAt: 1_000,
    });
    expect(store.lastCapacityReadAt("claude-main")).toBe(1_000);
  });

  it("degrades to unavailable on a failed reading and forgets the old number", () => {
    const store = new ProviderStatusStore(AGENTS);
    store.recordCapacity(
      "claude-main",
      { ok: true, fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00Z" }, sevenDay: undefined },
      1_000,
    );
    store.recordCapacity("claude-main", { ok: false, reason: "unavailable" }, 2_000);

    // A stale number kept behind a failure would be a reading the user
    // cannot date — worse than saying we don't know (ruling P21's shape).
    expect(store.snapshot()[0]?.capacity).toEqual({ state: "unknown", reason: "unavailable" });
  });

  it("never records capacity for an account that has no config dir", () => {
    const store = new ProviderStatusStore(AGENTS);
    store.recordCapacity(
      "copilot",
      { ok: true, fiveHour: { usedPercent: 1, resetsAt: "2026-08-31T14:30:00Z" }, sevenDay: undefined },
      1_000,
    );
    expect(store.snapshot()[1]?.capacity).toEqual({ state: "unknown", reason: "unsupported" });
  });

  it("applies one vendor's health to every account of that vendor only", () => {
    const store = new ProviderStatusStore(AGENTS);
    store.recordHealth("anthropic", { state: "degraded", detail: "Partially Degraded Service" }, 5_000);

    expect(store.snapshot()[0]?.health).toEqual({
      state: "degraded",
      detail: "Partially Degraded Service",
      readAt: 5_000,
    });
    expect(store.snapshot()[1]?.health.state).toBe("unknown");
  });

  it("fans one vendor's health out to every account of that vendor, without touching a sibling's capacity", () => {
    const store = new ProviderStatusStore(MULTI_ANTHROPIC_AGENTS);
    // Give both anthropic accounts a known capacity reading first, so a bug
    // that let recordHealth touch capacity would be visible as a change.
    store.recordCapacity(
      "claude-main",
      { ok: true, fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00Z" }, sevenDay: undefined },
      1_000,
    );
    store.recordCapacity(
      "claude-acme",
      { ok: true, fiveHour: { usedPercent: 42, resetsAt: "2026-08-31T15:00:00Z" }, sevenDay: undefined },
      1_500,
    );
    const capacityBeforeMm = store.snapshot()[0]?.capacity;
    const capacityBeforeAcme = store.snapshot()[1]?.capacity;

    store.recordHealth("anthropic", { state: "degraded", detail: "Partially Degraded Service" }, 5_000);

    const [mm, acme, copilot] = store.snapshot();

    // Both anthropic accounts got the health update — this is the fan-out.
    expect(mm?.health).toEqual({ state: "degraded", detail: "Partially Degraded Service", readAt: 5_000 });
    expect(acme?.health).toEqual({ state: "degraded", detail: "Partially Degraded Service", readAt: 5_000 });

    // The github account is untouched.
    expect(copilot?.health.state).toBe("unknown");

    // Health is a vendor fact; capacity is an account fact. Neither
    // anthropic account's capacity moved.
    expect(mm?.capacity).toEqual(capacityBeforeMm);
    expect(acme?.capacity).toEqual(capacityBeforeAcme);
  });

  it("ignores a reading for an id it does not know", () => {
    const store = new ProviderStatusStore(AGENTS);
    expect(() =>
      store.recordCapacity("ghost", { ok: false, reason: "unavailable" }, 1),
    ).not.toThrow();
    expect(store.snapshot()).toHaveLength(2);
  });

  // Ruling S7: lastCapacityReadAt reports the last *attempt*, success or
  // failure, not just the last success. A failed reading still opened and
  // billed the SDK query before the usage call failed, so Task 6's throttle
  // must see the attempt time or it will retry a failing account every
  // cycle. These tests are written to fail under success-only semantics.
  describe("lastCapacityReadAt (ruling S7: last attempt, not last success)", () => {
    it("reports the failure's own time, not undefined and not an earlier success", () => {
      const store = new ProviderStatusStore(AGENTS);
      store.recordCapacity(
        "claude-main",
        { ok: true, fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00Z" }, sevenDay: undefined },
        1_000,
      );
      store.recordCapacity("claude-main", { ok: false, reason: "unavailable" }, 2_000);

      expect(store.lastCapacityReadAt("claude-main")).toBe(2_000);
    });

    it("advances to the later failed attempt even though the reading itself reverts to unknown", () => {
      const store = new ProviderStatusStore(AGENTS);
      store.recordCapacity(
        "claude-main",
        { ok: true, fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00Z" }, sevenDay: undefined },
        1_000,
      );
      store.recordCapacity("claude-main", { ok: false, reason: "unavailable" }, 2_000);

      expect(store.lastCapacityReadAt("claude-main")).toBe(2_000);
      expect(store.snapshot()[0]?.capacity).toEqual({ state: "unknown", reason: "unavailable" });
    });

    it("returns undefined for an account that has never been read", () => {
      const store = new ProviderStatusStore(AGENTS);
      expect(store.lastCapacityReadAt("claude-main")).toBeUndefined();
    });
  });

  it("does not emit for recordHealth on a vendor no configured account uses", () => {
    const store = new ProviderStatusStore(AGENTS);
    const listener = vi.fn();
    store.onChange(listener);

    store.recordHealth("openai", { state: "ok", detail: "All Systems Operational" }, 1);

    expect(listener).toHaveBeenCalledTimes(0);
  });

  it("does not emit for recordCapacity on an unknown account id", () => {
    const store = new ProviderStatusStore(AGENTS);
    const listener = vi.fn();
    store.onChange(listener);

    store.recordCapacity("ghost", { ok: false, reason: "unavailable" }, 1);

    expect(listener).toHaveBeenCalledTimes(0);
  });

  it("notifies listeners on every record, and stops after unsubscribe", () => {
    const store = new ProviderStatusStore(AGENTS);
    const listener = vi.fn();
    const off = store.onChange(listener);

    store.recordCapacity("claude-main", { ok: false, reason: "unavailable" }, 1);
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    store.recordHealth("github", { state: "ok", detail: "All Systems Operational" }, 2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("does not let a throwing listener starve a later one (ruling S18)", () => {
    const store = new ProviderStatusStore(AGENTS);
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    store.onChange(bad);
    store.onChange(good);

    store.recordCapacity("claude-main", { ok: false, reason: "unavailable" }, 1);

    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledWith(store.snapshot());
  });

  it("hands listeners and callers copies, so a mutation cannot reach the store", () => {
    const store = new ProviderStatusStore(AGENTS);
    const first = store.snapshot();
    first.pop();
    expect(store.snapshot()).toHaveLength(2);
  });
});
