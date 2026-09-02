import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The stylesheet lives beside index.html rather than inside it, so a CSS
// assertion reads styles.css and a markup assertion reads index.html. They
// were one file until the redesign moved 1,747 lines of CSS out of it.
const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");
const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

describe("workspace markup", () => {
  it("has a nav button", () => {
    expect(html).toContain('id="nav-workspace"');
  });

  it("has the route container, hidden by default", () => {
    expect(html).toMatch(/id="view-workspace"[^>]*hidden/);
  });

  it.each([
    "workspace-project",
    "workspace-tabs",
    "workspace-new-tab",
    "workspace-back",
    "workspace-forward",
    "workspace-reload",
    "workspace-address",
    "workspace-error",
    "workspace-page",
    "workspace-bookmarks",
    "workspace-bookmark-list",
    "workspace-bookmark-toggle",
    "workspace-open-editor",
    "workspace-open-database",
    "workspace-open-terminal",
    "workspace-open-api",
    "workspace-api",
    "api-collection",
    "api-tree",
    "api-method",
    "api-url",
    "api-environment",
    "api-send",
    "api-save",
    "api-tabs",
    "api-panel",
    "api-response-tabs",
    "api-response-head",
    "api-status",
    "api-curl",
    "api-new-request",
    "api-new-folder",
    "api-new-collection",
    "api-import",
    "api-env-edit",
    "api-env-panel",
    "api-env-name",
    "api-env-vars",
    "api-env-add",
    "api-env-save",
    "api-env-close",
    "api-history-toggle",
    "api-cookies-toggle",
    "api-settings-toggle",
    "api-ask",
    "api-ask-label",
    "api-ask-input",
    "api-ask-ok",
    "api-ask-cancel",
    "api-side-panel",
    "api-side-tabs",
    "api-side-body",
    "api-dirty",
    "api-response",
    "workspace-toggle-bookmarks",
    "workspace-devtools",
    "workspace-devtools-handle",
    "workspace-toggle-devtools",
    "workspace-terminal",
    "workspace-tool-status",
    "workspace-bar",
  ])("has #%s", (id) => {
    expect(html).toContain(`id="${id}"`);
  });

  // The page slot is measured with getBoundingClientRect and its rectangle
  // is handed to the main process; it must be a real, sized element, not a
  // zero-height placeholder collapsed by its own content.
  // The slot's height comes from flex sizing, not from anything it
  // contains — it stays empty; a hosted view is positioned over it, not
  // inside it. This codebase's convention is flex-grow/flex-shrink rather
  // than the flex shorthand (see .session-terminal, .workspace-browser),
  // so either form counts.
  it("gives the page slot a flexible height rather than sizing it to content", () => {
    expect(css).toMatch(/\.workspace-page\s*\{[^}]*flex(-grow)?:\s*1/);
  });
});

// .workspace-nav is a 28px square built for an icon button. Every button in
// the API bar carries a word instead, and without a width of their own the
// labels overflow the square and print on top of one another — which is
// exactly what happened on screen.
describe("api bar layout", () => {
  it("sizes the API bar's buttons to their labels", () => {
    expect(css).toMatch(/\.api-bar button \{[^}]*width:\s*auto/);
  });

  it("lets only the URL field absorb and give up width", () => {
    expect(css).toMatch(/\.api-bar \.workspace-address \{[^}]*flex:\s*1/);
    expect(css).toMatch(/\.api-bar button \{[^}]*flex-shrink:\s*0/);
  });

  // An empty select collapses to its border and reads as a glitch.
  it("keeps an empty select from collapsing", () => {
    expect(css).toMatch(/\.api-bar select \{[^}]*min-width/);
  });

  it("wraps the bar rather than pushing buttons off the edge", () => {
    expect(css).toMatch(/\.api-bar \{[^}]*flex-wrap:\s*wrap/);
  });

  // A stray inline width would put the bar back where it was, one button at
  // a time.
  it("keeps the sizing in the stylesheet, not on the buttons", () => {
    const bar = html.slice(html.indexOf('<div class="api-bar">'), html.indexOf('id="api-tabs"'));
    expect(bar).not.toContain("style=\"width: auto");
  });
});

// The bookmarks list used to be a 200px full-height rail beside the whole
// browser column — workspace furniture rather than browser chrome. It now
// sits where every other browser puts it: one horizontal row inside the
// browser's own chrome, directly under the address bar, hidden by the same
// rule that hides the address bar for a hosted app.
describe("bookmarks bar layout", () => {
  it("puts the bookmarks between the address bar and the page", () => {
    const bar = html.indexOf('id="workspace-bar"');
    const bookmarks = html.indexOf('id="workspace-bookmarks"');
    const page = html.indexOf('id="workspace-page"');
    expect(bar).toBeGreaterThan(-1);
    expect(bookmarks).toBeGreaterThan(bar);
    expect(page).toBeGreaterThan(bookmarks);
  });

  // The rail's row wrapper existed only to put a sidebar beside the browser
  // column. With no sidebar there is no second column, and the extra
  // wrapper div is one more thing between the page slot and its flex
  // parent.
  it("stacks the browser as a single column", () => {
    expect(css).toMatch(/\.workspace-browser \{[^}]*flex-direction:\s*column/);
    expect(html).not.toContain("workspace-browser-main");
    expect(css).not.toContain(".workspace-browser-main");
  });

  it("no longer reserves a fixed rail width for the bookmarks", () => {
    expect(css).not.toMatch(/\.workspace-bookmarks \{[^}]*width:\s*200px/);
  });

  // The prior art here is .workspace-nav's fixed 28x28 square, which
  // squeezed word-labelled buttons until they printed on top of one
  // another. A bookmark chip in a flex row has the same failure mode: with
  // flex-shrink left at its default of 1, twenty bookmarks each collapse
  // to a few pixels instead of overflowing the row.
  it("keeps a bookmark at its own width rather than squeezing it", () => {
    expect(css).toMatch(/\.workspace-bookmark \{[^}]*flex-shrink:\s*0/);
  });

  // A wrapping bar grows in height, and this bar's height is the page
  // slot's inset — so a wrap would move the hosted view on every added
  // bookmark. Scroll instead, exactly as the tab strip above it does.
  it("scrolls the bookmarks rather than wrapping them onto more rows", () => {
    expect(css).toMatch(/\.workspace-bookmark-list \{[^}]*flex-wrap:\s*nowrap/);
    expect(css).toMatch(/\.workspace-bookmark-list \{[^}]*overflow-x:\s*auto/);
  });

  // A one-line strip has no room for a second line of text under the
  // title, which is what the rail's rows carried.
  it("drops the rail's stacked domain line", () => {
    expect(css).not.toContain(".workspace-bookmark-domain");
  });

  // "BOOKMARKS" was an English-only heading for a column that no longer
  // exists; a horizontal strip under the address bar needs no label.
  it("drops the rail's heading", () => {
    expect(html).not.toContain("BOOKMARKS");
  });
});
