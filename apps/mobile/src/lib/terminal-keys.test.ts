// Task 5: mode-aware key bytes for the terminal key bar and the Ctrl
// latch's character mapping. See
// the mobile milestone 7, task 5 plan (docs/superpowers/plans).

import { describe, expect, it } from "vitest";
import type { KeyName, TerminalModes } from "./terminal-keys";
import {
  altKeyBytes,
  ctrlByte,
  KEY_BAR,
  keyBytes,
  MORE_KEYS,
  SESSION_KEYS,
  sgrWheelSequence,
  NAV_KEYS,
  TERMINAL_KEYS,
  terminalFooterKeys,
  TEXT_KEY_VALUE,
  isTextKey,
} from "./terminal-keys";

const NORMAL: TerminalModes = { applicationCursor: false };
const APP_CURSOR: TerminalModes = { applicationCursor: true };

describe("keyBytes", () => {
  // Each byte string here is what xterm.js's `evaluateKeyboardEvent`
  // (upstream: src/common/input/Keyboard.ts, vendored minified at
  // packages/desktop/renderer/vendor/xterm.mjs) returns for the same key
  // in DECCKM-reset/-set mode; each `it` below cites the specific case.
  it("esc -> ESC (xterm Keyboard: case 27 'Escape' -> key = C0.ESC = \\x1b)", () => {
    expect(keyBytes("esc", NORMAL)).toBe("\x1b");
    expect(keyBytes("esc", APP_CURSOR)).toBe("\x1b");
  });

  it("tab -> TAB (xterm Keyboard: case 9 'Tab', no modifiers -> key = \"\\t\")", () => {
    expect(keyBytes("tab", NORMAL)).toBe("\t");
    expect(keyBytes("tab", APP_CURSOR)).toBe("\t");
  });

  it("shiftTab -> ESC [ Z (xterm Keyboard: case 9 'Tab' with shiftKey -> key = C0.ESC + '[Z')", () => {
    expect(keyBytes("shiftTab", NORMAL)).toBe("\x1b[Z");
    expect(keyBytes("shiftTab", APP_CURSOR)).toBe("\x1b[Z");
  });

  it("ctrlC -> ETX (xterm Keyboard: case 67 'KeyC' with ctrlKey -> key = String.fromCharCode(3))", () => {
    expect(keyBytes("ctrlC", NORMAL)).toBe("\x03");
    expect(keyBytes("ctrlC", APP_CURSOR)).toBe("\x03");
  });

  it("backspace -> DEL (xterm Keyboard: case 8 'Backspace', no modifiers -> key = C0.DEL = \\x7f)", () => {
    expect(keyBytes("backspace", NORMAL)).toBe("\x7f");
    expect(keyBytes("backspace", APP_CURSOR)).toBe("\x7f");
  });

  it("enter -> CR (xterm Keyboard: case 13 'Enter'/'NumpadEnter' -> key = C0.CR = \\r)", () => {
    expect(keyBytes("enter", NORMAL)).toBe("\r");
    expect(keyBytes("enter", APP_CURSOR)).toBe("\r");
  });

  it("arrows send CSI in normal mode, SS3 in application-cursor mode (xterm Keyboard: cases 37-40 'Arrow*' -> key = C0.ESC + (applicationCursorMode ? 'O' : '[') + letter)", () => {
    expect(keyBytes("up", NORMAL)).toBe("\x1b[A");
    expect(keyBytes("down", NORMAL)).toBe("\x1b[B");
    expect(keyBytes("right", NORMAL)).toBe("\x1b[C");
    expect(keyBytes("left", NORMAL)).toBe("\x1b[D");

    // [bite-proof: ignore modes; up in application-cursor mode must differ
    // from up in normal mode, or this row fails]
    expect(keyBytes("up", APP_CURSOR)).toBe("\x1bOA");
    expect(keyBytes("down", APP_CURSOR)).toBe("\x1bOB");
    expect(keyBytes("right", APP_CURSOR)).toBe("\x1bOC");
    expect(keyBytes("left", APP_CURSOR)).toBe("\x1bOD");
  });
});

describe("KEY_BAR", () => {
  it("contains every KeyName exactly once, plus the two latches, in the specified display order", () => {
    const expected: (KeyName | "ctrl" | "alt")[] = [
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
    expect(KEY_BAR).toEqual(expected);
    expect(new Set(KEY_BAR).size).toBe(KEY_BAR.length);
  });
});

describe("ctrlByte", () => {
  it("maps letters case-insensitively to their control byte", () => {
    expect(ctrlByte("c")).toBe("\x03");
    expect(ctrlByte("C")).toBe("\x03");
    expect(ctrlByte("d")).toBe("\x04");
  });

  it("maps the punctuation set", () => {
    expect(ctrlByte("@")).toBe("\x00");
    expect(ctrlByte(" ")).toBe("\x00");
    expect(ctrlByte("[")).toBe("\x1b");
    expect(ctrlByte("\\")).toBe("\x1c");
    expect(ctrlByte("]")).toBe("\x1d");
    expect(ctrlByte("^")).toBe("\x1e");
    expect(ctrlByte("_")).toBe("\x1f");
    expect(ctrlByte("?")).toBe("\x7f");
  });

  it("returns undefined for anything not exactly one UTF-16 unit mappable by the table", () => {
    expect(ctrlByte("ab")).toBeUndefined();
    expect(ctrlByte("")).toBeUndefined();
    expect(ctrlByte("1")).toBeUndefined();
    expect(ctrlByte("é")).toBeUndefined();
  });
});

// Bug 9: a touch-drag scroll gesture, in the alternate screen buffer while
// a program has mouse tracking on, is sent as an SGR mouse-wheel escape —
// button code 64 (up) / 65 (down), terminated "M" for a press.
describe("sgrWheelSequence", () => {
  it("encodes wheel-up as button 64", () => {
    expect(sgrWheelSequence("up")).toBe("\x1b[<64;1;1M");
  });

  it("encodes wheel-down as button 65", () => {
    expect(sgrWheelSequence("down")).toBe("\x1b[<65;1;1M");
  });
});

describe("altKeyBytes", () => {
  it("puts the Alt modifier on arrows whatever the cursor mode", () => {
    expect(altKeyBytes("left", { applicationCursor: false })).toBe("\x1b[1;3D");
    expect(altKeyBytes("up", { applicationCursor: true })).toBe("\x1b[1;3A");
  });

  it("puts ESC before every other key's bytes", () => {
    expect(altKeyBytes("backspace", { applicationCursor: false })).toBe("\x1b\x7f");
    expect(altKeyBytes("enter", { applicationCursor: false })).toBe("\x1b\r");
  });
});

describe("ctrlR", () => {
  it("is DC2, and Alt+ctrlR follows the Alt rule (ESC first)", () => {
    expect(keyBytes("ctrlR", NORMAL)).toBe("\x12");
    expect(altKeyBytes("ctrlR", NORMAL)).toBe("\x1b\x12");
  });
});

describe("key sets", () => {
  const valid = new Set<string>([...KEY_BAR, "ctrlR", ...Object.keys(TEXT_KEY_VALUE)]);

  it.each([
    ["SESSION_KEYS", SESSION_KEYS],
    ["MORE_KEYS", MORE_KEYS],
    ["TERMINAL_KEYS", TERMINAL_KEYS],
    ["NAV_KEYS", NAV_KEYS],
  ])("%s holds only known keys, each once", (_name, keys) => {
    for (const key of keys) expect(valid.has(key)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the session bar and its more row together lose no former key-bar key", () => {
    const shown = new Set<string>([...SESSION_KEYS, ...MORE_KEYS]);
    for (const key of KEY_BAR) expect(shown.has(key)).toBe(true);
    expect(SESSION_KEYS.filter((key) => MORE_KEYS.includes(key))).toEqual([]);
  });

  it("switches the terminal footer's key set on navigation mode", () => {
    expect(terminalFooterKeys(false)).toBe(TERMINAL_KEYS);
    expect(terminalFooterKeys(true)).toBe(NAV_KEYS);
    expect(TERMINAL_KEYS).toEqual(["esc", "tab", "up", "down", "ctrlC", "ctrlR"]);
    expect(NAV_KEYS).toContain("ctrl");
    expect(NAV_KEYS).toContain("alt");
  });

  it("sends | and ~ as text, not as control keys", () => {
    expect(TEXT_KEY_VALUE).toEqual({ pipe: "|", tilde: "~" });
    expect(isTextKey("pipe")).toBe(true);
    expect(isTextKey("esc")).toBe(false);
  });
});
