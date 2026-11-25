import { describe, expect, it } from "vitest";
import { readAgentStatusLine } from "./agent-status-line.js";

const RULE = "─".repeat(60);
const claude = (...below: string[]): string =>
  ["Some output above", "", RULE, "❯ ", RULE, ...below].join("\n");

describe("readAgentStatusLine — Claude", () => {
  it("reads the user's own statusline rows and leaves the mode row out", () => {
    const view = readAgentStatusLine(
      "anthropic",
      claude(
        "  work-account  someone@example.com",
        "  [user@host:/repo (main)]  [Haiku 5.5]",
        "  ⏸ manual mode on (shift+tab to cycle)",
      ),
    );
    expect(view.lines).toEqual([
      "work-account someone@example.com",
      "[user@host:/repo (main)] [Haiku 5.5]",
    ]);
    expect(view.limits).toEqual([]);
  });

  it("reads labelled percents with resets, and drops the bar glyphs", () => {
    const view = readAgentStatusLine(
      "anthropic",
      claude(
        "  Session █░░░░░░ 13% resets 04:20  │  Week ███████░ 83% resets Wed 22:00",
        "  ? for shortcuts",
      ),
    );
    expect(view.lines).toEqual(["Session 13% resets 04:20 │ Week 83% resets Wed 22:00"]);
    expect(view.limits).toEqual([
      { label: "Session", usedPercent: 13, resets: "04:20" },
      { label: "Week", usedPercent: 83, resets: "Wed 22:00" },
    ]);
  });

  it("reads percent-only windows, left forms, and ignores context percents", () => {
    const view = readAgentStatusLine(
      "anthropic",
      claude("  5h 40% │ 7d 10% left │ Context 45% │ Haiku 5.5 12%", "  ⏵⏵ accept edits on"),
    );
    expect(view.limits).toEqual([
      { label: "5h", usedPercent: 40 },
      { label: "7d", usedPercent: 90 },
    ]);
  });

  it("reads the CLI's own limit note", () => {
    const view = readAgentStatusLine(
      "anthropic",
      [
        "You've used 92% of your 5-hour limit · resets 11:20pm (Africa/Cairo)",
        RULE,
        "❯ ",
        RULE,
        "  ? for shortcuts",
      ].join("\n"),
    );
    expect(view.limits).toEqual([
      { label: "5-hour", usedPercent: 92, resets: "11:20pm (Africa/Cairo)" },
    ]);
    expect(view.lines).toEqual([]);
  });

  it("reads limits only from the statusline rows and the note beside the box", () => {
    const view = readAgentStatusLine(
      "anthropic",
      [
        "Session 90% resets 5pm",
        "The answer: week 99% is high",
        RULE,
        "❯ week 99%",
        RULE,
        "  Session 13% resets 04:20",
        "  ? for shortcuts",
      ].join("\n"),
    );
    expect(view.limits).toEqual([{ label: "Session", usedPercent: 13, resets: "04:20" }]);
    const inBox = readAgentStatusLine(
      "anthropic",
      [RULE, "❯ You've used 92% of your 5-hour limit", RULE, "  ? for shortcuts"].join("\n"),
    );
    expect(inBox.limits).toEqual([]);
    const sentence = readAgentStatusLine(
      "anthropic",
      [
        "I said You've used 92% of your 5-hour limit · resets 11:20pm",
        RULE,
        "❯ ",
        RULE,
        "  ? for shortcuts",
      ].join("\n"),
    );
    expect(sentence.limits).toEqual([]);
  });

  it("shows a window once, preferring the statusline over the note", () => {
    const view = readAgentStatusLine(
      "anthropic",
      [
        "You've used 92% of your 5-hour limit · resets 11:20pm",
        RULE,
        "❯ ",
        RULE,
        "  Session 13% resets 04:20",
        "  ? for shortcuts",
      ].join("\n"),
    );
    expect(view.limits).toEqual([{ label: "Session", usedPercent: 13, resets: "04:20" }]);
  });

  it("shows nothing for the default statusline and nothing while a menu is open", () => {
    expect(readAgentStatusLine("anthropic", claude("  ? for shortcuts"))).toEqual({
      lines: [],
      details: {},
      limits: [],
    });
    const menu = [
      "Bash command",
      "  rm -rf build",
      "Do you want to proceed?",
      "❯ 1. Yes",
      "  2. No, and tell Claude what to do differently (esc)",
      RULE,
      "  Session 13% resets 04:20",
    ].join("\n");
    expect(readAgentStatusLine("anthropic", menu)).toEqual({ lines: [], limits: [], details: {} });
  });

  it("needs the input box: a lone rule and its text is not a statusline", () => {
    expect(readAgentStatusLine("anthropic", `${RULE}\n  hello\n`)).toEqual({
      lines: [],
      details: {},
      limits: [],
    });
  });

  it("strips escapes and control characters, bounds rows and length", () => {
    const rows = Array.from({ length: 9 }, (_, i) => `  row${i} \u001b[31mred\u001b[0m\u0007`);
    rows.push(`  ${"x".repeat(500)}`);
    const view = readAgentStatusLine("anthropic", claude(...rows, "  ? for shortcuts"));
    expect(view.lines).toHaveLength(6);
    expect(view.lines[0]).toBe("row0 red");
    const long = readAgentStatusLine(
      "anthropic",
      claude(`  ${"x".repeat(500)}`, "  ? for shortcuts"),
    );
    expect(long.lines[0]).toHaveLength(300);
  });
});

describe("readAgentStatusLine — Codex", () => {
  it("reads the row under the input and leaves the hint row out", () => {
    const view = readAgentStatusLine(
      "openai",
      [
        "• Done.",
        "",
        "› Ask Codex to do anything",
        "",
        "  GPT-6-Luna default · /private/tmp/x/demo-api · Create note.txt",
        "  ← for agents · ? for shortcuts",
      ].join("\n"),
    );
    expect(view).toEqual({
      lines: ["GPT-6-Luna default · /private/tmp/x/demo-api · Create note.txt"],
      limits: [],
      details: { model: "GPT-6-Luna default", folder: "/private/tmp/x/demo-api" },
    });
  });

  it("is empty with an approval menu or without the input row", () => {
    const menu = [
      "Would you like to run the following command?",
      "› 1. Yes, proceed (y)",
      "  2. No, and tell Codex what to do differently (esc)",
      "  GPT-6-Luna default · /private/tmp/x",
    ].join("\n");
    expect(readAgentStatusLine("openai", menu)).toEqual({ lines: [], limits: [], details: {} });
    expect(readAgentStatusLine("openai", "just text\nmore")).toEqual({
      lines: [],
      limits: [],
      details: {},
    });
  });
});

describe("readAgentStatusLine — Copilot", () => {
  const screen = [
    "answer text",
    "account:/private/tmp/x/demo-web [⎇ master] +0 -0      Plan: 1,029/21,900 (4% used) · Run on: This computer ctrl+e change environment",
    "╭──────────────╮",
    "│ >            │",
    "╰──────────────╯",
    "← open sidebar · Interactive · Manual Approval · / commands · ? help · tab next tab      Claude Sonnet 5.5 · Medium · (13%)",
  ].join("\n");

  it("reads the account row without the hints, the right group below, and the plan", () => {
    const view = readAgentStatusLine("github", screen);
    expect(view.lines).toEqual([
      "account:/private/tmp/x/demo-web [⎇ master] +0 -0 Plan: 1,029/21,900 (4% used)",
      "Claude Sonnet 5.5 · Medium · (13%)",
    ]);
    expect(view.limits).toEqual([{ label: "Plan", usedPercent: 4, detail: "1,029/21,900" }]);
  });

  it("is empty while a menu is open and never throws on junk", () => {
    expect(readAgentStatusLine("github", "")).toEqual({ lines: [], limits: [], details: {} });
    expect(readAgentStatusLine("github", "\u0000\u001b[".repeat(50))).toEqual({
      lines: [],
      details: {},
      limits: [],
    });
    expect(readAgentStatusLine("nope" as never, screen)).toEqual({
      lines: [],
      limits: [],
      details: {},
    });
  });
});

describe("readAgentStatusLine — details", () => {
  it("reads the account from an email row, the word before it, or the email itself", () => {
    const named = readAgentStatusLine("anthropic", claude("  work-account  someone@example.com"));
    expect(named.details).toEqual({ account: "work-account" });
    const bare = readAgentStatusLine("anthropic", claude("  someone@example.com"));
    expect(bare.details).toEqual({ account: "someone@example.com" });
  });

  it("reads folder and branch, then model and context, from the bracket groups", () => {
    const view = readAgentStatusLine(
      "anthropic",
      claude(
        "  [user@host:/repo/app (feat/x)]  [Haiku 5.5 ctx:6% (64k/1000k)]",
        "  ? for shortcuts",
      ),
    );
    expect(view.details).toEqual({
      folder: "/repo/app",
      branch: "feat/x",
      model: "Haiku 5.5",
      context: { usedPercent: 6, usedText: "64k", totalText: "1000k" },
    });
  });

  it("reads a bare model group and a context group without the counts", () => {
    expect(readAgentStatusLine("anthropic", claude("  [Haiku 5.5]")).details).toEqual({
      model: "Haiku 5.5",
    });
    expect(readAgentStatusLine("anthropic", claude("  [Haiku ctx:41%]")).details).toEqual({
      model: "Haiku",
      context: { usedPercent: 41 },
    });
  });

  it("reads a plain path row, a (branch) row and a glyph branch row, and nothing vague", () => {
    expect(readAgentStatusLine("anthropic", claude("  ~/work/app", "  (main)")).details).toEqual({
      folder: "~/work/app",
      branch: "main",
    });
    expect(readAgentStatusLine("anthropic", claude("  /repo/app  dev")).details).toEqual({
      folder: "/repo/app",
      branch: "dev",
    });
    expect(
      readAgentStatusLine("anthropic", claude("  building things now", "  [a/b: c]")).details,
    ).toEqual({});
  });

  it("reads Codex model and folder", () => {
    const view = readAgentStatusLine(
      "openai",
      ["› Ask", "", "  GPT-6-Luna default · /private/tmp/x/demo-api · Create note.txt"].join("\n"),
    );
    expect(view.details).toEqual({
      model: "GPT-6-Luna default",
      folder: "/private/tmp/x/demo-api",
    });
  });

  it("reads Copilot account, folder and branch, and the model row alone", () => {
    const view = readAgentStatusLine(
      "github",
      [
        "account:/private/tmp/x/demo-web [⎇ master] +0 -0      Plan: 1,029/21,900 (4% used)",
        "│ >            │",
        "← open sidebar · / commands · ? help      Claude Sonnet 5.5 · Medium · (13%)",
      ].join("\n"),
    );
    expect(view.details).toEqual({
      account: "account",
      folder: "/private/tmp/x/demo-web",
      branch: "master",
      model: "Claude Sonnet 5.5",
    });
  });
});
