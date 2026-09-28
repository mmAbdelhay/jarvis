import { describe, expect, it } from "vitest";
import { pasteInput, routeTerminalKey, type HardwareKey } from "./terminal-keyboard";

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
