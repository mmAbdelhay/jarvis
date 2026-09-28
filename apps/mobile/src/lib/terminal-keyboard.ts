// Wide layout (2026-09-28 spec §3, Review Focus 4): a hardware keyboard
// typing into the inline terminal. The terminal page never produces pty
// bytes (it is display-only), so the keys are read by the app itself, from
// a focus target beside the page, and turned into input here. Pure so the
// routing rules are unit tested.
//
// Every key that reaches the terminal stops there: nothing typed into it
// propagates to the shell. Cmd combos (and Ctrl+Shift ones) keep the
// browser's own meaning, such as copy, paste, reload or closing the tab.
// They are neither sent to the pty nor claimed.

import { ctrlByte, type KeyName } from "./terminal-keys";

export type HardwareKey = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
};

/** What a key sends: a key-bar key (mode-aware bytes, see keyBytes) or
 *  literal text. */
export type TerminalKeyInput = { kind: "key"; key: KeyName } | { kind: "text"; text: string };

export type KeyRoute = {
  input: TerminalKeyInput | undefined;
  /** Claim the key from the browser: true exactly when it is sent. */
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

function inputFor(event: HardwareKey): TerminalKeyInput | undefined {
  if (event.isComposing === true) return undefined;
  // Cmd is the browser's and the OS's; Ctrl+Shift is the Linux terminal
  // convention for copy/paste.
  if (event.metaKey) return undefined;
  if (event.ctrlKey && event.shiftKey) return undefined;
  if (event.ctrlKey) {
    if (event.altKey || event.key.length !== 1) return undefined;
    const byte = ctrlByte(event.key);
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
  return { kind: "text", text: event.altKey ? `\x1b${event.key}` : event.key };
}

export function routeTerminalKey(event: HardwareKey): KeyRoute {
  const input = inputFor(event);
  return { input, preventDefault: input !== undefined, stopPropagation: true };
}

/** A paste into the terminal, as xterm sends one: line breaks become CR.
 *  Nothing for an empty clipboard. */
export function pasteInput(text: string): TerminalKeyInput | undefined {
  if (text === "") return undefined;
  return { kind: "text", text: text.replace(/\r?\n/g, "\r") };
}
