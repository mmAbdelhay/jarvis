import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit.js";
import { formatAuditLine } from "./audit.js";
import { fakeClock } from "./clock-double.js";
import {
  createLoginLimits,
  DEVICE_FAILURES_BEFORE_LOCKOUT,
  DEVICE_LOCKOUT_BASE_MS,
  DEVICE_LOCKOUT_MAX_MS,
  GLOBAL_FAILURE_LIMIT,
  GLOBAL_FAILURE_WINDOW_MS,
  GLOBAL_LOCKOUT_MS,
} from "./login-limits.js";
import type { DesktopNoticeKind } from "./owner-auth.js";

const SOURCE = "100.64.0.2";

function deviceId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function makeLimits() {
  const clock = fakeClock(1_000_000);
  const events: AuditEvent[] = [];
  const notifyDesktop = vi.fn<(kind: DesktopNoticeKind) => void>();
  const limits = createLoginLimits({
    now: clock.now,
    audit: { record: (event) => events.push(event) },
    notifyDesktop,
  });
  return { clock, events, notifyDesktop, limits };
}

function failTimes(limits: ReturnType<typeof makeLimits>["limits"], id: string, times: number) {
  for (let i = 0; i < times; i++) limits.failed(id, SOURCE);
}

describe("createLoginLimits: per device", () => {
  it("5 failures block the 6th attempt for 60 s, and audit locked-out once", () => {
    const { limits, events, clock } = makeLimits();
    const id = deviceId(1);
    failTimes(limits, id, DEVICE_FAILURES_BEFORE_LOCKOUT - 1);
    expect(limits.allow(id, SOURCE)).toBe(true);
    limits.failed(id, SOURCE);
    expect(limits.allow(id, SOURCE)).toBe(false);
    expect(events).toEqual([{ kind: "locked-out", deviceId: id, source: SOURCE, scope: "device" }]);

    clock.advance(DEVICE_LOCKOUT_BASE_MS - 1);
    expect(limits.allow(id, SOURCE)).toBe(false);
    clock.advance(1);
    expect(limits.allow(id, SOURCE)).toBe(true);
    // Other devices are untouched.
    expect(limits.allow(deviceId(2), SOURCE)).toBe(true);
  });

  it("each further failure doubles the lockout, capped at 1 hour", () => {
    const { limits, events, clock } = makeLimits();
    const id = deviceId(1);
    failTimes(limits, id, DEVICE_FAILURES_BEFORE_LOCKOUT);
    const expected = [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000];
    for (const [index, lockout] of expected.entries()) {
      if (index > 0) limits.failed(id, SOURCE);
      expect(lockout).toBeLessThanOrEqual(DEVICE_LOCKOUT_MAX_MS);
      clock.advance(lockout - 1);
      expect(limits.allow(id, SOURCE)).toBe(false);
      clock.advance(1);
      expect(limits.allow(id, SOURCE)).toBe(true);
    }
    expect(events.filter((event) => event.kind === "locked-out")).toHaveLength(expected.length);
  });

  it("a success resets the device's failure count", () => {
    const { limits } = makeLimits();
    const id = deviceId(1);
    failTimes(limits, id, DEVICE_FAILURES_BEFORE_LOCKOUT - 1);
    limits.succeeded(id, SOURCE);
    failTimes(limits, id, DEVICE_FAILURES_BEFORE_LOCKOUT - 1);
    expect(limits.allow(id, SOURCE)).toBe(true);
  });
});

describe("createLoginLimits: global", () => {
  it("20 failures within an hour refuse every login for 15 min and notify the desktop once", () => {
    const { limits, events, notifyDesktop, clock } = makeLimits();
    // Spread over many devices so no single device locks out.
    for (let i = 0; i < GLOBAL_FAILURE_LIMIT - 1; i++) {
      limits.failed(deviceId(100 + i), SOURCE);
      clock.advance(60_000);
    }
    expect(limits.allow(deviceId(1), SOURCE)).toBe(true);
    expect(notifyDesktop).not.toHaveBeenCalled();

    limits.failed(deviceId(99), SOURCE);
    expect(limits.allow(deviceId(1), SOURCE)).toBe(false);
    expect(notifyDesktop).toHaveBeenCalledExactlyOnceWith("locked-out-global");
    expect(events).toContainEqual({
      kind: "locked-out",
      deviceId: deviceId(99),
      source: SOURCE,
      scope: "global",
    });

    clock.advance(GLOBAL_LOCKOUT_MS - 1);
    expect(limits.allow(deviceId(1), SOURCE)).toBe(false);
    clock.advance(1);
    expect(limits.allow(deviceId(1), SOURCE)).toBe(true);
  });

  it("failures older than the rolling hour do not count", () => {
    const { limits, notifyDesktop, clock } = makeLimits();
    for (let i = 0; i < GLOBAL_FAILURE_LIMIT - 1; i++) limits.failed(deviceId(100 + i), SOURCE);
    clock.advance(GLOBAL_FAILURE_WINDOW_MS);
    limits.failed(deviceId(99), SOURCE);
    expect(limits.allow(deviceId(1), SOURCE)).toBe(true);
    expect(notifyDesktop).not.toHaveBeenCalled();
  });

  it("a throwing notifyDesktop or audit never escapes", () => {
    const clock = fakeClock(0);
    const limits = createLoginLimits({
      now: clock.now,
      audit: {
        record: () => {
          throw new Error("disk");
        },
      },
      notifyDesktop: () => {
        throw new Error("no display");
      },
    });
    expect(() => {
      for (let i = 0; i < GLOBAL_FAILURE_LIMIT; i++) limits.failed(deviceId(i % 3), SOURCE);
    }).not.toThrow();
    expect(limits.allow(deviceId(7), SOURCE)).toBe(false);
  });
});

describe("locked-out audit line", () => {
  it("carries only the device id, source and scope", () => {
    const line = formatAuditLine(0, {
      kind: "locked-out",
      deviceId: deviceId(1),
      source: SOURCE,
      scope: "device",
    });
    expect(line).toBe(
      `1970-01-01T00:00:00.000Z locked-out deviceId="${deviceId(1)}" scope="device" source="${SOURCE}"\n`,
    );
  });
});
