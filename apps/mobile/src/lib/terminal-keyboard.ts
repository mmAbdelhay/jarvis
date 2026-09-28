// Wide layout (2026-09-28 spec §3, Review Focus 4): a hardware keyboard
// typing into the inline terminal. The terminal page never produces pty
// bytes (it is display-only), so the keys are read by the app itself, from
// a focus target beside the page, and turned into input here. Pure so the
// routing rules are unit tested.
//
// Every key that reaches the terminal stops there: nothing typed into it
// propagates to the shell. Cmd combos (and Ctrl+Shift ones) keep the
// browser's own meaning, such as reload or closing the tab. They are
// neither sent to the pty nor claimed. Two chords are the terminal's own:
// - copy (Cmd+C, Ctrl+Shift+C, or Ctrl+C while text is selected) copies
//   the terminal's selection, and is never sent;
// - paste (Cmd+V, Ctrl+V, Ctrl+Shift+V) is left to the browser, whose
//   paste event then sends the clipboard (pasteInput).

import { ctrlByte, type KeyName } from "./terminal-keys";

export type HardwareKey = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  /** The physical key (`KeyC`), the same under any keyboard layout. */
  code?: string;
};

/** What a key sends: a key-bar key (mode-aware bytes, see keyBytes) or
 *  literal text. */
export type TerminalKeyInput = { kind: "key"; key: KeyName } | { kind: "text"; text: string };

export type KeyRoute = {
  input: TerminalKeyInput | undefined;
  /** Copy the terminal's selection to the clipboard. */
  copy: boolean;
  /** Claim the key from the browser: true exactly when it is sent or it
   *  copies. */
  preventDefault: boolean;
  /** Always true: a key typed into the terminal never reaches the shell. */
  stopPropagation: true;
};

const NAMED_KEYS: ReadonlyMap<string, KeyName> = new Map([
  ["Enter", "enter"],
  ["Backspace", "backspace"],
  ["Escape", "esc"],
  ["Tab", "tab"],
  ["ArrowUp", "up"],
  ["ArrowDown", "down"],
  ["ArrowLeft", "left"],
  ["ArrowRight", "right"],
]);

// The bytes xterm sends for these (normal cursor mode).
const EDITING_KEYS: ReadonlyMap<string, string> = new Map([
  ["Delete", "\x1b[3~"],
  ["Home", "\x1b[H"],
  ["End", "\x1b[F"],
  ["PageUp", "\x1b[5~"],
  ["PageDown", "\x1b[6~"],
  ["Insert", "\x1b[2~"],
]);

/** One character as the user sees it (a surrogate pair counts as one). */
function isPrintable(key: string): boolean {
  return [...key].length === 1;
}

// The Latin character on a physical key, for chords typed under another
// layout (Arabic Ctrl+C gives key "ؤ" but code "KeyC").
const CODE_CHARACTERS: ReadonlyMap<string, string> = new Map([
  ["BracketLeft", "["],
  ["BracketRight", "]"],
  ["Backslash", "\\"],
  ["Space", " "],
  ["Slash", "/"],
  ["Period", "."],
  ["Comma", ","],
  ["Minus", "-"],
]);

function latinFor(code: string | undefined): string | undefined {
  if (code === undefined) return undefined;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter !== null) return letter[1]?.toLowerCase();
  return CODE_CHARACTERS.get(code);
}

function isAscii(key: string): boolean {
  return key.length === 1 && key.charCodeAt(0) < 0x80;
}

/** The chord's letter: the key under a Latin layout, else the physical
 *  key's Latin letter. */
function chordLetter(event: HardwareKey): string | undefined {
  if (isAscii(event.key)) return event.key.toLowerCase();
  return latinFor(event.code);
}

function isCopyChord(event: HardwareKey, hasSelection: boolean): boolean {
  if (event.altKey || chordLetter(event) !== "c") return false;
  if (event.metaKey) return !event.ctrlKey;
  if (event.ctrlKey && event.shiftKey) return true;
  return event.ctrlKey && hasSelection;
}

function isPasteChord(event: HardwareKey): boolean {
  if (event.altKey || chordLetter(event) !== "v") return false;
  return event.metaKey !== event.ctrlKey;
}

function inputFor(event: HardwareKey): TerminalKeyInput | undefined {
  if (event.isComposing === true) return undefined;
  // Cmd is the browser's and the OS's; Ctrl+Shift is the Linux terminal
  // convention for copy/paste.
  if (event.metaKey) return undefined;
  if (event.ctrlKey && event.shiftKey) return undefined;
  if (event.ctrlKey) {
    if (event.altKey || event.key.length !== 1) return undefined;
    const direct = ctrlByte(event.key);
    const latin = latinFor(event.code);
    const byte = direct ?? (latin === undefined ? undefined : ctrlByte(latin));
    return byte === undefined ? undefined : { kind: "text", text: byte };
  }
  const named = NAMED_KEYS.get(event.key);
  if (named !== undefined) {
    if (event.altKey) return undefined;
    if (named === "tab" && event.shiftKey) return { kind: "key", key: "shiftTab" };
    return { kind: "key", key: named };
  }
  const editing = EDITING_KEYS.get(event.key);
  if (editing !== undefined) return event.altKey ? undefined : { kind: "text", text: editing };
  if (!isPrintable(event.key)) return undefined;
  if (!event.altKey) return { kind: "text", text: event.key };
  // Alt as Meta: ESC plus the key, the Latin one under another layout.
  const meta = isAscii(event.key) ? event.key : (latinFor(event.code) ?? event.key);
  return { kind: "text", text: `\x1b${meta}` };
}

/** `hasSelection`: the terminal has selected text (the page's last
 *  `selection` message was non-empty). */
export function routeTerminalKey(
  event: HardwareKey,
  context: { hasSelection: boolean } = { hasSelection: false },
): KeyRoute {
  if (event.isComposing !== true && isCopyChord(event, context.hasSelection)) {
    // Copy with nothing selected: Cmd/Ctrl+Shift keep the browser's own
    // meaning; plain Ctrl+C falls through to ^C below.
    if (context.hasSelection) {
      return { input: undefined, copy: true, preventDefault: true, stopPropagation: true };
    }
    return { input: undefined, copy: false, preventDefault: false, stopPropagation: true };
  }
  if (isPasteChord(event)) {
    return { input: undefined, copy: false, preventDefault: false, stopPropagation: true };
  }
  const input = inputFor(event);
  return { input, copy: false, preventDefault: input !== undefined, stopPropagation: true };
}

/** A paste into the terminal, as xterm sends one: line breaks become CR.
 *  Nothing for an empty clipboard. */
export function pasteInput(text: string): TerminalKeyInput | undefined {
  if (text === "") return undefined;
  return { kind: "text", text: text.replace(/\r?\n/g, "\r") };
}

/** The capture element's text value, as far as these helpers need it. */
export type CaptureTarget = { value: string };

/** An IME or dead-key composition was committed: its text, sent once. The
 *  element is cleared, so an `input` event that follows (Safari's order)
 *  finds nothing left to send. */
export function composedInput(
  target: CaptureTarget,
  data: string | null | undefined,
): TerminalKeyInput | undefined {
  const text = data !== undefined && data !== null && data !== "" ? data : target.value;
  target.value = "";
  return text === "" ? undefined : { kind: "text", text };
}

/** Text that reached the element outside a composition (keydown claims
 *  every key it sends, so this is only what it left alone). Mid-
 *  composition input is left for composedInput (Chrome's order). */
export function strayInput(
  target: CaptureTarget,
  isComposing: boolean,
): TerminalKeyInput | undefined {
  if (isComposing || target.value === "") return undefined;
  const text = target.value;
  target.value = "";
  return { kind: "text", text };
}
