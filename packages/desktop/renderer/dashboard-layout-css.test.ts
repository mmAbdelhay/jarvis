// @vitest-environment jsdom
// A CSS assertion reads styles.css; see view-display-css.test.ts for why the
// source shape is pinned rather than a computed style (jsdom does no layout).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("packages/desktop/renderer/styles.css", "utf8");
const html = readFileSync("packages/desktop/renderer/index.html", "utf8");

// The last rule wins the cascade, so read the last declaration of a property
// among every rule whose selector is exactly `selector`.
function lastDeclaration(selector: string, property: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rules = [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`, "g"))];
  let value: string | undefined;
  for (const rule of rules) {
    const decl = new RegExp(`(?:^|;|\\s)${property}\\s*:\\s*([^;]+);`).exec(rule[1] ?? "");
    if (decl?.[1] !== undefined) value = decl[1].trim();
  }
  if (value === undefined) throw new Error(`No ${property} declared for ${selector}`);
  return value;
}

describe("dashboard height", () => {
  // `.dash-links` and `.field` are absolutely positioned, so they take no grid
  // track. With one row template entry too many, the `1fr` landed on an empty
  // fourth track and SESSIONS/CONVERSATION stayed content-height, leaving the
  // bottom third of a tall monitor blank.
  it("gives the leftover height to the SESSIONS/CONVERSATION row", () => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const dashboard = doc.getElementById("view-dashboard");
    if (dashboard === null) throw new Error("#view-dashboard missing");
    const absolute = new Set(["dash-links", "field"]);
    const inFlow = [...dashboard.children].filter(
      (el) => ![...el.classList].some((c) => absolute.has(c)),
    );
    const tracks = lastDeclaration(".main", "grid-template-rows").split(/\s+(?![^(]*\))/);

    expect(tracks).toHaveLength(inFlow.length);
    expect(tracks.at(-1)).toBe("minmax(0, 1fr)");
    expect(inFlow.at(-1)?.classList.contains("dash-row3")).toBe(true);
  });

  // System, the core stage and Providers share one height that grows with a
  // tall viewport instead of staying at 340px.
  it("scales the top row with the viewport", () => {
    expect(lastDeclaration(".dash-row1", "--dash-row1-h")).toBe("clamp(340px, 32vh, 520px)");
    expect(css).toMatch(
      /\.dash-row1 \.system-panel,\s*\n\.dash-row1 \.providers-panel \{ height: var\(--dash-row1-h\);/,
    );
    expect(lastDeclaration(".core-stage", "height")).toBe("var(--dash-row1-h)");
  });
});
