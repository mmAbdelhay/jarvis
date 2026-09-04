// The pane's layout, pinned at the source.
//
// jsdom computes no layout at all, so a computed-style assertion here would
// prove nothing — the same reason view-display-css.test.ts and
// history-overlay-css.test.ts read styles.css as text rather than as a
// cascade. What these pin is the shape of two rules that were wrong in a way
// nothing else can catch:
//
//   1. The pane scrolled and `.terminal-blocks` had no min-height, so a flex
//      child that cannot shrink below its content squeezed `.terminal-live`
//      down to its own min-height — about seven rows — as soon as the blocks
//      outgrew the pane. The pty was then told it had seven rows, and xterm,
//      whose only cue to refit is a ResizeObserver on a box that never
//      changed, went on drawing its old grid over the blocks above it.
//
//   2. The editor was appended after the live terminal instead of covering
//      its cursor row, so at every idle prompt the prompt was drawn twice —
//      once by zsh in the live terminal, and once by the editor, which reads
//      it out of that very buffer — with a tall empty terminal between them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./styles.css", import.meta.url)), "utf8");

function ruleBodyFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  const body = match?.[1];
  if (body === undefined) throw new Error(`No CSS rule found for selector ${selector}`);
  return body;
}

describe("the terminal pane's layout", () => {
  it("lets the block list shrink and scroll instead of crushing the live terminal", () => {
    const body = ruleBodyFor(".terminal-blocks");
    expect(body).toMatch(/min-height\s*:\s*0/);
    expect(body).toMatch(/overflow-y\s*:\s*auto/);
  });

  it("does not make the pane itself the scroller", () => {
    // A scrolling pane is what let the list push the live terminal out of
    // the viewport rather than scrolling within it.
    expect(ruleBodyFor(".terminal-pane")).not.toMatch(/overflow(-y)?\s*:\s*auto/);
  });

  it("keeps the live terminal a real terminal", () => {
    expect(ruleBodyFor(".terminal-live")).toMatch(/min-height\s*:\s*120px/);
  });

  it("hides the live terminal only where the editor is actually the prompt line", () => {
    // Both attributes, and no other rule may hide it: `data-editor="on"` is
    // written by applyState and is true only while the editor is visible, so
    // a pane with no editor, one whose shell has no integration yet, and one
    // with a command running all keep the terminal they have always had.
    const hiding = [...css.matchAll(/([^{}]*\.terminal-live[^{}]*)\{([^}]*)\}/g)].filter(([, , body]) =>
      /display\s*:\s*none/.test(body ?? ""),
    );
    expect(hiding).toHaveLength(1);
    expect(hiding[0]?.[1]).toContain('[data-state="blocks"]');
    expect(hiding[0]?.[1]).toContain('[data-editor="on"]');
  });
});
