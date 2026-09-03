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
    "workspace-body",
    "workspace-page",
    "workspace-bookmarks",
    "workspace-essentials",
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
    "workspace-pip",
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
// .workspace-nav declares no `display`, so the UA stylesheet's
// `[hidden] { display: none }` is free to hide the button — the reason it
// needs no rule of its own. A `display` added to .workspace-nav later would
// out-cascade that and put a dead PiP button on every page.
describe("the picture-in-picture button", () => {
  it("is hidden by default in the markup", () => {
    expect(html).toMatch(/id="workspace-pip"[^>]*hidden/);
  });

  it("relies on the UA hidden rule, so .workspace-nav must set no display", () => {
    const rule = css.slice(css.indexOf(".workspace-nav {"));
    expect(rule.slice(0, rule.indexOf("}"))).not.toMatch(/\bdisplay\s*:/);
  });
});

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

// The bookmarks went through a horizontal-bar phase (one row under the
// address bar, this file's own history briefly pinned that shape) before
// landing here: an Arc-style sidebar, a grid of pinned essentials above a
// list of everything else, beside the page slot rather than above it.
describe("bookmarks sidebar layout", () => {
  it("wraps the sidebar and the page slot in a body row", () => {
    const error = html.indexOf('id="workspace-error"');
    const body = html.indexOf('id="workspace-body"');
    const bookmarks = html.indexOf('id="workspace-bookmarks"');
    const essentials = html.indexOf('id="workspace-essentials"');
    const list = html.indexOf('id="workspace-bookmark-list"');
    const page = html.indexOf('id="workspace-page"');
    expect(error).toBeGreaterThan(-1);
    expect(body).toBeGreaterThan(error);
    expect(bookmarks).toBeGreaterThan(body);
    expect(essentials).toBeGreaterThan(bookmarks);
    expect(list).toBeGreaterThan(essentials);
    expect(page).toBeGreaterThan(list);
  });

  it("lays the body row out as a flex row, not a column", () => {
    expect(css).toMatch(/\.workspace-body \{[^}]*display:\s*flex/);
    expect(css).not.toMatch(/\.workspace-body \{[^}]*flex-direction:\s*column/);
  });

  // Hidden in lockstep with #workspace-page — see workspace.ts — since an
  // author `display` rule always beats the UA's [hidden]{display:none}
  // (the same footgun .workspace-bar and .workspace-bookmarks already hit;
  // see view-display-css.test.ts).
  it("overrides display for .workspace-body when hidden is present", () => {
    expect(css).toMatch(/\.workspace-body\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  // The sidebar is a fixed column, not a rail that reserves the old rail's
  // width by coincidence.
  it("gives the sidebar a fixed width", () => {
    expect(css).toMatch(/\.workspace-bookmarks \{[^}]*flex:\s*0 0 240px/);
  });

  it("lays the essentials out as a grid", () => {
    expect(css).toMatch(/\.workspace-essentials \{[^}]*display:\s*grid/);
  });

  // A narrow column has no width to spare for the bar's old horizontal
  // scroll-and-ellipsis compromise; the title wraps instead.
  it("wraps the listed bookmark's title instead of truncating it", () => {
    expect(css).not.toMatch(/\.workspace-bookmark-title \{[^}]*text-overflow:\s*ellipsis/);
  });

  // A one-line strip had no room for a second line of text under the
  // title, which is what the rail's rows carried; the sidebar has no more
  // use for it than the bar did.
  it("carries no domain line", () => {
    expect(css).not.toContain(".workspace-bookmark-domain");
  });
});
