import { describe, expect, it } from "vitest";
import { phaseAfterReadForJoin, setJoinNameSignal, takeJoinNameSignal } from "./join-name-signal";

describe("join-name-signal", () => {
  it("defaults to nothing", () => {
    expect(takeJoinNameSignal()).toBeUndefined();
  });

  it("is read once", () => {
    setJoinNameSignal("mac.tail1234.ts.net:9000");
    expect(takeJoinNameSignal()).toBe("mac.tail1234.ts.net:9000");
    expect(takeJoinNameSignal()).toBeUndefined();
  });
});

describe("phaseAfterReadForJoin", () => {
  it("a found machine goes to the join form once the machines are read", () => {
    expect(phaseAfterReadForJoin("scan", "mac.tail1234.ts.net")).toBe("join");
  });

  it("without one, the read's own answer", () => {
    expect(phaseAfterReadForJoin("scan", undefined)).toBe("scan");
    expect(phaseAfterReadForJoin("checkFailed", undefined)).toBe("checkFailed");
  });

  it("a failed read still fails closed", () => {
    expect(phaseAfterReadForJoin("checkFailed", "mac.tail1234.ts.net")).toBe("checkFailed");
  });
});
