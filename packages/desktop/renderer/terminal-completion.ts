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
