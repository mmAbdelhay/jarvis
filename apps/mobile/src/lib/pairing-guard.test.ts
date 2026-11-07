import { describe, expect, it } from "vitest";
import { isClearingPairing, setClearingPairing } from "./pairing-guard";

const A = "a_1";
const B = "b_1";

describe("pairing-guard", () => {
  it("defaults to false", () => {
    expect(isClearingPairing(A)).toBe(false);
    expect(isClearingPairing(null)).toBe(false);
  });

  it("reflects whatever was last set", () => {
    setClearingPairing(A, true);
    expect(isClearingPairing(A)).toBe(true);

    setClearingPairing(A, false);
    expect(isClearingPairing(A)).toBe(false);
  });

  it("clearing A blocks A only", () => {
    setClearingPairing(A, true);
    expect(isClearingPairing(A)).toBe(true);
    expect(isClearingPairing(B)).toBe(false);
    expect(isClearingPairing(null)).toBe(false);
    setClearingPairing(A, false);
  });

  it("the null scope counts on its own", () => {
    setClearingPairing(null, true);
    expect(isClearingPairing(null)).toBe(true);
    expect(isClearingPairing(A)).toBe(false);
    setClearingPairing(null, false);
    expect(isClearingPairing(null)).toBe(false);
  });

  it(
    "R-M6: a counter, not a shared boolean — two overlapping clearers (A, B) " +
      "stay 'clearing' until both end, in either order " +
      "[bite-proof: a plain boolean; isClearingPairing() reads false as soon " +
      "as A ends, while B is still clearing]",
    () => {
      setClearingPairing(A, true); // first begins
      setClearingPairing(A, true); // second begins
      expect(isClearingPairing(A)).toBe(true);

      setClearingPairing(A, false); // first ends
      expect(isClearingPairing(A)).toBe(true); // second is still clearing

      setClearingPairing(A, false); // second ends
      expect(isClearingPairing(A)).toBe(false);
    },
  );

  it("counts per id: an end for B leaves A's clear in place", () => {
    setClearingPairing(A, true);
    setClearingPairing(B, true);
    setClearingPairing(B, false);
    expect(isClearingPairing(A)).toBe(true);
    expect(isClearingPairing(B)).toBe(false);
    setClearingPairing(A, false);
    expect(isClearingPairing(A)).toBe(false);
  });

  it("an end without a matching begin never goes negative", () => {
    setClearingPairing(A, false);
    setClearingPairing(A, false);
    expect(isClearingPairing(A)).toBe(false);

    // A single real begin afterward still reads as clearing — an
    // over-clamped counter stuck below 0 would need two `true`s to
    // recover.
    setClearingPairing(A, true);
    expect(isClearingPairing(A)).toBe(true);
    setClearingPairing(A, false);
    expect(isClearingPairing(A)).toBe(false);
  });
});
