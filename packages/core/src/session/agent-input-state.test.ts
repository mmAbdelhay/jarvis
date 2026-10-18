import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inputLineHasDraft, readAgentInputState } from "./agent-input-state.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/agent-input/${name}.txt`, import.meta.url), "utf8");

// Re-colours every line and erases it first, the way a TUI redraw arrives
// in a pane's raw output: the verdict must not depend on the escapes.
const wrapInAnsi = (tail: string): string =>
  tail
    .split("\n")
    .map((line) => `\x1b[2K\x1b[38;5;246m${line}\x1b[39m\r`)
    .join("\n");

const CASES = [
  { name: "claude-idle", vendor: "anthropic", state: "idle-input" },
  { name: "claude-busy", vendor: "anthropic", state: "busy" },
  { name: "claude-approval", vendor: "anthropic", state: "approval-prompt" },
  { name: "codex-idle", vendor: "openai", state: "idle-input" },
  { name: "codex-busy", vendor: "openai", state: "busy" },
] as const;

describe("readAgentInputState", () => {
  for (const { name, vendor, state } of CASES) {
    it(`reads ${name} as ${state}`, () => {
      expect(readAgentInputState(fixture(name), vendor)).toBe(state);
    });

    it(`reads ${name} wrapped in ANSI colour codes as ${state}`, () => {
      expect(readAgentInputState(wrapInAnsi(fixture(name)), vendor)).toBe(state);
    });
  }

  it("never reads a half-typed draft as idle-input", () => {
    expect(readAgentInputState(fixture("claude-draft"), "anthropic")).not.toBe("idle-input");
    expect(readAgentInputState(wrapInAnsi(fixture("claude-draft")), "anthropic")).not.toBe(
      "idle-input",
    );
  });

  it("gives unknown for a vendor it has no markers for", () => {
    expect(readAgentInputState(fixture("claude-idle"), "github")).toBe("unknown");
  });

  // Keyed by vendor, not by the user's config key: "claude-mm" and "claude"
  // are agent ids, never marker keys.
  it("gives unknown for an agent id passed where a vendor belongs", () => {
    expect(readAgentInputState(fixture("claude-idle"), "claude")).toBe("unknown");
    expect(readAgentInputState(fixture("claude-idle"), "claude-mm")).toBe("unknown");
  });

  it("gives unknown for a prototype key", () => {
    expect(readAgentInputState(fixture("claude-idle"), "constructor")).toBe("unknown");
  });

  it("gives approval-prompt for any vendor, even one it has no markers for", () => {
    expect(readAgentInputState(fixture("claude-approval"), "github")).toBe("approval-prompt");
  });

  it("gives unknown for an empty tail", () => {
    expect(readAgentInputState("", "anthropic")).toBe("unknown");
  });

  // bite-proof: the idle fixture's own box with the agent's busy line put
  // back in must stop being idle — the empty "> " alone is not enough.
  it("reads an empty box under an esc-to-interrupt line as busy", () => {
    const tail = fixture("claude-idle").replace(
      "✻ Worked for 18s",
      "✻ Thinking… (3s · esc to interrupt)",
    );
    expect(readAgentInputState(tail, "anthropic")).toBe("busy");
  });

  it("reads a Claude spinner line without esc-to-interrupt as busy", () => {
    const tail = fixture("claude-idle").replace("✻ Worked for 18s", "✢ Thinking…");
    expect(readAgentInputState(tail, "anthropic")).toBe("busy");
  });

  it("is not idle once the input box is pushed away from the end of the tail", () => {
    const noise = Array.from({ length: 10 }, (_, i) => `  line ${i} of agent output`).join("\n");
    expect(readAgentInputState(`${fixture("claude-idle")}${noise}\n`, "anthropic")).not.toBe(
      "idle-input",
    );
  });
});

describe("inputLineHasDraft", () => {
  it("is true for the Claude draft fixture", () => {
    expect(inputLineHasDraft(fixture("claude-draft"), "anthropic")).toBe(true);
  });

  it("is true for the Claude draft fixture wrapped in ANSI colour codes", () => {
    expect(inputLineHasDraft(wrapInAnsi(fixture("claude-draft")), "anthropic")).toBe(true);
  });

  it("is false for the empty Claude input box", () => {
    expect(inputLineHasDraft(fixture("claude-idle"), "anthropic")).toBe(false);
  });
});
