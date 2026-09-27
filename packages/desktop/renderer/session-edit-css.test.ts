// A source assertion over styles.css, the same shape as
// settings-number-input-css.test.ts and running-pill-css.test.ts: jsdom
// cannot lay out a real grid or report a `<select>`'s UA popup colours, so
// the redesigned edit-row form (bug: "the ui design is so wrong" — bare
// browser-default inputs, no visible Save/Cancel, the edit button stacking
// under Resume) is pinned at the CSS source instead.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

function ruleBody(pattern: RegExp): string {
  const match = pattern.exec(css);
  if (match === null) throw new Error(`No CSS rule found for ${pattern}`);
  const body = match[1];
  if (body === undefined) throw new Error(`No CSS rule found for ${pattern}`);
  return body;
}

describe("session row actions", () => {
  it("wraps Resume and the edit button in a flex row, so they sit on one line", () => {
    const body = ruleBody(/\.session-row-actions\s*\{([^}]*)\}/);
    expect(body).toMatch(/display:\s*(inline-)?flex/);
  });

  it("gives the edit button its own real background and border rule (not a browser default)", () => {
    const body = ruleBody(/\.session-table-edit\s*\{([^}]*)\}/);
    expect(body).toMatch(/background:\s*var\(--surface-raised\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(body).toMatch(/border-radius:\s*var\(--r-control\)/);
  });

  it("sizes the edit button square, at Resume's own height", () => {
    const editBody = ruleBody(/\.session-table-edit\s*\{([^}]*)\}/);
    expect(editBody).toMatch(/width:\s*24px/);
    expect(editBody).toMatch(/height:\s*24px/);

    const resumeBody = ruleBody(/\.session-table-resume\s*\{([^}]*)\}/);
    expect(resumeBody).toMatch(/height:\s*24px/);
  });

  it("reveals the edit button alongside Resume on row hover / focus", () => {
    const revealRule = css.match(
      /\.session-table-row:hover \.session-table-resume,\s*\.session-table-row:hover \.session-table-edit,\s*\.session-table-resume:focus-visible,\s*\.session-table-edit:focus-visible\s*\{([^}]*)\}/,
    );
    expect(revealRule).not.toBeNull();
    expect(revealRule?.[1]).toMatch(/opacity:\s*1/);
  });
});

describe("session edit panel", () => {
  it("is a real panel, not a bare row: a dark surface with a top hairline", () => {
    const body = ruleBody(/\.session-edit-panel\s*\{([^}]*)\}/);
    expect(body).toMatch(/background:\s*var\(--surface-alt\)/);
    expect(body).toMatch(/border-top:\s*1px solid var\(--hairline-soft\)/);
    expect(body).toMatch(/border-radius:\s*var\(--r-control\)/);
  });

  it("lays its fields out as a grid, Title wider than the rest", () => {
    const body = ruleBody(/\.session-edit-grid\s*\{([^}]*)\}/);
    expect(body).toMatch(/display:\s*grid/);
    expect(body).toMatch(/grid-template-columns:\s*2fr repeat\(4,\s*1fr\)/);
  });

  it("wraps to two columns once the panel itself (not the viewport) narrows past 900px", () => {
    expect(css).toMatch(/@container session-edit \(max-width:\s*900px\)/);
    const match =
      /@container session-edit \(max-width:\s*900px\)\s*\{\s*\.session-edit-grid\s*\{([^}]*)\}/.exec(
        css,
      );
    expect(match?.[1]).toMatch(/grid-template-columns:\s*repeat\(2,\s*1fr\)/);
  });

  it("gives each field a small muted uppercase label above the control", () => {
    const body = ruleBody(/\.session-edit-field label\s*\{([^}]*)\}/);
    expect(body).toMatch(/font-size:\s*11px/);
    expect(body).toMatch(/text-transform:\s*uppercase/);
    expect(body).toMatch(/color:\s*var\(--text-muted\)/);
  });

  it("styles the controls with the Settings-field dark look: dark background, border, dark colour-scheme", () => {
    const body = ruleBody(
      /\.session-edit-field input,\s*\.session-edit-field select\s*\{([^}]*)\}/,
    );
    expect(body).toMatch(/background:\s*var\(--surface-sunken\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/);
    expect(body).toMatch(/color:\s*var\(--text\)/);
    expect(body).toMatch(/color-scheme:\s*dark/);
  });

  it("shows the accent border on focus", () => {
    const body = ruleBody(
      /\.session-edit-field input:focus,\s*\.session-edit-field select:focus\s*\{([^}]*)\}/,
    );
    expect(body).toMatch(/border-color:\s*var\(--accent\)/);
  });
});

describe("session edit actions line", () => {
  it("keeps the error status text in --bad and lets it take the leftover width", () => {
    const body = ruleBody(/\.session-edit-status\s*\{([^}]*)\}/);
    expect(body).toMatch(/color:\s*var\(--bad\)/);
    expect(body).toMatch(/flex:\s*1 1 auto/);
  });

  it("gives Cancel its own real ghost/secondary rule", () => {
    const body = ruleBody(/\.session-edit-cancel\s*\{([^}]*)\}/);
    expect(body).toMatch(/background:\s*var\(--surface-raised\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--border\)/);
  });

  it("gives Save its own real accent/primary rule", () => {
    const body = ruleBody(/\.session-edit-save\s*\{([^}]*)\}/);
    expect(body).toMatch(/background:\s*var\(--accent-quiet\)/);
    expect(body).toMatch(/border:\s*1px solid var\(--accent\)/);
  });

  // Cancel then Save, left to right (bug: Save/Cancel were invisible
  // browser-default text with no visual hierarchy at all) — `order` moves
  // Cancel before Save without touching the DOM order session-view.ts's own
  // callers address them by.
  it("reorders Cancel before Save visually via `order`, without reordering the DOM", () => {
    const cancelBody = ruleBody(/\.session-edit-cancel\s*\{([^}]*)\}/);
    const saveBody = ruleBody(/\.session-edit-save\s*\{([^}]*)\}/);
    const cancelOrder = Number(/order:\s*(\d+)/.exec(cancelBody)?.[1]);
    const saveOrder = Number(/order:\s*(\d+)/.exec(saveBody)?.[1]);
    expect(cancelOrder).toBeLessThan(saveOrder);
  });
});
