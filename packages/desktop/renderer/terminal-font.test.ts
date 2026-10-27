// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TERMINAL_FONT_SIZE_MAX as CONFIG_MAX,
  TERMINAL_FONT_SIZE_MIN as CONFIG_MIN,
} from "../src/config.js";
import {
  onTerminalFontSize,
  resetTerminalFontZoom,
  setTerminalFontBase,
  terminalFontSize,
  zoomTerminalFont,
} from "./terminal-font.js";
import { TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "./terminal-theme.js";

const cssSize = (): string =>
  document.documentElement.style.getPropertyValue("--terminal-font-size");

beforeEach(() => {
  // Module state outlives a test: back to a base of 12 with no zoom.
  setTerminalFontBase(12);
  resetTerminalFontZoom();
});

describe("terminal font size", () => {
  it("accepts the same range config.ts does", () => {
    // The renderer cannot import config.ts's values, so it keeps a copy.
    expect(TERMINAL_FONT_SIZE_MIN).toBe(CONFIG_MIN);
    expect(TERMINAL_FONT_SIZE_MAX).toBe(CONFIG_MAX);
  });

  it("takes the saved size and tells the stylesheet and every listener", () => {
    const listener = vi.fn();
    const stop = onTerminalFontSize(listener);

    setTerminalFontBase(16);

    expect(terminalFontSize()).toBe(16);
    expect(cssSize()).toBe("16px");
    expect(listener).toHaveBeenCalledWith(16);
    stop();
  });

  it("ignores a saved size that is missing, not a number, or out of range", () => {
    for (const bad of [undefined, "16", Number.NaN, 4, 40]) setTerminalFontBase(bad);
    expect(terminalFontSize()).toBe(12);
  });

  it("zooms a pixel at a time and resets back to the saved size", () => {
    zoomTerminalFont(1);
    zoomTerminalFont(1);
    expect(terminalFontSize()).toBe(14);
    zoomTerminalFont(-1);
    expect(terminalFontSize()).toBe(13);

    resetTerminalFontZoom();
    expect(terminalFontSize()).toBe(12);
    expect(cssSize()).toBe("12px");
  });

  it("stops at the ends of the range, and zooming back moves at once", () => {
    for (let step = 0; step < 100; step++) zoomTerminalFont(1);
    expect(terminalFontSize()).toBe(TERMINAL_FONT_SIZE_MAX);
    // No hidden overshoot to climb back down through first.
    zoomTerminalFont(-1);
    expect(terminalFontSize()).toBe(TERMINAL_FONT_SIZE_MAX - 1);

    for (let step = 0; step < 100; step++) zoomTerminalFont(-1);
    expect(terminalFontSize()).toBe(TERMINAL_FONT_SIZE_MIN);
  });

  it("keeps the zoom when the same saved size arrives again, and drops it for a new one", () => {
    zoomTerminalFont(1);
    setTerminalFontBase(12);
    expect(terminalFontSize()).toBe(13);

    setTerminalFontBase(14);
    expect(terminalFontSize()).toBe(14);
  });

  it("tells nobody after an unsubscribe, and nothing when nothing changed", () => {
    const listener = vi.fn();
    const stop = onTerminalFontSize(listener);
    resetTerminalFontZoom();
    setTerminalFontBase(12);
    expect(listener).not.toHaveBeenCalled();

    stop();
    zoomTerminalFont(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps telling the other listeners when one throws", () => {
    const stopBad = onTerminalFontSize(() => {
      throw new Error("disposed terminal");
    });
    const good = vi.fn();
    const stopGood = onTerminalFontSize(good);

    zoomTerminalFont(1);

    expect(good).toHaveBeenCalledWith(13);
    stopBad();
    stopGood();
  });
});
