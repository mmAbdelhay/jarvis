import { AGENT_INPUT_MARKERS, readAgentInputState } from "./agent-input-state.js";
import { type PendingPrompt, readPrompt, stripAnsi } from "./awaiting-input.js";

export type ClaudeMode = "default" | "auto" | "plan" | "acceptEdits";

const SPINNER_ROW = /^\s*[✻✶✳✢·✽*]\s+(\S+….*)$/;

// Claude's status row opens on its mode glyph: "⏸ plan mode on", "⏵⏵ auto
// mode on", "⏵⏵ accept edits on". The same words without the glyph — in the
// transcript, or typed into the box — are not a mode.
const MODE_ROWS: readonly [RegExp, ClaudeMode][] = [
  [/^\s*⏸\s*plan mode on\b/i, "plan"],
  [/^\s*⏵⏵\s*auto mode on\b/i, "auto"],
  [/^\s*⏵⏵\s*accept edits on\b/i, "acceptEdits"],
];

/** A spinner's elapsed time: "6s", "5m 43s", "1h 2m". */
const ELAPSED = /^\d+[hms](?:\s+\d+[hms])*$/;

/** Lines Claude prints when a turn ends — the same set the busy check uses. */
const FINISHED = AGENT_INPUT_MARKERS["anthropic"]?.finished ?? [];

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
    for (const [marker, value] of MODE_ROWS) {
      if (marker.test(row)) mode = value;
    }
  }

  let working: string | undefined;
  if (readAgentInputState(tail, "anthropic") === "busy") {
    // Only rows after the last finished turn: a spinner above it is history,
    // which a draft in the box (busy on its own) must not bring back.
    for (const row of rows.slice(afterLastFinished(rows))) {
      const match = SPINNER_ROW.exec(row);
      if (match === null) continue;
      working = spinnerLabel(match[1] ?? "");
    }
  }
  return { prompt, mode, working };
}

/** The index after the last finished-turn row, or 0 when there is none. */
function afterLastFinished(rows: readonly string[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = (rows[i] ?? "").trim();
    if (FINISHED.some((marker) => marker.test(row))) return i + 1;
  }
  return 0;
}

/**
 * "Crunching… (6s · ↓ 235 tokens · thinking)" → "Crunching… 6s": the
 * parenthetical keeps its elapsed time and loses the rest, and an older
 * build's bare "· esc to interrupt" tail goes too.
 */
function spinnerLabel(text: string): string {
  const label = text.replace(/\s*\(([^)]*)\)\s*$/, (_, inside: string) => {
    const first = inside.split("·")[0]?.trim() ?? "";
    return ELAPSED.test(first) ? ` ${first}` : "";
  });
  return label.replace(/\s*·\s*esc to interrupt.*$/i, "").trim();
}
