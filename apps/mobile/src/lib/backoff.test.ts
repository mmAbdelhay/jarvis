import { describe, expect, it } from "vitest";
import { createBackoff } from "./backoff";

describe("createBackoff", () => {
  it("doubles from 1000ms to a 30000ms cap with no jitter at random()=0.5", () => {
    const backoff = createBackoff(() => 0.5);
    expect(backoff.next()).toBe(1_000);
    expect(backoff.next()).toBe(2_000);
    expect(backoff.next()).toBe(4_000);
    expect(backoff.next()).toBe(8_000);
    expect(backoff.next()).toBe(16_000);
    expect(backoff.next()).toBe(30_000); // 32000 capped
    expect(backoff.next()).toBe(30_000); // stays capped
  });

  it("applies -20% jitter at random()=0", () => {
    const backoff = createBackoff(() => 0);
    expect(backoff.next()).toBe(800); // 1000 - 20%
    expect(backoff.next()).toBe(1_600); // 2000 - 20%
  });

  it("applies +20% jitter at random()=1", () => {
    const backoff = createBackoff(() => 1);
    expect(backoff.next()).toBe(1_200); // 1000 + 20%
    expect(backoff.next()).toBe(2_400); // 2000 + 20%
  });

  it("caps jitter within bounds at an arbitrary random()", () => {
    const backoff = createBackoff(() => 0.75);
    const delay = backoff.next();
    expect(delay).toBeGreaterThanOrEqual(800);
    expect(delay).toBeLessThanOrEqual(1_200);
  });

  it("reset() returns the sequence to 1000ms", () => {
    const backoff = createBackoff(() => 0.5);
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.next()).toBe(1_000);
  });
});
