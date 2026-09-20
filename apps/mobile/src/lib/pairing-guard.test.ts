import { describe, expect, it } from "vitest";
import { isClearingPairing, setClearingPairing } from "./pairing-guard";

describe("pairing-guard", () => {
  it("defaults to false", () => {
    expect(isClearingPairing()).toBe(false);
  });

  it("reflects whatever was last set", () => {
    setClearingPairing(true);
    expect(isClearingPairing()).toBe(true);

    setClearingPairing(false);
    expect(isClearingPairing()).toBe(false);
  });

  it(
    "R-M6: a counter, not a shared boolean — two overlapping clearers (A, B) " +
      "stay 'clearing' until both end, in either order " +
      "[bite-proof: a plain boolean; isClearingPairing() reads false as soon " +
      "as A ends, while B is still clearing]",
    () => {
      setClearingPairing(true); // A begins
      setClearingPairing(true); // B begins
      expect(isClearingPairing()).toBe(true);

      setClearingPairing(false); // A ends
      expect(isClearingPairing()).toBe(true); // B is still clearing

      setClearingPairing(false); // B ends
      expect(isClearingPairing()).toBe(false);
    },
  );

  it("the reverse order (B ends first, then A) also holds until both end", () => {
    setClearingPairing(true); // A begins
    setClearingPairing(true); // B begins

    setClearingPairing(false); // B ends first
    expect(isClearingPairing()).toBe(true); // A is still clearing

    setClearingPairing(false); // A ends
    expect(isClearingPairing()).toBe(false);
  });

  it("an end without a matching begin never goes negative", () => {
    setClearingPairing(false);
    setClearingPairing(false);
    expect(isClearingPairing()).toBe(false);

    // A single real begin afterward still reads as clearing — an
    // over-clamped counter stuck below 0 would need two `true`s to
    // recover.
    setClearingPairing(true);
    expect(isClearingPairing()).toBe(true);
    setClearingPairing(false);
    expect(isClearingPairing()).toBe(false);
  });
});
