// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { FakeTerminal } from "./terminal-double.js";
import {
  attachCompletion,
  createDropdown,
  createPromptTracker,
  currentInput,
  type CompletionHooks,
  type ReadableBuffer,
} from "./terminal-completion.js";

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

describe("createDropdown", () => {
  // Shell history is untrusted text: it holds whatever the user, or
  // anything that wrote to their history, put there.
  it("renders a suggestion containing HTML as text, never as markup", () => {
    const host = document.createElement("div");
    const dropdown = createDropdown(host);

    dropdown.show(["echo <img src=x onerror=alert(1)>"], { x: 0, y: 0 }, 8, 16);

    expect(host.querySelectorAll("img")).toHaveLength(0);
    expect(host.textContent).toContain("echo <img src=x onerror=alert(1)>");
  });

  it("selects the first suggestion when it opens", () => {
    const dropdown = createDropdown(document.createElement("div"));

    dropdown.show(["a", "b"], { x: 0, y: 0 }, 8, 16);

    expect(dropdown.selected()).toBe("a");
  });

  it("moves the selection and wraps at both ends", () => {
    const dropdown = createDropdown(document.createElement("div"));
    dropdown.show(["a", "b", "c"], { x: 0, y: 0 }, 8, 16);

    dropdown.move(1);
    expect(dropdown.selected()).toBe("b");

    dropdown.move(-1);
    dropdown.move(-1);
    expect(dropdown.selected()).toBe("c");

    dropdown.move(1);
    expect(dropdown.selected()).toBe("a");
  });

  it("is closed, with nothing selected, after hide()", () => {
    const dropdown = createDropdown(document.createElement("div"));
    dropdown.show(["a"], { x: 0, y: 0 }, 8, 16);

    dropdown.hide();

    expect(dropdown.isOpen()).toBe(false);
    expect(dropdown.selected()).toBeUndefined();
  });

  it("does not open on an empty list", () => {
    const dropdown = createDropdown(document.createElement("div"));

    dropdown.show([], { x: 0, y: 0 }, 8, 16);

    expect(dropdown.isOpen()).toBe(false);
  });

  it("positions itself under the cell the input starts at", () => {
    const host = document.createElement("div");
    const dropdown = createDropdown(host);

    dropdown.show(["a"], { x: 6, y: 2 }, 8, 16);

    expect(dropdown.element.style.left).toBe("48px");
    expect(dropdown.element.style.top).toBe("48px");
  });
});

describe("attachCompletion", () => {
  function attached(suggestions: string[] = ["git status"]) {
    const terminal = new FakeTerminal();
    const host = document.createElement("div");
    const sent: string[] = [];
    const asked: string[] = [];
    const hooks: CompletionHooks = {
      suggest: async (input) => {
        asked.push(input);
        return suggestions;
      },
      sendInput: (data) => sent.push(data),
    };
    const completion = attachCompletion(terminal as never, host, hooks);
    // The dropdown never attaches a key handler of its own — xterm keeps
    // only one, and terminal-addons.ts owns it. So the tests drive the
    // handler the same way that module does.
    const press = (init: { key: string; ctrlKey?: boolean; metaKey?: boolean }): boolean =>
      completion.handleKey({ type: "keydown", preventDefault: () => {}, ...init } as never);
    return { terminal, host, sent, asked, press };
  }

  /** Puts the shell at a prompt with `typed` after it, and lets the
   *  refresh settle. */
  async function typeAt(terminal: FakeTerminal, prompt: string, typed: string): Promise<void> {
    terminal.parser.emitOsc(133, "A");
    terminal.typeLine(prompt);
    terminal.parser.emitOsc(133, "B");
    terminal.typeLine(prompt + typed);
    terminal.emitData(typed.slice(-1));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  // The single rule that keeps the terminal feeling like a terminal: with
  // the dropdown shut, zsh receives every key exactly as it does today.
  it("passes every key to zsh while the dropdown is closed", () => {
    const { terminal, press } = attached();

    for (const key of ["Tab", "ArrowUp", "ArrowDown", "Enter", "Escape", "a", "c"]) {
      expect(press({ key })).toBe(true);
    }
  });

  it("opens on typing and lists what the source returned", async () => {
    const { terminal, host, asked, press } = attached();

    await typeAt(terminal, "~/p > ", "git sta");

    expect(asked).toEqual(["git sta"]);
    expect(host.textContent).toContain("git status");
  });

  it("does not open at a bare prompt, and does not even ask", async () => {
    const { terminal, host, asked, press } = attached();

    terminal.parser.emitOsc(133, "A");
    terminal.typeLine("~/p > ");
    terminal.parser.emitOsc(133, "B");
    terminal.emitData("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(asked).toEqual([]);
    expect(host.textContent).toBe("");
  });

  it("does not open while a command is running", async () => {
    const { terminal, asked, press } = attached();
    await typeAt(terminal, "~/p > ", "git sta");

    terminal.parser.emitOsc(133, "C");
    terminal.emitData("x");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(asked).toEqual(["git sta"]);
    expect(press({ key: "Tab" })).toBe(true);
  });

  it("does not open when there is nothing to suggest, so Tab falls through to zsh", async () => {
    const { terminal, press } = attached([]);

    await typeAt(terminal, "~/p > ", "globex-dep");

    expect(press({ key: "Tab" })).toBe(true);
  });

  it("claims Tab, the arrows, Enter and Escape only while it is open", async () => {
    const { terminal, press } = attached(["git status", "git stash"]);
    await typeAt(terminal, "~/p > ", "git sta");

    for (const key of ["ArrowDown", "ArrowUp"]) {
      expect(press({ key })).toBe(false);
    }
    expect(press({ key: "Enter" })).toBe(false);
  });

  it("leaves a Ctrl or Cmd chord to the terminal even while open", async () => {
    const { terminal, press } = attached();
    await typeAt(terminal, "~/p > ", "git sta");

    expect(press({ key: "c", ctrlKey: true })).toBe(true);
    expect(press({ key: "f", metaKey: true })).toBe(true);
  });

  it("replaces the typed line with the accepted suggestion, without running it", async () => {
    const { terminal, sent, press } = attached();
    await typeAt(terminal, "~/p > ", "git sta");

    press({ key: "Tab" });

    expect(sent).toEqual(["\u007f".repeat(7) + "git status"]);
  });

  it("closes after accepting, so the next Tab is zsh's again", async () => {
    const { terminal, press } = attached();
    await typeAt(terminal, "~/p > ", "git sta");
    press({ key: "Tab" });

    expect(press({ key: "Tab" })).toBe(true);
  });

  it("closes on Escape without sending anything to the shell", async () => {
    const { terminal, sent, press } = attached();
    await typeAt(terminal, "~/p > ", "git sta");

    expect(press({ key: "Escape" })).toBe(false);
    expect(sent).toEqual([]);
    expect(press({ key: "Tab" })).toBe(true);
  });

  it("stays closed when the buffer read throws", async () => {
    const { terminal, press } = attached();
    terminal.parser.emitOsc(133, "A");
    terminal.typeLine("~/p > ");
    terminal.parser.emitOsc(133, "B");
    Object.defineProperty(terminal, "buffer", {
      get() {
        throw new Error("disposed");
      },
    });

    terminal.emitData("g");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(press({ key: "Tab" })).toBe(true);
  });

  it("survives a terminal whose parser refuses an OSC handler", () => {
    const terminal = new FakeTerminal();
    Object.defineProperty(terminal, "parser", {
      get() {
        throw new Error("no parser");
      },
    });

    expect(() =>
      attachCompletion(terminal as never, document.createElement("div"), {
        suggest: async () => [],
        sendInput: () => {},
      }),
    ).not.toThrow();
  });
});
