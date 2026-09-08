// A CSS assertion reads styles.css. See view-display-css.test.ts for the
// full account of why this is a source assertion rather than a computed
// style: jsdom reports `display: none` for an element with the `hidden`
// attribute whether or not an author rule out-cascades the UA rule, so a
// getComputedStyle check here would pass against the broken stylesheet.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("the running-sessions pill", () => {
  // Found by looking at the running app: the pill is a .pill, .pill sets
  // `display: flex` in its base rule, and both are author-origin — so the
  // UA's [hidden]{display:none} lost, and an empty pill sat in the topbar
  // permanently with nothing running. app.test.ts proves the JS sets
  // `hidden` correctly; this is the half of the fix it cannot see.
  it("is actually hidden by its hidden attribute", () => {
    expect(css).toMatch(/\.pill--running\[hidden\] \{ display: none; \}/);
  });
});
