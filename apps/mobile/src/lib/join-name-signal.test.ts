import { describe, expect, it, vi } from "vitest";
import {
  openJoinWithName,
  phaseAfterReadForJoin,
  setJoinNameSignal,
  takeJoinNameSignal,
} from "./join-name-signal";

describe("openJoinWithName", () => {
  it("sets the name only when the navigation runs", () => {
    let action: (() => void) | undefined;
    const gate = {
      navigate: (a: () => void) => {
        action = a;
      },
    };
    const push = vi.fn();
    openJoinWithName(gate, "mac.tail1234.ts.net", push);
    expect(takeJoinNameSignal()).toBeUndefined();
    action!();
    expect(push).toHaveBeenCalledOnce();
    expect(takeJoinNameSignal()).toBe("mac.tail1234.ts.net");
  });

  it("a dropped navigation leaves no name for the next /pair visit", () => {
    const gate = { navigate: (_a: () => void, onDropped?: () => void) => onDropped?.() };
    const push = vi.fn();
    openJoinWithName(gate, "mac.tail1234.ts.net", push);
    expect(push).not.toHaveBeenCalled();
    expect(takeJoinNameSignal()).toBeUndefined();
  });
});

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
