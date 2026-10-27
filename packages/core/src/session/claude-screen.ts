import { readAgentInputState } from "./agent-input-state.js";
import { type PendingPrompt, readPrompt, stripAnsi } from "./awaiting-input.js";

export type ClaudeMode = "default" | "auto" | "plan" | "acceptEdits";

const SPINNER_ROW = /^\s*[✻✶✳✢·*]\s+(\S+….*)$/;

/** Reads Claude Code's prompt, mode and live spinner from the last 40 screen rows. */
export function readClaudeScreen(screen: string): {
  prompt?: PendingPrompt;
  mode: ClaudeMode;
  working?: string;
} {
  const rows = stripAnsi(screen).split("\n").slice(-40);
  const tail = rows.join("\n");
  const prompt = readPrompt(tail);
  let mode: ClaudeMode = "default";
  for (const row of rows) {
    if (/plan mode on/i.test(row)) mode = "plan";
    else if (/auto mode on/i.test(row)) mode = "auto";
    else if (/accept edits on/i.test(row)) mode = "acceptEdits";
  }

  let working: string | undefined;
  if (readAgentInputState(tail, "anthropic") === "busy") {
    for (const row of rows) {
      const match = SPINNER_ROW.exec(row);
      if (match === null) continue;
      // Keep elapsed time inside the interrupt hint, but drop its UI wrapper.
      working = (match[1] ?? "")
        .replace(/\(([^)]*?)\s*(?:·\s*)?esc to interrupt[^)]*\)\s*$/i, "$1")
        .replace(/\s*·\s*esc to interrupt.*$/i, "")
        .trim();
    }
  }
  return { prompt, mode, working };
}
