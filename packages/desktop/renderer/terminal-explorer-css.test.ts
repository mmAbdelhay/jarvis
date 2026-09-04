// The file sidebar's styling, pinned at the source.
//
// jsdom computes no layout, so a computed-style assertion here would prove
// nothing about how the tree actually looks — the same reason
// terminal-layout-css.test.ts reads styles.css as text rather than as a
// cascade. What these pin is structure a screenshot cannot: that the
// chevron and the file spacer share one width (the alignment that makes
// the list read as a tree), that a hover and a focus-visible state exist
// and use the quiet accent, and that a long name is set up to truncate
// with an ellipsis rather than wrap or overflow the sidebar.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

// A selector may share its rule body with others in a comma list (as
// `.file-tree-chevron, .file-tree-spacer` does), so this matches the
// selector followed by either a "," (another selector follows) or "{"
// (the body starts here) rather than requiring it to open the rule alone.
function ruleBodyFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[\\n,])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`).exec(css);
  const body = match?.[1];
  if (body === undefined) throw new Error(`No CSS rule found for selector ${selector}`);
  return body;
}

function widthOf(body: string): string | undefined {
  return /width\s*:\s*([^;]+);/.exec(body)?.[1]?.trim();
}

describe("the file sidebar's styling", () => {
  it("gives the chevron and the file-row spacer the same width", () => {
    const chevronWidth = widthOf(ruleBodyFor(".file-tree-chevron"));
    const spacerWidth = widthOf(ruleBodyFor(".file-tree-spacer"));
    expect(chevronWidth).toBeDefined();
    expect(chevronWidth).toBe(spacerWidth);
  });

  it("colors a directory row with --text and a file row with --text-muted", () => {
    expect(ruleBodyFor(".file-tree-row")).toMatch(/color\s*:\s*var\(--text-muted\)/);
    expect(ruleBodyFor('.file-tree-row[data-directory="true"]')).toMatch(
      /color\s*:\s*var\(--text\)/,
    );
  });

  it("lifts both to --text on hover, using the quiet accent as the hover background", () => {
    const hover = ruleBodyFor(".file-tree-row:hover");
    expect(hover).toMatch(/color\s*:\s*var\(--text\)/);
    expect(hover).toMatch(/background\s*:\s*var\(--accent-quiet\)/);
  });

  it("gives a focused row a focus-visible ring", () => {
    expect(ruleBodyFor(".file-tree-row:focus-visible")).toMatch(/outline\s*:/);
  });

  it("gives every row a fixed height", () => {
    expect(ruleBodyFor(".file-tree-row")).toMatch(/height\s*:\s*\d/);
  });

  it("truncates a long name with an ellipsis instead of wrapping or overflowing", () => {
    const body = ruleBodyFor(".file-tree-name");
    expect(body).toMatch(/overflow\s*:\s*hidden/);
    expect(body).toMatch(/text-overflow\s*:\s*ellipsis/);
  });

  // `pre` (not `nowrap`) so a file name with two consecutive spaces still
  // renders exactly as it is on disk — `nowrap` collapses whitespace runs
  // before rendering, `pre` does not. Both suppress wrapping, so this does
  // not change the ellipsis truncation above: it is `overflow: hidden` +
  // `text-overflow: ellipsis` that clip, and neither value wraps first.
  it("keeps exact on-disk spacing in a name rather than collapsing it", () => {
    const body = ruleBodyFor(".file-tree-name");
    expect(body).toMatch(/white-space\s*:\s*pre\b/);
  });

  it("draws an indent guide down each nested group", () => {
    expect(ruleBodyFor(".file-tree-children")).toMatch(/border-left\s*:\s*1px/);
  });

  it("has a header rule for the sidebar's current-root line", () => {
    expect(() => ruleBodyFor(".terminal-explorer-header")).not.toThrow();
  });
});
