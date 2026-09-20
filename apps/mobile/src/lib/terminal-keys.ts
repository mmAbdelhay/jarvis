// Task 5: mode-aware key bytes for the terminal key bar, and the Ctrl
// latch's one-character mapping to a control byte. Byte tables come from
// the brief (ruling 4) — the same bytes xterm 6 sends for the same keys,
// so a key tap is indistinguishable on the wire from typing it at a real
// terminal. See
// the mobile milestone 7, task 5 plan (docs/superpowers/plans).

export type KeyName =
  | "esc"
  | "tab"
  | "shiftTab"
  | "ctrlC"
  | "left"
  | "up"
  | "down"
  | "right"
  | "backspace"
  | "enter";

// Display order per the brief: esc, tab, shiftTab, ctrl, ctrlC, left, up,
// down, right, backspace, enter.
export const KEY_BAR: readonly (KeyName | "ctrl")[] = [
  "esc",
  "tab",
  "shiftTab",
  "ctrl",
  "ctrlC",
  "left",
  "up",
  "down",
  "right",
  "backspace",
  "enter",
];

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
