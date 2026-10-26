// The terminal's font size, as every terminal surface draws it.
//
// One value for the live xterm and for the frozen blocks beside it. A block
// is painted as DOM and styled by styles.css, so if the two sizes disagree a
// command's output changes size the moment it finishes — the same reason
// terminal-theme.ts keeps one palette. xterm takes the number through its
// options (each pane subscribes below); the stylesheet reads it as
// `--terminal-font-size`, set on the root element.
//
// Two layers. The base is `terminal.fontSize` from jarvis.yaml: set when the
// settings payload arrives, and again whenever Settings saves a new one. The
// zoom keys move a session offset on top of it that is never written back —
// a size wanted for one screen share is not a preference.

import { TERMINAL_FONT, TERMINAL_FONT_SIZE_MAX, TERMINAL_FONT_SIZE_MIN } from "./terminal-theme.js";

type Listener = (size: number) => void;

let base = TERMINAL_FONT.fontSize;
let zoom = 0;
const listeners = new Set<Listener>();

function clamp(size: number): number {
  return Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, size));
}

/** The size every terminal should be drawing right now, in pixels. */
export function terminalFontSize(): number {
  return clamp(base + zoom);
}

function publish(): void {
  const size = terminalFontSize();
  try {
    document.documentElement.style.setProperty("--terminal-font-size", `${size}px`);
  } catch {
    // No document (a test without jsdom). xterm still hears about it below.
  }
  for (const listener of listeners) {
    try {
      listener(size);
    } catch {
      // One pane failing to resize must not stop the rest.
    }
  }
}

/**
 * The saved size from jarvis.yaml. Anything that is not a number in range
 * is ignored: it arrives over IPC, so it is not the type checker's to
 * promise, and a renderer talking to an older main gets no field at all.
 *
 * A new base clears the zoom — the user has just said what size they want.
 * The same base again changes nothing, which is what lets both terminal
 * modules hand over the payload they each read without resetting a zoom.
 */
export function setTerminalFontBase(size: unknown): void {
  if (typeof size !== "number" || !Number.isFinite(size)) return;
  if (size < TERMINAL_FONT_SIZE_MIN || size > TERMINAL_FONT_SIZE_MAX) return;
  if (size === base) return;
  base = size;
  zoom = 0;
  publish();
}

/** One pixel bigger (1) or smaller (-1), stopping at the range's ends. */
export function zoomTerminalFont(step: 1 | -1): void {
  const current = terminalFontSize();
  const next = clamp(current + step);
  if (next === current) return;
  zoom = next - base;
  publish();
}

/** Back to the saved size. */
export function resetTerminalFontZoom(): void {
  if (zoom === 0) return;
  zoom = 0;
  publish();
}

/** Called with the new size on every change. Returns the unsubscribe, which
 *  a pane must call when it is disposed or the set keeps it alive. */
export function onTerminalFontSize(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
