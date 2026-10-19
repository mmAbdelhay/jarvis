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

export function createPaneScreens(
  shells: Pick<ShellManager, "onOutput" | "onShellExit" | "termSize">,
): PaneScreens {
  const screens = new Map<string, HeadlessTerminal>();
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
      screen = new Terminal({ cols, rows, scrollback: SCROLLBACK_LINES, allowProposedApi: true });
      screens.set(paneKey, screen);
    } else if (screen.cols !== cols || screen.rows !== rows) {
      screen.resize(cols, rows);
    }
    return screen;
  }

  const offOutput = shells.onOutput(({ paneKey, chunk }) => {
    const screen = screenFor(paneKey);
    lastWrite.set(paneKey, new Promise<void>((done) => screen.write(chunk, done)));
  });

  function drop(paneKey: string): void {
    screens.get(paneKey)?.dispose();
    screens.delete(paneKey);
    lastWrite.delete(paneKey);
  }

  const offExit = shells.onShellExit(({ paneKey }) => drop(paneKey));

  return {
    screenText(paneKey) {
      const screen = screens.get(paneKey);
      if (screen === undefined) return undefined;
      const buffer = screen.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buffer.length; i++) {
        lines.push((buffer.getLine(i)?.translateToString(true) ?? "").trimEnd());
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
