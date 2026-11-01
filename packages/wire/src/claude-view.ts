// The phone's chat view of a Terminal pane running Claude Code: the
// transcript's recent turns plus what the pane's screen shows right now
// (prompt, mode, spinner). `ChatTurn`/`ChatTool` mirror platform's own
// (packages/platform/src/session-import.ts) field for field — wire cannot
// import them (no-node-imports.test.ts), so the assignability check lives in
// packages/desktop/src/wire-claude-view-dto.test.ts.

export type ChatTool = { name: string; target?: string; added?: number; removed?: number };

export type ChatTurn = { role: "user" | "assistant"; text: string; tools: ChatTool[] };

/** A pending Claude Code prompt as the pane shows it. `keys` is display
 *  data only: terminal:answer re-reads the screen and types its own. */
export type ClaudePrompt = { question: string; options: { label: string; keys: string }[] };

export type ClaudeMode = "default" | "auto" | "plan" | "acceptEdits";

export type ClaudeView =
  | { kind: "none" }
  | {
      kind: "claude";
      sessionId: string;
      title?: string;
      model?: string;
      mode?: ClaudeMode;
      turns: ChatTurn[];
      prompt?: ClaudePrompt;
      working?: string;
    };

/** terminal:answer's reply. `gone`: the pane is at no prompt; `changed`:
 *  the option at that index no longer has that label. */
export type ClaudeAnswerResult = { ok: true } | { ok: false; reason: "gone" | "changed" };

export const CLAUDE_VIEW_CHANNEL = "terminal:claudeView";
export const CLAUDE_ANSWER_CHANNEL = "terminal:answer";
/** Push, keyed by paneKey; payload `{ paneKey }`. Says "re-fetch", nothing more. */
export const CLAUDE_VIEW_CHANGED = "terminal:claudeViewChanged";

const NONE: ClaudeView = { kind: "none" };
const MODES: readonly string[] = ["default", "auto", "plan", "acceptEdits"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optional(value: unknown, type: "string" | "number"): boolean {
  return value === undefined || typeof value === type;
}

function parseTool(raw: unknown): ChatTool | undefined {
  if (!isRecord(raw) || typeof raw["name"] !== "string") return undefined;
  const { target, added, removed } = raw;
  if (!optional(target, "string") || !optional(added, "number") || !optional(removed, "number")) {
    return undefined;
  }
  return {
    name: raw["name"],
    ...(typeof target === "string" ? { target } : {}),
    ...(typeof added === "number" ? { added } : {}),
    ...(typeof removed === "number" ? { removed } : {}),
  };
}

function parseTurn(raw: unknown): ChatTurn | undefined {
  if (!isRecord(raw)) return undefined;
  const { role, text, tools } = raw;
  if ((role !== "user" && role !== "assistant") || typeof text !== "string") return undefined;
  if (!Array.isArray(tools)) return undefined;
  const parsed = tools.map(parseTool);
  if (parsed.some((tool) => tool === undefined)) return undefined;
  return { role, text, tools: parsed as ChatTool[] };
}

function parsePrompt(raw: unknown): ClaudePrompt | undefined {
  if (!isRecord(raw) || typeof raw["question"] !== "string") return undefined;
  const options = raw["options"];
  if (!Array.isArray(options)) return undefined;
  const parsed: ClaudePrompt["options"] = [];
  for (const option of options) {
    if (!isRecord(option)) return undefined;
    const { label, keys } = option;
    if (typeof label !== "string" || typeof keys !== "string") return undefined;
    parsed.push({ label, keys });
  }
  return { question: raw["question"], options: parsed };
}

/** The host's reply, checked field by field and rebuilt with only known
 *  fields. Anything malformed — at any depth — is `{ kind: "none" }`. */
export function parseClaudeView(raw: unknown): ClaudeView {
  if (!isRecord(raw)) return NONE;
  if (raw["kind"] !== "claude") return NONE;
  const { sessionId, title, model, mode, turns, prompt, working } = raw;
  if (typeof sessionId !== "string" || !Array.isArray(turns)) return NONE;
  if (!optional(title, "string") || !optional(model, "string") || !optional(working, "string")) {
    return NONE;
  }
  if (mode !== undefined && (typeof mode !== "string" || !MODES.includes(mode))) return NONE;
  const parsedTurns = turns.map(parseTurn);
  if (parsedTurns.some((turn) => turn === undefined)) return NONE;
  const parsedPrompt = prompt === undefined ? undefined : parsePrompt(prompt);
  if (prompt !== undefined && parsedPrompt === undefined) return NONE;
  return {
    kind: "claude",
    sessionId,
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(mode !== undefined ? { mode: mode as ClaudeMode } : {}),
    turns: parsedTurns as ChatTurn[],
    ...(parsedPrompt !== undefined ? { prompt: parsedPrompt } : {}),
    ...(typeof working === "string" ? { working } : {}),
  };
}
