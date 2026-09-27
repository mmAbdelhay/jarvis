import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit.js";
import { formatAuditLine } from "./audit.js";
import { fakeClock } from "./clock-double.js";
import {
  createLoginLimits,
  DEVICE_FAILURES_BEFORE_LOCKOUT,
  DEVICE_LOCKOUT_NOTICE_INTERVAL_MS,
  DEVICE_LOCKOUT_BASE_MS,
  DEVICE_LOCKOUT_MAX_MS,
  GLOBAL_FAILURE_LIMIT,
  GLOBAL_FAILURE_WINDOW_MS,
  GLOBAL_LOCKOUT_MS,
  MAX_TRACKED_LOGIN_DEVICES,
  REFUSED_AUDIT_WINDOW_MS,
} from "./login-limits.js";
import type { DesktopNoticeKind } from "./owner-auth.js";

const SOURCE = "100.64.0.2";

function deviceId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function makeLimits() {
  const clock = fakeClock(1_000_000);
  const events: AuditEvent[] = [];
  const notifyDesktop = vi.fn<(kind: DesktopNoticeKind, deviceName?: string) => void>();
  const limits = createLoginLimits({
    now: clock.now,
    audit: { record: (event) => events.push(event) },
    notifyDesktop,
    deviceName: (id) => (id === deviceId(1) ? "Owner's phone" : undefined),
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

describe("createLoginLimits: device lockout notice", () => {
  it("a device's first lockout notifies the desktop with its name", () => {
    const { limits, notifyDesktop } = makeLimits();
    failTimes(limits, deviceId(1), DEVICE_FAILURES_BEFORE_LOCKOUT - 1);
    expect(notifyDesktop).not.toHaveBeenCalled();
    limits.failed(deviceId(1), SOURCE);
    expect(notifyDesktop).toHaveBeenCalledExactlyOnceWith("locked-out-device", "Owner's phone");
  });

  it("notifies at most once per device per 15 minutes, across escalations", () => {
    const { limits, notifyDesktop, clock } = makeLimits();
    const id = deviceId(1);
    failTimes(limits, id, DEVICE_FAILURES_BEFORE_LOCKOUT);
    // Escalations while the notice interval runs: 60 s, 120 s, 240 s, 480 s.
    for (const lockout of [60_000, 120_000, 240_000]) {
      clock.advance(lockout);
      limits.failed(id, SOURCE);
    }
    expect(notifyDesktop).toHaveBeenCalledTimes(1);
    // 60+120+240 s have passed; the next lockout at the 15-minute mark notifies.
    clock.advance(DEVICE_LOCKOUT_NOTICE_INTERVAL_MS - 420_000 - 1);
    limits.failed(id, SOURCE);
    expect(notifyDesktop).toHaveBeenCalledTimes(1);
    clock.advance(1);
    limits.failed(id, SOURCE);
    expect(notifyDesktop).toHaveBeenCalledTimes(2);
  });

  it("each device has its own throttle; an unknown name is left out", () => {
    const { limits, notifyDesktop } = makeLimits();
    failTimes(limits, deviceId(1), DEVICE_FAILURES_BEFORE_LOCKOUT);
    failTimes(limits, deviceId(2), DEVICE_FAILURES_BEFORE_LOCKOUT);
    expect(notifyDesktop.mock.calls).toEqual([
      ["locked-out-device", "Owner's phone"],
      ["locked-out-device"],
    ]);
  });
});

describe("createLoginLimits: capacity refusals", () => {
  it("a refusal for a full check queue is coalesced as login-refused scope=capacity and blocks nothing", () => {
    const { limits, events, clock } = makeLimits();
    const id = deviceId(1);
    for (let i = 0; i < 50; i++) limits.refused(id, SOURCE, "capacity");
    expect(limits.allow(id, SOURCE)).toBe(true);
    expect(events).toEqual([]);
    clock.advance(REFUSED_AUDIT_WINDOW_MS);
    limits.allow(id, SOURCE);
    expect(events).toEqual([
      { kind: "login-refused", deviceId: id, source: SOURCE, scope: "capacity", count: 50 },
    ]);
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

describe("createLoginLimits: refused attempts are audited, coalesced", () => {
  function refusedLines(events: AuditEvent[]) {
    return events.filter((event) => event.kind === "login-refused");
  }

  it("50 refusals within 60 s give exactly one line with count 50, written after the window", () => {
    const { limits, events, clock } = makeLimits();
    const id = deviceId(1);
    // 7 failures: a 240 s lockout, so the 60 s window closes first.
    failTimes(limits, id, DEVICE_FAILURES_BEFORE_LOCKOUT + 2);
    for (let i = 0; i < 50; i++) {
      expect(limits.allow(id, SOURCE)).toBe(false);
      limits.refused(id, SOURCE);
      clock.advance(1_000);
    }
    clock.advance(REFUSED_AUDIT_WINDOW_MS - 50_000 - 1);
    limits.allow(id, SOURCE);
    expect(refusedLines(events)).toEqual([]);

    clock.advance(1);
    limits.allow(id, SOURCE);
    expect(refusedLines(events)).toEqual([
      { kind: "login-refused", deviceId: id, source: SOURCE, scope: "device", count: 50 },
    ]);

    // The next window starts afresh.
    limits.refused(id, "100.64.0.9");
    clock.advance(REFUSED_AUDIT_WINDOW_MS);
    limits.allow(id, SOURCE);
    expect(refusedLines(events)).toHaveLength(2);
    expect(refusedLines(events)[1]).toEqual({
      kind: "login-refused",
      deviceId: id,
      source: "100.64.0.9",
      scope: "device",
      count: 1,
    });
    // The locked-out line at lockout start is still there, once per lockout.
    expect(events.filter((event) => event.kind === "locked-out")).toHaveLength(3);
  });

  it("a pending count is written when the lockout ends before its window does", () => {
    const { limits, events, clock } = makeLimits();
    const id = deviceId(1);
    failTimes(limits, id, DEVICE_FAILURES_BEFORE_LOCKOUT);
    clock.advance(DEVICE_LOCKOUT_BASE_MS - 10_000);
    limits.refused(id, SOURCE);
    limits.refused(id, SOURCE);
    clock.advance(10_000);
    expect(limits.allow(id, SOURCE)).toBe(true);
    expect(refusedLines(events)).toEqual([
      { kind: "login-refused", deviceId: id, source: SOURCE, scope: "device", count: 2 },
    ]);
  });

  it("refusals during a global lockout are audited with scope global", () => {
    const { limits, events, clock } = makeLimits();
    for (let i = 0; i < GLOBAL_FAILURE_LIMIT; i++) limits.failed(deviceId(100 + i), SOURCE);
    limits.refused(deviceId(1), SOURCE);
    clock.advance(REFUSED_AUDIT_WINDOW_MS);
    limits.allow(deviceId(1), SOURCE);
    expect(refusedLines(events)).toEqual([
      { kind: "login-refused", deviceId: deviceId(1), source: SOURCE, scope: "global", count: 1 },
    ]);
  });
});

describe("createLoginLimits: device map bounds", () => {
  it("forgets a device whose lockout is over and whose last failure is over an hour old", () => {
    const { limits, clock } = makeLimits();
    failTimes(limits, deviceId(1), DEVICE_FAILURES_BEFORE_LOCKOUT - 1);
    clock.advance(60 * 60_000);
    limits.failed(deviceId(2), SOURCE);
    expect(limits.trackedDeviceIds()).toEqual([deviceId(2)]);
    // Its old failures no longer count toward a lockout.
    limits.failed(deviceId(1), SOURCE);
    expect(limits.allow(deviceId(1), SOURCE)).toBe(true);
  });

  it(`never tracks more than ${MAX_TRACKED_LOGIN_DEVICES} devices, evicting the least recently failed`, () => {
    const { limits } = makeLimits();
    for (let i = 0; i <= MAX_TRACKED_LOGIN_DEVICES; i++) limits.failed(deviceId(i), SOURCE);
    const tracked = limits.trackedDeviceIds();
    expect(tracked).toHaveLength(MAX_TRACKED_LOGIN_DEVICES);
    expect(tracked).not.toContain(deviceId(0));
    expect(tracked).toContain(deviceId(MAX_TRACKED_LOGIN_DEVICES));
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
