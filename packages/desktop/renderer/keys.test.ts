import { describe, expect, it } from "vitest";
import { keyLabel, matchChord, type ChordAction } from "./keys.js";

const key = (init: Partial<KeyboardEvent> & { key: string }): KeyboardEvent =>
  ({
    type: "keydown",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  }) as KeyboardEvent;

describe("matchChord on darwin", () => {
  it("opens the palette on Cmd+P", () => {
    expect(matchChord(key({ key: "p", metaKey: true }), "darwin")).toBe("palette");
  });

  it("splits beside on Cmd+D and below on Cmd+Shift+D", () => {
    expect(matchChord(key({ key: "d", metaKey: true }), "darwin")).toBe("splitRow");
    expect(matchChord(key({ key: "D", metaKey: true, shiftKey: true }), "darwin")).toBe(
      "splitColumn",
    );
  });

  it("searches on Cmd+F and filters to failures on Cmd+Shift+F", () => {
    expect(matchChord(key({ key: "f", metaKey: true }), "darwin")).toBe("search");
    expect(matchChord(key({ key: "F", metaKey: true, shiftKey: true }), "darwin")).toBe(
      "filterFailed",
    );
  });

  it("moves pane focus on Option+Cmd+arrow", () => {
    expect(matchChord(key({ key: "ArrowRight", metaKey: true, altKey: true }), "darwin")).toBe(
      "focusNext",
    );
    expect(matchChord(key({ key: "ArrowLeft", metaKey: true, altKey: true }), "darwin")).toBe(
      "focusPrev",
    );
  });

  it("leaves Cmd+Left alone — it is start-of-line, which no split may take", () => {
    expect(matchChord(key({ key: "ArrowLeft", metaKey: true }), "darwin")).toBeUndefined();
  });

  it("moves the block selection on Cmd+arrow", () => {
    expect(matchChord(key({ key: "ArrowUp", metaKey: true }), "darwin")).toBe("blockPrev");
    expect(matchChord(key({ key: "ArrowDown", metaKey: true }), "darwin")).toBe("blockNext");
  });

  it("leaves Ctrl entirely to the shell, except ^R", () => {
    for (const k of ["c", "d", "v", "k", "p", "f", "w"]) {
      expect(matchChord(key({ key: k, ctrlKey: true }), "darwin")).toBeUndefined();
    }
    expect(matchChord(key({ key: "r", ctrlKey: true }), "darwin")).toBe("historySearch");
  });
});

describe("matchChord on linux", () => {
  it("opens the palette on Ctrl+Shift+P", () => {
    expect(matchChord(key({ key: "P", ctrlKey: true, shiftKey: true }), "linux")).toBe("palette");
  });

  it("splits beside on Ctrl+Shift+D and below on Ctrl+Shift+E", () => {
    // Not a second Shift: Shift is already spent making this an app chord.
    expect(matchChord(key({ key: "D", ctrlKey: true, shiftKey: true }), "linux")).toBe("splitRow");
    expect(matchChord(key({ key: "E", ctrlKey: true, shiftKey: true }), "linux")).toBe(
      "splitColumn",
    );
  });

  it("searches on Ctrl+Shift+F and filters to failures on Ctrl+Shift+G", () => {
    expect(matchChord(key({ key: "F", ctrlKey: true, shiftKey: true }), "linux")).toBe("search");
    expect(matchChord(key({ key: "G", ctrlKey: true, shiftKey: true }), "linux")).toBe(
      "filterFailed",
    );
  });

  it("copies and pastes on Ctrl+Shift+C and Ctrl+Shift+V", () => {
    expect(matchChord(key({ key: "C", ctrlKey: true, shiftKey: true }), "linux")).toBe("copy");
    expect(matchChord(key({ key: "V", ctrlKey: true, shiftKey: true }), "linux")).toBe("paste");
  });

  it("moves pane focus on Alt+arrow, with no second modifier to spare", () => {
    expect(matchChord(key({ key: "ArrowRight", altKey: true }), "linux")).toBe("focusNext");
    expect(matchChord(key({ key: "ArrowLeft", altKey: true }), "linux")).toBe("focusPrev");
  });

  it("ignores a bare Meta chord — Super belongs to the window manager", () => {
    for (const k of ["p", "d", "w", "f"]) {
      expect(matchChord(key({ key: k, metaKey: true }), "linux")).toBeUndefined();
    }
  });
});

// The single most important property of the Linux scheme. A regression here
// makes the Terminal tab unusable, and would be reported as "Ctrl+C stopped
// working" rather than as a keybinding bug.
describe("the shell keeps its control keys on linux", () => {
  const TERMINAL_ACTIONS = new Set<ChordAction>([
    "palette",
    "search",
    "filterFailed",
    "blockPrev",
    "blockNext",
    "copy",
    "paste",
    "clearScreen",
    "splitRow",
    "splitColumn",
    "closePane",
    "focusPrev",
    "focusNext",
  ]);

  // Every letter readline or the tty binds. `r` is excluded because ^R is
  // claimed deliberately on both platforms, and `s` because Ctrl+S is the API
  // tab's save — matched only by that tab's own editor, where no shell is
  // listening.
  it.each(["c", "d", "z", "u", "a", "e", "k", "w", "l", "q", "b", "f", "p", "v", "n", "o", "t", "y"])(
    "never claims Ctrl+%s for the terminal",
    (k) => {
      const action = matchChord(key({ key: k, ctrlKey: true }), "linux");
      expect(action === undefined || !TERMINAL_ACTIONS.has(action)).toBe(true);
    },
  );

  it("claims ^R on both platforms, as it already did", () => {
    // Superseded on purpose: the palette searches the same command log,
    // against the same history the editor's ↑/↓ walk.
    expect(matchChord(key({ key: "r", ctrlKey: true }), "linux")).toBe("historySearch");
    expect(matchChord(key({ key: "r", ctrlKey: true }), "darwin")).toBe("historySearch");
  });
});

describe("matchChord matching rules", () => {
  it("ignores a keyup carrying the same modifiers", () => {
    // The same chord being released. Claiming it would fire twice.
    expect(
      matchChord(key({ key: "p", metaKey: true, type: "keyup" } as never), "darwin"),
    ).toBeUndefined();
  });

  it("matches a chord exactly, never as a subset", () => {
    // Option+Cmd+P is not ⌘P. Without this, an unrelated chord that happens
    // to include the app modifier would fire an action the user did not ask
    // for — and the two listeners that both see ⌘P would disagree about it.
    expect(matchChord(key({ key: "p", metaKey: true, altKey: true }), "darwin")).toBeUndefined();
    expect(
      matchChord(key({ key: "P", ctrlKey: true, shiftKey: true, altKey: true }), "linux"),
    ).toBeUndefined();
  });

  it("is insensitive to the case Shift gives the key", () => {
    expect(matchChord(key({ key: "P", metaKey: true }), "darwin")).toBe("palette");
    expect(matchChord(key({ key: "p", ctrlKey: true, shiftKey: true }), "linux")).toBe("palette");
  });

  it("treats anything that is not darwin as Linux-spelled", () => {
    expect(matchChord(key({ key: "P", ctrlKey: true, shiftKey: true }), "freebsd")).toBe("palette");
  });
});

describe("keyLabel", () => {
  it("shows the glyphs a Mac user reads", () => {
    expect(keyLabel("palette", "darwin")).toBe("⌘P");
    expect(keyLabel("splitColumn", "darwin")).toBe("⌘⇧D");
    expect(keyLabel("voiceStart", "darwin")).toBe("⌥Space");
    expect(keyLabel("voiceStop", "darwin")).toBe("⌥⇧Space");
  });

  it("spells the chords a Linux user reads", () => {
    expect(keyLabel("palette", "linux")).toBe("Ctrl+Shift+P");
    expect(keyLabel("splitColumn", "linux")).toBe("Ctrl+Shift+E");
    expect(keyLabel("voiceStart", "linux")).toBe("Alt+Space");
    expect(keyLabel("voiceStop", "linux")).toBe("Alt+Shift+Space");
  });

  it("labels every action it can match, on both platforms", () => {
    // A hint that names a key which does nothing is worse than no hint, and
    // an action with no label is how one gets written by hand somewhere else.
    for (const platform of ["darwin", "linux"] as const) {
      for (const action of [
        "palette", "historySearch", "search", "filterFailed", "blockPrev", "blockNext",
        "copy", "paste", "clearScreen", "splitRow", "splitColumn", "closePane",
        "focusPrev", "focusNext", "sendRequest", "saveRequest", "voiceStart", "voiceStop",
      ] as const) {
        expect(keyLabel(action, platform)).not.toBe("");
      }
    }
  });
});
