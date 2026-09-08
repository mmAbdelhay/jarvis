// A CSS assertion reads styles.css — see view-display-css.test.ts for why
// these are source assertions rather than computed styles.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("the sticky block header", () => {
  // The block's own rule hides its controls until `.block:hover`, and the
  // sticky header is not inside a `.block`. Without a rule of its own the
  // actions it now really has would sit there at opacity 0 — present,
  // wired, and invisible, which is its own kind of broken.
  it("reveals the actions it holds when the strip is hovered", () => {
    expect(css).toMatch(
      /\.terminal-sticky-header:hover \.block-header \[role="button"\] \{ opacity: 1; \}/,
    );
  });

  // The more menu is absolutely positioned inside the header wrap. Clipping
  // the strip would leave ⋯ opening a menu nobody can see.
  it("does not clip what the header opens", () => {
    const rule = /\.terminal-sticky-header \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(rule).not.toContain("overflow: hidden");
  });
});
