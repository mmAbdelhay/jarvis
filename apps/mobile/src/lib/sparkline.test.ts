import { describe, expect, it } from "vitest";
import { ringDash, sparklinePoints } from "./sparkline";

describe("sparklinePoints", () => {
  it("draws one value as a flat line across the whole width", () => {
    expect(sparklinePoints([50])).toBe("0,14 140,14");
  });

  it("maps 100 to the top inset and 0 to the bottom inset", () => {
    expect(sparklinePoints([100, 0])).toBe("0,2 140,26");
  });

  it("clamps values outside 0-100", () => {
    expect(sparklinePoints([150, -20])).toBe(sparklinePoints([100, 0]));
  });

  it("spreads the values evenly", () => {
    expect(
      sparklinePoints([0, 0, 0])
        .split(" ")
        .map((p) => p.split(",")[0]),
    ).toEqual(["0", "70", "140"]);
  });

  it("gives nothing for no values", () => {
    expect(sparklinePoints([])).toBe("");
  });
});

describe("ringDash", () => {
  it("covers the given fraction of the circle", () => {
    expect(ringDash(0)).toBe("0 94.2");
    expect(ringDash(1)).toBe("94.2 94.2");
    expect(ringDash(0.429)).toBe("40.4 94.2");
  });

  it("clamps and survives a non-number", () => {
    expect(ringDash(2)).toBe(ringDash(1));
    expect(ringDash(Number.NaN)).toBe(ringDash(0));
  });
});
