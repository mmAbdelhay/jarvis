import { describe, expect, it } from "vitest";
import { readClaudeScreen } from "./claude-screen.js";

const IDLE = "────────────\n❯\n────────────";
const MENU = [
  "Do you want to proceed?",
  "❯ 1. Yes",
  "  2. Yes, and don't ask again",
  "  3. No",
  "Esc to cancel",
].join("\n");

describe("readClaudeScreen", () => {
  it("reads a permission menu as a prompt with 3 options and keys", () => {
    expect(readClaudeScreen(MENU)).toEqual({
      mode: "default",
      prompt: {
        question: "Do you want to proceed?",
        options: [
          { label: "Yes", keys: "\r" },
          { label: "Yes, and don't ask again", keys: "\x1b[B\r" },
          { label: "No", keys: "\x1b[B\x1b[B\r" },
        ],
      },
    });
  });

  it.each([
    ["⏵⏵ auto mode on (shift+tab to cycle)", "auto"],
    ["⏸ plan mode on", "plan"],
    ["accept edits on", "acceptEdits"],
    ["AUTO MODE ON", "auto"],
    ["PLAN MODE ON", "plan"],
    ["ACCEPT EDITS ON", "acceptEdits"],
  ])("reads %s as mode %s", (marker, mode) => {
    expect(readClaudeScreen(`${IDLE}\n${marker}`).mode).toBe(mode);
  });

  it("reads a busy spinner and keeps its elapsed time", () => {
    expect(readClaudeScreen(`✻ Crunching… (5m 43s · esc to interrupt)\n${IDLE}`)).toEqual({
      mode: "default",
      working: "Crunching… 5m 43s",
    });
  });

  it("reads an idle screen with no working and no prompt", () => {
    expect(readClaudeScreen(IDLE)).toEqual({ mode: "default" });
  });

  it("sets working for a ✽ spinner frame", () => {
    expect(readClaudeScreen(`✽ Crunching… 5m 43s\n${IDLE}`).working).toBe("Crunching… 5m 43s");
  });

  it("ignores markers above the last 40 rows, including blank rows", () => {
    for (const marker of ["plan mode on", MENU, "✻ Crunching… (esc to interrupt)"]) {
      expect(readClaudeScreen(`${marker}\n${"\n".repeat(37)}${IDLE}`)).toEqual({
        mode: "default",
      });
    }
  });

  it("reads a mode marker on the first of the last 40 rows", () => {
    expect(readClaudeScreen(`auto mode on\n${"\n".repeat(36)}${IDLE}`).mode).toBe("auto");
  });

  it("uses the last spinner and removes a bare interrupt tail", () => {
    expect(
      readClaudeScreen(`✶ Thinking…\n  · Crunching… 5m 43s · esc to interrupt\n${IDLE}`).working,
    ).toBe("Crunching… 5m 43s");
  });

  it("does not expose a historical spinner after a completed turn", () => {
    expect(readClaudeScreen(`✻ Crunching…\n✻ Baked for 5s\n${IDLE}`).working).toBeUndefined();
  });

  it("does not expose a spinner while a permission menu is active", () => {
    expect(readClaudeScreen(`✻ Crunching…\n${MENU}`).working).toBeUndefined();
  });
});
