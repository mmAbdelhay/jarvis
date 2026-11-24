import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readAgentMenu } from "./agent-menu.js";

const ESC = "\x1b";
const DOWN = `${ESC}[B`;
const UP = `${ESC}[A`;

// Fixtures are committed screens: the claude-* ones were rendered from a real
// pane, codex-approval is built from Codex's own approval menu text.
const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/agent-input/${name}.txt`, import.meta.url), "utf8").replace(
    /^# (?:synthetic|rendered).*\n/,
    "",
  );

const RULE = "─".repeat(40);

describe("readAgentMenu: shapes proven by a fixture", () => {
  it("reads Claude's permission menu with the command above it", () => {
    const menu = readAgentMenu(fixture("claude-approval"), "anthropic");
    expect(menu).toMatchObject({ kind: "single", question: "Do you want to proceed?" });
    if (menu?.kind !== "single") throw new Error("not single");
    expect(menu.options.map((o) => [o.number, o.highlighted, o.keys])).toEqual([
      [1, true, "\r"],
      [2, false, `${DOWN}\r`],
      [3, false, `${DOWN}${DOWN}\r`],
      [4, false, `${DOWN}${DOWN}${DOWN}\r`],
    ]);
    expect(menu.options[0]?.label).toBe("Yes");
    expect(menu.options[3]?.label).toBe("No");
    expect(menu.body).toContain("touch e2e-approval-probe.txt");
    expect(menu.body).toContain("Create empty probe file");
    expect(menu.body).not.toContain("╌");
    expect(menu.body).not.toContain("sleep 40");
  });

  it("reads Codex's approval menu, its › highlight, and the command between question and rows", () => {
    const menu = readAgentMenu(fixture("codex-approval"), "openai");
    expect(menu).toMatchObject({
      kind: "single",
      question: "Would you like to run the following command?",
    });
    if (menu?.kind !== "single") throw new Error("not single");
    expect(menu.options.map((o) => o.label)).toEqual([
      "Yes, proceed (y)",
      "Yes, and don't ask again for this command (a)",
      "No, and tell Codex what to do differently (esc)",
    ]);
    expect(menu.options.map((o) => o.keys)).toEqual(["\r", `${DOWN}\r`, `${DOWN}${DOWN}\r`]);
    expect(menu.body).toBe(
      "Reason: remove the stale desktop build output\n\n$ rm -rf packages/desktop/dist".replace(
        "\n\n",
        "\n",
      ),
    );
  });

  it("starts from wherever the highlight already is", () => {
    const screen = [
      "Do you want to proceed?",
      "  1. Yes",
      "❯ 2. Yes, always",
      "  3. No",
      "Esc to cancel",
    ].join("\n");
    const menu = readAgentMenu(screen, "anthropic");
    if (menu?.kind !== "single") throw new Error("not single");
    expect(menu.options.map((o) => o.keys)).toEqual([`${UP}\r`, "\r", `${DOWN}\r`]);
  });

  it("reads the menu the phone reads, wire colours and CRLF included", () => {
    const screen = [
      `${ESC}[2K${ESC}[1A${ESC}[38;5;246m Bash command${ESC}[39m`,
      "   rm -rf build",
      ` ${ESC}[1mDo you want to proceed?${ESC}[22m`,
      ` ${ESC}[36m❯ 1. Yes${ESC}[39m`,
      "   2. Yes, and don't ask again for rm commands",
      "   3. No, and tell Claude what to do differently (esc)",
      "",
    ].join("\r\n");
    const menu = readAgentMenu(screen, "anthropic");
    expect(menu).toMatchObject({ kind: "single", question: "Do you want to proceed?" });
    if (menu?.kind !== "single") throw new Error("not single");
    expect(menu.options).toHaveLength(3);
    expect(menu.body).toBeUndefined();
  });

  it("reads a (y/n) question and a Press Enter prompt, as the phone does", () => {
    const yn = readAgentMenu("ok\r\nOverwrite config.json? (y/n)", "anthropic");
    expect(yn).toMatchObject({
      kind: "single",
      question: "Overwrite config.json? (y/n)",
      options: [
        { label: "Yes", keys: "y\r" },
        { label: "No", keys: "n\r" },
      ],
    });
    const enter = readAgentMenu("Installed.\r\nPress Enter to continue", "openai");
    expect(enter).toMatchObject({
      kind: "single",
      question: "Press Enter to continue",
      options: [{ label: "Enter", keys: "\r" }],
    });
  });
});

describe("readAgentMenu: unreadable goes to the drawer", () => {
  it("never guesses keys for Claude's folder-trust dialog", () => {
    expect(readAgentMenu(fixture("claude-trust"), "anthropic")).toEqual({ kind: "unreadable" });
  });

  it.each([
    [
      "checkbox rows",
      ["Which ones?", "❯ 1. [ ] alpha", "  2. [x] beta", "Enter to confirm · Esc to cancel"],
    ],
    [
      "a multi-question tab header",
      [
        "← ☐ Scope  ☐ Style  ✔ Submit →",
        "Which scope?",
        "❯ 1. One",
        "  2. Two",
        "Enter to select · Esc to cancel",
      ],
    ],
    [
      "a description under an option",
      [
        "Do you want to proceed?",
        "❯ 1. Yes",
        "     Runs the command now",
        "  2. No",
        "Esc to cancel",
      ],
    ],
    ["numbers with a gap", ["Do you want to continue?", "❯ 1. Yes", "  3. No", "Esc to cancel"]],
    [
      "numbers not starting at 1",
      ["Do you want to continue?", "❯ 2. Yes", "  3. No", "Esc to cancel"],
    ],
    ["no highlighted row", ["Do you want to proceed?", "  1. Yes", "  2. No", "Esc to cancel"]],
    ["two highlighted rows", ["Do you want to proceed?", "❯ 1. Yes", "❯ 2. No", "Esc to cancel"]],
    ["a single row", ["Do you want to proceed?", "❯ 1. Yes", "Esc to cancel"]],
    ["no question above the rows", ["Run it", "❯ 1. Yes", "  2. No", "Esc to cancel"]],
    [
      "text after the rows",
      ["Do you want to proceed?", "❯ 1. Yes", "  2. No", "and then some other words"],
    ],
    [
      "the other vendor's highlight",
      ["Do you want to proceed?", "› 1. Yes", "  2. No", "Esc to cancel"],
    ],
    [
      "a Press Enter that is not the continue prompt",
      ["Some text", "Press enter to confirm or esc to cancel"],
    ],
  ])("reads %s as unreadable", (_name, rows) => {
    expect(readAgentMenu(rows.join("\n"), "anthropic")).toEqual({ kind: "unreadable" });
  });

  it("is unreadable for a vendor it has no proven menu for, and nothing without a prompt", () => {
    const screen = ["Do you want to proceed?", "❯ 1. Yes", "  2. No", "Esc to cancel"].join("\n");
    expect(readAgentMenu(screen, "github")).toEqual({ kind: "unreadable" });
    expect(readAgentMenu("some output\n$ ls", "github")).toBeUndefined();
  });
});

describe("readAgentMenu: plain screens are never a menu", () => {
  it.each(["claude-idle", "claude-idle-placeholder", "claude-busy"])("%s", (name) => {
    expect(readAgentMenu(fixture(name), "anthropic")).toBeUndefined();
  });
  it.each(["codex-idle", "codex-busy"])("%s", (name) => {
    expect(readAgentMenu(fixture(name), "openai")).toBeUndefined();
  });

  it("ignores a numbered list and a question in the transcript above an idle box", () => {
    const screen = [
      "Do you want to proceed with option one?",
      "❯ 1. Yes",
      "  2. No",
      RULE,
      "❯",
      RULE,
      "  ⏵⏵ auto mode on",
    ].join("\n");
    expect(readAgentMenu(screen, "anthropic")).toBeUndefined();
    const codex = [
      "Do you want to proceed?",
      "› 1. Yes",
      "  2. No",
      "",
      "› Ask Codex to do anything",
      "",
      "  100% context left",
    ].join("\n");
    expect(readAgentMenu(codex, "openai")).toBeUndefined();
  });

  it("ignores numbered output of a shell or a list in prose", () => {
    expect(readAgentMenu("Steps:\n1. install\n2. build\n3. test\n$ ", "anthropic")).toBeUndefined();
    expect(readAgentMenu("Which one?\n1. a\n2. b\n", "anthropic")).toBeUndefined();
    expect(readAgentMenu("> 1. Yes\n> 2. No\n$ echo hi\nhi", "openai")).toBeUndefined();
    expect(readAgentMenu("", "anthropic")).toBeUndefined();
  });

  it("ignores a long-answered prompt that scrolled up", () => {
    const rows = ["Overwrite x? (y/n)", ...Array.from({ length: 10 }, (_, i) => `out ${i}`)];
    expect(readAgentMenu(rows.join("\n"), "anthropic")).toBeUndefined();
  });

  it("never throws on junk and strips control characters", () => {
    expect(() => readAgentMenu("\u0000\u001b[".repeat(5000), "anthropic")).not.toThrow();
    expect(() => readAgentMenu("x".repeat(500_000), "openai")).not.toThrow();
    const menu = readAgentMenu(
      `Do you want to proceed?\n❯ 1. Ye\u0007s\n  2. No\nEsc to cancel`,
      "anthropic",
    );
    if (menu?.kind !== "single") throw new Error("not single");
    expect(menu.options[0]?.label).toBe("Yes");
  });
});
