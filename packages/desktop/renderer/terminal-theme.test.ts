import { describe, expect, it } from "vitest";
import { TERMINAL_THEME, ansiColor } from "./terminal-theme.js";

describe("the terminal theme", () => {
  it("maps the sixteen ANSI slots onto the theme's own colours", () => {
    expect(ansiColor(0)).toBe(TERMINAL_THEME.black);
    expect(ansiColor(1)).toBe(TERMINAL_THEME.red);
    expect(ansiColor(7)).toBe(TERMINAL_THEME.white);
    expect(ansiColor(8)).toBe(TERMINAL_THEME.brightBlack);
    expect(ansiColor(15)).toBe(TERMINAL_THEME.brightWhite);
  });

  it("falls back to the foreground for an index outside the sixteen", () => {
    expect(ansiColor(256)).toBe(TERMINAL_THEME.foreground);
    expect(ansiColor(-1)).toBe(TERMINAL_THEME.foreground);
  });
});
