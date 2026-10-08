import type { ProviderReachability } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { createProviderMonitor, UNREACHABLE_RECHECK_MS } from "./provider-monitor.js";

function fakeTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    pending,
    timers: {
      setTimeout: (callback: () => void, ms: number) => {
        const id = next++;
        pending.set(id, { callback, ms });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        pending.delete(handle as number);
      },
    },
    fire() {
      for (const [id, entry] of [...pending]) {
        pending.delete(id);
        entry.callback();
      }
    },
  };
}

describe("createProviderMonitor", () => {
  it("pushes only on change and re-checks every 30 s while unreachable", async () => {
    const answers = [
      { ok: false, error: "Cannot reach 10.0.0.2" },
      { ok: false, error: "Cannot reach 10.0.0.2" },
      { ok: true },
    ];
    const pushed: ProviderReachability[] = [];
    const clock = fakeTimers();
    const monitor = createProviderMonitor({
      check: async () => answers.shift() ?? { ok: true },
      push: (status) => pushed.push(status),
      timers: clock.timers,
    });
    await monitor.recheck();
    expect(pushed).toEqual([
      { reachable: false, error: "Cannot reach 10.0.0.2", activeId: null, fallbackReason: null },
    ]);
    expect([...clock.pending.values()].map((p) => p.ms)).toEqual([UNREACHABLE_RECHECK_MS]);
    clock.fire();
    await Promise.resolve();
    await monitor.recheck();
    expect(pushed).toEqual([
      { reachable: false, error: "Cannot reach 10.0.0.2", activeId: null, fallbackReason: null },
      { reachable: true, activeId: null, fallbackReason: null },
    ]);
    expect(clock.pending.size).toBe(0);
  });

  it("takes reports from turns and stops cleanly", () => {
    const pushed: ProviderReachability[] = [];
    const clock = fakeTimers();
    const monitor = createProviderMonitor({
      check: async () => ({ ok: true }),
      push: (s) => pushed.push(s),
      timers: clock.timers,
    });
    monitor.reportFailure("401 invalid x-api-key");
    monitor.reportOk();
    expect(pushed).toEqual([
      { reachable: false, error: "401 invalid x-api-key", activeId: null, fallbackReason: null },
      { reachable: true, activeId: null, fallbackReason: null },
    ]);
    monitor.reportFailure("down");
    monitor.stop();
    expect(clock.pending.size).toBe(0);
    expect(monitor.current()).toEqual({
      reachable: false,
      error: "down",
      activeId: null,
      fallbackReason: null,
    });
  });

  it("carries the active provider and the fallback reason, and re-pushes when they change", async () => {
    const pushed: unknown[] = [];
    let active = { activeId: "cloud" as string | null, fallbackReason: null as string | null };
    const monitor = createProviderMonitor({
      check: async () => ({ ok: true }),
      active: () => active,
      push: (status) => pushed.push(status),
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
    });
    await monitor.recheck();
    active = { activeId: "lan", fallbackReason: "cloud returned an error (503)" };
    monitor.noteActive();
    monitor.noteActive();
    expect(pushed).toEqual([
      { reachable: true, activeId: "cloud", fallbackReason: null },
      { reachable: true, activeId: "lan", fallbackReason: "cloud returned an error (503)" },
    ]);
  });
});
