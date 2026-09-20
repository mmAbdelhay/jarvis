// The one palette every terminal surface reads.
//
// It used to be a literal in workspace-terminal.ts and an identical literal
// in session-view.ts, each with a comment warning that the two must not
// drift. Blocks make that unenforceable by comment: a frozen block is
// painted by this file's ansiColor() and the live terminal by xterm's own
// theme, and if those disagree the same bytes change colour when a command
// finishes. One constant, read by both, is the only version of this that
// stays true.

export const TERMINAL_THEME = {
  background: "#060a0f",
  foreground: "#e6f3f8",
  cursor: "#45c8dc",
  cursorAccent: "#060a0f",
  selectionBackground: "#1c3f49",
  black: "#0b1219",
  red: "#d9645a",
  green: "#5fb87a",
  yellow: "#d9a85a",
  blue: "#45c8dc",
  magenta: "#a97fd0",
  cyan: "#7ddced",
  white: "#cfe4ec",
  brightBlack: "#5c7484",
  brightRed: "#e8837a",
  brightGreen: "#7fd398",
  brightYellow: "#efc47c",
  brightBlue: "#7ddced",
  brightMagenta: "#c3a0e4",
  brightCyan: "#a8e9f6",
  brightWhite: "#ffffff",
};

export const TERMINAL_FONT = {
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
  fontSize: 12,
  lineHeight: 1.35,
};

/**
 * How much scrollback a terminal keeps when jarvis.yaml says nothing.
 *
 * xterm stores a line as `Uint32Array(cols * 3)` — 12 bytes a cell — so at
 * 200 columns this is ~12 MB per pane once filled, and a split tab has one
 * pane per leaf beside the Session route's own. It was 20 000 (~48 MB each)
 * until the memory pass of 2026-09-05; `performance.terminalScrollback` is
 * how you ask for that back.
 */
export const SCROLLBACK_LINES = 5_000;

const ANSI_16 = [
  TERMINAL_THEME.black,
  TERMINAL_THEME.red,
  TERMINAL_THEME.green,
  TERMINAL_THEME.yellow,
  TERMINAL_THEME.blue,
  TERMINAL_THEME.magenta,
  TERMINAL_THEME.cyan,
  TERMINAL_THEME.white,
  TERMINAL_THEME.brightBlack,
  TERMINAL_THEME.brightRed,
  TERMINAL_THEME.brightGreen,
  TERMINAL_THEME.brightYellow,
  TERMINAL_THEME.brightBlue,
  TERMINAL_THEME.brightMagenta,
  TERMINAL_THEME.brightCyan,
  TERMINAL_THEME.brightWhite,
];

/** Slot → colour, for the frozen renderer. Out of range means the program
 *  asked for a 256-colour index this palette does not name; the foreground
 *  is the honest answer, and Task 3 handles the RGB case separately. */
export function ansiColor(index: number): string {
  return ANSI_16[index] ?? TERMINAL_THEME.foreground;
}
