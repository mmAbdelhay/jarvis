// The range `terminal.fontSize` accepts, in one node-free module so the
// renderer (Settings, terminal-font.ts) checks a size by the same rule
// config.ts loads it with.

/** Below 8 a cell is unreadable; above 32 a split pane is left a handful of
 *  columns wide. The zoom keys clamp to the same pair. */
export const TERMINAL_FONT_SIZE_MIN = 8;
export const TERMINAL_FONT_SIZE_MAX = 32;

/** A whole number of pixels in range. A fractional size gives xterm
 *  fractional cells: blurred glyphs, and frozen blocks that no longer line
 *  up with the canvas they were copied from. */
export function isTerminalFontSize(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= TERMINAL_FONT_SIZE_MIN &&
    value <= TERMINAL_FONT_SIZE_MAX
  );
}
