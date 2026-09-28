import { describe, expect, it } from "vitest";
import { setPasskeyOfferSignal, takePasskeyOfferSignal } from "./passkey-offer-signal";

describe("passkey-offer-signal", () => {
  it("is off until pairing sets it, and is consumed exactly once", () => {
    expect(takePasskeyOfferSignal()).toBe(false);
    setPasskeyOfferSignal();
    expect(takePasskeyOfferSignal()).toBe(true);
    expect(takePasskeyOfferSignal()).toBe(false);
  });
});
