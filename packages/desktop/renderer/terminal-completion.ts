// Terminal autocomplete, in the renderer.
//
// The one decision everything else rests on: what the user has typed is
// read from the xterm buffer, never modelled by accumulating keystrokes.
// A keystroke model is correct right up until the user presses Up, ^W, ^U,
// ^A or pastes, at which point Jarvis's idea of the line silently diverges
// from the shell's and every suggestion is computed against a line that is
// not on the screen. What is on screen is what the shell believes, by
// construction, so history recall and kill-word simply work — there is
// nothing to keep in sync.
//
// Reading the screen needs the one thing the screen does not carry: where
// the prompt stops and the command begins. Prompts are user-configured and
// cannot be pattern-matched, so it comes from OSC 133 — the FinalTerm marks
// that VS Code, WezTerm and Warp all use, emitted by the hook in the
// ZDOTDIR wrapper (see zsh-integration.ts).

/** Where the typed line starts: an absolute buffer row and a column. */
export type PromptMark = { x: number; y: number };

/** The part of xterm's buffer this module reads. Narrowed to what it
 *  actually uses so a test can hand it a plain object. */
export type ReadableBuffer = {
  cursorX: number;
  /** Rows below the top of the viewport. */
  cursorY: number;
  /** The absolute row the viewport starts at. */
  baseY: number;
  getLine(y: number):
    | { translateToString(trimRight?: boolean, start?: number, end?: number): string }
    | undefined;
};

export type PromptTracker = {
  /** Feed it an OSC 133 payload — "A", "B", "C", "D;0" — and where the
   *  cursor was when it arrived. */
  handle(payload: string, cursor: { x: number; y: number }): void;
  /** Where the typed line starts, or undefined when that is unknown: no
   *  marks yet, or a command is running. */
  mark(): PromptMark | undefined;
  running(): boolean;
};

/**
 * Follows the shell through prompt and command.
 *
 * `A` starts a prompt, `B` ends it — the column the typed command begins
 * at, which is the whole point. `C` says a command started, so there is no
 * input line to complete and the dropdown must close; `D` says it finished.
 *
 * A tracker that has seen no marks has no mark to give, and that is the
 * feature's off switch: an unknown shell, a failed wrapper write, or a
 * user's own precmd that overwrote the hook all end here, quietly.
 */
export function createPromptTracker(): PromptTracker {
  let mark: PromptMark | undefined;
  let running = false;

  return {
    handle(payload, cursor) {
      const kind = payload.charAt(0);
      if (kind === "A") {
        // A new prompt is starting; the old line is gone.
        mark = undefined;
        running = false;
        return;
      }
      if (kind === "B") {
        mark = { x: cursor.x, y: cursor.y };
        running = false;
        return;
      }
      if (kind === "C") {
        mark = undefined;
        running = true;
        return;
      }
      if (kind === "D") {
        running = false;
      }
      // Anything else is a mark this version does not use — ignored rather
      // than treated as a state change.
    },
    mark: () => mark,
    running: () => running,
  };
}

/**
 * The text between the prompt mark and the cursor — what the user has
 * typed, exactly as the shell has it.
 *
 * Rows are absolute (`baseY + cursorY`), so scrollback moving underneath
 * does not shift what is read, and a wrapped command is stitched back into
 * the one line it is.
 *
 * Every failure returns undefined, which the caller reads as "close the
 * dropdown": a cursor above the mark means the screen was cleared or
 * reflowed, a missing row means the mark scrolled out, and a throw means
 * the terminal is being disposed. None of those is worth an error.
 */
export function currentInput(buffer: ReadableBuffer, mark: PromptMark): string | undefined {
  try {
    const cursorRow = buffer.baseY + buffer.cursorY;
    if (cursorRow < mark.y) return undefined;

    let text = "";
    for (let row = mark.y; row <= cursorRow; row += 1) {
      const line = buffer.getLine(row);
      if (line === undefined) return undefined;
      const start = row === mark.y ? mark.x : 0;
      const end = row === cursorRow ? buffer.cursorX : undefined;
      text += line.translateToString(false, start, end);
    }
    // A cell the shell has not written reads as a space; the trailing run
    // of them is padding, not typed input.
    return text.replace(/\s+$/, "");
  } catch {
    return undefined;
  }
}

export type Dropdown = {
  /** Opens under the cell at `at`. An empty list does not open — that is
   *  what lets Tab fall through to zsh when there is nothing to offer. */
  show(items: readonly string[], at: PromptMark, cellWidth: number, cellHeight: number): void;
  hide(): void;
  isOpen(): boolean;
  /** Moves the selection, wrapping at both ends. */
  move(delta: number): void;
  selected(): string | undefined;
  element: HTMLElement;
};

/**
 * The suggestion list, built as nodes and appended to the terminal's own
 * host so it travels with the pane it belongs to.
 *
 * Every suggestion goes in through `textContent`, never `innerHTML`. Shell
 * history is untrusted text — it holds whatever the user, or anything that
 * appended to their history, put there — and a dropdown that parsed it as
 * markup would be executing it.
 */
export function createDropdown(host: HTMLElement): Dropdown {
  const element = document.createElement("div");
  element.className = "terminal-completion";
  element.hidden = true;
  host.append(element);

  let items: readonly string[] = [];
  let index = 0;

  function paint(): void {
    element.replaceChildren();
    items.forEach((value, position) => {
      const row = document.createElement("div");
      row.className =
        position === index ? "terminal-completion-item selected" : "terminal-completion-item";
      // textContent, deliberately. See the note above.
      row.textContent = value;
      element.append(row);
    });
  }

  return {
    element,

    show(next, at, cellWidth, cellHeight) {
      items = next;
      index = 0;
      if (items.length === 0) {
        element.hidden = true;
        return;
      }
      element.style.left = `${at.x * cellWidth}px`;
      // One row below the line being typed, so the dropdown never covers it.
      element.style.top = `${(at.y + 1) * cellHeight}px`;
      element.hidden = false;
      paint();
    },

    hide() {
      items = [];
      index = 0;
      element.hidden = true;
      element.replaceChildren();
    },

    isOpen: () => !element.hidden,

    move(delta) {
      if (items.length === 0) return;
      index = (index + delta + items.length) % items.length;
      paint();
    },

    selected: () => items[index],
  };
}

export type CompletionHooks = {
  /** What to offer for the line as it now stands. */
  suggest: (input: string) => Promise<string[]>;
  /** Sends bytes to this terminal's pty. */
  sendInput: (data: string) => void;
};

/** DEL, the byte a terminal sends for Backspace and the one zsh's line
 *  editor binds to backward-delete-char. Accepting a suggestion erases what
 *  was typed this way rather than with ^U, which kills the whole line and
 *  would take a prefix the user had recalled with it. */
const BACKSPACE = "\u007f";

/** Anything the terminal draws is measured in cells, and xterm exposes no
 *  cell size. The host's measured box divided by the grid is the same
 *  number, and it stays right through a resize. */
function cellSize(host: HTMLElement, cols: number, rows: number): { x: number; y: number } {
  const width = host.clientWidth > 0 && cols > 0 ? host.clientWidth / cols : 8;
  const height = host.clientHeight > 0 && rows > 0 ? host.clientHeight / rows : 17;
  return { x: width, y: height };
}

type CompletableTerminal = {
  cols: number;
  rows: number;
  buffer: { active: ReadableBuffer };
  parser: { registerOscHandler(ident: number, callback: (data: string) => boolean): unknown };
  onData(listener: (data: string) => void): void;
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void;
};

/** The OSC identifier FinalTerm defined and iTerm2, VS Code, WezTerm and
 *  Warp all speak. */
const OSC_SHELL_INTEGRATION = 133;

/**
 * Wires the dropdown to a terminal.
 *
 * Two rules hold the whole thing together.
 *
 * Keys are claimed *only while the dropdown is open*. Closed, the handler
 * returns true for everything and zsh's own Tab completion, history search
 * and arrows behave exactly as they do today — which is what keeps this
 * from making the terminal feel broken.
 *
 * Nothing here can throw into the terminal. A parser that will not take a
 * handler, a buffer read that fails on a disposed terminal, a suggestion
 * call that rejects: each one leaves a terminal with no autocomplete, which
 * is the terminal the user already had.
 */
export function attachCompletion(
  terminal: CompletableTerminal,
  host: HTMLElement,
  hooks: CompletionHooks,
): void {
  const tracker = createPromptTracker();
  const dropdown = createDropdown(host);
  /** The line the open dropdown was computed for — what accepting has to
   *  erase, and what a late response is checked against. */
  let openFor: string | undefined;

  try {
    terminal.parser.registerOscHandler(OSC_SHELL_INTEGRATION, (data) => {
      const active = terminal.buffer.active;
      tracker.handle(data, { x: active.cursorX, y: active.baseY + active.cursorY });
      if (tracker.mark() === undefined) {
        dropdown.hide();
        openFor = undefined;
      }
      // False: this is a mark, not something to render, and xterm should go
      // on with its own handling of the sequence.
      return false;
    });
  } catch {
    // No marks means no dropdown, and that is the whole failure.
    return;
  }

  async function refresh(): Promise<void> {
    const mark = tracker.mark();
    if (mark === undefined) {
      dropdown.hide();
      openFor = undefined;
      return;
    }

    let input: string | undefined;
    try {
      input = currentInput(terminal.buffer.active, mark);
    } catch {
      input = undefined;
    }
    if (input === undefined || input.trim() === "") {
      dropdown.hide();
      openFor = undefined;
      return;
    }

    let items: string[];
    try {
      items = await hooks.suggest(input);
    } catch {
      items = [];
    }

    // The user has typed on since this was asked for; the answer is stale.
    const latest = tracker.mark();
    if (latest === undefined) return;
    let stillTyped: string | undefined;
    try {
      stillTyped = currentInput(terminal.buffer.active, latest);
    } catch {
      stillTyped = undefined;
    }
    if (stillTyped !== input) return;

    const cell = cellSize(host, terminal.cols, terminal.rows);
    dropdown.show(items, mark, cell.x, cell.y);
    openFor = dropdown.isOpen() ? input : undefined;
  }

  // A keystroke is only in the buffer after xterm has processed it, so the
  // read is deferred by a turn rather than done inline.
  terminal.onData(() => {
    setTimeout(() => void refresh(), 0);
  });

  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    // Closed: every key is zsh's, unchanged. This is the line that keeps
    // the terminal behaving exactly as it does today.
    if (!dropdown.isOpen()) return true;
    // A chord is the app's or the shell's — Ctrl-C must still interrupt,
    // Cmd-F must still open the find bar.
    if (event.ctrlKey || event.metaKey || event.altKey) return true;

    if (event.key === "Escape") {
      dropdown.hide();
      openFor = undefined;
      event.preventDefault();
      return false;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      dropdown.move(event.key === "ArrowDown" ? 1 : -1);
      event.preventDefault();
      return false;
    }

    if (event.key === "Tab" || event.key === "Enter") {
      const value = dropdown.selected();
      const typed = openFor;
      dropdown.hide();
      openFor = undefined;
      event.preventDefault();
      if (value !== undefined && typed !== undefined) {
        // Erase what is typed, then write the whole line. No newline: the
        // user still presses Enter themselves, so accepting a suggestion
        // can never run a command they did not read.
        hooks.sendInput(BACKSPACE.repeat(typed.length) + value);
      }
      return false;
    }

    return true;
  });
}
