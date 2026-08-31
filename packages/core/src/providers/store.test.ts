import { describe, expect, it, vi } from "vitest";
import type { AgentConfig } from "../registry/types.js";
import { ProviderStatusStore } from "./store.js";

const AGENTS: AgentConfig[] = [
  { id: "claude-mm", command: "claude-mm", configDir: "/c/mm", vendor: "anthropic" },
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
      "claude-mm",
      "copilot",
    ]);
  });

  it("records a successful capacity reading with the time it was read", () => {
    const store = new ProviderStatusStore(AGENTS);
    store.recordCapacity(
      "claude-mm",
      { ok: true, fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00Z" }, sevenDay: undefined },
      1_000,
    );

    expect(store.snapshot()[0]?.capacity).toEqual({
      state: "known",
      fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00Z" },
      sevenDay: undefined,
      readAt: 1_000,
    });
    expect(store.lastCapacityReadAt("claude-mm")).toBe(1_000);
  });

  it("degrades to unavailable on a failed reading and forgets the old number", () => {
    const store = new ProviderStatusStore(AGENTS);
    store.recordCapacity(
      "claude-mm",
      { ok: true, fiveHour: { usedPercent: 9, resetsAt: "2026-08-31T14:30:00Z" }, sevenDay: undefined },
      1_000,
    );
    store.recordCapacity("claude-mm", { ok: false, reason: "unavailable" }, 2_000);

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

  it("ignores a reading for an id it does not know", () => {
    const store = new ProviderStatusStore(AGENTS);
    expect(() =>
      store.recordCapacity("ghost", { ok: false, reason: "unavailable" }, 1),
    ).not.toThrow();
    expect(store.snapshot()).toHaveLength(2);
  });

  it("notifies listeners on every record, and stops after unsubscribe", () => {
    const store = new ProviderStatusStore(AGENTS);
    const listener = vi.fn();
    const off = store.onChange(listener);

    store.recordCapacity("claude-mm", { ok: false, reason: "unavailable" }, 1);
    expect(listener).toHaveBeenCalledTimes(1);

    off();
    store.recordHealth("github", { state: "ok", detail: "All Systems Operational" }, 2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("hands listeners and callers copies, so a mutation cannot reach the store", () => {
    const store = new ProviderStatusStore(AGENTS);
    const first = store.snapshot();
    first.pop();
    expect(store.snapshot()).toHaveLength(2);
  });
});
