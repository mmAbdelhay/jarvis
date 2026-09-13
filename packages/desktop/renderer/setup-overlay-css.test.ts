// The `[hidden]` cascade trap, found for the fourth time — this one in
// `.setup-overlay`, and reported by a user rather than by a test.
//
// The symptom was "the prerequisites screen opens every launch". It did not:
// it never *closed*. `.setup-overlay` set `display: flex` on the base rule,
// which is author-origin and therefore beats the UA stylesheet's
// `[hidden] { display: none }` whatever the attribute says. `closeSetup()`
// sets `hidden = true` and nothing else, so Skip did nothing, and the comment
// at the top of setup.ts — "Skip closes it for good" — had never been true.
//
// Measured in the running app over CDP, on a launch that was neither a first
// run nor missing anything required:
//
//     firstRun: false   agentInstalled: true   missingRequired: false
//     overlayHidden: true   display: flex
//
// `openSetupIfNeeded` had correctly declined to open it. It was visible
// regardless.
//
// history-overlay-css.test.ts explains at length why this is pinned at the CSS
// source rather than through `getComputedStyle`: jsdom special-cases `hidden`
// outside the real cascade, so a computed-style assertion passes whether or
// not the bug is present.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

function ruleBodyFor(selector: string, source: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(source);
  if (match === null) throw new Error(`No CSS rule found for selector ${selector}`);
  const body = match[1];
  if (body === undefined) throw new Error(`No CSS rule found for selector ${selector}`);
  return body;
}

describe("setup overlay [hidden] cascade", () => {
  it("the base .setup-overlay rule does not set display", () => {
    expect(ruleBodyFor(".setup-overlay", css)).not.toMatch(/display\s*:/);
  });

  it("display: flex is gated on :not([hidden]), so closeSetup() can actually close it", () => {
    expect(ruleBodyFor(".setup-overlay:not([hidden])", css)).toMatch(/display\s*:\s*flex/);
  });
});

// The general guard in history-overlay-css.test.ts checks every selector that
// *already* has a `:not([hidden])` variant — so it can only ever catch a
// regression in a rule somebody has already fixed. `.setup-overlay` had no
// variant at all, which is precisely why it escaped for four releases.
//
// This catches the unfixed shape instead, and needs no list to maintain: the
// markup itself declares which elements are meant to be hideable. Anything
// carrying a `hidden` attribute in index.html must not have CSS that renders
// it anyway.
describe("every element markup declares hidden must actually be hideable", () => {
  const hiddenElements = [...html.matchAll(/<[a-z]+[^>]*\shidden(?:\s|>|\/)/gi)].map((m) => m[0]);

  it("finds the hideable elements in index.html", () => {
    expect(hiddenElements.length).toBeGreaterThan(0);
  });

  // Two shapes in this stylesheet are correct, and both appear in it already:
  //
  //   .x:not([hidden]) { display: flex }   — never applies while hidden
  //   .x[hidden] { display: none }         — an author rule that out-ranks .x
  //
  // Either is fine. What breaks is a base rule with `display` and neither of
  // them, which is what `.setup-overlay` was.
  it("each of them either withholds display or overrides it for [hidden]", () => {
    const offenders: string[] = [];

    for (const tag of hiddenElements) {
      const id = /\sid="([^"]+)"/.exec(tag)?.[1];
      const classes = (/\sclass="([^"]+)"/.exec(tag)?.[1] ?? "").split(/\s+/).filter(Boolean);
      const selectors = [...(id === undefined ? [] : [`#${id}`]), ...classes.map((c) => `.${c}`)];

      for (const selector of selectors) {
        const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const base = new RegExp(`(^|[,{}\\s])${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
        if (base === null) continue;

        // `display: none` on the base rule hides; it does not show.
        if (!/display\s*:\s*(?!none)/.test(base[2] ?? "")) continue;

        const guarded = new RegExp(`${escaped}:not\\(\\[hidden\\]\\)\\s*\\{`).test(css);
        const overridden = new RegExp(
          `${escaped}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`,
        ).test(css);
        if (!guarded && !overridden) {
          offenders.push(
            `${selector} sets display on its base rule with no [hidden] escape — ` +
              `add ${selector}:not([hidden]) or ${selector}[hidden] { display: none }`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
