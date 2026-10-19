import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inputLineHasDraft, readAgentInputState } from "./agent-input-state.js";

// Drops the "# synthetic" / "# rendered" provenance line, so it is never
// part of a tail. The claude-* fixtures are real Claude Code screens: raw
// pane output captured in an end-to-end run, rendered through
// @xterm/headless the way pane-screen.ts renders a live pane.
const fixture = (name: string): string =>
  readFileSync(new URL(`./__fixtures__/agent-input/${name}.txt`, import.meta.url), "utf8").replace(
    /^# (?:synthetic|rendered).*\n/,
    "",
  );

// The idle fixture's finished-turn line, which tests below swap out.
const FINISHED = "✻ Baked for 15s · done 12:34 AM · 1 shell still running";
// Its empty input box, as the rendered screen has it (trailing space trimmed).
const EMPTY_BOX = /^❯$/m;
const withDraft = (draft: string): string =>
  fixture("claude-idle").replace(EMPTY_BOX, `❯ ${draft}`);

// Re-colours every line and erases it first, the way a TUI redraw arrives
// in a pane's raw output: the verdict must not depend on the escapes.
const wrapInAnsi = (tail: string): string =>
  tail
    .split("\n")
    .map((line) => `\x1b[2K\x1b[38;5;246m${line}\x1b[39m\r`)
    .join("\n");

const CASES = [
  { name: "claude-idle", vendor: "anthropic", state: "idle-input" },
  // Its placeholder as plain text: pane-screen.ts drops the dim placeholder
  // before the reader sees it, so plain `Try "…"` here is typed — a draft.
  { name: "claude-idle-placeholder", vendor: "anthropic", state: "busy" },
  { name: "claude-busy", vendor: "anthropic", state: "busy" },
  { name: "claude-approval", vendor: "anthropic", state: "approval-prompt" },
  { name: "codex-idle", vendor: "openai", state: "idle-input" },
  { name: "codex-busy", vendor: "openai", state: "busy" },
  { name: "codex-approval", vendor: "openai", state: "approval-prompt" },
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
    expect(readAgentInputState(withDraft("fix the fla"), "anthropic")).not.toBe("idle-input");
    expect(readAgentInputState(wrapInAnsi(withDraft("fix the fla")), "anthropic")).not.toBe(
      "idle-input",
    );
  });

  it("never reads Claude's folder-trust dialog as idle-input", () => {
    expect(readAgentInputState(fixture("claude-trust"), "anthropic")).not.toBe("idle-input");
  });

  it("still reads the older '>' input glyph", () => {
    const tail = fixture("claude-idle").replace(EMPTY_BOX, ">");
    expect(readAgentInputState(tail, "anthropic")).toBe("idle-input");
  });

  it("reads Claude's spinner line from the real mid-turn screen as busy, box empty", () => {
    const busy = fixture("claude-busy");
    expect(busy).toMatch(EMPTY_BOX);
    expect(busy).toContain("✶ Moseying… (6s");
    expect(busy).not.toContain("esc to interrupt");
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
    const tail = fixture("claude-idle").replace(FINISHED, "✻ Thinking… (3s · esc to interrupt)");
    expect(readAgentInputState(tail, "anthropic")).toBe("busy");
  });

  it("reads a Claude spinner line without esc-to-interrupt as busy", () => {
    const tail = fixture("claude-idle").replace(FINISHED, "✢ Thinking…");
    expect(readAgentInputState(tail, "anthropic")).toBe("busy");
  });

  it("is not idle once the input box is pushed away from the end of the tail", () => {
    const noise = Array.from({ length: 10 }, (_, i) => `  line ${i} of agent output`).join("\n");
    expect(readAgentInputState(`${fixture("claude-idle")}${noise}\n`, "anthropic")).not.toBe(
      "idle-input",
    );
  });
});

describe("readAgentInputState — long turns, drafts and menus", () => {
  // A running Claude turn with its todo list and queued messages between
  // the spinner and the box pushes the spinner far above any fixed window.
  it("reads a spinner above 18 todo lines and 3 queued messages as busy", () => {
    const todos = Array.from({ length: 18 }, (_, i) => `     ☐ Step ${i + 1} of the plan`);
    const tail = [
      "> work through the plan",
      "",
      "✶ Percolating… (2m 4s · ↓ 8.1k tokens · esc to interrupt)",
      "  ⎿  ☒ Read the spec",
      ...todos,
      "",
      "> also check the docs",
      "> and the changelog",
      "> then push",
      "",
      "─".repeat(80),
      "> ",
      "─".repeat(80),
      "  ? for shortcuts",
    ].join("\n");
    expect(readAgentInputState(tail, "anthropic")).toBe("busy");
  });

  it("reads an old spinner as finished once a completed-turn line follows it", () => {
    const tail = fixture("claude-idle").replace(
      FINISHED,
      `✶ Percolating… (12s · esc to interrupt)\n${FINISHED}`,
    );
    expect(readAgentInputState(tail, "anthropic")).toBe("idle-input");
  });

  it("reads a spinner after the completed-turn line as busy", () => {
    const tail = fixture("claude-idle").replace(
      FINISHED,
      `${FINISHED}\n\n❯ next\n\n✶ Percolating… (1s · thinking)`,
    );
    expect(readAgentInputState(tail, "anthropic")).toBe("busy");
  });

  it("reads a half-typed Codex draft as busy", () => {
    const tail = fixture("codex-idle").replace(
      "› Ask Codex to do anything",
      "› refactor the auth mod",
    );
    expect(readAgentInputState(tail, "openai")).toBe("busy");
    expect(inputLineHasDraft(tail, "openai")).toBe(true);
  });

  it("reads a Codex placeholder as an empty composer", () => {
    for (const placeholder of ["Explain this codebase", "Implement {feature}"]) {
      const tail = fixture("codex-idle").replace("› Ask Codex to do anything", `› ${placeholder}`);
      expect(readAgentInputState(tail, "openai")).toBe("idle-input");
      expect(inputLineHasDraft(tail, "openai")).toBe(false);
    }
  });

  // bite-proof: without its "esc to cancel" footer the menu is no longer a
  // looksLikePrompt match; its "› 1." row must still never pass for a composer.
  // It must read as approval-prompt, not just busy: that is the state that
  // also blocks "Deliver now".
  it("reads a Codex approval menu without its footer as approval-prompt", () => {
    const tail = fixture("codex-approval").replace(
      "  Press enter to confirm or esc to cancel\n",
      "",
    );
    expect(tail).not.toContain("esc to cancel");
    expect(readAgentInputState(tail, "openai")).toBe("approval-prompt");
  });
});

describe("readAgentInputState — a shell prompt is never Claude's box", () => {
  // starship / pure draw a bare "❯" prompt: no rules around it.
  it("reads a starship ❯ prompt alone at the bottom as not idle", () => {
    const tail = ["~/projects/app on  main", "❯ "].join("\n");
    expect(readAgentInputState(tail, "anthropic")).not.toBe("idle-input");
    expect(readAgentInputState(`${tail}\n`, "anthropic")).not.toBe("idle-input");
  });

  it("reads a ❯ with only one rule beside it as not idle", () => {
    const tail = ["⏺ done", "─".repeat(80), "❯ "].join("\n");
    expect(readAgentInputState(tail, "anthropic")).not.toBe("idle-input");
  });

  // Claude exited (or was stopped) and left its last frame on screen; the
  // shell's prompt sits below it.
  for (const prompt of ["user@mac app % ", "user@box:~/app$ ", "❯ ", "~/app ❯ "]) {
    it(`reads Claude's leftover frame under a shell prompt ${JSON.stringify(prompt)} as not idle`, () => {
      const tail = `${fixture("claude-idle")}${prompt}`;
      expect(readAgentInputState(tail, "anthropic")).not.toBe("idle-input");
    });
  }

  it("still reads the real status lines under the box as idle", () => {
    expect(readAgentInputState(fixture("claude-idle"), "anthropic")).toBe("idle-input");
  });
});

describe("inputLineHasDraft", () => {
  it("is true for a Claude draft", () => {
    expect(inputLineHasDraft(withDraft("fix the fla"), "anthropic")).toBe(true);
  });

  it("is true for a Claude draft wrapped in ANSI colour codes", () => {
    expect(inputLineHasDraft(wrapInAnsi(withDraft("fix the fla")), "anthropic")).toBe(true);
  });

  it("is false for the empty Claude input box", () => {
    expect(inputLineHasDraft(fixture("claude-idle"), "anthropic")).toBe(false);
  });

  it("is true for placeholder words that are not styled as a placeholder", () => {
    expect(inputLineHasDraft(fixture("claude-idle-placeholder"), "anthropic")).toBe(true);
  });
});
