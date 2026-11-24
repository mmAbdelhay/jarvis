// What a coding agent's own status line shows on the pane's screen, and the
// usage limits among it — read from the bottom rows only, never guessed:
// a row that is not clearly the agent's status row is left out, and a screen
// the reader does not recognise (a menu is open, a redraw is half done) reads
// as nothing. Nothing here logs; a read never throws.

import { readAgentInputState, readAgentMenu, readPrompt, stripAnsi } from "@jarvis/core";
import type { AgentVendor } from "./agent-view.js";

export type AgentLimit = {
  label: string;
  usedPercent?: number;
  detail?: string;
  resets?: string;
};

export type AgentStatusLine = { lines: string[]; limits: AgentLimit[] };

export const STATUS_MAX_LINES = 6;
export const STATUS_MAX_CHARS = 300;
const MAX_LIMITS = 8;
const TAIL_ROWS = 40;

const EMPTY = (): AgentStatusLine => ({ lines: [], limits: [] });

/** The text without control characters (a newline is split on before this). */
function withoutControls(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    out += char;
  }
  return out;
}
// Block elements and the bar glyphs of a meter.
const METER_GLYPHS = /[▀-▟▰▱]/g;

function clean(row: string): string {
  return withoutControls(row.replace(/\t/g, " "))
    .replace(METER_GLYPHS, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The screen's last rows with escapes and controls gone, trailing blanks cut. */
function bottomRows(screen: string): string[] {
  const rows = stripAnsi(screen)
    .split("\n")
    .slice(-TAIL_ROWS)
    .map((row) => withoutControls(row.replace(/\t/g, " ")).replace(/\s+$/, ""));
  while (rows.length > 0 && rows[rows.length - 1]?.trim() === "") rows.pop();
  return rows;
}

function bounded(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const text = clean(line).slice(0, STATUS_MAX_CHARS);
    if (text !== "" && !out.includes(text)) out.push(text);
    if (out.length === STATUS_MAX_LINES) break;
  }
  return out;
}

const RULE = /^\s*─{10,}\s*$/;
const INPUT_ROW = /^\s*[>❯›]/;
const MODE_ROW =
  /^\s*(?:[⏸⏵⏯▶]|\? for shortcuts|esc to |shift\+tab|ctrl\+[a-z] to )|\(shift\+tab to cycle\)|for shortcuts\s*$/i;

/** The input box's opening and closing rules, or undefined without a box. */
function claudeBox(rows: string[]): { open: number; close: number } | undefined {
  let close = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (RULE.test(rows[i] as string)) {
      close = i;
      break;
    }
  }
  if (close < 1) return undefined;
  let open = -1;
  for (let i = close - 1; i >= 0 && i >= close - 12; i--) {
    if (RULE.test(rows[i] as string)) {
      open = i;
      break;
    }
  }
  if (open === -1 || !INPUT_ROW.test(rows[open + 1] ?? "")) return undefined;
  return { open, close };
}

/** Rows of the user's own statusline: between the box's closing rule and the mode row. */
function claudeLines(rows: string[]): string[] {
  const box = claudeBox(rows);
  if (box === undefined) return [];
  const out: string[] = [];
  for (const row of rows.slice(box.close + 1)) {
    if (MODE_ROW.test(row)) break;
    out.push(row);
  }
  return out;
}

const WINDOW_LABEL =
  /^(?:session|5\s?-?\s?h(?:ours?)?|5-hour|week(?:ly)?|7\s?-?\s?d(?:ays?)?|7-day)$/i;
const NOT_A_LIMIT = /\b(?:context|ctx|tokens?|compact)\b/i;

function percentOf(text: string): number | undefined {
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
}

/** One `label NN% [left] [resets X]` group, or undefined when it is not clearly a limit. */
function limitOf(segment: string): AgentLimit | undefined {
  const found = /^(.*?)\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)\s*%\s*(used|left|remaining)?\s*(.*)$/i.exec(
    segment,
  );
  if (found === null) return undefined;
  const label = (found[1] ?? "").replace(/[-:\s]+$/, "").trim();
  const value = percentOf(found[2] ?? "");
  if (label === "" || label.length > 24 || value === undefined || NOT_A_LIMIT.test(label)) {
    return undefined;
  }
  const resets = /\bresets?\s+(?:in\s+|at\s+)?(.{1,40})$/i.exec(found[4] ?? "")?.[1]?.trim();
  if (!WINDOW_LABEL.test(label) && resets === undefined) return undefined;
  const left = /^(?:left|remaining)$/i.test(found[3] ?? "");
  return {
    label,
    usedPercent: left ? 100 - value : value,
    ...(resets === undefined || resets === "" ? {} : { resets }),
  };
}

const NOTE =
  /^You['’]ve used (\d{1,3}(?:\.\d+)?)% of your ([\w -]{1,24}?) limit(?:\s*[·•-]\s*resets\s+(.{1,40}))?\s*$/i;

/** One key per usage window, so the CLI's "5-hour" and a statusline's "Session" are one. */
function windowKey(label: string): string {
  const text = label.toLowerCase().replace(/[\s-]/g, "");
  if (/^(session|5h|5hours?)$/.test(text)) return "5h";
  if (/^(week|weekly|7d|7days?)$/.test(text)) return "week";
  return text;
}

function claudeLimits(rows: string[]): AgentLimit[] {
  const box = claudeBox(rows);
  if (box === undefined) return [];
  const out: AgentLimit[] = [];
  const seen = new Set<string>();
  const add = (limit: AgentLimit): void => {
    const key = windowKey(limit.label);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(limit);
  };
  // Generic groups only from the user's own statusline rows.
  for (const row of claudeLines(rows)) {
    for (const segment of clean(row).split(/\s[│|¦]\s/)) {
      const limit = limitOf(segment.trim());
      if (limit !== undefined) add(limit);
    }
  }
  // The CLI's own note: the whole row, directly beside the box.
  const beside = [rows[box.open - 1], ...rows.slice(box.close + 1)];
  for (const row of beside) {
    const note = NOTE.exec(clean(row ?? ""));
    const used = percentOf(note?.[1] ?? "");
    if (note === null || used === undefined || note.index !== 0) continue;
    const resets = note[3]?.trim();
    add({
      label: (note[2] ?? "").trim(),
      usedPercent: used,
      ...(resets === undefined || resets === "" ? {} : { resets }),
    });
  }
  return out;
}

const CODEX_HINT = /for agents|for shortcuts|esc to |ctrl\+[a-z]|^\s*\?/i;

function codexLines(rows: string[]): string[] {
  let input = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^\s*›/.test(rows[i] as string)) {
      input = i;
      break;
    }
  }
  if (input === -1) return [];
  return rows.slice(input + 1).filter((row) => row.trim() !== "" && !CODEX_HINT.test(row));
}

const RUN_ON = /\s*(?:·\s*)?Run on:.*$/;
const PLAN = /Plan:\s*([\d,]+\/[\d,]+)\s*\((\d{1,3}(?:\.\d+)?)%\s*used\)/i;

function copilot(rows: string[]): AgentStatusLine {
  const bottom = rows.slice(-8);
  let below = -1;
  for (let i = bottom.length - 1; i >= 0; i--) {
    if (/open sidebar|\? help|\/ commands/.test(bottom[i] as string)) {
      below = i;
      break;
    }
  }
  if (below === -1) return EMPTY();
  let above = -1;
  for (let i = below - 1; i >= 0; i--) {
    if (/\[⎇[^\]]*\]|Plan:\s*[\d,]+\/[\d,]+/.test(bottom[i] as string)) {
      above = i;
      break;
    }
  }
  const lines: string[] = [];
  const limits: AgentLimit[] = [];
  if (above !== -1) {
    const row = (bottom[above] as string).replace(RUN_ON, "");
    lines.push(row);
    const plan = PLAN.exec(clean(row));
    const used = percentOf(plan?.[2] ?? "");
    if (plan !== null && used !== undefined) {
      limits.push({ label: "Plan", usedPercent: used, detail: plan[1] as string });
    }
  }
  const groups = (bottom[below] as string).trim().split(/ {2,}/);
  if (groups.length > 1) lines.push(groups[groups.length - 1] as string);
  return { lines, limits };
}

/** The agent's own status line and usage limits from its pane's screen. */
export function readAgentStatusLine(vendor: AgentVendor, screen: string): AgentStatusLine {
  try {
    if (vendor !== "anthropic" && vendor !== "openai" && vendor !== "github") return EMPTY();
    const rows = bottomRows(typeof screen === "string" ? screen : "");
    if (rows.length === 0) return EMPTY();
    const tail = rows.join("\n");
    if (
      readAgentMenu(tail, vendor) !== undefined ||
      readPrompt(tail) !== undefined ||
      readAgentInputState(tail, vendor) === "approval-prompt"
    ) {
      return EMPTY();
    }
    if (vendor === "github") {
      const out = copilot(rows);
      return { lines: bounded(out.lines), limits: out.limits.slice(0, MAX_LIMITS) };
    }
    if (vendor === "openai") return { lines: bounded(codexLines(rows)), limits: [] };
    return {
      lines: bounded(claudeLines(rows)),
      limits: claudeLimits(rows).slice(0, MAX_LIMITS),
    };
  } catch {
    return EMPTY();
  }
}
