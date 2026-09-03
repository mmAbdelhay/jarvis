// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { handlePaletteKey, type PaletteKeys } from "./terminal-addons.js";
import type { Palette, PaletteAction } from "./terminal-palette.js";

/** A plain object cast as a KeyboardEvent — the same style
 *  terminal-completion.test.ts and terminal-palette.test.ts use to drive a
 *  handleKey contract without a real DOM dispatch. */
function keydown(init: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  type?: string;
}): KeyboardEvent {
  return {
    type: init.type ?? "keydown",
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
}

/** A stub Palette recording what was asked of it, and standing in for the
 *  real one from terminal-palette.ts — this module only needs to know the
 *  chords are wired to the right calls, not how the widget renders. */
function stubPalette(open = false): { palette: Palette; opened: PaletteAction[][] } {
  const opened: PaletteAction[][] = [];
  const palette: Palette = {
    open: (actions) => opened.push([...actions]),
    ask: async () => undefined,
    close: () => {},
    isOpen: () => open,
    handleKey: () => false,
  };
  return { palette, opened };
}

describe("handlePaletteKey", () => {
  it("passes non-keydown events straight through", () => {
    const { palette } = stubPalette();
    const keys: PaletteKeys = { palette, actions: () => [], historySearch: () => {} };

    expect(handlePaletteKey(keydown({ key: "p", metaKey: true, type: "keyup" }), keys)).toBe(true);
  });

  it("leaves every other key alone while closed", () => {
    const { palette } = stubPalette();
    const keys: PaletteKeys = { palette, actions: () => [], historySearch: () => {} };

    for (const key of ["a", "Tab", "ArrowUp", "Enter", "Escape"]) {
      expect(handlePaletteKey(keydown({ key }), keys)).toBe(true);
    }
  });

  it("opens the palette over freshly built actions on Cmd+P, and claims the key", () => {
    const { palette, opened } = stubPalette();
    const action: PaletteAction = { id: "clear", label: "Clear", run: () => {} };
    const keys: PaletteKeys = { palette, actions: () => [action], historySearch: () => {} };

    const claimed = handlePaletteKey(keydown({ key: "p", metaKey: true }), keys);

    expect(claimed).toBe(false);
    expect(opened).toEqual([[action]]);
  });

  it("does not open on Ctrl+P — only the Cmd chord does", () => {
    const { palette, opened } = stubPalette();
    const keys: PaletteKeys = { palette, actions: () => [], historySearch: () => {} };

    expect(handlePaletteKey(keydown({ key: "p", ctrlKey: true }), keys)).toBe(true);
    expect(opened).toEqual([]);
  });

  it("runs the history-search flow on Ctrl+R, and claims the key", () => {
    const { palette } = stubPalette();
    let searched = 0;
    const keys: PaletteKeys = { palette, actions: () => [], historySearch: () => (searched += 1) };

    const claimed = handlePaletteKey(keydown({ key: "r", ctrlKey: true }), keys);

    expect(claimed).toBe(false);
    expect(searched).toBe(1);
  });

  it("does not treat Cmd+R as history search — that is a Ctrl chord only", () => {
    const { palette } = stubPalette();
    let searched = 0;
    const keys: PaletteKeys = { palette, actions: () => [], historySearch: () => (searched += 1) };

    expect(handlePaletteKey(keydown({ key: "r", metaKey: true }), keys)).toBe(true);
    expect(searched).toBe(0);
  });

  it("hands every key to the open palette instead of matching chords again", () => {
    const { palette } = stubPalette(true);
    const keys: PaletteKeys = { palette, actions: () => [], historySearch: () => {} };

    expect(handlePaletteKey(keydown({ key: "ArrowDown" }), keys)).toBe(false);
  });
});
