import { describe, expect, it } from "vitest";
import type { AuditEvent } from "./audit.js";
import { fakeClock } from "./clock-double.js";
import { createJoinLimits } from "./join-limits.js";
import {
  DEVICE_FAILURES_BEFORE_LOCKOUT,
  DEVICE_LOCKOUT_BASE_MS,
  DEVICE_LOCKOUT_MAX_MS,
  REFUSED_AUDIT_WINDOW_MS,
} from "./login-limits.js";

const SOURCE = "100.64.0.2";
const OTHER_SOURCE = "100.64.0.9";

function makeLimits() {
  const clock = fakeClock(1_000_000);
  const events: AuditEvent[] = [];
  const limits = createJoinLimits({
    now: clock.now,
    audit: { record: (event) => events.push(event) },
  });
  return { clock, events, limits };
}

function failTimes(
  limits: ReturnType<typeof makeLimits>["limits"],
  times: number,
  source = SOURCE,
) {
  for (let i = 0; i < times; i++) limits.failed(source);
}

function refusedLines(events: AuditEvent[]) {
  return events.filter((event) => event.kind === "join-refused");
}

describe("createJoinLimits: lockout", () => {
  it("4 failures still allow", () => {
    const { limits } = makeLimits();
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT - 1);
    expect(limits.allow(SOURCE)).toBe(true);
  });

  it("the 5th failure blocks for 60 s", () => {
    const { limits, clock } = makeLimits();
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT);
    expect(limits.allow(SOURCE)).toBe(false);
    clock.advance(DEVICE_LOCKOUT_BASE_MS - 1);
    expect(limits.allow(SOURCE)).toBe(false);
    clock.advance(1);
    expect(limits.allow(SOURCE)).toBe(true);
  });

  it("the next failure after expiry blocks for 120 s", () => {
    const { limits, clock } = makeLimits();
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT);
    clock.advance(DEVICE_LOCKOUT_BASE_MS);
    limits.failed(SOURCE);
    clock.advance(2 * DEVICE_LOCKOUT_BASE_MS - 1);
    expect(limits.allow(SOURCE)).toBe(false);
    clock.advance(1);
    expect(limits.allow(SOURCE)).toBe(true);
  });

  it("the lockout doubles up to a cap of 1 hour", () => {
    const { limits, clock } = makeLimits();
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT);
    clock.advance(DEVICE_LOCKOUT_BASE_MS);
    // 120 s, 240 s, 480 s, 960 s, 1920 s, then 3840 s capped to 1 hour, twice.
    const doubling = [2, 4, 8, 16, 32].map((n) => n * DEVICE_LOCKOUT_BASE_MS);
    for (const lockout of [...doubling, DEVICE_LOCKOUT_MAX_MS, DEVICE_LOCKOUT_MAX_MS]) {
      limits.failed(SOURCE);
      clock.advance(lockout - 1);
      expect(limits.allow(SOURCE)).toBe(false);
      clock.advance(1);
      expect(limits.allow(SOURCE)).toBe(true);
    }
  });

  it("success resets the count", () => {
    const { limits, clock } = makeLimits();
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT);
    clock.advance(DEVICE_LOCKOUT_BASE_MS);
    limits.succeeded();
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT - 1);
    expect(limits.allow(SOURCE)).toBe(true);
    limits.failed(SOURCE);
    expect(limits.allow(SOURCE)).toBe(false);
    // Back to the 60 s base lockout, not the escalated 120 s.
    clock.advance(DEVICE_LOCKOUT_BASE_MS);
    expect(limits.allow(SOURCE)).toBe(true);
  });

  it("two different sources share one bucket", () => {
    const { limits } = makeLimits();
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT - 1, SOURCE);
    expect(limits.allow(OTHER_SOURCE)).toBe(true);
    limits.failed(OTHER_SOURCE);
    expect(limits.allow(SOURCE)).toBe(false);
    expect(limits.allow(OTHER_SOURCE)).toBe(false);
  });
});

describe("createJoinLimits: audit", () => {
  it("audits each failure as join-failed with only its source", () => {
    const { limits, events } = makeLimits();
    limits.failed(SOURCE);
    limits.failed(OTHER_SOURCE);
    expect(events).toEqual([
      { kind: "join-failed", source: SOURCE },
      { kind: "join-failed", source: OTHER_SOURCE },
    ]);
  });

  it("refused attempts audit join-refused at most once per 60 s, with a count", () => {
    const { limits, events, clock } = makeLimits();
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT);
    clock.advance(DEVICE_LOCKOUT_BASE_MS);
    limits.failed(SOURCE); // a 120 s lockout, so two windows fit inside it
    for (let i = 0; i < 50; i++) {
      expect(limits.allow(SOURCE)).toBe(false);
      clock.advance(10);
    }
    expect(refusedLines(events)).toEqual([]);

    clock.advance(REFUSED_AUDIT_WINDOW_MS - 500 - 1);
    expect(limits.allow(SOURCE)).toBe(false);
    expect(refusedLines(events)).toEqual([]);

    // The first call after the window closes writes the line; there is no timer.
    clock.advance(1);
    expect(limits.allow(OTHER_SOURCE)).toBe(false);
    expect(refusedLines(events)).toEqual([{ kind: "join-refused", source: SOURCE, count: 51 }]);

    // That refusal opens the next window, and names the latest source.
    clock.advance(REFUSED_AUDIT_WINDOW_MS);
    limits.succeeded();
    expect(refusedLines(events)).toEqual([
      { kind: "join-refused", source: SOURCE, count: 51 },
      { kind: "join-refused", source: OTHER_SOURCE, count: 1 },
    ]);
  });

  it("writes no line while nothing was refused", () => {
    const { limits, events, clock } = makeLimits();
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT);
    clock.advance(DEVICE_LOCKOUT_BASE_MS);
    expect(limits.allow(SOURCE)).toBe(true);
    expect(refusedLines(events)).toEqual([]);
  });

  it("a throwing audit never breaks the limiter", () => {
    const clock = fakeClock(1_000_000);
    const limits = createJoinLimits({
      now: clock.now,
      audit: {
        record() {
          throw new Error("disk full");
        },
      },
    });
    failTimes(limits, DEVICE_FAILURES_BEFORE_LOCKOUT);
    expect(limits.allow(SOURCE)).toBe(false);
    clock.advance(DEVICE_LOCKOUT_BASE_MS);
    expect(limits.allow(SOURCE)).toBe(true);
  });
});
