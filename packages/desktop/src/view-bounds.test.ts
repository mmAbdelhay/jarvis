import { describe, expect, it } from "vitest";
import { toDeviceIndependent } from "./view-bounds.js";

describe("toDeviceIndependent", () => {
  const rect = { x: 12, y: 224, width: 1440, height: 676 };

  // The ordinary display: a CSS pixel and a DIP are the same size, so the
  // rectangle must cross untouched rather than pick up rounding drift.
  it("leaves a rectangle alone on an unscaled display", () => {
    expect(toDeviceIndependent(rect, 2, 2)).toEqual(rect);
    expect(toDeviceIndependent(rect, 1, 1)).toEqual(rect);
  });

  // The display this bug was found on: devicePixelRatio 2.1909 against a
  // scale factor of 2. A slot filling a 1577px viewport has to come out
  // filling the 1728 DIP window.
  it("scales a full-viewport slot up to fill the window", () => {
    const out = toDeviceIndependent(
      { x: 0, y: 224, width: 1577, height: 766 },
      2.190890312194824,
      2,
    );
    expect(out.x).toBe(0);
    expect(out.width).toBe(1728);
  });

  // The same ratio on both axes: a scaled display scales the whole picture,
  // and deriving the vertical factor separately is what put the view past
  // the bottom of the window.
  it("uses one ratio for both axes", () => {
    const out = toDeviceIndependent({ x: 100, y: 100, width: 200, height: 200 }, 3, 2);
    expect(out).toEqual({ x: 150, y: 150, width: 300, height: 300 });
  });

  it("scales the offset as well as the size", () => {
    const out = toDeviceIndependent({ x: 10, y: 20, width: 30, height: 40 }, 4, 2);
    expect(out).toEqual({ x: 20, y: 40, width: 60, height: 80 });
  });

  // Nonsense in, rectangle out: moving a view to NaN loses it entirely.
  it("refuses a scale it cannot use", () => {
    expect(toDeviceIndependent(rect, 0, 2)).toEqual(rect);
    expect(toDeviceIndependent(rect, 2, 0)).toEqual(rect);
    expect(toDeviceIndependent(rect, Number.NaN, 2)).toEqual(rect);
    expect(toDeviceIndependent(rect, -2, 2)).toEqual(rect);
  });
});
