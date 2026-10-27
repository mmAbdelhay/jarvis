import { describe, expect, it } from "vitest";
import { type ClaudeView, parseClaudeView } from "./claude-view.js";

const VALID: ClaudeView = {
  kind: "claude",
  sessionId: "s-1",
  title: "fix login",
  model: "claude-opus-5",
  mode: "plan",
  turns: [
    { role: "user", text: "fix it", tools: [] },
    {
      role: "assistant",
      text: "done",
      tools: [{ name: "Edit", target: "a.ts", added: 2, removed: 1 }, { name: "Bash" }],
    },
  ],
  prompt: { question: "Proceed?", options: [{ label: "Yes", keys: "\r" }] },
  working: "Crunching… 5m",
};

describe("parseClaudeView", () => {
  it("round-trips a valid view and a minimal one", () => {
    expect(parseClaudeView(JSON.parse(JSON.stringify(VALID)))).toEqual(VALID);
    expect(parseClaudeView({ kind: "claude", sessionId: "s", turns: [] })).toEqual({
      kind: "claude",
      sessionId: "s",
      turns: [],
    });
    expect(parseClaudeView({ kind: "none" })).toEqual({ kind: "none" });
  });

  it("drops fields it does not know", () => {
    const parsed = parseClaudeView({ ...VALID, extra: 1, prompt: { ...VALID.prompt, x: 1 } });
    expect(parsed).toEqual(VALID);
  });

  it.each([
    ["null", null],
    ["a string", "claude"],
    ["an array", []],
    ["an unknown kind", { kind: "other" }],
    ["no sessionId", { kind: "claude", turns: [] }],
    ["turns not an array", { kind: "claude", sessionId: "s", turns: {} }],
    ["a bad role", { ...VALID, turns: [{ role: "system", text: "", tools: [] }] }],
    ["a turn without tools", { ...VALID, turns: [{ role: "user", text: "" }] }],
    ["a tool without name", { ...VALID, turns: [{ role: "user", text: "", tools: [{}] }] }],
    [
      "a tool with string counts",
      { ...VALID, turns: [{ role: "user", text: "", tools: [{ name: "Edit", added: "2" }] }] },
    ],
    ["an unknown mode", { ...VALID, mode: "yolo" }],
    ["a numeric title", { ...VALID, title: 3 }],
    [
      "a prompt option without keys",
      { ...VALID, prompt: { question: "q", options: [{ label: "a" }] } },
    ],
    ["a prompt without options", { ...VALID, prompt: { question: "q" } }],
  ])("is none for %s", (_name, raw) => {
    expect(parseClaudeView(raw)).toEqual({ kind: "none" });
  });
});
