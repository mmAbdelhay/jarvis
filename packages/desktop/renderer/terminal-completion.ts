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
  /** The current line, read from somewhere other than the xterm buffer —
   *  the DOM editor Task 8 put in front of the shell. When this is given
   *  it is the source of the current line and `currentInput`'s buffer
   *  scrape is not consulted: while that editor is live the screen still
   *  shows the bare prompt, since nothing the user types reaches the pty
   *  (and so the buffer) until they press Enter. Absent — the terminal has
   *  no editor, or this is the alternate screen — the buffer scrape is
   *  exactly what it always was. */
  readInput?: () => string | undefined;
  /** Accepts a suggestion by setting the editor's value directly, in place
   *  of erasing what is typed with backspaces and retyping it. When this
   *  is given, `sendInput` is not called at all on accept: the pty never
   *  received the typed line in the first place (see `readInput`), so
   *  backspacing it there would erase bytes the shell does not have, or
   *  worse, whatever real input arrives next. Absent, acceptance falls
   *  back to the backspace-and-retype dance against the pty. */
  applyInput?: (line: string) => void;
  /** Where to put the dropdown when there is an editor: the anchor box's
   *  left edge and its vertical span (`top`/`bottom`), all in pixels
   *  relative to `host` — rather than the buffer-cell math `mark` drives.
   *  The editor draws over the terminal, so there is no caret cell to
   *  compute the dropdown's position from — the caller hands over the
   *  editor's own bounding box instead. `top`/`bottom` (not a single `y`)
   *  is what lets `show` open the list upward when the box sits near the
   *  bottom of `host` — as the pinned input editor does — rather than
   *  driving it off the pane on the assumption the box is always near the
   *  top. Absent, the dropdown positions itself under the prompt mark's
   *  cell, as it always has. */
  anchor?: () => { x: number; top: number; bottom: number };
  /** Whether a prompt is waiting, according to the caller rather than to
   *  this module's own OSC handler.
   *
   *  It exists because the handler cannot see the marks in blocks mode.
   *  terminal-pane's write() does not hand the raw stream to xterm there —
   *  it pushes into the block splitter and writes only the text that comes
   *  back, and the splitter consumes every "133;" payload as its own. So
   *  the parser is never told a prompt started, tracker.mark() stays
   *  undefined, and refresh() gave up on its first line for every
   *  keystroke: no dropdown at all in the one mode that has an editor to
   *  complete into.
   *
   *  The pane knows the answer — the splitter is what told it to show a
   *  prompt — so it is the honest source here. Absent, the mark is the
   *  source exactly as before, which is what a plain-mode terminal (raw
   *  stream, real marks) still uses. */
  promptActive?: () => boolean;
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
};

export type Completion = {
  /** Run before the terminal's own key handling. Returns false when the
   *  dropdown claimed the key, true to let it through — the shape
   *  attachCustomKeyEventHandler expects.
   *
   *  This is deliberately not registered here. xterm keeps exactly one
   *  custom key handler, so a second attachCustomKeyEventHandler would
   *  silently replace the addon stack's and take Cmd+F, Cmd+V and
   *  Shift+Enter with it. terminal-addons.ts owns the one handler and
   *  consults this first. */
  handleKey(event: KeyboardEvent): boolean;
  /** Hides the dropdown without accepting anything — what the command
   *  palette calls before it opens over the same pane, so a suggestion
   *  list left showing from mid-typing does not sit stale underneath it. */
  close(): void;
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
): Completion {
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
    // No marks means no dropdown, and that is the whole failure. Every key
    // goes straight through.
    return { handleKey: () => true, close: () => {} };
  }

  /** A prompt is waiting: either this module saw the mark, or the caller —
   *  which in blocks mode is the only one that can — says so. */
  function atPrompt(): boolean {
    return tracker.mark() !== undefined || (hooks.promptActive?.() ?? false);
  }

  async function refresh(): Promise<void> {
    const mark = tracker.mark();
    if (!atPrompt()) {
      dropdown.hide();
      openFor = undefined;
      return;
    }

    let input: string | undefined;
    try {
      // The buffer scrape needs a mark to read from. It is only ever
      // reached with no editor in front of the shell, and that is exactly
      // the case where the mark is the thing that got us here.
      input =
        hooks.readInput?.() ??
        (mark === undefined ? undefined : currentInput(terminal.buffer.active, mark));
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
    // Still at a prompt, by whichever source answered before.
    if (!atPrompt()) return;
    const latest = tracker.mark();
    let stillTyped: string | undefined;
    try {
      stillTyped =
        hooks.readInput?.() ??
        (latest === undefined ? undefined : currentInput(terminal.buffer.active, latest));
    } catch {
      stillTyped = undefined;
    }
    if (stillTyped !== input) return;

    const cell = cellSize(host, terminal.cols, terminal.rows);
    // With no mark there is an editor, and `anchor` below replaces this
    // placement outright — the origin is only somewhere for `show` to start.
    dropdown.show(items, mark ?? { x: 0, y: 0 }, cell.x, cell.y);
    // An editor in front of the shell has no caret cell to be under — the
    // buffer never moves while it is live — so its own bounding box wins
    // over the cell math `show` just did. Direction is decided from the
    // room actually measured in `host`, not from an assumption that the
    // box sits at the top: today the input editor is pinned at the
    // pane's bottom, where "just below the box" is at or past the pane's
    // own bottom edge — invisible, or a sliver.
    if (hooks.anchor !== undefined && dropdown.isOpen()) {
      const box = hooks.anchor();
      const hostHeight = host.clientHeight;
      const spaceAbove = box.top;
      const spaceBelow = hostHeight - box.bottom;
      dropdown.element.style.left = `${box.x}px`;
      if (spaceBelow >= spaceAbove) {
        dropdown.element.style.top = `${box.bottom}px`;
        dropdown.element.style.bottom = "";
      } else {
        dropdown.element.style.top = "";
        dropdown.element.style.bottom = `${hostHeight - box.top}px`;
      }
    }
    openFor = dropdown.isOpen() ? input : undefined;
  }

  // A keystroke is only in the buffer after xterm has processed it, so the
  // read is deferred by a turn rather than done inline.
  terminal.onData(() => {
    setTimeout(() => void refresh(), 0);
  });

  // With an editor live, nothing reaches the pty per keystroke — the whole
  // point of readInput — so `terminal.onData` never fires while the user
  // types and refresh() has nothing else to wake it. A keydown is the only
  // signal left, deferred a turn so the read lands after the editor (or
  // the browser's own default action) has actually applied it, the same
  // way the onData path defers behind the pty's own echo.
  function scheduleRefresh(): void {
    if (hooks.readInput !== undefined) setTimeout(() => void refresh(), 0);
  }

  function handleKey(event: KeyboardEvent): boolean {
    if (event.type !== "keydown") return true;
    // Closed: every key is zsh's, unchanged. This is the line that keeps
    // the terminal behaving exactly as it does today.
    if (!dropdown.isOpen()) {
      scheduleRefresh();
      return true;
    }
    // A chord is the app's or the shell's, never the dropdown's — ^C must
    // still interrupt, and the find bar's chord (⌘F, or Ctrl+Shift+F off
    // darwin — see keys.ts) must still open it. Both carry a modifier, which
    // is all this needs to know.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      scheduleRefresh();
      return true;
    }

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
        if (hooks.applyInput !== undefined) {
          // The editor's own value, direct — nothing to erase, because the
          // pty never had the typed line to begin with.
          hooks.applyInput(value);
        } else {
          // Erase what is typed, then write the whole line. No newline: the
          // user still presses Enter themselves, so accepting a suggestion
          // can never run a command they did not read.
          hooks.sendInput(BACKSPACE.repeat(typed.length) + value);
        }
      }
      return false;
    }

    scheduleRefresh();
    return true;
  }

  return {
    handleKey,
    close: () => {
      dropdown.hide();
      openFor = undefined;
    },
  };
}
