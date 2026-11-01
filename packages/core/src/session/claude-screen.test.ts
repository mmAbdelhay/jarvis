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
    ["  ⏸ plan mode on (shift+tab to cycle)", "plan"],
    ["⏵⏵ accept edits on (shift+tab to cycle)", "acceptEdits"],
    ["⏵⏵ AUTO MODE ON", "auto"],
    ["⏸ PLAN MODE ON", "plan"],
    ["⏵⏵ ACCEPT EDITS ON", "acceptEdits"],
  ])("reads %s as mode %s", (marker, mode) => {
    expect(readClaudeScreen(`${IDLE}\n${marker}`).mode).toBe(mode);
  });

  // Only Claude's own status row carries the glyph; the same words in the
  // transcript, or typed into the box, are not a mode.
  it.each([
    "plan mode on",
    "auto mode on",
    "accept edits on",
    "I asked it to turn plan mode on yesterday",
    "⏵⏵ plan mode on",
    "⏸ auto mode on",
  ])("does not read %s as a mode", (text) => {
    expect(readClaudeScreen(`${text}\n${IDLE}`).mode).toBe("default");
    expect(readClaudeScreen(`${IDLE}\n${text}`).mode).toBe("default");
  });

  it("does not read a draft that says turn plan mode on as a mode", () => {
    expect(readClaudeScreen("────────────\n❯ turn ⏸ plan mode on\n────────────").mode).toBe(
      "default",
    );
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

  it("reads the current spinner format, keeping only its elapsed time", () => {
    expect(readClaudeScreen(`✻ Crunching… (6s · ↓ 235 tokens · thinking)\n${IDLE}`).working).toBe(
      "Crunching… 6s",
    );
    expect(
      readClaudeScreen(`✻ Crunching… (1m 2s · ↑ 1.2k tokens · esc to interrupt)\n${IDLE}`).working,
    ).toBe("Crunching… 1m 2s");
    expect(readClaudeScreen(`✻ Crunching… (thinking)\n${IDLE}`).working).toBe("Crunching…");
  });

  // A draft makes the screen busy on its own; the spinner above the last
  // finished turn is history, not work in progress.
  it("ignores a stale spinner above a finished turn when a draft makes it busy", () => {
    const screen =
      "✻ Crunching… (6s · esc to interrupt)\n✻ Baked for 6s\n────────────\n❯ next question\n────────────";
    expect(readClaudeScreen(screen).working).toBeUndefined();
  });

  it("sets working for a ✽ spinner frame", () => {
    expect(readClaudeScreen(`✽ Crunching… 5m 43s\n${IDLE}`).working).toBe("Crunching… 5m 43s");
  });

  it("ignores markers above the last 40 rows, including blank rows", () => {
    for (const marker of ["⏸ plan mode on", MENU, "✻ Crunching… (esc to interrupt)"]) {
      expect(readClaudeScreen(`${marker}\n${"\n".repeat(37)}${IDLE}`)).toEqual({
        mode: "default",
      });
    }
  });

  it("reads a mode marker on the first of the last 40 rows", () => {
    expect(readClaudeScreen(`⏵⏵ auto mode on\n${"\n".repeat(36)}${IDLE}`).mode).toBe("auto");
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
