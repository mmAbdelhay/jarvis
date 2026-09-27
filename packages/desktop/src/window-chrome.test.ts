import { readFileSync } from "node:fs";
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

  // The overlay's height is a literal copy of the topbar's (see
  // window-chrome.ts). The redesign moved the bar from 40px to 48px and the
  // first version of this fix copied the stale 40 — the buttons then sat
  // 8px short of the bar. The last top-level `.topbar` rule is the one that
  // wins, so it is the one to match.
  it("matches the overlay height to the stylesheet's topbar", () => {
    const css = readFileSync(new URL("../renderer/styles.css", import.meta.url), "utf8");
    const heights = [...css.matchAll(/^\.topbar \{[^}]*?\bheight: (\d+)px/gm)].map((m) =>
      Number(m[1]),
    );
    const overlay = windowChrome("linux").titleBarOverlay;
    expect(heights.length).toBeGreaterThan(0);
    expect(typeof overlay === "object" && overlay.height).toBe(heights.at(-1));
  });
});
