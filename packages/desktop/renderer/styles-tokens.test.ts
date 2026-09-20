import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The guard that makes a design system possible.
//
// Before it, 1,747 lines of CSS lived inside index.html and every rule chose
// its own colour, radius and spacing — which is why nothing in the app looked
// related to anything else. A rule that writes a raw colour is a rule that has
// opted out of the system, so this fails the build rather than trusting
// discipline.

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");
const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

/** The `:root` block, which is the one place a literal value belongs. */
const tokenBlock = css.slice(0, css.indexOf("}") + 1);
const rules = css.slice(css.indexOf("}") + 1);

describe("design tokens", () => {
  it("declares every colour used by a rule as a token", () => {
    expect([...rules.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((match) => match[0])).toEqual([]);
  });

  // A var() naming a token that was never declared resolves to nothing, and
  // the property silently falls back to its initial value — a background
  // becomes transparent, a colour becomes black, and nothing errors. The
  // session state dot shipped invisible this way, painted with a var(--add)
  // that does not exist in this file.
  it("uses no token it does not declare", () => {
    const declared = new Set(
      [...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]),
    );
    // Set from JS per element rather than declared here — the renderer
    // writes it inline as each tab's own accent.
    const setAtRuntime = new Set(["--tab-color"]);
    const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]));
    const undeclared = [...used].filter(
      (name) => !declared.has(name) && !setAtRuntime.has(name as string),
    );

    expect(undeclared).toEqual([]);
  });

  it("names three levels of surface and three of text", () => {
    for (const token of [
      "--bg",
      "--surface",
      "--surface-raised",
      "--text",
      "--text-secondary",
      "--text-muted",
    ]) {
      expect(tokenBlock).toContain(`${token}:`);
    }
  });

  it("names the state colours, so state is never improvised", () => {
    for (const token of ["--good", "--warn", "--bad", "--accent"]) {
      expect(tokenBlock).toContain(`${token}:`);
    }
  });

  it("names a spacing rhythm and two radii", () => {
    for (const token of ["--s1", "--s4", "--r-control", "--r-panel"]) {
      expect(tokenBlock).toContain(`${token}:`);
    }
  });

  it("names the three type families", () => {
    for (const token of ["--font-ui", "--font-mono", "--font-ar"]) {
      expect(tokenBlock).toContain(`${token}:`);
    }
  });
});

describe("typography", () => {
  // A display face used for interface text is a large part of why this app
  // read as themed rather than as a tool.
  it("no longer loads a display face", () => {
    expect(html).not.toContain("Space+Grotesk");
    // A rule that sets it, not a comment that explains why it went: the
    // comment is the record of the decision and should survive.
    expect(css).not.toMatch(/font-family:[^;]*Space Grotesk/);
  });

  // The 2026 redesign moved off a Google Fonts request entirely — the CSP
  // has no network font-src, so index.html links the vendored stylesheet
  // instead of naming a family on a remote request.
  it("loads the UI face it actually uses, vendored rather than over the network", () => {
    expect(html).toContain('href="vendor/fonts.css"');
    expect(html).not.toContain("fonts.googleapis.com");
    expect(tokenBlock).toMatch(/--font-ui:\s*Manrope/);
  });
});

describe("the stylesheet's home", () => {
  // index.html is loaded from source by window.loadFile, so a sibling
  // stylesheet needs no build step, and style-src 'self' already allows it.
  it("is linked rather than inlined", () => {
    expect(html).toContain('href="./styles.css"');
    expect(html).not.toContain("<style>");
  });
});

// Re-review 2, item 5: the board 0 redesign section (after the token block)
// is the layer that actually paints — it comes later in the cascade than
// the original .workspace-tab rules above it, so a colour band restored in
// the earlier rule alone would never reach the screen. `.at(-1)` below reads
// whichever declaration of each selector is LAST in the file, i.e. the one
// that wins.
describe("workspace tab colour band", () => {
  it("gives every tab chip a 2px top band in --tab-color, in the rule that actually wins", () => {
    const chipRule = rules.match(/\.workspace-tab\s*\{[^}]*\}/g)?.at(-1) ?? "";
    expect(chipRule).toContain("border-block-start: 2px solid var(--tab-color");
  });

  it("lets the active chip's own rule add the hairline sides without wiping that band", () => {
    const activeRule = rules.match(/\.workspace-tab--on\s*\{[^}]*\}/g)?.at(-1) ?? "";
    // A `border:` shorthand here would reset every side, including the top
    // band .workspace-tab just set — exactly the bug this pins.
    expect(activeRule).not.toContain("border:");
    expect(activeRule).toContain("border-inline");
  });

  it("colours the project switcher's own leading edge the same way", () => {
    const switcherRule = rules.match(/\.workspace-project\s*\{[^}]*\}/g)?.at(-1) ?? "";
    expect(switcherRule).toContain("border-inline-start: 3px solid var(--tab-color");
  });
});

// The board 0 brain redesign (2026-09-19-desktop-redesign) replaced the
// two/three-column `.centre__body--grid` (idle projects only, swapped in for
// the Sessions list) with `.node-grid` — always on screen, self-sizing via
// `repeat(auto-fill, minmax(172px, 1fr))` rather than a fixed column count,
// so it never needs the old breakpoint-driven column switch.
describe("dashboard projects grid", () => {
  it("auto-fits centred columns of 172-232px instead of a fixed column count", () => {
    const gridRule = rules.match(/\.node-grid\s*\{[^}]*\}/)?.[0] ?? "";
    expect(gridRule).toContain("grid-template-columns: repeat(auto-fit, minmax(172px, 232px))");
    expect(gridRule).toContain("justify-content: center");
    expect(gridRule).toContain("gap: 14px 10px");
  });

  it("scrolls its own overflow rather than stretching .main past its clipped height", () => {
    const gridRule = rules.match(/\.node-grid\s*\{[^}]*\}/)?.[0] ?? "";
    expect(gridRule).toMatch(/overflow-y:\s*auto/);
  });
});

// A button the renderer builds and never styles falls back to the user
// agent's own control — grey-on-white, square, wearing none of the design
// system, and the one thing on the page that looks like it came from
// somewhere else. The session table's Resume button shipped that way after
// an edit dropped its appearance rules and left only its `opacity`, which is
// why "has a rule at all" is not the property worth testing.
describe("renderer buttons", () => {
  const rendererDir = fileURLToPath(new URL(".", import.meta.url));

  /** Every declaration block whose selector mentions this class. */
  function declarationsFor(className: string): string {
    const escaped = className.replaceAll("-", "\\-");
    const rule = new RegExp(`[^{}]*\\.${escaped}\\b[^{}]*\\{([^}]*)\\}`, "g");
    return [...css.matchAll(rule)].map((match) => match[1]).join(" ");
  }

  const created = readdirSync(rendererDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .flatMap((name) => {
      const source = readFileSync(`${rendererDir}${name}`, "utf8");
      const pattern =
        /const (\w+) = document\.createElement\("button"\);[\s\S]{0,400}?\1\.className = "([a-z0-9 _-]+)"/g;
      return [...source.matchAll(pattern)].map((match) => ({ file: name, classes: match[2] }));
    });

  it("finds the buttons the renderer builds", () => {
    expect(created.length).toBeGreaterThan(0);
  });

  it.each(created)("$file: .$classes is styled, not a browser default", ({ classes }) => {
    const styled = (classes as string)
      .split(/\s+/)
      .filter(Boolean)
      .some((className) => /background/.test(declarationsFor(className)));

    expect(styled).toBe(true);
  });
});
