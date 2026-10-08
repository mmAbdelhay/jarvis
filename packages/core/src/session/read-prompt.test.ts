import { describe, expect, it } from "vitest";
import { readPrompt } from "./awaiting-input.js";

const ESC = "\x1b";
const DOWN = `${ESC}[B`;

// What Claude Code's permission prompt looks like on the wire: colours,
// cursor moves and a redraw, around rows the eye reads as a menu.
const claudePermission = [
  `${ESC}[2K${ESC}[1A${ESC}[38;5;246m Bash command${ESC}[39m`,
  "   rm -rf build",
  ` ${ESC}[1mDo you want to proceed?${ESC}[22m`,
  ` ${ESC}[36m❯ 1. Yes${ESC}[39m`,
  "   2. Yes, and don't ask again for rm commands",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
].join("\r\n");

describe("readPrompt", () => {
  it("reads a numbered menu, answering by moving the highlight and pressing Enter", () => {
    expect(readPrompt(claudePermission)).toEqual({
      question: "Do you want to proceed?",
      options: [
        { label: "Yes", keys: "\r" },
        { label: "Yes, and don't ask again for rm commands", keys: `${DOWN}\r` },
        { label: "No, and tell Claude what to do differently (esc)", keys: `${DOWN}${DOWN}\r` },
      ],
    });
  });

  it("starts from wherever the highlight already is", () => {
    const moved = claudePermission
      .replace(`${ESC}[36m❯ 1. Yes${ESC}[39m`, "  1. Yes")
      .replace("   2. Yes, and", " ❯ 2. Yes, and");
    const prompt = readPrompt(moved);
    expect(prompt?.options.map((option) => option.keys)).toEqual([`${ESC}[A\r`, "\r", `${DOWN}\r`]);
  });

  it("reads only the last prompt when an earlier one is still in the tail", () => {
    const twice = `${claudePermission}\r\nok\r\nOverwrite config.json? (y/n)`;
    expect(readPrompt(twice)).toEqual({
      question: "Overwrite config.json? (y/n)",
      options: [
        { label: "Yes", keys: "y\r" },
        { label: "No", keys: "n\r" },
      ],
    });
  });

  it("reads a press-Enter prompt as one option", () => {
    expect(readPrompt("Installed.\r\nPress Enter to continue")).toEqual({
      question: "Press Enter to continue",
      options: [{ label: "Enter", keys: "\r" }],
    });
  });

  it("reads nothing for output that is not sitting at a prompt", () => {
    expect(readPrompt("")).toBeUndefined();
    expect(readPrompt("Running tests…\r\n212 passed")).toBeUndefined();
  });

  it("refuses a menu whose numbers it cannot drive", () => {
    const gappy = "Do you want to continue?\r\n❯ 1. Yes\r\n  3. No";
    expect(readPrompt(gappy)).toBeUndefined();
  });
});
