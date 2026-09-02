import { readFileSync } from "node:fs";
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

  it("loads the UI face it actually uses", () => {
    expect(html).toContain("family=Inter");
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
