import { describe, expect, it } from "vitest";
import { fakeClock } from "./clock-double.js";
import {
  AUTH_BACKOFF_BASE_MS,
  AUTH_BACKOFF_MAX_MS,
  createAuthBackoff,
  createRateLimiter,
  MAX_TRACKED_SOURCES,
} from "./limits.js";

describe("createRateLimiter", () => {
  it("allows 200, refuses the 201st, still refuses at +9999ms, allows at +10000ms", () => {
    const clock = fakeClock(0);
    const limiter = createRateLimiter(clock.now);

    for (let i = 0; i < 200; i++) expect(limiter.take()).toBe(true);
    expect(limiter.take()).toBe(false);

    clock.advance(9_999);
    expect(limiter.take()).toBe(false);

    clock.advance(1); // now at +10000ms from the first 200 stamps
    expect(limiter.take()).toBe(true);
  });
});

describe("createAuthBackoff", () => {
  it("blocks consecutive failures for 1, 2, 4, 8, 16, 32, 60, 60s", () => {
    const clock = fakeClock(0);
    const backoff = createAuthBackoff(clock.now);
    const delays = [1, 2, 4, 8, 16, 32, 60, 60].map((s) => s * 1000);

    for (const delay of delays) {
      backoff.fail("s1");
      expect(backoff.isBlocked("s1")).toBe(true);
      clock.advance(delay - 1);
      expect(backoff.isBlocked("s1")).toBe(true);
      clock.advance(1);
      expect(backoff.isBlocked("s1")).toBe(false);
    }
  });

  it("blocks only the failing source", () => {
    const clock = fakeClock(0);
    const backoff = createAuthBackoff(clock.now);
    backoff.fail("s1");
    expect(backoff.isBlocked("s1")).toBe(true);
    expect(backoff.isBlocked("s2")).toBe(false);
  });

  it("succeed() resets the source, clearing any block", () => {
    const clock = fakeClock(0);
    const backoff = createAuthBackoff(clock.now);
    backoff.fail("s1");
    backoff.fail("s1");
    expect(backoff.isBlocked("s1")).toBe(true);
    backoff.succeed("s1");
    expect(backoff.isBlocked("s1")).toBe(false);
  });

  it(`evicts the first key once a new source would push past ${MAX_TRACKED_SOURCES} tracked`, () => {
    const clock = fakeClock(0);
    const backoff = createAuthBackoff(clock.now);
    for (let i = 0; i < MAX_TRACKED_SOURCES; i++) backoff.fail(`source-${i}`);
    expect(backoff.isBlocked("source-0")).toBe(true);

    backoff.fail(`source-${MAX_TRACKED_SOURCES}`); // the 1025th distinct source
    expect(backoff.isBlocked("source-0")).toBe(false);
    expect(backoff.isBlocked(`source-${MAX_TRACKED_SOURCES}`)).toBe(true);
  });

  it("exposes the base and max delay constants used above", () => {
    expect(AUTH_BACKOFF_BASE_MS).toBe(1_000);
    expect(AUTH_BACKOFF_MAX_MS).toBe(60_000);
  });

  describe("shouldLogBlocked", () => {
    it("returns true once per block period, then false until a fresh fail() re-blocks it", () => {
      const clock = fakeClock(0);
      const backoff = createAuthBackoff(clock.now);
      backoff.fail("s1"); // 1s block

      expect(backoff.shouldLogBlocked("s1")).toBe(true);
      expect(backoff.shouldLogBlocked("s1")).toBe(false);
      expect(backoff.shouldLogBlocked("s1")).toBe(false);

      clock.advance(1_000); // block expires
      backoff.fail("s1"); // a fresh failure — a new block period
      expect(backoff.shouldLogBlocked("s1")).toBe(true);
      expect(backoff.shouldLogBlocked("s1")).toBe(false);
    });

    it("returns false for a source with no entry at all", () => {
      const clock = fakeClock(0);
      const backoff = createAuthBackoff(clock.now);
      expect(backoff.shouldLogBlocked("nope")).toBe(false);
    });

    it("succeed() clears the flag along with the rest of the entry", () => {
      const clock = fakeClock(0);
      const backoff = createAuthBackoff(clock.now);
      backoff.fail("s1");
      expect(backoff.shouldLogBlocked("s1")).toBe(true);
      backoff.succeed("s1");
      backoff.fail("s1");
      // A fresh entry after succeed() — the flag must not still read "logged".
      expect(backoff.shouldLogBlocked("s1")).toBe(true);
    });
  });

  describe("size", () => {
    it(`shares the ${MAX_TRACKED_SOURCES}-source eviction cap with isBlocked/fail, so shouldLogBlocked's own bookkeeping never grows past it`, () => {
      const clock = fakeClock(0);
      const backoff = createAuthBackoff(clock.now);
      for (let i = 0; i < 2_000; i++) {
        backoff.fail(`source-${i}`);
        backoff.shouldLogBlocked(`source-${i}`);
      }
      expect(backoff.size()).toBeLessThanOrEqual(MAX_TRACKED_SOURCES);
    });
  });
});
