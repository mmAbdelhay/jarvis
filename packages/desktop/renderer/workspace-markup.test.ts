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
    "workspace-mode-browser",
    "workspace-mode-docs",
    "workspace-doc-list",
    "workspace-doc-body",
    "workspace-doc-title",
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
