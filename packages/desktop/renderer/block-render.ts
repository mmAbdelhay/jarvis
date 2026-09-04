// packages/desktop/renderer/block-render.ts
// A finished command's bytes, drawn once and never again.
//
// The bytes are replayed into a headless xterm — the same emulator that
// drew them live, so anything it understands is understood here too — and
// its buffer is then walked cell by cell into DOM nodes. Walking rather
// than serializing is deliberate: every character reaches the page as a
// text node, so no sequence of bytes a program prints can become markup.

import { TERMINAL_THEME, ansiColor } from "./terminal-theme.js";
import { Terminal } from "./vendor/xterm.mjs";

/** xterm's colour modes, which it does not export as constants. */
const COLOR_MODE_PALETTE = 0x01000000;
const COLOR_MODE_RGB = 0x02000000;

type Style = {
  color: string | undefined;
  background: string | undefined;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  dim: boolean;
};

export function renderOutput(ansi: string, cols: number): HTMLElement {
  const element = document.createElement("div");
  element.className = "block-output";

  // Terminal.write() always defers its parsing to a macrotask (xterm
  // schedules processing via setTimeout unless the write immediately
  // follows user keyboard input) — there is no public synchronous
  // alternative, and this module touches no private xterm API to fake one.
  // renderOutput() therefore returns its (initially empty) element right
  // away; the caller appends it, and its children arrive a tick later.
  // That is invisible to a user and is a documented part of this
  // function's contract (see the test that pins it).
  //
  // Constructing the terminal is inside this same try: a bad `cols` (NaN,
  // say) or any internal xterm failure must still leave a block with its
  // text on the page, never an uncaught throw out of renderOutput().
  let terminal: Terminal | undefined;
  try {
    const width = Number.isFinite(cols) ? Math.max(cols, 20) : 80;
    terminal = new Terminal({
      cols: width,
      rows: 24,
      scrollback: 100_000,
      allowProposedApi: true,
    });
    terminal.write(ansi, () => {
      try {
        paint(terminal as Terminal, element);
      } catch {
        fallBackToText(ansi, element);
      } finally {
        dispose(terminal as Terminal);
      }
    });
  } catch {
    // A block that cannot be frozen shows its text without styling rather
    // than nothing at all.
    fallBackToText(ansi, element);
    if (terminal !== undefined) dispose(terminal);
  }

  return element;
}

function fallBackToText(ansi: string, element: HTMLElement): void {
  element.replaceChildren();
  const fallback = document.createElement("div");
  fallback.className = "block-line";
  fallback.textContent = ansi.replace(/\[[0-9;]*[A-Za-z]/g, "");
  element.append(fallback);
}

function dispose(terminal: Terminal): void {
  try {
    terminal.dispose();
  } catch {
    // Disposing a terminal that never opened can throw; nothing depends on
    // it having worked.
  }
}

function paint(terminal: Terminal, element: HTMLElement): void {
  element.replaceChildren();
  const buffer = terminal.buffer.active;
  const lastRow = lastWrittenRow(buffer);

  for (let y = 0; y <= lastRow; y += 1) {
    const line = buffer.getLine(y);
    const row = document.createElement("div");
    row.className = "block-line";
    if (line === undefined) {
      element.append(row);
      continue;
    }

    let span: HTMLSpanElement | undefined;
    let previous: string | undefined;
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      if (cell === undefined) continue;
      if (cell.getWidth() === 0) continue; // The tail of a wide character.
      const style = styleOf(cell);
      const key = JSON.stringify(style);
      if (span === undefined || key !== previous) {
        span = document.createElement("span");
        apply(span, style);
        row.append(span);
        previous = key;
      }
      // textContent, always. See the note at the top of this file.
      span.textContent = (span.textContent ?? "") + (cell.getChars() || " ");
    }
    trimTrailingSpaces(row);
    element.append(row);
  }
}

/** Rows past the last one the program wrote are padding, not output. */
function lastWrittenRow(buffer: { length: number; getLine(y: number): { translateToString(t?: boolean): string } | undefined }): number {
  for (let y = buffer.length - 1; y >= 0; y -= 1) {
    if ((buffer.getLine(y)?.translateToString(true) ?? "") !== "") return y;
  }
  return -1;
}

function styleOf(cell: {
  isBold(): number; isItalic(): number; isUnderline(): number; isDim(): number;
  isInverse(): number;
  getFgColorMode(): number; getBgColorMode(): number;
  getFgColor(): number; getBgColor(): number;
}): Style {
  const fg = colorOf(cell.getFgColorMode(), cell.getFgColor());
  const bg = colorOf(cell.getBgColorMode(), cell.getBgColor());
  const inverse = cell.isInverse() !== 0;
  return {
    color: inverse ? (bg ?? TERMINAL_THEME.background) : fg,
    background: inverse ? (fg ?? TERMINAL_THEME.foreground) : bg,
    bold: cell.isBold() !== 0,
    italic: cell.isItalic() !== 0,
    underline: cell.isUnderline() !== 0,
    dim: cell.isDim() !== 0,
  };
}

function colorOf(mode: number, value: number): string | undefined {
  if (mode === COLOR_MODE_RGB) {
    return `#${value.toString(16).padStart(6, "0")}`;
  }
  if (mode === COLOR_MODE_PALETTE) {
    if (value < 16) return ansiColor(value);
    return xterm256(value);
  }
  return undefined; // The default colour: let CSS supply it.
}

/** The standard 6×6×6 cube and greyscale ramp, for indices 16–255. */
function xterm256(index: number): string {
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return rgb(level, level, level);
  }
  const steps = [0, 95, 135, 175, 215, 255];
  const n = index - 16;
  return rgb(steps[Math.floor(n / 36) % 6] ?? 0, steps[Math.floor(n / 6) % 6] ?? 0, steps[n % 6] ?? 0);
}

const rgb = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;

function apply(span: HTMLSpanElement, style: Style): void {
  if (style.color !== undefined) span.style.color = style.color;
  if (style.background !== undefined) span.style.background = style.background;
  if (style.bold) span.style.fontWeight = "bold";
  if (style.italic) span.style.fontStyle = "italic";
  if (style.underline) span.style.textDecoration = "underline";
  if (style.dim) span.style.opacity = "0.7";
}

/** A terminal line is padded to its width; the padding is not output. */
function trimTrailingSpaces(row: HTMLElement): void {
  const last = row.lastElementChild;
  if (last === null) return;
  last.textContent = (last.textContent ?? "").replace(/\s+$/, "");
  if (last.textContent === "" && row.childElementCount > 1) last.remove();
}
