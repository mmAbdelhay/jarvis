import { describe, expect, it } from "vitest";
import { duePrayerNotifications, type PrayerTickState } from "./prayer-notify.js";
import type { PrayerConfig } from "../src/config.js";

const enabled: PrayerConfig = { enabled: true };
const now = new Date("2026-09-19T12:00:00Z");

function state(overrides: Partial<PrayerTickState>): PrayerTickState {
  return {
    name: "Maghrib",
    remaining: 20 * 60_000,
    previousName: "Asr",
    sincePrevious: 3 * 60 * 60_000,
    ...overrides,
  };
}

describe("duePrayerNotifications", () => {
  it("fires 'before' once when remaining crosses into the window, never again for the same instant", () => {
    const fired = new Map<string, number>();
    const first = duePrayerNotifications(now, state({ remaining: 9 * 60_000 }), enabled, fired);
    expect(first).toEqual([{ kind: "before", name: "Maghrib", time: now.getTime() + 9 * 60_000 }]);

    // A second later, still inside the window, same prayer instant: no repeat.
    const oneSecondLater = new Date(now.getTime() + 1000);
    const second = duePrayerNotifications(
      oneSecondLater,
      state({ remaining: 9 * 60_000 - 1000 }),
      enabled,
      fired,
    );
    expect(second).toEqual([]);
  });

  it("fires 'at time' once for the prayer that just passed, never again for the same instant", () => {
    const fired = new Map<string, number>();
    const first = duePrayerNotifications(now, state({ sincePrevious: 10_000 }), enabled, fired);
    expect(first).toEqual([{ kind: "at", name: "Asr", time: now.getTime() - 10_000 }]);

    const oneSecondLater = new Date(now.getTime() + 1000);
    const second = duePrayerNotifications(
      oneSecondLater,
      state({ sincePrevious: 11_000 }),
      enabled,
      fired,
    );
    expect(second).toEqual([]);
  });

  it("fires both kinds together when both are due and both are on", () => {
    const fired = new Map<string, number>();
    const result = duePrayerNotifications(
      now,
      state({ remaining: 5 * 60_000, sincePrevious: 5_000 }),
      enabled,
      fired,
    );
    expect(result).toEqual([
      { kind: "before", name: "Maghrib", time: now.getTime() + 5 * 60_000 },
      { kind: "at", name: "Asr", time: now.getTime() - 5_000 },
    ]);
  });

  it("fires nothing when both kinds are turned off", () => {
    const fired = new Map<string, number>();
    const config: PrayerConfig = {
      enabled: true,
      notify: { before: false, beforeMinutes: 10, atTime: false },
    };
    const result = duePrayerNotifications(
      now,
      state({ remaining: 30_000, sincePrevious: 30_000 }),
      config,
      fired,
    );
    expect(result).toEqual([]);
  });

  it("respects each toggle independently", () => {
    const beforeOnly: PrayerConfig = {
      enabled: true,
      notify: { before: true, beforeMinutes: 10, atTime: false },
    };
    const atOnly: PrayerConfig = {
      enabled: true,
      notify: { before: false, beforeMinutes: 10, atTime: true },
    };
    const dueState = state({ remaining: 30_000, sincePrevious: 30_000 });
    expect(duePrayerNotifications(now, dueState, beforeOnly, new Map()).map((n) => n.kind)).toEqual(
      ["before"],
    );
    expect(duePrayerNotifications(now, dueState, atOnly, new Map()).map((n) => n.kind)).toEqual([
      "at",
    ]);
  });

  it("never fires when prayer itself is disabled", () => {
    const disabled: PrayerConfig = { enabled: false };
    const result = duePrayerNotifications(
      now,
      state({ remaining: 30_000, sincePrevious: 30_000 }),
      disabled,
      new Map(),
    );
    expect(result).toEqual([]);
  });

  it("does not fire 'before' once remaining has passed (0 or negative)", () => {
    const result = duePrayerNotifications(now, state({ remaining: 0 }), enabled, new Map());
    expect(result).toEqual([]);
  });

  it("respects the configured beforeMinutes window boundary", () => {
    const config: PrayerConfig = {
      enabled: true,
      notify: { before: true, beforeMinutes: 10, atTime: false },
    };
    // Exactly at the boundary: due.
    expect(
      duePrayerNotifications(now, state({ remaining: 10 * 60_000 }), config, new Map()),
    ).toEqual([{ kind: "before", name: "Maghrib", time: now.getTime() + 10 * 60_000 }]);
    // Just outside the boundary: not due.
    expect(
      duePrayerNotifications(now, state({ remaining: 10 * 60_000 + 1000 }), config, new Map()),
    ).toEqual([]);
  });

  it("respects the at-time window boundary", () => {
    const config: PrayerConfig = {
      enabled: true,
      notify: { before: false, beforeMinutes: 10, atTime: true },
    };
    // Exactly at the boundary: due.
    expect(
      duePrayerNotifications(now, state({ sincePrevious: 60_000 }), config, new Map()),
    ).toEqual([{ kind: "at", name: "Asr", time: now.getTime() - 60_000 }]);
    // Just outside the boundary: not due.
    expect(
      duePrayerNotifications(now, state({ sincePrevious: 60_000 + 1000 }), config, new Map()),
    ).toEqual([]);
  });

  it("never fires 'at time' retroactively for an event hours in the past on the first tick after launch", () => {
    // Simulates a fresh launch (empty `fired`) long after the previous
    // prayer, and a next prayer still hours away — the "compute from
    // times, not from a threshold crossing" requirement: nothing here
    // implies "just started, so treat this as new".
    const fired = new Map<string, number>();
    const result = duePrayerNotifications(
      now,
      state({ remaining: 3 * 60 * 60_000, sincePrevious: 3 * 60 * 60_000 }),
      enabled,
      fired,
    );
    expect(result).toEqual([]);
  });

  it("prunes dedupe keys older than a day so the map cannot grow unbounded", () => {
    const fired = new Map<string, number>();
    const oldKeyTime = now.getTime() - 25 * 60 * 60_000;
    fired.set("before:old", oldKeyTime);
    fired.set("at:recent", now.getTime() - 1000);
    duePrayerNotifications(
      now,
      state({ remaining: 3 * 60 * 60_000, sincePrevious: 3 * 60 * 60_000 }),
      enabled,
      fired,
    );
    expect(fired.has("before:old")).toBe(false);
    expect(fired.has("at:recent")).toBe(true);
  });

  it("falls back to the default notify settings when the config omits `notify`", () => {
    // enabled:true, no notify key at all — the defaults (before on, 10
    // minutes, at-time on) must still apply.
    const result = duePrayerNotifications(
      now,
      state({ remaining: 9 * 60_000 }),
      enabled,
      new Map(),
    );
    expect(result).toEqual([{ kind: "before", name: "Maghrib", time: now.getTime() + 9 * 60_000 }]);
  });
});
