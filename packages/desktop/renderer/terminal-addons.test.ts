// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  enhanceTerminal,
  handlePaletteKey,
  handleSplitKey,
  type PaletteKeys,
  type SplitKeys,
} from "./terminal-addons.js";
import type { Palette, PaletteAction } from "./terminal-palette.js";
import { FakeTerminal } from "./terminal-double.js";

/** A plain object cast as a KeyboardEvent — the same style
 *  terminal-completion.test.ts and terminal-palette.test.ts use to drive a
 *  handleKey contract without a real DOM dispatch. */
function keydown(init: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  type?: string;
}): KeyboardEvent {
  return {
    type: init.type ?? "keydown",
    key: init.key,
    metaKey: init.metaKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    // A real KeyboardEvent always carries every modifier as a boolean. Left
    // undefined, a chord matched as a subset rather than exactly — which is
    // precisely the sloppiness keys.ts exists to remove.
    shiftKey: init.shiftKey ?? false,
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

// ⌘P, wired through enhanceTerminal's own key handler (attachKeys) rather
// than through handlePaletteKey above. It has to be: attachKeys is the
// handler xterm's own textarea actually receives a keydown through
// whenever the DOM editor is not what has focus — no editor at all, a
// command running, the alt screen — which is exactly the set of states
// terminal-pane.ts's editor-gated listener defers on. Between the two,
// every pane state is covered; this describes the half attachKeys owns.
describe("enhanceTerminal — ⌘P claims the palette in every pane state", () => {
  function terminalWithHooks(openPalette: (() => void) | undefined) {
    const terminal = new FakeTerminal();
    enhanceTerminal(terminal as never, document.createElement("div"), {
      sendInput: () => {},
      openLink: () => {},
      openPalette,
    });
    return terminal;
  }

  it("calls openPalette() and claims the key on Cmd+P", () => {
    let opened = 0;
    const terminal = terminalWithHooks(() => (opened += 1));

    const claimed = terminal.pressKey({ key: "p", metaKey: true });

    expect(claimed).toBe(false);
    expect(opened).toBe(1);
    expect(terminal.defaultPrevented).toBe(true);
  });

  it("does not claim Cmd+P for a terminal with no palette at all", () => {
    const terminal = terminalWithHooks(undefined);

    const claimed = terminal.pressKey({ key: "p", metaKey: true });

    expect(claimed).toBe(true);
    expect(terminal.defaultPrevented).toBe(false);
  });

  it("leaves Ctrl+P (no Cmd) to the shell — this handler only ever claims the Cmd chord", () => {
    let opened = 0;
    const terminal = terminalWithHooks(() => (opened += 1));

    const claimed = terminal.pressKey({ key: "p", ctrlKey: true });

    expect(claimed).toBe(true);
    expect(opened).toBe(0);
  });
});

// The macOS cases above are the originals. These are the same behaviours in
// the other spelling — the point of keys.ts is that one table drives both, so
// a regression on either platform shows up on the machine that is not it.
describe("the same chords, spelled for Linux", () => {
  it("splits beside and below, and closes a pane", () => {
    const calls: string[] = [];
    const keys: SplitKeys = {
      split: (direction) => {
        calls.push(`split:${direction}`);
        return true;
      },
      closeFocused: () => {
        calls.push("closeFocused");
        return true;
      },
      focus: (delta) => calls.push(`focus:${delta}`),
      closeTab: () => calls.push("closeTab"),
    };

    expect(
      handleSplitKey(keydown({ key: "D", ctrlKey: true, shiftKey: true }), keys, "linux"),
    ).toBe(false);
    expect(
      handleSplitKey(keydown({ key: "E", ctrlKey: true, shiftKey: true }), keys, "linux"),
    ).toBe(false);
    expect(
      handleSplitKey(keydown({ key: "W", ctrlKey: true, shiftKey: true }), keys, "linux"),
    ).toBe(false);
    expect(handleSplitKey(keydown({ key: "ArrowRight", altKey: true }), keys, "linux")).toBe(false);

    expect(calls).toEqual(["split:row", "split:column", "closeFocused", "focus:1"]);
  });

  it("leaves the shell's own control keys alone", () => {
    // The property that makes the Terminal tab usable at all on Linux. A
    // regression here reads as "Ctrl+C stopped working".
    const keys: SplitKeys = {
      split: () => {
        throw new Error("must not split");
      },
      closeFocused: () => {
        throw new Error("must not close");
      },
      focus: () => {
        throw new Error("must not move focus");
      },
      closeTab: () => {
        throw new Error("must not close the tab");
      },
    };
    for (const k of ["c", "d", "w", "e", "u", "a", "k", "z"]) {
      expect(handleSplitKey(keydown({ key: k, ctrlKey: true }), keys, "linux")).toBe(true);
    }
  });

  it("opens the palette on Ctrl+Shift+P and history search on Ctrl+R", () => {
    const { palette, opened } = stubPalette();
    let searched = 0;
    const keys: PaletteKeys = {
      palette,
      actions: () => [],
      historySearch: () => {
        searched += 1;
      },
    };

    expect(
      handlePaletteKey(keydown({ key: "P", ctrlKey: true, shiftKey: true }), keys, "linux"),
    ).toBe(false);
    expect(opened).toHaveLength(1);

    expect(handlePaletteKey(keydown({ key: "r", ctrlKey: true }), keys, "linux")).toBe(false);
    expect(searched).toBe(1);
  });
});
