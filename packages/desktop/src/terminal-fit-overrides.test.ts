import { describe, expect, it } from "vitest";
import { createTerminalFitOverrides } from "./terminal-fit-overrides.js";

function setup() {
  const resizes: [string, number, number][] = [];
  const fit = createTerminalFitOverrides({
    resize: (paneKey, cols, rows) => resizes.push([paneKey, cols, rows]),
  });
  return { fit, resizes };
}

describe("createTerminalFitOverrides", () => {
  it("a fit on a pane the desktop never sized is not an override", () => {
    const { fit, resizes } = setup();
    expect(fit.fit("t1", "phone", { cols: 40, rows: 90 })).toBe(false);
    expect(resizes).toEqual([]);
  });

  it("a fit resizes a desktop-sized pane; the restore gives the desktop's size back", () => {
    const { fit, resizes } = setup();
    fit.desktopResized("t1", { cols: 120, rows: 40 });
    expect(fit.fit("t1", "phone", { cols: 40, rows: 90 })).toBe(true);
    expect(fit.restore("t1")).toEqual({ cols: 120, rows: 40 });
    expect(resizes).toEqual([
      ["t1", 40, 90],
      ["t1", 120, 40],
    ]);
  });

  it("a desktop resize during Fit ends it: a later restore resizes nothing, but says the size", () => {
    const { fit, resizes } = setup();
    fit.desktopResized("t1", { cols: 120, rows: 40 });
    fit.fit("t1", "phone", { cols: 40, rows: 90 });
    fit.desktopResized("t1", { cols: 150, rows: 45 });
    expect(fit.restore("t1")).toEqual({ cols: 150, rows: 45 });
    expect(resizes).toEqual([["t1", 40, 90]]);
  });

  it("restores the desktop's size on the fitting device's disconnect, once", () => {
    const { fit, resizes } = setup();
    fit.desktopResized("t1", { cols: 120, rows: 40 });
    fit.desktopResized("t2", { cols: 100, rows: 30 });
    fit.fit("t1", "phone", { cols: 40, rows: 90 });
    fit.fit("t2", "tablet", { cols: 60, rows: 50 });
    resizes.length = 0;

    fit.deviceDisconnected("phone");
    fit.deviceDisconnected("phone");

    expect(resizes).toEqual([["t1", 120, 40]]);
    expect(fit.restore("t1")).toEqual({ cols: 120, rows: 40 });
    expect(resizes).toHaveLength(1);
  });

  it("forgets a closed pane entirely", () => {
    const { fit } = setup();
    fit.desktopResized("t1", { cols: 120, rows: 40 });
    fit.forget("t1");
    expect(fit.isDesktopSized("t1")).toBe(false);
  });
});
