import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Critical fix: the `.history-overlay` rule previously set `display: flex`
// unconditionally. That is an AUTHOR-origin rule, and the UA stylesheet's
// `[hidden] { display: none }` is UA-origin — author rules always win the
// cascade over UA rules regardless of specificity, so toggling the
// `hidden` attribute (app.test.ts's "history panel" describe block proves
// the JS side does this correctly) never actually hid the overlay. The
// original review caught this by reading computed style in a real
// Chromium `BrowserWindow`, which this test suite has no way to drive
// (there is no browser-automation harness in this repo, and running the
// full Electron main process requires more than a unit-test environment).
//
// jsdom cannot stand in for that check: verified directly (see the fix
// commit's investigation), jsdom's own `getComputedStyle` special-cases
// the `hidden` attribute outside the normal CSS cascade — it reports
// `display: none` for a hidden element even when an author rule sets an
// unconditional `display: flex` on the same selector, which is not how a
// real browser's cascade works. A naive `getComputedStyle` assertion here
// would therefore pass whether or not the cascade bug is actually fixed,
// silently proving nothing. This test instead pins the CSS *source*
// itself: the base `.history-overlay` rule must not set `display` at all,
// and the only rule that sets `display: flex` for it must be gated on
// `:not([hidden])` — an author selector that, by construction, can never
// match while the `hidden` attribute is present, so there is nothing left
// to override the UA `[hidden]` rule with. This proves the fixed CSS
// shape is present and that the un-gated pattern hasn't crept back in; it
// does NOT independently prove a real browser renders it correctly — that
// still rests on the cascade-origin reasoning above, not a live
// measurement from this test suite.
const htmlSource = readFileSync(
  fileURLToPath(new URL("./index.html", import.meta.url)),
  "utf8",
);

function ruleBodyFor(selector: string, source: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  if (match === null) throw new Error(`No CSS rule found for selector ${selector}`);
  const body = match[1];
  if (body === undefined) throw new Error(`No CSS rule found for selector ${selector}`);
  return body;
}

describe("history overlay [hidden] cascade", () => {
  it("the base .history-overlay rule does not set display (nothing to out-cascade [hidden] with)", () => {
    const body = ruleBodyFor(".history-overlay", htmlSource);
    expect(body).not.toMatch(/display\s*:/);
  });

  it("display: flex is gated on :not([hidden]), never applying while hidden is present", () => {
    const body = ruleBodyFor(".history-overlay:not([hidden])", htmlSource);
    expect(body).toMatch(/display\s*:\s*flex/);
  });
});
