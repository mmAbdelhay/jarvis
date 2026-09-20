// Task 5: mode-aware key bytes for the terminal key bar and the Ctrl
// latch's character mapping. See
// the mobile milestone 7, task 5 plan (docs/superpowers/plans).

import { describe, expect, it } from "vitest";
import type { KeyName, TerminalModes } from "./terminal-keys";
import { ctrlByte, KEY_BAR, keyBytes } from "./terminal-keys";

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
  it("contains every KeyName exactly once, plus 'ctrl', in the specified display order", () => {
    const expected: (KeyName | "ctrl")[] = [
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
