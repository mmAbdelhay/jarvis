// "Idle at its input box" check for the Reviews delivery gate (spec §4.3):
// a pure marker read over a pane's output tail that says whether text can
// be pasted into the agent running there. This is the safety core — a
// wrong "idle-input" pastes into a busy agent or, worse, the trailing
// Enter answers an approval menu — so every doubt resolves to anything but
// "idle-input". A false "busy" only delays a delivery.
//
// The tail is a raw terminal stream with redraws in it, so an older frame's
// spinner can still sit in the scanned lines after the agent went idle;
// that reads as busy, which is the safe direction.

import { looksLikePrompt, stripAnsi } from "./awaiting-input.js";

export type AgentInputState = "idle-input" | "approval-prompt" | "busy" | "unknown";

/** How many trailing non-empty lines the busy markers are looked for in. */
export const BUSY_SCAN_LINES = 20;

/**
 * How close to the end the input line must be. Below the box sit only its
 * bottom rule and a status line or two; an input line further up than this
 * is history, not the box the agent is waiting at.
 */
export const INPUT_LINE_WINDOW = 6;

type AgentInputMarkers = {
  /** Matches the agent's input line; group 1, when present, is its text. */
  inputLine: RegExp;
  /** Any of these in the last {@link BUSY_SCAN_LINES} lines means busy. */
  busy: readonly RegExp[];
  /**
   * Whether text on the input line is the user's own draft. False where the
   * empty box shows a placeholder the stripped tail cannot tell apart from
   * typed text.
   */
  draftReadable: boolean;
};

// One entry per agent vendor (`AgentConfig.vendor`), not per agent id: ids
// are the user's config keys ("claude-mm", "claude-work") and any number of
// them run the same CLI. A vendor with no entry — or an agent with no
// vendor — is "unknown", never guessed idle.
export const AGENT_INPUT_MARKERS: Readonly<Record<string, AgentInputMarkers>> = {
  // anthropic — Claude Code: the input box is "> " between two rules (or inside "│ … │"
  // on older builds); while a turn runs a spinner line — one of its glyphs,
  // a gerund, "…", usually "(12s · esc to interrupt)" — sits above it. The
  // finished-turn line ("✻ Worked for 18s") has no "…", so it is not busy.
  anthropic: {
    inputLine: /^│?\s*>(?:\s+(.*?))?\s*│?$/,
    busy: [/esc to interrupt/i, /^[·✢✳✶✻✽*]\s+\S.*…/],
    draftReadable: true,
  },
  // openai — Codex CLI: the composer is "› " (or "▌" on older builds) and shows a
  // placeholder when empty; a running turn shows "• Working (8s • esc to
  // interrupt)" above it.
  openai: {
    inputLine: /^[›▌]\s*(.*)$/,
    busy: [/esc to interrupt/i, /\bWorking\s*\(/],
    draftReadable: false,
  },
};

function markersFor(vendor: string): AgentInputMarkers | undefined {
  // Own keys only, so a value like "constructor" is not read off the prototype.
  return Object.hasOwn(AGENT_INPUT_MARKERS, vendor) ? AGENT_INPUT_MARKERS[vendor] : undefined;
}

function lastLines(tail: string): string[] {
  return stripAnsi(tail)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-BUSY_SCAN_LINES);
}

/**
 * The text on the agent's input line ("" when empty), or undefined when no
 * input line sits within the last {@link INPUT_LINE_WINDOW} lines. The last
 * match wins: earlier ones are user turns echoed in the transcript.
 */
function readInputLine(lines: readonly string[], markers: AgentInputMarkers): string | undefined {
  const window = lines.slice(-INPUT_LINE_WINDOW);
  for (let i = window.length - 1; i >= 0; i--) {
    const match = markers.inputLine.exec(window[i] ?? "");
    if (match !== null) return (match[1] ?? "").trim();
  }
  return undefined;
}

/**
 * What the agent in a pane is doing, read from the pane's output tail:
 *
 *  - `approval-prompt` whenever {@link looksLikePrompt} is true, for any
 *    vendor, checked first — a paste's Enter would answer the menu;
 *  - `busy` when a busy marker for `vendor` is in the last
 *    {@link BUSY_SCAN_LINES} non-empty lines, or the input line holds a
 *    draft the user is typing;
 *  - `idle-input` when the agent's input line is near the end of the tail
 *    (and, for Claude Code, empty);
 *  - `unknown` for a vendor with no markers, or no input line in view.
 *
 * Only `idle-input` permits a delivery.
 */
export function readAgentInputState(tail: string, vendor: string): AgentInputState {
  if (looksLikePrompt(stripAnsi(tail))) return "approval-prompt";
  const markers = markersFor(vendor);
  if (markers === undefined) return "unknown";
  const lines = lastLines(tail);
  if (lines.some((line) => markers.busy.some((marker) => marker.test(line)))) return "busy";
  const input = readInputLine(lines, markers);
  if (input === undefined) return "unknown";
  if (markers.draftReadable && input.length > 0) return "busy";
  return "idle-input";
}

/**
 * True iff the agent's input line, near the end of the tail, holds text the
 * user typed. Always false for an agent whose empty box shows a placeholder
 * (Codex) or whose vendor has no markers — callers must not read false as "empty"
 * there; {@link readAgentInputState} is the delivery gate.
 */
export function inputLineHasDraft(tail: string, vendor: string): boolean {
  const markers = markersFor(vendor);
  if (markers === undefined || !markers.draftReadable) return false;
  const input = readInputLine(lastLines(tail), markers);
  return input !== undefined && input.length > 0;
}
