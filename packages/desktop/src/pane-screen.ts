// What each Terminal pane's screen shows, for the Reviews idle reader
// (agent-input-state.ts). Claude Code redraws with cursor-positioning
// escapes, so its raw output stripped of escapes glues words and lines
// together; a headless terminal per pane, fed the same output at the
// pane's own size, turns that stream back into the lines the user sees.
//
// One terminal per pane that has printed, created on its first chunk and
// dropped when its shell exits (a restarted shell starts a fresh screen —
// the reader then falls back to the raw log until it prints). Its size
// follows the pane's last resize, read per chunk; until the first resize
// it is the pty's default 80x24.

import type { ShellManager } from "@jarvis/platform";
import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;
type HeadlessTerminal = InstanceType<typeof Terminal>;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;
/** Lines kept above the visible screen — more than the idle reader's
 *  400-line busy scan (MAX_SCAN_LINES) ever looks at. */
const SCROLLBACK_LINES = 500;

type BufferLine = NonNullable<ReturnType<HeadlessTerminal["buffer"]["active"]["getLine"]>>;

/** The prompt glyphs an agent's input line starts with (Claude Code). */
const INPUT_GLYPHS = new Set(["❯", ">"]);

/**
 * One row as text, trailing whitespace trimmed — except that on a row whose
 * first visible character is an input glyph, everything after the glyph is
 * dropped when all of it is drawn dim: that is the empty box's placeholder
 * (Claude Code's `Try "…"`), never typed text, which is drawn plain.
 */
function rowText(line: BufferLine): string {
  const text = line.translateToString(true).trimEnd();
  const start = text.length - text.trimStart().length;
  if (!INPUT_GLYPHS.has(text.charAt(start))) return text;
  // Cells, not string indices: a wide or combined character can span more
  // than one of either. Walk to the glyph's cell, then check every visible
  // cell after it.
  let glyphX = -1;
  let anyAfter = false;
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (cell === undefined) break;
    const chars = cell.getChars();
    if (glyphX < 0) {
      if (chars.trim() !== "" && chars !== "\u00a0") {
        if (!INPUT_GLYPHS.has(chars)) return text;
        glyphX = x;
      }
      continue;
    }
    if (chars.trim() === "" || chars === "\u00a0") continue;
    if (cell.isDim() === 0) return text;
    anyAfter = true;
  }
  return anyAfter ? text.slice(0, start + 1) : text;
}

export type PaneScreens = {
  /** The pane's rendered buffer — scrollback, then the visible screen — one
   *  line per row with trailing whitespace trimmed, joined by "\n"; trailing
   *  empty rows dropped. Undefined for a pane with no screen (nothing
   *  printed since its shell started). May trail the newest chunk by the
   *  parser's one-tick write queue. */
  screenText(paneKey: string): string | undefined;
  /** Resolves once every chunk received so far has been parsed. */
  whenWritten(): Promise<void>;
  dispose(): void;
};

type TerminalOptions = {
  cols: number;
  rows: number;
  scrollback: number;
  allowProposedApi: boolean;
};

export type PaneScreensOptions = {
  /** Makes a pane's headless terminal; tests inject one that throws. */
  createTerminal?: (options: TerminalOptions) => HeadlessTerminal;
};

export function createPaneScreens(
  shells: Pick<ShellManager, "onOutput" | "onShellExit" | "termSize">,
  options: PaneScreensOptions = {},
): PaneScreens {
  const createTerminal =
    options.createTerminal ?? ((terminalOptions: TerminalOptions) => new Terminal(terminalOptions));
  const screens = new Map<string, HeadlessTerminal>();
  // Panes whose terminal threw: no screen (the reader uses the raw log)
  // until the shell exits — a screen rebuilt mid-stream would miss what
  // was drawn before it and could show a box without the spinner above.
  const failed = new Set<string>();
  // Each live screen's newest write: xterm parses writes in order, so its
  // callback means every earlier chunk is parsed too. A dropped screen's
  // entry goes with it, so a write a disposed terminal never finishes
  // cannot hold whenWritten up.
  const lastWrite = new Map<string, Promise<void>>();

  function screenFor(paneKey: string): HeadlessTerminal {
    const size = shells.termSize(paneKey);
    const cols = size?.cols ?? DEFAULT_COLS;
    const rows = size?.rows ?? DEFAULT_ROWS;
    let screen = screens.get(paneKey);
    if (screen === undefined) {
      screen = createTerminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
      screens.set(paneKey, screen);
    } else if (screen.cols !== cols || screen.rows !== rows) {
      screen.resize(cols, rows);
    }
    return screen;
  }

  // Runs inside ShellManager's onData loop: nothing may throw out of it.
  const offOutput = shells.onOutput(({ paneKey, chunk }) => {
    if (failed.has(paneKey)) return;
    try {
      const screen = screenFor(paneKey);
      // write is called here, not inside a Promise executor, so a throw
      // reaches the catch below instead of becoming an unhandled rejection.
      let done = (): void => {};
      const written = new Promise<void>((resolve) => {
        done = resolve;
      });
      screen.write(chunk, () => done());
      lastWrite.set(paneKey, written);
    } catch (error) {
      console.error(
        `pane-screen: ${paneKey}: ${error instanceof Error ? error.message : String(error)}`,
      );
      drop(paneKey);
      failed.add(paneKey);
    }
  });

  function drop(paneKey: string): void {
    const screen = screens.get(paneKey);
    screens.delete(paneKey);
    lastWrite.delete(paneKey);
    try {
      screen?.dispose();
    } catch {
      // Already broken; it is forgotten either way.
    }
  }

  const offExit = shells.onShellExit(({ paneKey }) => {
    drop(paneKey);
    failed.delete(paneKey);
  });

  return {
    screenText(paneKey) {
      const screen = screens.get(paneKey);
      if (screen === undefined) return undefined;
      const buffer = screen.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        const line = buffer.getLine(i);
        lines.push(line === undefined ? "" : rowText(line));
      }
      while (lines.length > 0 && lines.at(-1) === "") lines.pop();
      return lines.join("\n");
    },
    whenWritten: async () => {
      await Promise.all(lastWrite.values());
    },
    dispose() {
      offOutput();
      offExit();
      for (const paneKey of [...screens.keys()]) drop(paneKey);
    },
  };
}
