import { describe, expect, it, vi } from "vitest";
import type { Clock, RandomBytes } from "./io.js";
import {
  createSidecarRegistry,
  HANDLE_MAX_AGE_MS,
  HANDLE_PATTERN,
  KEY_PATTERN,
  KEY_TTL_MS,
  MAX_HANDLES_PER_DEVICE,
  type SidecarTarget,
} from "./sidecar-registry.js";

// `timingSafeEqual` is mocked to a spy that calls through to the real
// implementation (same technique as tokens.test.ts): behaviour is
// unchanged, but the bite-proof test below can assert it was never invoked
// for a length mismatch, rather than a `===`/`Buffer.equals` short-circuit
// sneaking in unnoticed. A plain `vi.spyOn` can't do this — ESM named
// exports from a built-in module aren't configurable properties.
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

const { timingSafeEqual } = await import("node:crypto");

/** A RandomBytes double that fills each call's buffer with an incrementing byte, so successive calls never collide and callers can assert call order. */
function countingRandom(): RandomBytes {
  let call = 0;
  return (size: number) => Buffer.alloc(size, ++call);
}

/** A Clock double whose value only moves when the test advances it. */
function fakeClock(start: number): Clock & { advance(ms: number): void } {
  let now = start;
  const clock = () => now;
  clock.advance = (ms: number) => {
    now += ms;
  };
  return clock;
}

const TARGET: SidecarTarget = { kind: "editor", port: 9001 };
const START = 1_700_000_000_000;

describe("createSidecarRegistry — publish", () => {
  it("mints a 32-hex handle and a 64-hex key", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);

    expect(published.handle).toMatch(HANDLE_PATTERN);
    expect(published.key).toMatch(KEY_PATTERN);
    expect(registry.count()).toBe(1);
  });

  it("copies the target field-by-field: mutating the caller's object after publish does not change what redeemKey returns", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const target: SidecarTarget = {
      kind: "database",
      port: 5432,
      basicAuth: { login: "jarvis", password: "pw" },
    };
    const published = registry.publish("device-1", target);

    target.port = 1;
    if (target.basicAuth !== undefined) target.basicAuth.password = "changed";

    const redeemed = registry.redeemKey(published.handle, published.key);
    expect(redeemed?.target).toEqual({
      kind: "database",
      port: 5432,
      basicAuth: { login: "jarvis", password: "pw" },
    });
  });

  it("evicts the oldest of 8 live handles on a 9th publish for the same device — the first handle's cookie no longer resolves, the other 8 do", () => {
    const clock = fakeClock(START);
    const registry = createSidecarRegistry({ random: countingRandom(), now: clock });

    // Redeem each handle's key as it's published, before any later publish
    // can evict it — otherwise the evicted handle's cookie could never be
    // learned through the public API at all.
    const entries: { handle: string; cookie: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const published = registry.publish("device-1", TARGET);
      const redeemed = registry.redeemKey(published.handle, published.key);
      entries.push({ handle: published.handle, cookie: redeemed?.cookie as string });
      clock.advance(1);
    }
    expect(registry.count()).toBe(8);

    const ninthPublished = registry.publish("device-1", TARGET);
    const ninthRedeemed = registry.redeemKey(ninthPublished.handle, ninthPublished.key);
    const ninth = { handle: ninthPublished.handle, cookie: ninthRedeemed?.cookie as string };
    expect(registry.count()).toBe(8);

    // The first handle was evicted: its cookie no longer resolves.
    const first = entries[0] as { handle: string; cookie: string };
    expect(registry.resolveCookie(first.handle, first.cookie)).toBeUndefined();

    // The other 7 originally-published handles plus the 9th all still resolve.
    for (const entry of [...entries.slice(1), ninth]) {
      expect(registry.resolveCookie(entry.handle, entry.cookie)).toBeDefined();
    }
  });

  it("does not evict across devices: an 8-handle device stays intact when another device publishes", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const publishedForDeviceOne: { handle: string; key: string }[] = [];
    for (let i = 0; i < 8; i++) {
      publishedForDeviceOne.push(registry.publish("device-1", TARGET));
    }
    registry.publish("device-2", TARGET);

    expect(registry.count()).toBe(9);
    for (const entry of publishedForDeviceOne) {
      expect(registry.redeemKey(entry.handle, entry.key)).toBeDefined();
    }
  });
});

describe("createSidecarRegistry — redeemKey", () => {
  it("returns the cookie and a target copy on the first redeem", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);

    const redeemed = registry.redeemKey(published.handle, published.key);
    expect(redeemed).toBeDefined();
    expect(redeemed?.target).toEqual(TARGET);
    expect(redeemed?.cookie).toMatch(/^[0-9a-f]{64}$/);
  });

  it("[bite-proof] refuses a second redeem of the same key", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);

    expect(registry.redeemKey(published.handle, published.key)).toBeDefined();
    expect(registry.redeemKey(published.handle, published.key)).toBeUndefined();
  });

  it("[bite-proof] refuses a key redeemed past the 30000ms TTL", () => {
    const clock = fakeClock(START);
    const registry = createSidecarRegistry({ random: countingRandom(), now: clock });
    const published = registry.publish("device-1", TARGET);

    clock.advance(KEY_TTL_MS + 1);
    expect(registry.redeemKey(published.handle, published.key)).toBeUndefined();
  });

  it("accepts a key redeemed exactly at the TTL boundary", () => {
    const clock = fakeClock(START);
    const registry = createSidecarRegistry({ random: countingRandom(), now: clock });
    const published = registry.publish("device-1", TARGET);

    clock.advance(KEY_TTL_MS);
    expect(registry.redeemKey(published.handle, published.key)).toBeDefined();
  });

  it("refuses a handle past its 24h max age", () => {
    const clock = fakeClock(START);
    const registry = createSidecarRegistry({ random: countingRandom(), now: clock });
    const published = registry.publish("device-1", TARGET);

    clock.advance(HANDLE_MAX_AGE_MS);
    expect(registry.redeemKey(published.handle, published.key)).toBeUndefined();
  });

  it("refuses an unknown handle without throwing", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    expect(() => registry.redeemKey("a".repeat(32), "b".repeat(64))).not.toThrow();
    expect(registry.redeemKey("a".repeat(32), "b".repeat(64))).toBeUndefined();
  });

  it("refuses a wrong-length key without throwing, without calling timingSafeEqual", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);

    vi.mocked(timingSafeEqual).mockClear();
    expect(() => registry.redeemKey(published.handle, "short")).not.toThrow();
    expect(registry.redeemKey(published.handle, "short")).toBeUndefined();
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("refuses a 64-char non-ASCII candidate without throwing, without calling timingSafeEqual", () => {
    // "é" is one UTF-16 code unit but 2 UTF-8 bytes: a candidate built from
    // it can match `stored.length` in code units while being a different
    // byte length once turned into a Buffer — exactly the gap a length
    // check on `.length` alone would miss (Important 2 / fix round 1).
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);
    const nonAsciiCandidate = `${"é".repeat(63)}a`;
    expect(nonAsciiCandidate).toHaveLength(64);

    vi.mocked(timingSafeEqual).mockClear();
    expect(() => registry.redeemKey(published.handle, nonAsciiCandidate)).not.toThrow();
    expect(registry.redeemKey(published.handle, nonAsciiCandidate)).toBeUndefined();
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("calls timingSafeEqual exactly once on a successful equal-length compare", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);

    vi.mocked(timingSafeEqual).mockClear();
    expect(registry.redeemKey(published.handle, published.key)).toBeDefined();
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed handle without throwing", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    expect(() => registry.redeemKey("not-a-handle", "b".repeat(64))).not.toThrow();
    expect(registry.redeemKey("not-a-handle", "b".repeat(64))).toBeUndefined();
  });
});

describe("createSidecarRegistry — resolveCookie", () => {
  it("resolves a live handle's cookie to its handle/deviceId/target, target copied", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);
    const redeemed = registry.redeemKey(published.handle, published.key);
    const cookie = redeemed?.cookie as string;

    const resolved = registry.resolveCookie(published.handle, cookie);
    expect(resolved).toEqual({ handle: published.handle, deviceId: "device-1", target: TARGET });
  });

  it("refuses a wrong cookie without throwing", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);
    expect(() => registry.resolveCookie(published.handle, "f".repeat(64))).not.toThrow();
    expect(registry.resolveCookie(published.handle, "f".repeat(64))).toBeUndefined();
  });

  it("refuses a wrong-length cookie without throwing", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);
    expect(() => registry.resolveCookie(published.handle, "short")).not.toThrow();
    expect(registry.resolveCookie(published.handle, "short")).toBeUndefined();
  });

  it("refuses a 64-char non-ASCII candidate without throwing, without calling timingSafeEqual", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const published = registry.publish("device-1", TARGET);
    const nonAsciiCandidate = `${"é".repeat(63)}a`;
    expect(nonAsciiCandidate).toHaveLength(64);

    vi.mocked(timingSafeEqual).mockClear();
    expect(() => registry.resolveCookie(published.handle, nonAsciiCandidate)).not.toThrow();
    expect(registry.resolveCookie(published.handle, nonAsciiCandidate)).toBeUndefined();
    expect(timingSafeEqual).not.toHaveBeenCalled();
  });

  it("refuses a handle past its 24h max age, and deletes it (count() reflects it) for both cookie and key", () => {
    const clock = fakeClock(START);
    const registry = createSidecarRegistry({ random: countingRandom(), now: clock });
    const published = registry.publish("device-1", TARGET);
    const redeemed = registry.redeemKey(published.handle, published.key);
    const cookie = redeemed?.cookie as string;

    clock.advance(HANDLE_MAX_AGE_MS);
    expect(registry.resolveCookie(published.handle, cookie)).toBeUndefined();
    expect(registry.count()).toBe(0);
  });

  it("a key does not authenticate resolveCookie, and a cookie does not authenticate redeemKey", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const first = registry.publish("device-1", TARGET);
    expect(registry.resolveCookie(first.handle, first.key)).toBeUndefined();

    const redeemed = registry.redeemKey(first.handle, first.key);
    const cookie = redeemed?.cookie as string;

    // A fresh, still-unused handle: redeemKey's failure below is a value
    // mismatch (the cookie is not this handle's key), not a reused-key
    // rejection — isolating "a cookie does not authenticate redeemKey"
    // from "a key can only be redeemed once".
    const second = registry.publish("device-1", TARGET);
    expect(registry.redeemKey(second.handle, cookie)).toBeUndefined();
  });
});

describe("createSidecarRegistry — revokeDevice / clear", () => {
  it("revokeDevice deletes every handle of that device, returns the count, and leaves other devices' handles", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    const a1 = registry.publish("device-a", TARGET);
    const a2 = registry.publish("device-a", TARGET);
    const b1 = registry.publish("device-b", TARGET);

    expect(registry.revokeDevice("device-a")).toBe(2);
    expect(registry.count()).toBe(1);
    expect(registry.redeemKey(a1.handle, a1.key)).toBeUndefined();
    expect(registry.redeemKey(a2.handle, a2.key)).toBeUndefined();
    expect(registry.redeemKey(b1.handle, b1.key)).toBeDefined();
  });

  it("revokeDevice on an unknown device returns 0", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    expect(registry.revokeDevice("nobody")).toBe(0);
  });

  it("clear deletes every handle of every device", () => {
    const registry = createSidecarRegistry({ random: countingRandom(), now: () => START });
    registry.publish("device-a", TARGET);
    registry.publish("device-b", TARGET);

    registry.clear();
    expect(registry.count()).toBe(0);
  });

  it("MAX_HANDLES_PER_DEVICE is 8", () => {
    expect(MAX_HANDLES_PER_DEVICE).toBe(8);
  });
});
