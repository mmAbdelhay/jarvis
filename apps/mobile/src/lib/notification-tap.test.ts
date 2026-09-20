// task-5-brief.md, "Tests: notification-tap.test.ts" and rule 8.
import { describe, expect, test } from "vitest";
import { NOTIFICATION_NAV_WAIT_MS, planNavigation } from "./notification-tap";

describe("planNavigation (rule 8)", () => {
  test("a session-* kind whose sessionId is in the given set -> /session/<id>", () => {
    const plan = planNavigation({ kind: "session-done", sessionId: "s1" }, new Set(["s1"]));
    expect(plan).toEqual({ route: "/session/s1" });
  });

  test(
    "a session-* kind whose sessionId is absent from the set -> unknown-session " +
      "[bite-proof: skip the set check]",
    () => {
      const plan = planNavigation({ kind: "session-done", sessionId: "s1" }, new Set(["s2"]));
      expect(plan).toEqual({ route: undefined, reason: "unknown-session" });
    },
  );

  test("session-failed and session-waiting behave the same as session-done", () => {
    expect(planNavigation({ kind: "session-failed", sessionId: "s1" }, new Set(["s1"]))).toEqual({
      route: "/session/s1",
    });
    expect(planNavigation({ kind: "session-waiting", sessionId: "s1" }, new Set(["s1"]))).toEqual({
      route: "/session/s1",
    });
  });

  test("a session-* kind with no sessionId at all -> unknown-session", () => {
    const plan = planNavigation({ kind: "session-done" }, new Set(["s1"]));
    expect(plan).toEqual({ route: undefined, reason: "unknown-session" });
  });

  test("kind: reply -> /voice", () => {
    const plan = planNavigation({ kind: "reply" }, new Set());
    expect(plan).toEqual({ route: "/voice" });
  });

  test("kind: command-finished -> dashboard", () => {
    const plan = planNavigation({ kind: "command-finished" }, new Set(["s1"]));
    expect(plan).toEqual({ route: undefined, reason: "dashboard" });
  });

  test("a sessionId that fails parsePushData's own validation -> invalid", () => {
    const plan = planNavigation({ kind: "session-done", sessionId: "../x" }, new Set(["../x"]));
    expect(plan).toEqual({ route: undefined, reason: "invalid" });
  });

  test("data with no recognizable shape at all (a raw deep link string) -> invalid", () => {
    const plan = planNavigation({ url: "jarvis://session/s1" }, new Set(["s1"]));
    expect(plan).toEqual({ route: undefined, reason: "invalid" });
  });

  test("null -> invalid", () => {
    const plan = planNavigation(null, new Set(["s1"]));
    expect(plan).toEqual({ route: undefined, reason: "invalid" });
  });

  test("an unknown kind -> invalid (parsePushData itself already rejects it)", () => {
    const plan = planNavigation({ kind: "bogus" }, new Set());
    expect(plan).toEqual({ route: undefined, reason: "invalid" });
  });

  test("the route string is built from the validated id only, not the raw input", () => {
    // A malicious-looking id that nonetheless matches SUBSCRIPTION_KEY_PATTERN
    // still only ever produces "/session/<that exact id>" — no extra
    // interpolation, no query string, nothing appended.
    const plan = planNavigation(
      { kind: "session-done", sessionId: "a.b-c_d" },
      new Set(["a.b-c_d"]),
    );
    expect(plan).toEqual({ route: "/session/a.b-c_d" });
  });
});

test("NOTIFICATION_NAV_WAIT_MS is 15_000", () => {
  expect(NOTIFICATION_NAV_WAIT_MS).toBe(15_000);
});
