// Task 5: mode-aware key bytes for the terminal key bar, and the Ctrl
// latch's one-character mapping to a control byte. Byte tables come from
// the brief (ruling 4) — the same bytes xterm 6 sends for the same keys,
// so a key tap is indistinguishable on the wire from typing it at a real
// terminal. See
// the mobile milestone 7, task 5 plan (docs/superpowers/plans).

/** The key bar's two latches: armed by a tap, applied to the next input. */
export type Latch = "ctrl" | "alt";

export type KeyName =
  | "esc"
  | "tab"
  | "shiftTab"
  | "ctrlC"
  | "ctrlR"
  | "left"
  | "up"
  | "down"
  | "right"
  | "backspace"
  | "enter";

// Display order per the brief: esc, tab, shiftTab, ctrl, alt, ctrlC, left,
// up, down, right, backspace, enter.
export const KEY_BAR: readonly (KeyName | Latch)[] = [
  "esc",
  "tab",
  "shiftTab",
  "ctrl",
  "alt",
  "ctrlC",
  "left",
  "up",
  "down",
  "right",
  "backspace",
  "enter",
];

/** Keys that type a character rather than send a control sequence. */
export type TextKey = "pipe" | "tilde";

/** Anything a key bar can show. */
export type BarKey = KeyName | Latch | TextKey;

export const TEXT_KEY_VALUE: Readonly<Record<TextKey, string>> = { pipe: "|", tilde: "~" };

export function isTextKey(key: BarKey): key is TextKey {
  return key === "pipe" || key === "tilde";
}

/** The Session screen's own bar: the mockup's five keys. */
export const SESSION_KEYS: readonly BarKey[] = ["esc", "tab", "up", "down", "ctrlC"];

/** What the session bar's "more keys" row adds, so no key is lost. */
export const MORE_KEYS: readonly BarKey[] = [
  "shiftTab",
  "ctrl",
  "alt",
  "ctrlR",
  "left",
  "right",
  "backspace",
  "enter",
  "pipe",
  "tilde",
];

/** The terminal pane's bar (the full set, until the pane is redrawn). */
export const TERMINAL_KEYS: readonly (KeyName | Latch)[] = KEY_BAR;

export type TerminalModes = { applicationCursor: boolean };

const CURSOR_KEY_LETTER: Record<"up" | "down" | "right" | "left", string> = {
  up: "A",
  down: "B",
  right: "C",
  left: "D",
};

export function keyBytes(key: KeyName, modes: TerminalModes): string {
  switch (key) {
    case "esc":
      return "\x1b";
    case "tab":
      return "\t";
    case "shiftTab":
      return "\x1b[Z";
    case "ctrlC":
      return "\x03";
    case "ctrlR":
      return "\x12";
    case "backspace":
      return "\x7f";
    case "enter":
      return "\r";
    case "up":
    case "down":
    case "right":
    case "left": {
      const letter = CURSOR_KEY_LETTER[key];
      return modes.applicationCursor ? `\x1bO${letter}` : `\x1b[${letter}`;
    }
  }
}

/**
 * The bytes for Alt+<key>, as xterm sends them with Alt as Meta: an arrow
 * carries the modifier parameter (`ESC [ 1 ; 3 D`, whatever the cursor
 * mode), every other key is its usual bytes behind an ESC — so Alt+⌫
 * deletes a word and Alt+← moves back one in a shell.
 */
export function altKeyBytes(key: KeyName, modes: TerminalModes): string {
  switch (key) {
    case "up":
    case "down":
    case "right":
    case "left":
      return `\x1b[1;3${CURSOR_KEY_LETTER[key]}`;
    default:
      return `\x1b${keyBytes(key, modes)}`;
  }
}

// M3: a `Map`, not a plain object indexed by user text — defence in depth
// against prototype-key lookups (moot today, since the length-1 guard
// below means no `Object.prototype` key, none of which is one character
// long, could ever be reached, but a `Map` makes that structurally true
// rather than incidentally true).
const CTRL_PUNCTUATION = new Map<string, string>([
  ["@", "\x00"],
  [" ", "\x00"],
  ["[", "\x1b"],
  ["\\", "\x1c"],
  ["]", "\x1d"],
  ["^", "\x1e"],
  ["_", "\x1f"],
  ["?", "\x7f"],
]);

/**
 * Maps a single character to the control byte a terminal would send for
 * Ctrl+<character>. `undefined` for anything not exactly one UTF-16 unit,
 * or not in the a-z/A-Z/punctuation table.
 */
export function ctrlByte(character: string): string | undefined {
  if (character.length !== 1) return undefined;
  const code = character.charCodeAt(0);
  if (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x41 && code <= 0x5a) // A-Z
  ) {
    return String.fromCharCode(code & 0x1f);
  }
  return CTRL_PUNCTUATION.get(character);
}

// Bug 9: SGR (1006) mouse-wheel button codes — 64 for wheel-up, 65 for
// wheel-down, the same encoding xterm.js's own mouse handling sends for a
// real wheel event. Column/row are fixed at the top-left cell: the touch
// page (terminal-page.ts) tracks only a scroll direction, never a cell
// position, so a wheel event's exact coordinates are not meaningful here —
// what a mouse-tracking program reads off this is the direction, same as
// every other terminal's "scroll" mouse wheel report.
const SGR_WHEEL_BUTTON: Record<"up" | "down", number> = { up: 64, down: 65 };

/** The exact bytes a real terminal sends for a mouse wheel scroll, SGR
 *  (`\x1b[<...M`) encoded — `\x1b[<64;1;1M` for up, `\x1b[<65;1;1M` for
 *  down. */
export function sgrWheelSequence(direction: "up" | "down"): string {
  return `\x1b[<${SGR_WHEEL_BUTTON[direction]};1;1M`;
}
