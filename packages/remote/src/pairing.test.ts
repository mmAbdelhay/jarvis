import { describe, expect, it, vi } from "vitest";
import { fakeClock } from "./clock-double.js";
import type { RandomBytes } from "./io.js";
import {
  CONFIRMATION_TTL_MS,
  createPairing,
  PAIRING_TTL_MS,
  type PairingChange,
  type PairingStatus,
} from "./pairing.js";

/** A RandomBytes double that fills each call's buffer with an incrementing byte, so successive secrets/ids never collide. */
const SOURCE = "10.0.0.1:1";

function countingRandom(): RandomBytes {
  let call = 0;
  return (size: number) => Buffer.alloc(size, ++call);
}

function makePairing(overrides: { random?: RandomBytes; start?: number } = {}) {
  const clock = fakeClock(overrides.start ?? 0);
  const random = overrides.random ?? countingRandom();
  const changes: PairingChange[] = [];
  const statuses: PairingStatus[] = [];
  const onChange = vi.fn((status: PairingStatus, change: PairingChange) => {
    statuses.push(status);
    changes.push(change);
  });
  const pairing = createPairing({ random, now: clock.now, timers: clock.timers, onChange });
  return { pairing, clock, onChange, changes, statuses };
}

describe("createPairing", () => {
  it("open() mints a 43-char secret expiring in 120s, and emits opened", () => {
    const { pairing, changes } = makePairing();
    const { secret, expiresAt } = pairing.open();

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBe(PAIRING_TTL_MS);
    expect(pairing.status()).toEqual({ kind: "open", secret, expiresAt });
    expect(changes).toEqual(["opened"]);
  });

  it("begin() before open() is closed", () => {
    const { pairing } = makePairing();
    expect(pairing.begin("anything", "Phone", SOURCE)).toEqual({ ok: false, reason: "closed" });
  });

  it("[bite-proof] a secret expires at exactly 120s, not a moment before", () => {
    const { pairing, clock, changes } = makePairing();
    const { secret } = pairing.open();

    clock.advance(119_999);
    expect(pairing.status().kind).toBe("open");

    clock.advance(1);
    expect(pairing.status()).toEqual({ kind: "closed" });
    expect(changes).toEqual(["opened", "expired"]);
    expect(pairing.begin(secret, "Phone", SOURCE)).toEqual({ ok: false, reason: "closed" });
  });

  it("[fix] begin() also checks the clock directly, not just the timer: a window whose timer never fires still closes at expiresAt", () => {
    // A Timers double that records nothing and never calls back — proves
    // `begin()`'s own `now() >= state.expiresAt` check is what closes the
    // window here, independent of the 120s timer (already covered by the
    // "expires at exactly 120s" bite-proof above).
    const inertTimers = { setTimeout: () => 0, clearTimeout: () => undefined };
    const random = countingRandom();
    const changes: PairingChange[] = [];
    let time = 0;
    const pairing = createPairing({
      random,
      now: () => time,
      timers: inertTimers,
      onChange: (_status, change) => changes.push(change),
    });

    const { secret, expiresAt } = pairing.open();
    time = expiresAt; // now() >= expiresAt, but the inert timer never fires

    expect(pairing.status().kind).toBe("open"); // nothing has closed it yet — only begin() checks now()
    expect(pairing.begin(secret, "Phone", SOURCE)).toEqual({ ok: false, reason: "closed" });
    expect(changes).toEqual(["opened", "expired"]);
    expect(pairing.status()).toEqual({ kind: "closed" });
  });

  it("a wrong secret is a mismatch, and the window stays open for the right one", () => {
    const { pairing } = makePairing();
    const { secret } = pairing.open();

    expect(pairing.begin("not-the-secret-at-all-xxxxxxxxxxxxxxxxxxxxx", "Phone", SOURCE)).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(pairing.status().kind).toBe("open");

    const result = pairing.begin(secret, "Phone", SOURCE);
    expect(result.ok).toBe(true);
  });

  it("[bite-proof] a secret is single-use: reusing it while confirming is busy, and it is gone after decide()", async () => {
    const { pairing } = makePairing();
    const { secret } = pairing.open();

    const first = pairing.begin(secret, "Phone", SOURCE);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");
    expect(JSON.stringify(pairing.status())).not.toContain(secret);

    expect(pairing.begin(secret, "Phone", SOURCE)).toEqual({ ok: false, reason: "busy" });

    expect(pairing.decide(first.requestId, true)).toBe(true);
    await first.decision;
    expect(pairing.begin(secret, "Phone", SOURCE)).toEqual({ ok: false, reason: "closed" });
  });

  it("a second open() mismatches the first secret but works with the second", () => {
    const { pairing } = makePairing();
    const { secret: first } = pairing.open();
    const { secret: second } = pairing.open();

    expect(pairing.begin(first, "Phone", SOURCE)).toEqual({ ok: false, reason: "mismatch" });
    expect(pairing.begin(second, "Phone", SOURCE).ok).toBe(true);
  });

  // P15/D4: the connecting address is carried on the confirming status —
  // a photographed QR lets an attacker name itself "iPhone" too, but not
  // choose the address it connects from.
  it("carries the connecting source as `address` on the confirming status", () => {
    const { pairing } = makePairing();
    const { secret } = pairing.open();
    pairing.begin(secret, "Phone", SOURCE);

    expect(pairing.status()).toMatchObject({ kind: "confirming", address: SOURCE });
  });

  it("open() while confirming resolves the pending decision cancelled", async () => {
    const { pairing } = makePairing();
    const { secret } = pairing.open();
    const begun = pairing.begin(secret, "Phone", SOURCE);
    if (!begun.ok) throw new Error("unreachable");

    pairing.open();
    await expect(begun.decision).resolves.toBe("cancelled");
  });

  it("decide() rejects a wrong id, accepts the right one once, and a deny resolves denied", async () => {
    const { pairing } = makePairing();
    const { secret } = pairing.open();
    const begun = pairing.begin(secret, "Phone", SOURCE);
    if (!begun.ok) throw new Error("unreachable");

    expect(pairing.decide("not-the-id", true)).toBe(false);
    expect(pairing.decide(begun.requestId, true)).toBe(true);
    expect(pairing.decide(begun.requestId, true)).toBe(false);
    await expect(begun.decision).resolves.toBe("approved");
  });

  it("a deny resolves denied", async () => {
    const { pairing } = makePairing();
    const { secret } = pairing.open();
    const begun = pairing.begin(secret, "Phone", SOURCE);
    if (!begun.ok) throw new Error("unreachable");

    expect(pairing.decide(begun.requestId, false)).toBe(true);
    await expect(begun.decision).resolves.toBe("denied");
  });

  it("advancing 60s while confirming times out and closes", async () => {
    const { pairing, clock } = makePairing();
    const { secret } = pairing.open();
    const begun = pairing.begin(secret, "Phone", SOURCE);
    if (!begun.ok) throw new Error("unreachable");

    clock.advance(CONFIRMATION_TTL_MS);
    await expect(begun.decision).resolves.toBe("timed-out");
    expect(pairing.status()).toEqual({ kind: "closed" });
  });

  it("begin() clears the window timer: confirming survives past the original 120s mark", () => {
    const { pairing, clock } = makePairing();
    const { secret } = pairing.open();
    clock.advance(119_000);
    const begun = pairing.begin(secret, "Phone", SOURCE);
    expect(begun.ok).toBe(true);

    clock.advance(5_000); // now 124s from open() — past the window's original 120s
    expect(pairing.status().kind).toBe("confirming");
  });

  it("cancel() closes as cancelled, and the change sequence is opened, requested, cancelled", async () => {
    const { pairing, changes } = makePairing();
    const { secret } = pairing.open();
    const begun = pairing.begin(secret, "Phone", SOURCE);
    if (!begun.ok) throw new Error("unreachable");

    pairing.cancel();
    await expect(begun.decision).resolves.toBe("cancelled");
    expect(changes).toEqual(["opened", "requested", "cancelled"]);
    expect(pairing.status()).toEqual({ kind: "closed" });
  });
});
