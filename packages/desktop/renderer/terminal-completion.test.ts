// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createPromptTracker, currentInput, type ReadableBuffer } from "./terminal-completion.js";

/** A fake xterm buffer: the rows of the screen, and where the cursor is.
 *  xterm renders to a canvas jsdom does not have, so the tests talk to the
 *  same shape it exposes rather than to a real emulator. */
function buffer(lines: string[], cursor: { x: number; y: number }, baseY = 0): ReadableBuffer {
  return {
    cursorX: cursor.x,
    cursorY: cursor.y,
    baseY,
    getLine: (y: number) => {
      const line = lines[y];
      if (line === undefined) return undefined;
      return {
        translateToString: (_trim?: boolean, start = 0, end = line.length) =>
          line.slice(start, end),
      };
    },
  };
}

describe("createPromptTracker", () => {
  // The absence of a mark is the off switch: an unknown shell, or a user
  // whose own precmd overwrote the hook, simply never gets a dropdown.
  it("has no mark before any OSC 133 arrives", () => {
    expect(createPromptTracker().mark()).toBeUndefined();
  });

  it("records the cursor at the prompt-end mark", () => {
    const tracker = createPromptTracker();

    tracker.handle("A", { x: 0, y: 5 });
    tracker.handle("B", { x: 12, y: 5 });

    expect(tracker.mark()).toEqual({ x: 12, y: 5 });
  });

  // Suggestions must not appear over a running program's output.
  it("forgets the mark while a command is running", () => {
    const tracker = createPromptTracker();
    tracker.handle("B", { x: 12, y: 5 });

    tracker.handle("C", { x: 12, y: 5 });

    expect(tracker.running()).toBe(true);
    expect(tracker.mark()).toBeUndefined();
  });

  it("clears the old mark at the start of the next prompt", () => {
    const tracker = createPromptTracker();
    tracker.handle("B", { x: 12, y: 5 });
    tracker.handle("C", { x: 12, y: 5 });

    tracker.handle("D;0", { x: 0, y: 6 });
    expect(tracker.running()).toBe(false);

    tracker.handle("A", { x: 0, y: 6 });
    expect(tracker.mark()).toBeUndefined();
  });

  it("takes a fresh mark at the next prompt's end", () => {
    const tracker = createPromptTracker();
    tracker.handle("B", { x: 12, y: 5 });
    tracker.handle("C", { x: 12, y: 5 });
    tracker.handle("D;0", { x: 0, y: 6 });
    tracker.handle("A", { x: 0, y: 6 });

    tracker.handle("B", { x: 7, y: 6 });

    expect(tracker.mark()).toEqual({ x: 7, y: 6 });
  });

  it("ignores a payload it does not know", () => {
    const tracker = createPromptTracker();
    tracker.handle("B", { x: 3, y: 1 });

    tracker.handle("Z;whatever", { x: 9, y: 9 });

    expect(tracker.mark()).toEqual({ x: 3, y: 1 });
  });
});

describe("currentInput", () => {
  it("is the text between the mark and the cursor", () => {
    expect(currentInput(buffer(["~/p > git sta"], { x: 13, y: 0 }), { x: 6, y: 0 })).toBe("git sta");
  });

  it("is empty at a bare prompt", () => {
    expect(currentInput(buffer(["~/p > "], { x: 6, y: 0 }), { x: 6, y: 0 })).toBe("");
  });

  // A long command wraps, and the shell's idea of the line does not.
  it("joins a line that wrapped onto the next row", () => {
    expect(currentInput(buffer(["~/p > aaaa", "bbb"], { x: 3, y: 1 }), { x: 6, y: 0 })).toBe(
      "aaaabbb",
    );
  });

  // The mark's row is absolute, so scrollback moving under it does not
  // shift what is read.
  it("reads absolute rows, so a scrolled viewport still reads the right line", () => {
    const lines = ["scrolled away", "~/p > git sta"];
    expect(currentInput(buffer(lines, { x: 13, y: 0 }, 1), { x: 6, y: 1 })).toBe("git sta");
  });

  it("is undefined when the cursor is above the mark — the screen was cleared", () => {
    expect(currentInput(buffer(["~/p > x"], { x: 0, y: 0 }), { x: 6, y: 4 })).toBeUndefined();
  });

  it("is undefined when the marked row has scrolled out of the buffer", () => {
    expect(currentInput(buffer([], { x: 0, y: 0 }), { x: 0, y: 0 })).toBeUndefined();
  });

  it("is undefined rather than throwing when the buffer read fails", () => {
    const hostile: ReadableBuffer = {
      cursorX: 0,
      cursorY: 0,
      baseY: 0,
      getLine: () => {
        throw new Error("disposed");
      },
    };

    expect(currentInput(hostile, { x: 0, y: 0 })).toBeUndefined();
  });
});
