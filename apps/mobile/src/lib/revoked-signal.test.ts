import { describe, expect, it } from "vitest";
import { setRevokedSignal, takeRevokedSignal } from "./revoked-signal";

describe("revoked-signal", () => {
  it("is off until set, and reading it clears it", () => {
    takeRevokedSignal();
    expect(takeRevokedSignal()).toBe(false);
    setRevokedSignal();
    expect(takeRevokedSignal()).toBe(true);
    expect(takeRevokedSignal()).toBe(false);
  });
});
