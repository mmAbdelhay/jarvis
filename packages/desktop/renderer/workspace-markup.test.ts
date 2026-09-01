import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

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
    expect(html).toMatch(/\.workspace-page\s*\{[^}]*flex(-grow)?:\s*1/);
  });
});

// .workspace-nav is a 28px square built for an icon button. Every button in
// the API bar carries a word instead, and without a width of their own the
// labels overflow the square and print on top of one another — which is
// exactly what happened on screen.
describe("api bar layout", () => {
  it("sizes the API bar's buttons to their labels", () => {
    expect(html).toMatch(/\.api-bar button \{[^}]*width:\s*auto/);
  });

  it("lets only the URL field absorb and give up width", () => {
    expect(html).toMatch(/\.api-bar \.workspace-address \{[^}]*flex:\s*1/);
    expect(html).toMatch(/\.api-bar button \{[^}]*flex-shrink:\s*0/);
  });

  // An empty select collapses to its border and reads as a glitch.
  it("keeps an empty select from collapsing", () => {
    expect(html).toMatch(/\.api-bar select \{[^}]*min-width/);
  });

  it("wraps the bar rather than pushing buttons off the edge", () => {
    expect(html).toMatch(/\.api-bar \{[^}]*flex-wrap:\s*wrap/);
  });

  // A stray inline width would put the bar back where it was, one button at
  // a time.
  it("keeps the sizing in the stylesheet, not on the buttons", () => {
    const bar = html.slice(html.indexOf('<div class="api-bar">'), html.indexOf('id="api-tabs"'));
    expect(bar).not.toContain("style=\"width: auto");
  });
});
