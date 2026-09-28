import { describe, expect, it } from "vitest";
import {
  composedInput,
  pasteInput,
  routeTerminalKey,
  strayInput,
  type HardwareKey,
} from "./terminal-keyboard";

function key(k: string, mods: Partial<Omit<HardwareKey, "key">> = {}): HardwareKey {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

describe("routeTerminalKey: typing", () => {
  it("sends printable characters verbatim", () => {
    expect(routeTerminalKey(key("a")).input).toEqual({ kind: "text", text: "a" });
    expect(routeTerminalKey(key("A", { shiftKey: true })).input).toEqual({
      kind: "text",
      text: "A",
    });
    expect(routeTerminalKey(key("é")).input).toEqual({ kind: "text", text: "é" });
    expect(routeTerminalKey(key("😀")).input).toEqual({ kind: "text", text: "😀" });
  });

  it("maps the key-bar keys to their mode-aware key names", () => {
    expect(routeTerminalKey(key("Enter")).input).toEqual({ kind: "key", key: "enter" });
    expect(routeTerminalKey(key("Backspace")).input).toEqual({ kind: "key", key: "backspace" });
    expect(routeTerminalKey(key("Escape")).input).toEqual({ kind: "key", key: "esc" });
    expect(routeTerminalKey(key("Tab")).input).toEqual({ kind: "key", key: "tab" });
    expect(routeTerminalKey(key("Tab", { shiftKey: true })).input).toEqual({
      kind: "key",
      key: "shiftTab",
    });
    expect(routeTerminalKey(key("ArrowUp")).input).toEqual({ kind: "key", key: "up" });
    expect(routeTerminalKey(key("ArrowLeft")).input).toEqual({ kind: "key", key: "left" });
  });

  it("sends xterm's bytes for the editing keys", () => {
    expect(routeTerminalKey(key("Delete")).input).toEqual({ kind: "text", text: "\x1b[3~" });
    expect(routeTerminalKey(key("Home")).input).toEqual({ kind: "text", text: "\x1b[H" });
    expect(routeTerminalKey(key("End")).input).toEqual({ kind: "text", text: "\x1b[F" });
    expect(routeTerminalKey(key("PageUp")).input).toEqual({ kind: "text", text: "\x1b[5~" });
    expect(routeTerminalKey(key("PageDown")).input).toEqual({ kind: "text", text: "\x1b[6~" });
  });

  it("turns Ctrl+letter into its control byte and Alt+key into an ESC prefix", () => {
    expect(routeTerminalKey(key("c", { ctrlKey: true })).input).toEqual({
      kind: "text",
      text: "\x03",
    });
    expect(routeTerminalKey(key("[", { ctrlKey: true })).input).toEqual({
      kind: "text",
      text: "\x1b",
    });
    expect(routeTerminalKey(key("b", { altKey: true })).input).toEqual({
      kind: "text",
      text: "\x1bb",
    });
  });

  it("claims the keys it sends, so the browser does not act on them too", () => {
    expect(routeTerminalKey(key("a")).preventDefault).toBe(true);
    expect(routeTerminalKey(key("Tab")).preventDefault).toBe(true);
    expect(routeTerminalKey(key("c", { ctrlKey: true })).preventDefault).toBe(true);
  });

  it("ignores lone modifiers, function keys and IME composition", () => {
    for (const k of ["Shift", "Control", "Alt", "Meta", "F5", "CapsLock"]) {
      const route = routeTerminalKey(key(k));
      expect(route.input).toBeUndefined();
      expect(route.preventDefault).toBe(false);
    }
    expect(routeTerminalKey({ ...key("a"), isComposing: true }).input).toBeUndefined();
  });
});

// Review Focus 4: a Cmd/Ctrl shortcut typed while the terminal has focus
// never reaches shell navigation. Every key from the terminal stops
// propagating; Cmd combos and Ctrl+Shift combos are left to the browser
// (copy, paste, reload, close tab) rather than sent or swallowed.
describe("routeTerminalKey: shortcuts that originate in the terminal", () => {
  const shortcuts: HardwareKey[] = [
    key("1", { metaKey: true }),
    key("[", { metaKey: true }),
    key("ArrowLeft", { metaKey: true }),
    key("k", { metaKey: true }),
    key("Tab", { ctrlKey: true }),
    key("c", { ctrlKey: true, shiftKey: true }),
    key("v", { metaKey: true }),
  ];

  it("never propagate to the shell", () => {
    for (const event of [...shortcuts, key("a"), key("F5"), key("c", { ctrlKey: true })]) {
      expect(routeTerminalKey(event).stopPropagation).toBe(true);
    }
  });

  it("are not sent to the pty and keep the browser's own meaning", () => {
    for (const event of shortcuts) {
      const route = routeTerminalKey(event);
      expect(route.input).toBeUndefined();
      expect(route.preventDefault).toBe(false);
    }
  });
});

describe("pasteInput", () => {
  it("sends the clipboard with line breaks as CR, and nothing when empty", () => {
    expect(pasteInput("ls\r\npwd\n")).toEqual({ kind: "text", text: "ls\rpwd\r" });
    expect(pasteInput("")).toBeUndefined();
  });
});

describe("routeTerminalKey: copy and paste chords (fix round 1)", () => {
  const selected = { hasSelection: true };
  const none = { hasSelection: false };

  it("a copy chord with a selection copies it and never reaches the pty", () => {
    for (const event of [
      key("c", { metaKey: true }),
      key("C", { ctrlKey: true, shiftKey: true }),
      key("c", { ctrlKey: true }),
      key("ؤ", { ctrlKey: true, code: "KeyC" }),
    ]) {
      const route = routeTerminalKey(event, selected);
      expect(route).toEqual({
        input: undefined,
        copy: true,
        preventDefault: true,
        stopPropagation: true,
      });
    }
  });

  it("with no selection, Ctrl+C is still ^C and Cmd+C stays the browser's", () => {
    expect(routeTerminalKey(key("c", { ctrlKey: true }), none)).toMatchObject({
      input: { kind: "text", text: "\x03" },
      copy: false,
    });
    expect(routeTerminalKey(key("c", { metaKey: true }), none)).toMatchObject({
      input: undefined,
      copy: false,
      preventDefault: false,
    });
  });

  it("leaves paste chords to the browser, so its paste event sends the clipboard", () => {
    for (const event of [
      key("v", { metaKey: true }),
      key("v", { ctrlKey: true }),
      key("V", { ctrlKey: true, shiftKey: true }),
      key("ر", { ctrlKey: true, code: "KeyV" }),
    ]) {
      const route = routeTerminalKey(event, selected);
      expect(route.input).toBeUndefined();
      expect(route.copy).toBe(false);
      expect(route.preventDefault).toBe(false);
      expect(route.stopPropagation).toBe(true);
    }
  });
});

describe("routeTerminalKey: chords under a non-Latin layout (fix round 1)", () => {
  it("computes the control byte from the physical key", () => {
    expect(routeTerminalKey(key("ؤ", { ctrlKey: true, code: "KeyC" })).input).toEqual({
      kind: "text",
      text: "\x03",
    });
    expect(routeTerminalKey(key("ي", { ctrlKey: true, code: "KeyD" })).input).toEqual({
      kind: "text",
      text: "\x04",
    });
    expect(routeTerminalKey(key("ج", { ctrlKey: true, code: "BracketLeft" })).input).toEqual({
      kind: "text",
      text: "\x1b",
    });
  });

  it("sends ESC plus the Latin key for Alt chords", () => {
    expect(routeTerminalKey(key("لا", { altKey: true, code: "KeyB" })).input).toBeUndefined();
    expect(routeTerminalKey(key("ذ", { altKey: true, code: "Backquote" })).input).toEqual({
      kind: "text",
      text: "\x1bذ",
    });
    expect(routeTerminalKey(key("ف", { altKey: true, code: "KeyT" })).input).toEqual({
      kind: "text",
      text: "\x1bt",
    });
  });

  it("types the layout's own character without a modifier", () => {
    expect(routeTerminalKey(key("ؤ", { code: "KeyC" })).input).toEqual({ kind: "text", text: "ؤ" });
  });
});

describe("composition (fix round 1)", () => {
  it("Chrome's order: a composing input, then compositionend, sends once", () => {
    const target = { value: "é" };
    expect(strayInput(target, true)).toBeUndefined();
    expect(composedInput(target, "é")).toEqual({ kind: "text", text: "é" });
    expect(target.value).toBe("");
  });

  it("Safari's order: compositionend, then a plain input, sends once", () => {
    const target = { value: "日本" };
    expect(composedInput(target, "日本")).toEqual({ kind: "text", text: "日本" });
    expect(strayInput(target, false)).toBeUndefined();
  });

  it("falls back to the element's value when the event carries no data", () => {
    const target = { value: "ü" };
    expect(composedInput(target, "")).toEqual({ kind: "text", text: "ü" });
    expect(composedInput(target, null)).toBeUndefined();
  });

  it("sends stray text outside a composition and clears it", () => {
    const target = { value: "x" };
    expect(strayInput(target, false)).toEqual({ kind: "text", text: "x" });
    expect(target.value).toBe("");
  });
});
