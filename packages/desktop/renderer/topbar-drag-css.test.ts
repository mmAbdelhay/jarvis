// A source assertion over styles.css — see history-overlay-css.test.ts for
// why: jsdom has no notion of -webkit-app-region (an Electron/Chromium-only
// property with no rendering effect to observe), so the fix is pinned at
// the CSS source instead.
//
// Bug 1: Linux/Windows now draw their min/max/close buttons via
// titleBarOverlay (window-chrome.ts) instead of the WM, painted over the
// window's own top-left area. Without `-webkit-app-region: drag` on
// `.topbar`, the window could no longer be dragged by its bar at all once
// the native frame was hidden — and without `no-drag` on the topbar's own
// interactive children, none of them could be clicked (a drag region
// swallows all pointer input).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

function ruleBody(pattern: RegExp): string {
  const match = pattern.exec(css);
  if (match === null) throw new Error(`No CSS rule found for ${pattern}`);
  const body = match[1];
  if (body === undefined) throw new Error(`No CSS rule found for ${pattern}`);
  return body;
}

describe("the topbar as a drag region", () => {
  it(".topbar itself is draggable", () => {
    const body = ruleBody(/\.topbar\s*\{([^}]*)\}/);
    expect(body).toMatch(/-webkit-app-region:\s*drag/);
  });

  it("its buttons, selects, inputs, pills and hover-tooltip chips opt back out of the drag region", () => {
    const body = ruleBody(
      /\.topbar (?:button|select|input|\.pill|\.prayer-chip|\.topbar-metrics|\.topbar-danger-dot)(?:,\s*\n?\s*\.topbar (?:button|select|input|\.pill|\.prayer-chip|\.topbar-metrics|\.topbar-danger-dot))*\s*\{([^}]*)\}/,
    );
    expect(body).toMatch(/-webkit-app-region:\s*no-drag/);
  });

  it("reserves room for the titlebar overlay's buttons on Linux/Windows, with a zero fallback", () => {
    expect(css).toMatch(/body\.platform-linux \.topbar,\s*\n?\s*body\.platform-win32 \.topbar/);
    expect(css).toMatch(/env\(titlebar-area-width,\s*100vw\)/);
    expect(css).toMatch(/env\(titlebar-area-x,\s*0px\)/);
  });
});
