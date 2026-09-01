// The stylesheet lives beside index.html rather than inside it, so a CSS
// assertion reads styles.css and a markup assertion reads index.html. They
// were one file until the redesign moved 1,747 lines of CSS out of it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Critical fix (found in Task 12 review, confirmed in real Chromium): `.main`
// and `.main--changes` previously set `display` unconditionally. Both are
// AUTHOR-origin rules, and the UA stylesheet's `[hidden] { display: none }`
// is UA-origin — an author rule always wins the cascade over a UA rule
// regardless of specificity, so `showView()` toggling the `hidden` attribute
// (app.test.ts and views.test.ts's "showView" tests prove the JS side does
// this correctly) never actually hid either view. Confirmed live:
//
//   VIEWPROBE: {"changesHiddenAttr":true, "changesDisplay":"flex",
//               "changesHeight":226, "mainDisplay":"grid", "mainHeight":581}
//
// — the empty Changes view rendered permanently at 226px, squeezing the
// dashboard down from its full height.
//
// This is the exact same footgun `.history-overlay` already hit and was
// fixed for (see history-overlay-css.test.ts, ~70 lines above this pattern
// in index.html): jsdom's own `getComputedStyle` special-cases the `hidden`
// attribute outside the normal CSS cascade, reporting `display: none` for a
// hidden element even when an unconditional author rule sets `display` on
// the same selector — a computed-style assertion here would pass whether or
// not the cascade bug is fixed, proving nothing. So, like that file, this
// test pins the CSS *source* shape instead: `.main` and `.main--changes`
// must not set `display` in their base rule, and the only rules that set
// `display` for them must be gated on `:not([hidden])`, a selector that by
// construction can never match while `hidden` is present.
const htmlSource = readFileSync(
  fileURLToPath(new URL("./styles.css", import.meta.url)),
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

describe(".main / .main--changes [hidden] cascade", () => {
  it("the base .main rule does not set display", () => {
    const body = ruleBodyFor(".main", htmlSource);
    expect(body).not.toMatch(/display\s*:/);
  });

  it("the base .main--changes rule does not set display", () => {
    const body = ruleBodyFor(".main--changes", htmlSource);
    expect(body).not.toMatch(/display\s*:/);
  });

  it("the dashboard grid applies only via .main:not([hidden])", () => {
    const body = ruleBodyFor(".main:not([hidden])", htmlSource);
    expect(body).toMatch(/display\s*:\s*grid/);
  });

  it("the changes flex layout applies only via .main--changes:not([hidden])", () => {
    const body = ruleBodyFor(".main--changes:not([hidden])", htmlSource);
    expect(body).toMatch(/display\s*:\s*flex/);
  });

  // The Session view is the third `.main` and hits exactly the same
  // footgun: an unconditional `display` here would leave the transcript
  // permanently on screen, squeezing whichever view is meant to be showing.
  it("the base .main--session rule does not set display", () => {
    const body = ruleBodyFor(".main--session", htmlSource);
    expect(body).not.toMatch(/display\s*:/);
  });

  it("the session flex layout applies only via .main--session:not([hidden])", () => {
    const body = ruleBodyFor(".main--session:not([hidden])", htmlSource);
    expect(body).toMatch(/display\s*:\s*flex/);
  });
});
  it("never sets display on .main--workspace outside a :not([hidden]) rule", () => {
    const rules = [...htmlSource.matchAll(/\.main--workspace[^{]*\{[^}]*\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      if (/display\s*:/.test(rule)) expect(rule).toContain(":not([hidden])");
    }
  });

  it("never sets display on .main--settings outside a :not([hidden]) rule", () => {
    const rules = [...htmlSource.matchAll(/\.main--settings[^{]*\{[^}]*\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      if (/display\s*:/.test(rule)) expect(rule).toContain(":not([hidden])");
    }
  });

  // Found live, twice: (1) renderWorkspace() set #workspace-bar's `hidden`
  // property for an editor-kind tab, but the base .workspace-bar rule set
  // `display: flex` unconditionally with no [hidden] override — an author
  // rule, which always beats the UA's [hidden]{display:none} regardless of
  // specificity, so the address bar stayed visible no matter what the JS
  // did. (2) Fixed by splitting the row so only back/forward/reload/
  // address hid, keeping "+" (open a new tab) reachable — but the user
  // then asked for "+" to sit at the end of the tab strip instead, which
  // makes the split unnecessary: "+" moved out of this row entirely
  // (workspace.ts relocates the existing button into #workspace-tabs on
  // every render), so hiding the *whole* .workspace-bar row is safe again.
  // This test pins the final shape's override.
  it("overrides display for .workspace-bar when hidden is present", () => {
    const rules = [...htmlSource.matchAll(/\.workspace-bar(?:\[hidden\])?[^{]*\{[^}]*\}/g)].map(
      (m) => m[0],
    );
    const hasOverride = rules.some(
      (rule) => rule.startsWith(".workspace-bar[hidden]") && /display\s*:\s*none/.test(rule),
    );
    expect(hasOverride).toBe(true);
  });
