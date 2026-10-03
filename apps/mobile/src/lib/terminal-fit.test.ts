import { describe, expect, it } from "vitest";
import { createTerminalFit, type TerminalSize } from "./terminal-fit";

function setup() {
  const sent: TerminalSize[] = [];
  const fit = createTerminalFit({ send: (size) => sent.push(size) });
  return { fit, sent };
}

describe("createTerminalFit", () => {
  it("starts off and sends nothing for page sizes while off", () => {
    const { fit, sent } = setup();
    fit.pageSize({ cols: 48, rows: 40 });
    expect(fit.isOn()).toBe(false);
    expect(sent).toEqual([]);
  });

  it("cannot turn on before the pty's size is known (nothing to restore to)", () => {
    const { fit } = setup();
    expect(fit.enable(undefined)).toBe(false);
    expect(fit.isOn()).toBe(false);
  });

  it("on: sends each new page size once, never a repeat", () => {
    const { fit, sent } = setup();
    expect(fit.enable({ cols: 200, rows: 50 })).toBe(true);
    fit.pageSize({ cols: 48, rows: 40 });
    fit.pageSize({ cols: 48, rows: 40 });
    fit.pageSize({ cols: 48, rows: 22 });
    expect(sent).toEqual([
      { cols: 48, rows: 40 },
      { cols: 48, rows: 22 },
    ]);
  });

  it("off: restores the desktop size captured at enable, and returns it", () => {
    const { fit, sent } = setup();
    fit.enable({ cols: 200, rows: 50 });
    fit.pageSize({ cols: 48, rows: 40 });
    expect(fit.disable()).toEqual({ cols: 200, rows: 50 });
    expect(fit.isOn()).toBe(false);
    expect(sent.at(-1)).toEqual({ cols: 200, rows: 50 });
    fit.pageSize({ cols: 48, rows: 40 });
    expect(sent).toHaveLength(2);
  });

  it("off when already off sends nothing", () => {
    const { fit, sent } = setup();
    expect(fit.disable()).toBeUndefined();
    expect(sent).toEqual([]);
  });

  it("a reported pty size that is its own echo, or the desktop's own, changes nothing", () => {
    const { fit, sent } = setup();
    fit.enable({ cols: 200, rows: 50 });
    expect(fit.ptyReported({ cols: 200, rows: 50 })).toBe(false);
    fit.pageSize({ cols: 48, rows: 40 });
    expect(fit.ptyReported({ cols: 48, rows: 40 })).toBe(false);
    expect(fit.isOn()).toBe(true);
    expect(sent).toEqual([{ cols: 48, rows: 40 }]);
  });

  it("a different size reported while on means the desktop resized: off, nothing sent back", () => {
    const { fit, sent } = setup();
    fit.enable({ cols: 200, rows: 50 });
    fit.pageSize({ cols: 48, rows: 40 });
    expect(fit.ptyReported({ cols: 160, rows: 45 })).toBe(true);
    expect(fit.isOn()).toBe(false);
    expect(sent).toEqual([{ cols: 48, rows: 40 }]);
    // Nothing left to restore: the desktop owns the size again.
    expect(fit.disable()).toBeUndefined();
    expect(sent).toHaveLength(1);
  });
});
