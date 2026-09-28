import { describe, expect, it } from "vitest";
import { layoutClassFor } from "./layout-class";

describe("layoutClassFor", () => {
  it.each([
    [412, 915, "phone", false],
    [915, 412, "phone", false],
    [744, 1133, "wide", true],
    [768, 1024, "wide", true],
    [820, 1180, "wide", true],
    [1024, 768, "wide", false],
    [1366, 1024, "wide", false],
    [1920, 1080, "wide", false],
  ] as const)("%i×%i is %s (compact %s)", (width, height, kind, compact) => {
    expect(layoutClassFor({ width, height })).toEqual({ kind, compact });
  });

  it("is compact at 899 wide and not at 900", () => {
    expect(layoutClassFor({ width: 899, height: 1000 })).toEqual({ kind: "wide", compact: true });
    expect(layoutClassFor({ width: 900, height: 1000 })).toEqual({ kind: "wide", compact: false });
  });

  it("is never compact on a phone", () => {
    expect(layoutClassFor({ width: 390, height: 844 }).compact).toBe(false);
  });
});
