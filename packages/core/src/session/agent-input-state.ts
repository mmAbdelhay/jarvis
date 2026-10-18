// "Idle at its input box" check for the Reviews delivery gate (spec §4.3):
// a pure marker read over a pane's output tail that says whether text can
// be pasted into the agent running there. This is the safety core — a
// wrong "idle-input" pastes into a busy agent or, worse, the trailing
// Enter answers an approval menu — so every doubt resolves to anything but
// "idle-input". A false "busy" only delays a delivery.
//
// The tail is a raw terminal stream with redraws in it: every spinner frame
// a turn drew is still in it once stripped. So "busy" is not "a spinner in
// the last N lines" — a todo list can push a live spinner far up — but "a
// busy marker after the last completed-turn marker". A spinner residue with
// no completed-turn line after it reads as busy, the safe direction.

import { looksLikePrompt, stripAnsi } from "./awaiting-input.js";

export type AgentInputState = "idle-input" | "approval-prompt" | "busy" | "unknown";

/** The most trailing non-empty lines ever scanned for busy markers. */
export const MAX_SCAN_LINES = 400;

/**
 * How close to the end the input line must be. Below the box sit only its
 * bottom rule and a status line or two; an input line further up than this
 * is history, not the box the agent is waiting at.
 */
export const INPUT_LINE_WINDOW = 6;

// A highlighted numbered menu row ("› 1. Yes, proceed (y)", "❯ 1. Yes"),
// any vendor. It starts with the same glyph as some composers, so it is
// checked before the input line and always means an approval menu.
const MENU_ROW = /^[›▌❯>]\s*\d+\.\s/;

type AgentInputMarkers = {
  /** Matches the agent's input line; group 1, when present, is its text. */
  inputLine: RegExp;
  /** Any of these after the last {@link finished} line means busy. */
  busy: readonly RegExp[];
  /** A line the agent prints when a turn ends (completed or interrupted). */
  finished: readonly RegExp[];
  /**
   * Input-line texts that are the empty box's placeholder, not a draft.
   * Exact matches only: anything else on the line is the user's draft.
   */
  placeholders: readonly string[];
};

// One entry per agent vendor (`AgentConfig.vendor`), not per agent id: ids
// are the user's config keys ("claude-mm", "claude-work") and any number of
// them run the same CLI. A vendor with no entry — or an agent with no
// vendor — is "unknown", never guessed idle.
export const AGENT_INPUT_MARKERS: Readonly<Record<string, AgentInputMarkers>> = {
  // anthropic — Claude Code: the input box is "> " between two rules (or
  // inside "│ … │" on older builds); while a turn runs a spinner line — one
  // of its glyphs, a gerund, "…", usually "(12s · esc to interrupt)" — sits
  // above it. A finished turn prints "✻ Worked for 18s" (no "…"); an
  // interrupted one "⎿  Interrupted · What should Claude do instead?". Its
  // first-run placeholder (`> Try "…"`) is left out on purpose: reading it
  // as a draft only delays.
  anthropic: {
    inputLine: /^│?\s*>(?:\s+(.*?))?\s*│?$/,
    busy: [/esc to interrupt/i, /^[·✢✳✶✻✽*]\s+\S.*…/],
    finished: [/^[·✢✳✶✻✽*]\s+[A-Za-z]+ for \d/, /^⎿\s+Interrupted\b/],
    placeholders: [],
  },
  // openai — Codex CLI: the composer is "› " (or "▌" on older builds) and
  // shows one of a fixed set of placeholders when empty; a running turn
  // shows "• Working (8s • esc to interrupt)" above it, a finished one a
  // "Worked for 1m 05s" separator, an interrupted one "■ Conversation
  // interrupted".
  openai: {
    inputLine: /^[›▌]\s*(.*)$/,
    busy: [/esc to interrupt/i, /\bWorking\s*\(/],
    finished: [/\bWorked for \d/, /conversation interrupted/i],
    placeholders: [
      "Ask Codex to do anything",
      "Explain this codebase",
      "Summarize recent commits",
      "Implement {feature}",
      "Find and fix a bug in @filename",
      "Write tests for @filename",
      "Improve documentation in @filename",
      "Run /review on my current changes",
      "Use /skills to list available skills",
    ],
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
    .slice(-MAX_SCAN_LINES);
}

type InputLine = { kind: "menu" } | { kind: "input"; draft: boolean };

/**
 * The agent's input line within the last {@link INPUT_LINE_WINDOW} lines,
 * walking up from the end: a highlighted menu row met first is a `menu`;
 * the first input line is the box (earlier ones are user turns echoed in
 * the transcript), a draft unless empty or a known placeholder. Undefined
 * when neither is in view.
 */
function readInputLine(
  lines: readonly string[],
  markers: AgentInputMarkers,
): InputLine | undefined {
  const window = lines.slice(-INPUT_LINE_WINDOW);
  for (let i = window.length - 1; i >= 0; i--) {
    const line = window[i] ?? "";
    if (MENU_ROW.test(line)) return { kind: "menu" };
    const match = markers.inputLine.exec(line);
    if (match === null) continue;
    const text = (match[1] ?? "").trim();
    return { kind: "input", draft: text.length > 0 && !markers.placeholders.includes(text) };
  }
  return undefined;
}

/** True iff a busy marker sits after the last completed-turn line. */
function turnRunning(lines: readonly string[], markers: AgentInputMarkers): boolean {
  let from = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (markers.finished.some((marker) => marker.test(line))) {
      from = i + 1;
      break;
    }
  }
  return lines.slice(from).some((line) => markers.busy.some((marker) => marker.test(line)));
}

/**
 * What the agent in a pane is doing, read from the pane's output tail:
 *
 *  - `approval-prompt` whenever {@link looksLikePrompt} is true, for any
 *    vendor, checked first — a paste's Enter would answer the menu — or when
 *    a highlighted numbered menu row sits where the input line would be;
 *  - `busy` when a busy marker for `vendor` comes after the last
 *    completed-turn line (the whole tail, up to {@link MAX_SCAN_LINES}
 *    lines, when there is none), or the input line holds a draft;
 *  - `idle-input` when the agent's empty input line is near the end;
 *  - `unknown` for a vendor with no markers, or no input line in view.
 *
 * Only `idle-input` permits a delivery.
 */
export function readAgentInputState(tail: string, vendor: string): AgentInputState {
  if (looksLikePrompt(stripAnsi(tail))) return "approval-prompt";
  const markers = markersFor(vendor);
  if (markers === undefined) return "unknown";
  const lines = lastLines(tail);
  const input = readInputLine(lines, markers);
  if (input?.kind === "menu") return "approval-prompt";
  if (turnRunning(lines, markers)) return "busy";
  if (input === undefined) return "unknown";
  return input.draft ? "busy" : "idle-input";
}

/**
 * True iff the agent's input line, near the end of the tail, holds text the
 * user typed (not empty, not the vendor's placeholder). False for a vendor
 * with no markers — callers must not read that as "empty";
 * {@link readAgentInputState} is the delivery gate.
 */
export function inputLineHasDraft(tail: string, vendor: string): boolean {
  const markers = markersFor(vendor);
  if (markers === undefined) return false;
  const input = readInputLine(lastLines(tail), markers);
  return input?.kind === "input" && input.draft;
}
