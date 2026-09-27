import { describe, expect, it } from "vitest";
import { windowChrome } from "./window-chrome.js";

describe("windowChrome", () => {
  // Bug 1: GNOME/Wayland (and some Windows configurations) hand the window
  // no min/max/close decorations at all — the WM simply doesn't draw them.
  // Electron's own titleBarOverlay draws them instead, independent of the WM.
  it("gives Linux a hidden native frame with an overlay", () => {
    expect(windowChrome("linux")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: expect.objectContaining({
        color: expect.any(String),
        symbolColor: expect.any(String),
        height: expect.any(Number),
      }),
    });
  });

  it("gives Windows the same hidden-frame overlay", () => {
    expect(windowChrome("win32")).toEqual({
      titleBarStyle: "hidden",
      titleBarOverlay: expect.objectContaining({
        color: expect.any(String),
        symbolColor: expect.any(String),
        height: expect.any(Number),
      }),
    });
  });

  // macOS already draws its own traffic lights without any of this.
  it("leaves macOS with the default (no overlay) chrome", () => {
    expect(windowChrome("darwin")).toEqual({});
  });
});
