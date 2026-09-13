// A CSS assertion reads styles.css; see view-display-css.test.ts for why
// the source shape is pinned rather than a computed style — jsdom
// special-cases `hidden` outside the cascade, so a getComputedStyle check
// here would pass whether or not the rule exists.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("page full screen", () => {
  // The hosted view is positioned over .workspace-page, so a page can only
  // fill that slot. Unless the chrome above it goes away, a full-screened
  // video sits under a topbar and a workspace head — which is what made it
  // look like Jarvis had gone full screen instead of the video.
  it("takes the topbar and the workspace head out of the layout", () => {
    expect(css).toMatch(
      /body\.page-fullscreen \.topbar,\s*\n\s*body\.page-fullscreen \.workspace-head \{ display: none; \}/,
    );
  });

  // Scoped to body, so that leaving full screen is a class removal with
  // nothing to put back — and so each element's own layout stays described
  // in exactly one place.
  it("never sets display on the base rules to do it", () => {
    expect(css).toMatch(/\n {2}\.topbar \{\n {4}display: flex;/);
    expect(css).toMatch(/\n {2}\.workspace-head \{\n {4}display: flex;/);
  });
});
