import { looksLikePrompt, stripAnsi } from "./awaiting-input.js";

// What an agent's question looks like on a rendered screen, for the desktop
// chat to show as a card. This is stricter than readPrompt on purpose: the
// card sends keys, and a menu read wrongly sends them into the wrong choice.
// Only shapes a committed fixture or the phone's prompt tests prove are read;
// anything else that looks like a prompt is `unreadable`, and the chat then
// shows the pane's own terminal instead of guessing.
//
// Proven shapes:
//  - Claude Code's numbered permission menu, `❯` on the highlighted row
//    (fixture claude-approval, read-prompt tests), the command above it;
//  - Codex's numbered approval menu, `›` on the highlighted row, the command
//    between the question and the rows (fixture codex-approval);
//  - a `(y/n)` question and "Press Enter to continue" as the last line
//    (read-prompt tests).
// Not proven, so unreadable: checkbox rows and multi-question tab headers
// (kind "multi" exists for them, but nothing here returns it yet),
// descriptions under options, the folder-trust dialog, and any other vendor.

export type AgentMenuOption = {
  number: number;
  label: string;
  /** Exactly what to type to choose it. */
  keys: string;
  highlighted: boolean;
};

export type AgentMenu =
  | { kind: "single"; question: string; body?: string; options: AgentMenuOption[] }
  | {
      kind: "multi";
      question: string;
      body?: string;
      options: (AgentMenuOption & { checked: boolean })[];
    }
  | { kind: "unreadable" };

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";

const MAX_LINES = 60;
const NEAR = 12;
const LAST = 4;
const QUESTION_REACH = 15;
const BODY_REACH = 30;
const MAX_BODY_LINES = 80;
const MAX_BODY_CHARS = 8_000;
const MAX_ROWS = 9;

/** The pointer a vendor draws on the highlighted row. */
const POINTERS: Readonly<Record<string, string>> = { anthropic: "❯", openai: "›" };

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const RULE_LINE = /^[╭╰]?─{8,}[╮╯]?$/;
const SOLID_RULE = /^[─━]{8,}$/;
const DECORATION = /^[╌┄┈─━═│\s]{5,}$/;
const FOOTER = /^(?:press\s+)?(?:enter|esc|tab)\b|\b(?:esc|enter|tab) to\b/i;
const YES_NO = /\((y)\/(n)\)|\[(y)\/(n)\]/i;
const CONTINUE = /^press enter to continue\b/i;
/** A tick box in a row or a multi-question tab header: shapes no fixture proves. */
const UNPROVEN = /^\[[ x✓✔*]\]|^[☐☑☒✔]|[☐☑☒✔]|^←|→$/;
const ROW = /^(\S)?\s*(\d{1,2})\.\s+(\S.*)$/;

function isFooter(line: string): boolean {
  return line.length <= 120 && FOOTER.test(line);
}

function hasPointerRow(lines: readonly string[]): boolean {
  return lines.some((line) => /^[❯›▌>]\s*\d{1,2}\.\s/.test(line));
}

/** The vendor's empty-or-draft input line near the end: the agent is not asking. */
function hasInputLine(lines: readonly string[], vendor: string): boolean {
  const near = lines.slice(-6);
  if (vendor === "openai") return near.some((line) => /^›(?!\s*\d{1,2}\.)/.test(line));
  return near.some(
    (line, i) =>
      /^│?\s*[>❯](?!\s*\d{1,2}\.)(?:\s.*?)?\s*│?$/.test(line) &&
      RULE_LINE.test(near[i - 1] ?? "") &&
      RULE_LINE.test(near[i + 1] ?? ""),
  );
}

const UNREADABLE: AgentMenu = { kind: "unreadable" };

/**
 * The question a session is sitting at, read from its rendered screen.
 * Undefined when nothing is asking; `unreadable` when something is but its
 * shape is not one of the proven ones. Never throws.
 */
export function readAgentMenu(screen: string, vendor: string): AgentMenu | undefined {
  try {
    return read(screen, vendor);
  } catch {
    return undefined;
  }
}

function read(screen: string, vendor: string): AgentMenu | undefined {
  const lines = stripAnsi(screen)
    .replaceAll(CONTROL, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-MAX_LINES);
  const bottom = lines.slice(-NEAR);
  const live =
    looksLikePrompt(lines.slice(-LAST).join("\n")) ||
    (looksLikePrompt(bottom.join("\n")) && hasPointerRow(bottom));
  if (!live || hasInputLine(lines, vendor)) return undefined;

  const pointer = Object.hasOwn(POINTERS, vendor) ? POINTERS[vendor] : undefined;
  if (pointer === undefined) return UNREADABLE;

  return readNumbered(lines, pointer) ?? readQuestion(lines, bottom) ?? UNREADABLE;
}

/** A numbered menu: question, optional body, rows 1..n, optional footer. */
function readNumbered(lines: readonly string[], pointer: string): AgentMenu | undefined {
  let end = lines.length - 1;
  while (end >= 0 && isFooter(lines[end] ?? "")) end--;

  const rows: { number: number; label: string; highlighted: boolean }[] = [];
  let first = end + 1;
  for (let i = end; i >= 0; i--) {
    const match = ROW.exec(lines[i] ?? "");
    if (match === null) break;
    const mark = match[1];
    if (mark !== undefined && mark !== pointer) break;
    rows.unshift({
      number: Number(match[2]),
      label: (match[3] ?? "").trim(),
      highlighted: mark !== undefined,
    });
    first = i;
    if (rows.length > MAX_ROWS) return undefined;
  }
  if (rows.length < 2) return undefined;
  if (rows.some((row) => UNPROVEN.test(row.label))) return undefined;
  if (rows.some((row, index) => row.number !== index + 1)) return undefined;
  const highlighted = rows.filter((row) => row.highlighted);
  if (highlighted.length !== 1) return undefined;

  let questionAt = -1;
  for (let i = first - 1; i >= Math.max(0, first - QUESTION_REACH); i--) {
    const line = lines[i] ?? "";
    if (SOLID_RULE.test(line) || ROW.test(line)) break;
    if (line.endsWith("?")) {
      questionAt = i;
      break;
    }
  }
  if (questionAt === -1) return undefined;
  if (lines.slice(Math.max(0, questionAt - 3), first).some((line) => UNPROVEN.test(line))) {
    return undefined;
  }

  const current = highlighted[0]?.number ?? 1;
  const options = rows.map((row) => ({
    number: row.number,
    label: row.label,
    highlighted: row.highlighted,
    keys:
      (row.number > current ? DOWN.repeat(row.number - current) : UP.repeat(current - row.number)) +
      ENTER,
  }));
  const body = bodyOf(lines, questionAt, first);
  return {
    kind: "single",
    question: lines[questionAt] ?? "",
    ...(body !== undefined ? { body } : {}),
    options,
  };
}

/** Text between question and rows (Codex), else above the question back to a rule (Claude). */
function bodyOf(
  lines: readonly string[],
  questionAt: number,
  firstRow: number,
): string | undefined {
  let found = lines.slice(questionAt + 1, firstRow);
  if (found.length === 0) {
    let rule = -1;
    for (let i = questionAt - 1; i >= Math.max(0, questionAt - BODY_REACH); i--) {
      if (SOLID_RULE.test(lines[i] ?? "")) {
        rule = i;
        break;
      }
    }
    if (rule === -1) return undefined;
    found = lines.slice(rule + 1, questionAt);
  }
  const kept = found.filter((line) => !DECORATION.test(line)).slice(-MAX_BODY_LINES);
  if (kept.length === 0) return undefined;
  const text = kept.join("\n");
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}

/** A (y/n) question or "Press Enter to continue" as the very last line. */
function readQuestion(lines: readonly string[], bottom: readonly string[]): AgentMenu | undefined {
  const last = lines.at(-1) ?? "";
  // A highlighted row anywhere near means a menu this did not read: never
  // answer it with a bare Enter or a letter.
  if (hasPointerRow(bottom)) return undefined;
  if (YES_NO.test(last)) {
    return {
      kind: "single",
      question: last,
      options: [
        { number: 1, label: "Yes", keys: `y${ENTER}`, highlighted: false },
        { number: 2, label: "No", keys: `n${ENTER}`, highlighted: false },
      ],
    };
  }
  if (CONTINUE.test(last)) {
    return {
      kind: "single",
      question: last,
      options: [{ number: 1, label: "Enter", keys: ENTER, highlighted: false }],
    };
  }
  return undefined;
}
