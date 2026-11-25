import { basename } from "node:path";
import { stripAnsi } from "@jarvis/core";
import {
  INJECTED_PREFIXES,
  argumentsTarget,
  asRecord,
  commandTarget,
  partsText,
} from "./agent-chat.js";
import {
  chatTool,
  claudeConversationRecord,
  claudeRecordModel,
  isLocalCommandNoise,
  readableCommand,
} from "./session-import.js";

/**
 * The desktop chat's document: a transcript as ordered items (messages and
 * tool calls in the order they happened) plus what the side panel derives
 * from the whole session — to-dos, sub-agents, changed files, context.
 *
 * It sits beside the phone's turn parsers (parseChatTranscript, parseCopilotChat,
 * parseCodexChat), which it leaves alone. The two share their rules by
 * importing them, never by copying: which Claude records are conversation,
 * how a slash command reads, what a tool's target is.
 *
 * Each vendor has an incremental reader: push() takes text as it arrives (a
 * record may be split across chunks, the first line may be a cut-off tail),
 * doc() reads the result. Memory is bounded: items beyond `maxItems` drop,
 * while the derived to-dos, sub-agents and files keep what they saw.
 */

export type ChatDiffLine = { sign: " " | "+" | "-"; text: string };

/** A message. `images` counts pictures sent with it, never their bytes. */
export type ChatMessageItem = {
  id: string;
  kind: "user" | "text";
  text: string;
  images?: number;
  at?: number;
};

/**
 * A marker between items. It carries no words: the renderer translates the
 * event. `label` is only ever a sub-agent's own label.
 */
export type ChatDividerItem = {
  id: string;
  kind: "divider";
  event: "compacted" | "interrupted" | "agentDone";
  label?: string;
  at?: number;
};

export type ChatToolItem = {
  id: string;
  kind: "tool";
  tool: string;
  target?: string;
  command?: string;
  path?: string;
  input?: { key: string; value: string }[];
  diff?: ChatDiffLine[];
  output?: string;
  outputCut?: boolean;
  /** A TodoWrite row: how many of its items are done, when its input says so. */
  progress?: { done: number; total: number };
  /** `ended`: no result was ever recorded, so how it finished is unknown. */
  state: "running" | "ok" | "error" | "ended";
  at?: number;
  endAt?: number;
};

export type ChatItem = ChatMessageItem | ChatDividerItem | ChatToolItem;
export type ChatTodo = { text: string; state: "done" | "active" | "open" };
export type ChatAgent = {
  id: string;
  label: string;
  state: "running" | "done" | "failed";
  startedAt?: number;
  endedAt?: number;
};
/** Lines changed are present only where the transcript lets them be counted. */
export type ChatFile = { path: string; added?: number; removed?: number };

/** A question or plan the agent is waiting on, as the transcript records it. */
export type ChatAsking = {
  id: string;
  tool: "AskUserQuestion" | "ExitPlanMode";
  questions?: {
    question: string;
    header?: string;
    multiSelect: boolean;
    options: { label: string; description?: string }[];
  }[];
  plan?: string;
};

/** A usage window the agent reported (Codex's rate limits). `resetsAt` is epoch
 *  seconds; whether it has passed is for the reader of the document to judge. */
export type ChatLimit = { label: string; usedPercent: number; resetsAt?: number };

export type ChatDoc = {
  asking?: ChatAsking;
  /** Desktop only: the phone's output never carries it. */
  limits?: ChatLimit[];
  items: ChatItem[];
  model?: string;
  contextTokens?: number;
  todos?: ChatTodo[];
  agents: ChatAgent[];
  files: ChatFile[];
};

export type ChatDocReader = {
  /** Feeds the next text of the transcript, whatever its chunking. */
  push(chunk: string): void;
  /** The document so far; an independent copy. */
  doc(): ChatDoc;
};

export type ChatDocOptions = { maxItems?: number };

export const DEFAULT_MAX_ITEMS = 5_000;
export const MAX_TEXT_CHARS = 64 * 1024;
export const MAX_OUTPUT_LINES = 200;
export const MAX_OUTPUT_CHARS = 32 * 1024;
export const MAX_DIFF_LINES = 400;
const MAX_COMMAND_CHARS = 8 * 1024;
const MAX_PAIR_CHARS = 200;
const MAX_PAIRS = 6;
const MAX_AGENTS = 100;
const MAX_FILES = 500;
/** A record longer than this without a newline is dropped, not buffered. */
const MAX_LINE_CHARS = 8 * 1024 * 1024;

// ---------------------------------------------------------------- helpers

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/** ANSI and control characters out (newline and tab stay), cut at `max`. */
function clean(text: string, max = MAX_TEXT_CHARS): string {
  const plain = stripAnsi(text).replaceAll(CONTROL, "");
  return plain.length > max ? plain.slice(0, max) : plain;
}

function cleanOutput(text: string): { text: string; cut: boolean } {
  const plain = clean(text, MAX_OUTPUT_CHARS + 1);
  const lines = plain.split("\n");
  let out = lines.length > MAX_OUTPUT_LINES ? lines.slice(0, MAX_OUTPUT_LINES).join("\n") : plain;
  const cut = out.length < plain.length || plain.length > MAX_OUTPUT_CHARS;
  if (out.length > MAX_OUTPUT_CHARS) out = out.slice(0, MAX_OUTPUT_CHARS);
  return { text: out, cut };
}

function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** FNV-1a: an id for a record that carries none, equal for equal text. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function lineCount(value: unknown): number {
  if (typeof value !== "string" || value === "") return 0;
  const lines = value.split("\n").length;
  return value.endsWith("\n") ? lines - 1 : lines;
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function diffOf(removed: unknown, added: unknown): ChatDiffLine[] {
  const diff: ChatDiffLine[] = [];
  if (typeof removed === "string" && removed !== "") {
    for (const text of splitLines(removed)) diff.push({ sign: "-", text: clean(text, 2000) });
  }
  if (typeof added === "string" && added !== "") {
    for (const text of splitLines(added)) diff.push({ sign: "+", text: clean(text, 2000) });
  }
  return diff.slice(0, MAX_DIFF_LINES);
}

/** Short scalar pairs of a tool's input, minus what has its own field. */
const INPUT_SKIP = new Set([
  "command",
  "file_path",
  "path",
  "content",
  "old_string",
  "new_string",
  "edits",
  "todos",
  "plan",
  "prompt",
]);

function inputPairs(input: Record<string, unknown> | undefined): { key: string; value: string }[] {
  const pairs: { key: string; value: string }[] = [];
  if (input === undefined) return pairs;
  for (const [key, value] of Object.entries(input)) {
    if (INPUT_SKIP.has(key)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      continue;
    }
    const text = clean(String(value), MAX_PAIR_CHARS).replaceAll(/\s+/g, " ").trim();
    if (text === "") continue;
    pairs.push({ key, value: text });
    if (pairs.length === MAX_PAIRS) break;
  }
  return pairs;
}

function todoState(status: unknown): ChatTodo["state"] | undefined {
  if (status === "completed" || status === "done") return "done";
  if (status === "in_progress" || status === "active") return "active";
  if (status === "pending" || status === "open") return "open";
  return undefined;
}

// ------------------------------------------------------------ the store

type Store = {
  items: ChatItem[];
  toolById: Map<string, ChatToolItem>;
  add(item: ChatItem): void;
  doc(extra: Omit<ChatDoc, "items">): ChatDoc;
};

function createStore(maxItems: number): Store {
  const items: ChatItem[] = [];
  const toolById = new Map<string, ChatToolItem>();
  return {
    items,
    toolById,
    add(item) {
      items.push(item);
      if (item.kind === "tool") toolById.set(item.id, item);
      if (items.length > maxItems + 256) {
        for (const dropped of items.splice(0, items.length - maxItems)) {
          if (dropped.kind === "tool" && toolById.get(dropped.id) === dropped) {
            toolById.delete(dropped.id);
          }
        }
      }
    },
    doc(extra) {
      const kept = items.slice(-maxItems);
      // A call with no result once the conversation moved on (any later
      // message) is settled, not running: its result was never written.
      let lastMessage = -1;
      for (let i = kept.length - 1; i >= 0; i--) {
        if (kept[i]?.kind !== "tool") {
          lastMessage = i;
          break;
        }
      }
      const settled = kept.map((item, i) =>
        item.kind === "tool" && item.state === "running" && i < lastMessage
          ? { ...item, state: "ended" as const }
          : { ...item },
      );
      return { items: settled, ...extra };
    },
  };
}

/** Text and chunk handling shared by the three readers. */
function createReader(
  handle: (record: Record<string, unknown>, line: string) => void,
  build: () => ChatDoc,
): ChatDocReader {
  // The unfinished last line is kept as parts and joined only when it ends,
  // so a long record arriving in small chunks is never re-split or re-read.
  let parts: string[] = [];
  let length = 0;
  let consumed = false;
  let skipping = false;
  const run = (line: string): void => {
    if (line.trim() === "") return;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return; // a cut-off first line, or one still being written
    }
    const fields = asRecord(record);
    if (fields === undefined) return;
    try {
      handle(fields, line);
    } catch {
      // One odd record is not a reason to lose the rest.
    }
  };
  return {
    push(chunk) {
      let text = chunk;
      if (skipping) {
        const at = text.indexOf("\n");
        if (at === -1) return;
        skipping = false;
        text = text.slice(at + 1);
      }
      let start = 0;
      for (;;) {
        const end = text.indexOf("\n", start);
        if (end === -1) break;
        const line =
          parts.length === 0 ? text.slice(start, end) : parts.join("") + text.slice(start, end);
        parts = [];
        length = 0;
        if (consumed) consumed = false;
        else run(line);
        start = end + 1;
      }
      const rest = start === 0 ? text : text.slice(start);
      if (rest !== "") {
        parts.push(rest);
        length += rest.length;
        if (length > MAX_LINE_CHARS) {
          parts = [];
          length = 0;
          consumed = false;
          skipping = true;
        }
      }
    },
    doc() {
      // A last record with no newline yet that is already whole is read now;
      // a partial object never parses, and it is not read again at its newline.
      if (!consumed && length > 0 && (parts.at(-1) ?? "").trimEnd().endsWith("}")) {
        const joined = parts.join("");
        parts = [joined];
        try {
          JSON.parse(joined);
          run(joined);
          consumed = true;
        } catch {
          // still partial
        }
      }
      return build();
    },
  };
}

function windowLabel(minutes: number): string {
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "week";
  if (minutes === 43200) return "30 days";
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

/** Codex's token_count rate_limits: primary and secondary, either may be null. */
function codexLimits(rate: unknown): ChatLimit[] | undefined {
  const record = asRecord(rate);
  if (record === undefined) return undefined;
  const out: ChatLimit[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = asRecord(record[key]);
    const used = window?.["used_percent"];
    const minutes = window?.["window_minutes"];
    if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || used > 100) continue;
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0) continue;
    const resets = window?.["resets_at"];
    out.push({
      label: windowLabel(minutes),
      usedPercent: used,
      ...(typeof resets === "number" && Number.isFinite(resets) && resets > 0
        ? { resetsAt: resets }
        : {}),
    });
  }
  return out;
}

function withOptional(
  doc: ChatDoc,
  model: string | undefined,
  tokens: number | undefined,
  todos: ChatTodo[] | undefined,
): ChatDoc {
  if (model !== undefined) doc.model = model;
  if (tokens !== undefined) doc.contextTokens = tokens;
  if (todos !== undefined) doc.todos = todos;
  return doc;
}

function addMessage(
  store: Store,
  id: string,
  kind: ChatMessageItem["kind"],
  text: string,
  at: number | undefined,
  images?: number,
): void {
  store.add({
    id,
    kind,
    text,
    ...(images !== undefined && images > 0 ? { images } : {}),
    ...(at !== undefined ? { at } : {}),
  });
}

function addDivider(
  store: Store,
  id: string,
  event: ChatDividerItem["event"],
  at: number | undefined,
  label?: string,
): void {
  store.add({
    id,
    kind: "divider",
    event,
    ...(label !== undefined ? { label } : {}),
    ...(at !== undefined ? { at } : {}),
  });
}

function newTool(
  id: string,
  tool: string,
  at: number | undefined,
  parts: Partial<ChatToolItem>,
): ChatToolItem {
  return {
    id,
    kind: "tool",
    tool,
    state: "running",
    ...(at !== undefined ? { at } : {}),
    ...parts,
  };
}

/** Changed files, counted per path; a failed edit's share is taken back. */
function createFiles() {
  const files = new Map<string, { added?: number; removed?: number }>();
  const shares = new Map<string, { path: string; added: number; removed: number }>();
  return {
    touch(path: string, added?: number, removed?: number, callId?: string) {
      const current = files.get(path) ?? {};
      if (added !== undefined) current.added = (current.added ?? 0) + added;
      if (removed !== undefined) current.removed = (current.removed ?? 0) + removed;
      files.set(path, current);
      if (callId !== undefined && added !== undefined && removed !== undefined) {
        shares.set(callId, { path, added, removed });
        if (shares.size > 1000) shares.delete(shares.keys().next().value as string);
      }
      if (files.size > MAX_FILES) files.delete(files.keys().next().value as string);
    },
    undo(callId: string) {
      const share = shares.get(callId);
      if (share === undefined) return;
      shares.delete(callId);
      const current = files.get(share.path);
      if (current === undefined) return;
      current.added = (current.added ?? 0) - share.added;
      current.removed = (current.removed ?? 0) - share.removed;
      if ((current.added ?? 0) <= 0 && (current.removed ?? 0) <= 0) files.delete(share.path);
    },
    list(): ChatFile[] {
      return [...files].map(([path, counts]) => ({ path, ...counts }));
    },
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const fields = asRecord(block);
    if (fields !== undefined && fields["type"] === "text" && typeof fields["text"] === "string") {
      parts.push(fields["text"]);
    }
  }
  return parts.join("\n");
}

function setOutput(tool: ChatToolItem, raw: string): void {
  if (raw === "") return;
  const out = cleanOutput(raw);
  tool.output = out.text;
  if (out.cut) tool.outputCut = true;
}

// ----------------------------------------------------------------- Claude

function claudeTodos(input: unknown): ChatTodo[] | undefined {
  const fields = asRecord(input);
  const list = fields?.["todos"];
  if (!Array.isArray(list)) return undefined;
  const todos: ChatTodo[] = [];
  for (const entry of list) {
    const item = asRecord(entry);
    const text = str(item?.["content"]) ?? str(item?.["subject"]);
    const state = todoState(item?.["status"]);
    if (text !== undefined && state !== undefined) {
      todos.push({ text: clean(text, 500), state });
    }
  }
  return todos;
}

function claudeDiff(name: string, input: Record<string, unknown>): ChatDiffLine[] | undefined {
  if (name === "Edit") return diffOf(input["old_string"], input["new_string"]);
  if (name === "Write") return diffOf(undefined, input["content"]);
  if (name === "MultiEdit" && Array.isArray(input["edits"])) {
    const diff: ChatDiffLine[] = [];
    for (const edit of input["edits"]) {
      const fields = asRecord(edit);
      if (fields !== undefined) diff.push(...diffOf(fields["old_string"], fields["new_string"]));
    }
    return diff.slice(0, MAX_DIFF_LINES);
  }
  return undefined;
}

function patchDiff(patch: unknown): ChatDiffLine[] | undefined {
  if (!Array.isArray(patch)) return undefined;
  const diff: ChatDiffLine[] = [];
  for (const hunk of patch) {
    const lines = asRecord(hunk)?.["lines"];
    if (!Array.isArray(lines)) continue;
    if (diff.length > 0) diff.push({ sign: " ", text: "…" });
    for (const raw of lines) {
      if (typeof raw !== "string" || raw === "") continue;
      const sign = raw[0];
      if (sign !== " " && sign !== "+" && sign !== "-") continue;
      diff.push({ sign, text: clean(raw.slice(1), 2000) });
    }
  }
  return diff.length === 0 ? undefined : diff.slice(0, MAX_DIFF_LINES);
}

function askingOf(
  id: string,
  tool: ChatAsking["tool"],
  input: Record<string, unknown> | undefined,
): ChatAsking | undefined {
  if (tool === "ExitPlanMode") {
    const plan = str(input?.["plan"]);
    return plan === undefined ? undefined : { id, tool, plan: clean(plan) };
  }
  const list = input?.["questions"];
  if (!Array.isArray(list)) return undefined;
  const questions: NonNullable<ChatAsking["questions"]> = [];
  for (const entry of list.slice(0, 10)) {
    const fields = asRecord(entry);
    const question = str(fields?.["question"]);
    if (fields === undefined || question === undefined) continue;
    const options: { label: string; description?: string }[] = [];
    const raw = fields["options"];
    for (const option of Array.isArray(raw) ? raw.slice(0, 10) : []) {
      const optionFields = asRecord(option);
      const label = str(optionFields?.["label"]);
      if (label === undefined) continue;
      const description = str(optionFields?.["description"]);
      options.push({
        label: clean(label, 200),
        ...(description !== undefined ? { description: clean(description, 500) } : {}),
      });
    }
    const header = str(fields["header"]);
    questions.push({
      question: clean(question, 1000),
      ...(header !== undefined ? { header: clean(header, 100) } : {}),
      multiSelect: fields["multiSelect"] === true,
      options,
    });
  }
  return questions.length === 0 ? undefined : { id, tool, questions };
}

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const NOTIFICATION = /<task-notification>[\s\S]*?<\/task-notification>/g;

/**
 * What a user record's text really is. Injected text (system reminders, a
 * task notification, local-command output) is never the user's words; an
 * interruption becomes a divider. Undefined when nothing is left.
 */
function userText(
  raw: string,
  onNotification: (notification: string) => void,
): { text: string; interrupted: boolean } | undefined {
  for (const found of raw.matchAll(NOTIFICATION)) onNotification(found[0]);
  const text = raw.replaceAll(NOTIFICATION, "").replaceAll(REMINDER, "").trim();
  if (text === "" || isLocalCommandNoise(text)) return undefined;
  if (text.startsWith("[Request interrupted by user")) return { text: "", interrupted: true };
  const words = readableCommand(text).trim();
  return words === "" ? undefined : { text: words, interrupted: false };
}

export function createClaudeDocReader(options: ChatDocOptions = {}): ChatDocReader {
  const store = createStore(options.maxItems ?? DEFAULT_MAX_ITEMS);
  const files = createFiles();
  const agents: ChatAgent[] = [];
  const agentById = new Map<string, ChatAgent>();
  let model: string | undefined;
  let tokens: number | undefined;
  let written: ChatTodo[] | undefined;
  // Tasks in creation order; `num` is the id the CLI printed in the result.
  const tasks: { todo: ChatTodo | null; callId: string; num?: number }[] = [];
  const background = new Set<string>();
  let asking: ChatAsking | undefined;
  let todoSource: "write" | "tasks" | undefined;

  const call = (block: Record<string, unknown>, fallbackId: string, at: number | undefined) => {
    const name = str(block["name"]) ?? "tool";
    const id = str(block["id"]) ?? fallbackId;
    const input = asRecord(block["input"]);
    const shaped = chatTool(name, input);
    const parts: Partial<ChatToolItem> = {};
    if (shaped.target !== undefined) parts.target = clean(shaped.target, 400);
    // An agent row names its job, not just "Task"; a to-do row counts what is done.
    if ((name === "Task" || name === "Agent") && parts.target === undefined) {
      const description = str(input?.["description"]);
      if (description !== undefined && description.trim() !== "")
        parts.target = clean(description, 400);
    }
    if (name === "TodoWrite") {
      const list = claudeTodos(input);
      if (list !== undefined && list.length > 0)
        parts.progress = {
          done: list.filter((todo) => todo.state === "done").length,
          total: list.length,
        };
    }
    const command = str(input?.["command"]);
    if (command !== undefined) parts.command = clean(command, MAX_COMMAND_CHARS);
    const path = str(input?.["file_path"]) ?? str(input?.["path"]);
    if (path !== undefined) parts.path = path;
    // A question or plan row names what it asks, never a bare tool name.
    if (name === "AskUserQuestion" || name === "ExitPlanMode") {
      const asked = askingOf(id, name, input);
      const title =
        name === "ExitPlanMode"
          ? asked?.plan
              ?.split("\n")
              .map((row) => row.replace(/^[#>*\s-]+/, "").trim())
              .find((row) => row !== "")
          : asked?.questions?.[0]?.question;
      if (title !== undefined) parts.target = clean(title, 400);
    }
    const pairs = inputPairs(input);
    if (pairs.length > 0) parts.input = pairs;
    if (input !== undefined) {
      const diff = claudeDiff(name, input);
      if (diff !== undefined && diff.length > 0) parts.diff = diff;
    }
    store.add(newTool(id, name, at, parts));

    if (name === "AskUserQuestion" || name === "ExitPlanMode") asking = askingOf(id, name, input);
    if (name === "TodoWrite") {
      const todos = claudeTodos(input);
      if (todos !== undefined) {
        written = todos;
        todoSource = "write";
      }
    } else if (name === "TaskCreate") {
      const subject = str(input?.["subject"]) ?? str(input?.["description"]);
      if (subject !== undefined) {
        tasks.push({ todo: { text: clean(subject, 500), state: "open" }, callId: id });
        todoSource = "tasks";
      }
    } else if (name === "TaskUpdate") {
      const wanted = Number(input?.["taskId"]);
      const byNumber = tasks.find((task) => task.num === wanted);
      const byOrder = tasks[wanted - 1];
      const task = byNumber ?? (byOrder?.num === undefined ? byOrder : undefined);
      if (task?.todo != null) {
        const status = input?.["status"];
        if (status === "deleted") task.todo = null;
        else {
          const state = todoState(status);
          if (state !== undefined) task.todo.state = state;
          const subject = str(input?.["subject"]);
          if (subject !== undefined) task.todo.text = clean(subject, 500);
        }
        todoSource = "tasks";
      }
    } else if (name === "Task" || name === "Agent") {
      const label = str(input?.["description"]) ?? str(input?.["subagent_type"]) ?? "agent";
      const agent: ChatAgent = {
        id,
        label: clean(label, 120),
        state: "running",
        ...(at !== undefined ? { startedAt: at } : {}),
      };
      agents.push(agent);
      agentById.set(id, agent);
      if (agents.length > MAX_AGENTS) {
        const dropped = agents.shift();
        if (dropped !== undefined) agentById.delete(dropped.id);
      }
    } else if (
      (name === "Edit" || name === "MultiEdit" || name === "Write") &&
      path !== undefined
    ) {
      files.touch(path, shaped.added ?? 0, shaped.removed ?? 0, id);
    }
  };

  const result = (
    block: Record<string, unknown>,
    at: number | undefined,
    meta: Record<string, unknown> | undefined,
  ): void => {
    const patch = meta?.["structuredPatch"];
    if (asking?.id === str(block["tool_use_id"])) asking = undefined;
    const id = str(block["tool_use_id"]);
    if (id === undefined) return;
    const failed = block["is_error"] === true;
    const tool = store.toolById.get(id);
    if (tool !== undefined) {
      tool.state = failed ? "error" : "ok";
      if (at !== undefined) tool.endAt = at;
      setOutput(tool, toolResultText(block["content"]));
      const diff = patchDiff(patch);
      if (diff !== undefined && !failed) tool.diff = diff;
    }
    const task = tasks.find((entry) => entry.callId === id);
    if (task !== undefined) {
      const number = /#(\d+)/.exec(toolResultText(block["content"]));
      if (number?.[1] !== undefined) task.num = Number(number[1]);
    }
    const agent = agentById.get(id);
    if (agent !== undefined) {
      // A background agent's result only says it started.
      if (meta?.["status"] === "async_launched" || meta?.["isAsync"] === true) {
        background.add(id);
      } else {
        agent.state = failed ? "failed" : "done";
        if (at !== undefined) agent.endedAt = at;
      }
    }
    if (failed) files.undo(id);
  };

  /**
   * A notification the CLI wrote beside the conversation rather than as a
   * user turn (it does that when the agent ends mid-turn): a queued_command
   * attachment, or a queue-operation enqueue. Only the end of a background
   * agent is taken from it; nothing becomes an item.
   */
  const queuedNotifications = (record: Record<string, unknown>, line: string): boolean => {
    const type = record["type"];
    let raw: string | undefined;
    if (type === "attachment") {
      const attachment = asRecord(record["attachment"]);
      if (attachment?.["type"] !== "queued_command") return false;
      const prompt = attachment["prompt"];
      if (typeof prompt === "string") raw = prompt;
      else if (Array.isArray(prompt)) {
        raw = prompt
          .map((part) => {
            const text = asRecord(part)?.["text"];
            return typeof text === "string" ? text : "";
          })
          .join("\n");
      }
    } else if (type === "queue-operation") {
      if (record["operation"] !== "enqueue") return false;
      if (typeof record["content"] === "string") raw = record["content"];
    } else return false;
    if (record["isSidechain"] === true) return true;
    if (raw === undefined || !raw.includes("<task-notification>")) return true;
    const at = timeOf(record["timestamp"]);
    const uuid = str(record["uuid"]) ?? `h${hash(line)}`;
    let index = 0;
    for (const found of raw.matchAll(NOTIFICATION)) {
      endAgent(found[0], `q${uuid}`, index, at);
      index += 1;
    }
    return true;
  };

  const handle = (record: Record<string, unknown>, line: string): void => {
    if (queuedNotifications(record, line)) return;
    const found = claudeConversationRecord(record);
    if (found === undefined) return;
    const { role, fields, body } = found;
    if (fields["isSidechain"] === true) return;
    const at = timeOf(fields["timestamp"]);
    const uuid = str(fields["uuid"]) ?? `h${hash(line)}`;
    const next = claudeRecordModel(role, body);
    if (next !== undefined) model = next;
    if (role === "assistant") {
      const usage = asRecord(body["usage"]);
      if (usage !== undefined && next !== undefined) {
        const total = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
          .map((key) => (typeof usage[key] === "number" ? (usage[key] as number) : 0))
          .reduce((a, b) => a + b, 0);
        if (total > 0) tokens = total;
      }
    }
    if (role === "user" && fields["isCompactSummary"] === true) {
      addDivider(store, `${uuid}:0`, "compacted", at);
      return;
    }
    const kind = role === "user" ? "user" : "text";
    const raw = body["content"];
    const content = typeof raw === "string" ? [{ type: "text", text: raw }] : raw;
    if (!Array.isArray(content)) return;
    const meta = asRecord(fields["toolUseResult"]);
    const results = content.filter((b) => asRecord(b)?.["type"] === "tool_result").length;
    const firstImage = content.findIndex((b) => asRecord(b)?.["type"] === "image");
    let images =
      role === "user" ? content.filter((b) => asRecord(b)?.["type"] === "image").length : 0;
    const message = (index: number, text: string): void => {
      asking = undefined;
      addMessage(store, `${uuid}:${index}`, kind, clean(text), at, images);
      images = 0;
    };
    content.forEach((item, index) => {
      const block = asRecord(item);
      if (block === undefined) return;
      const type = block["type"];
      if (type === "text" && typeof block["text"] === "string") {
        if (role === "assistant") {
          const text = readableCommand(block["text"]).trim();
          if (text !== "") message(index, text);
          return;
        }
        const text = userText(block["text"], (note) => endAgent(note, uuid, index, at));
        if (text === undefined) return;
        if (text.interrupted) addDivider(store, `${uuid}:${index}`, "interrupted", at);
        else message(index, text.text);
      } else if (type === "tool_use" && role === "assistant") {
        call(block, `${uuid}:${index}`, at);
      } else if (type === "tool_result") {
        result(block, at, results === 1 ? meta : undefined);
      }
    });
    if (images > 0) message(Math.max(firstImage, 0), "");
  };

  /** A background agent's end, from the CLI's own task notification. */
  const endAgent = (note: string, uuid: string, index: number, at: number | undefined): void => {
    const id = /<tool-use-id>\s*([^<]*?)\s*<\/tool-use-id>/.exec(note)?.[1];
    const status = /<status>\s*([^<]*?)\s*<\/status>/.exec(note)?.[1];
    const agent = id === undefined ? undefined : agentById.get(id);
    if (agent === undefined || id === undefined || !background.has(id)) return;
    background.delete(id);
    agent.state = status === "completed" ? "done" : "failed";
    if (at !== undefined) agent.endedAt = at;
    addDivider(store, `${uuid}:${index}`, "agentDone", at, agent.label);
  };

  const build = (): ChatDoc => {
    const todos =
      todoSource === "tasks"
        ? tasks.flatMap((task) => (task.todo === null ? [] : [task.todo]))
        : written;
    const doc = store.doc({ agents: agents.map((a) => ({ ...a })), files: files.list() });
    if (asking !== undefined) doc.asking = structuredClone(asking);
    return withOptional(
      doc,
      model,
      tokens,
      todos?.map((t) => ({ ...t })),
    );
  };
  return createReader(handle, build);
}

export function parseClaudeDoc(text: string, options: ChatDocOptions = {}): ChatDoc {
  const reader = createClaudeDocReader(options);
  reader.push(text);
  return reader.doc();
}

// ---------------------------------------------------------------- Copilot

export function createCopilotDocReader(options: ChatDocOptions = {}): ChatDocReader {
  const store = createStore(options.maxItems ?? DEFAULT_MAX_ITEMS);
  const files = createFiles();
  let model: string | undefined;

  const handle = (fields: Record<string, unknown>, line: string): void => {
    const body = asRecord(fields["data"]);
    if (body === undefined) return;
    const type = fields["type"];
    const id = str(fields["id"]) ?? `h${hash(line)}`;
    const at = timeOf(fields["timestamp"]);

    if (type === "session.model_change") {
      const next = str(body["newModel"]);
      if (next !== undefined) model = next;
    } else if (type === "user.message") {
      if (body["source"] !== undefined || body["isAutopilotContinuation"] === true) return;
      const content = body["content"];
      if (typeof content === "string" && content.trim() !== "") {
        addMessage(store, `${id}:0`, "user", clean(content.trim()), at);
      }
    } else if (type === "assistant.message") {
      if (body["parentToolCallId"] !== undefined) return;
      const next = str(body["model"]);
      if (next !== undefined) model = next;
      const content = body["content"];
      if (typeof content === "string" && content.trim() !== "") {
        addMessage(store, `${id}:0`, "text", clean(content.trim()), at);
      }
      const requests = body["toolRequests"];
      if (!Array.isArray(requests)) return;
      requests.forEach((request, index) => {
        const fieldsOfRequest = asRecord(request);
        if (fieldsOfRequest === undefined) return;
        const name = str(fieldsOfRequest["name"]) ?? "tool";
        const args = copilotArguments(fieldsOfRequest["arguments"]);
        const parts: Partial<ChatToolItem> = {};
        const target = argumentsTarget(fieldsOfRequest["arguments"]);
        if (target !== undefined) parts.target = clean(target, 400);
        const command = str(args?.["command"]);
        if (command !== undefined) parts.command = clean(command, MAX_COMMAND_CHARS);
        const path = str(args?.["path"]) ?? str(args?.["file_path"]);
        if (path !== undefined) parts.path = path;
        const pairs = inputPairs(args);
        if (pairs.length > 0) parts.input = pairs;
        const callId = str(fieldsOfRequest["toolCallId"]) ?? `${id}:${index + 1}`;
        store.add(newTool(callId, name, at, parts));
        if ((name === "edit" || name === "create") && path !== undefined) {
          const added =
            typeof args?.["new_str"] === "string" ? lineCount(args["new_str"]) : undefined;
          const removed =
            typeof args?.["old_str"] === "string" ? lineCount(args["old_str"]) : undefined;
          files.touch(path, added, removed);
        }
      });
    } else if (type === "tool.execution_complete") {
      const tool = store.toolById.get(str(body["toolCallId"]) ?? "");
      if (tool === undefined) return;
      tool.state = body["success"] === false ? "error" : "ok";
      if (at !== undefined) tool.endAt = at;
      const result = asRecord(body["result"]);
      const text = typeof result?.["content"] === "string" ? result["content"] : "";
      setOutput(tool, text);
    }
  };

  const build = (): ChatDoc =>
    withOptional(store.doc({ agents: [], files: files.list() }), model, undefined, undefined);
  return createReader(handle, build);
}

function copilotArguments(args: unknown): Record<string, unknown> | undefined {
  const fields = asRecord(args);
  if (fields !== undefined || typeof args !== "string") return fields;
  try {
    return asRecord(JSON.parse(args));
  } catch {
    return undefined;
  }
}

export function parseCopilotDoc(text: string, options: ChatDocOptions = {}): ChatDoc {
  const reader = createCopilotDocReader(options);
  reader.push(text);
  return reader.doc();
}

// ------------------------------------------------------------------ Codex

function unifiedDiffCounts(diff: unknown): { added: number; removed: number } | undefined {
  if (typeof diff !== "string") return undefined;
  let added = 0;
  let removed = 0;
  for (const row of diff.split("\n")) {
    if (row.startsWith("+++") || row.startsWith("---")) continue;
    if (row.startsWith("+")) added++;
    else if (row.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** Older rollouts' shell-style function names. */
const EXEC_NAMES = new Set([
  "shell",
  "exec",
  "exec_command",
  "shell_command",
  "container.exec",
  "local_shell",
]);

/** A call's output: plain text, or JSON with `output` and `metadata.exit_code`. */
function codexOutput(raw: unknown): { text: string; failed: boolean } {
  if (typeof raw !== "string") return { text: "", failed: false };
  if (raw.startsWith("{")) {
    try {
      const fields = asRecord(JSON.parse(raw));
      if (fields !== undefined && typeof fields["output"] === "string") {
        const exit = asRecord(fields["metadata"])?.["exit_code"];
        return { text: fields["output"], failed: typeof exit === "number" && exit !== 0 };
      }
    } catch {
      // plain text that begins with a brace
    }
  }
  return { text: raw, failed: false };
}

/** The files of an apply_patch body, each with its diff lines and counts. */
function patchFiles(
  patch: string,
): { path: string; added: number; removed: number; diff: ChatDiffLine[] }[] {
  const out: { path: string; added: number; removed: number; diff: ChatDiffLine[] }[] = [];
  let current: (typeof out)[number] | undefined;
  for (const row of patch.split("\n")) {
    const header = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/.exec(row);
    if (header?.[1] !== undefined) {
      current = { path: header[1], added: 0, removed: 0, diff: [] };
      out.push(current);
      continue;
    }
    if (current === undefined || row.startsWith("*** ") || row.startsWith("@@")) continue;
    const sign = row[0];
    if (sign !== " " && sign !== "+" && sign !== "-") continue;
    if (sign === "+") current.added++;
    if (sign === "-") current.removed++;
    if (current.diff.length < MAX_DIFF_LINES)
      current.diff.push({ sign, text: clean(row.slice(1), 2000) });
  }
  return out;
}

export function createCodexDocReader(options: ChatDocOptions = {}): ChatDocReader {
  const max = options.maxItems ?? DEFAULT_MAX_ITEMS;
  // Newer rollouts record item_completed events; older ones only response_item
  // messages. Both are read, one is shown: a rollout with both would repeat.
  const fromItems = createStore(max);
  const fromResponses = createStore(max);
  const files = createFiles();
  const responseFiles = createFiles();
  const patchCalls = new Map<string, ChatToolItem[]>();
  let sawItem = false;
  let model: string | undefined;
  let tokens: number | undefined;
  let plan: ChatTodo[] | undefined;
  let limits: ChatLimit[] | undefined;

  const handleItem = (item: Record<string, unknown>, id: string, at: number | undefined): void => {
    sawItem = true;
    const text = (partsText(item["content"]) || partsText(item["text"])).trim();
    switch (item["type"]) {
      case "UserMessage":
        if (text !== "") addMessage(fromItems, `${id}:0`, "user", clean(text), at);
        break;
      case "AgentMessage":
        if (text !== "") addMessage(fromItems, `${id}:0`, "text", clean(text), at);
        break;
      case "CommandExecution": {
        const raw = item["command"];
        const command = Array.isArray(raw)
          ? raw.filter((part) => typeof part === "string").join(" ")
          : str(raw);
        const parts: Partial<ChatToolItem> = {};
        const target = commandTarget(raw);
        if (target !== undefined) parts.target = clean(target, 400);
        if (command !== undefined) parts.command = clean(command, MAX_COMMAND_CHARS);
        const exit = item["exit_code"];
        const failed = (typeof exit === "number" && exit !== 0) || item["status"] === "failed";
        const tool = newTool(str(item["id"]) ?? `${id}:0`, "exec", at, {
          ...parts,
          state: failed ? "error" : "ok",
        });
        setOutput(
          tool,
          typeof item["aggregated_output"] === "string" ? item["aggregated_output"] : "",
        );
        fromItems.add(tool);
        break;
      }
      case "FileChange": {
        const changes = item["changes"];
        const entries: [string, unknown][] = [];
        if (Array.isArray(changes)) {
          for (const change of changes) {
            const fields = asRecord(change);
            const path = str(fields?.["path"]);
            if (path !== undefined) entries.push([path, fields]);
          }
        } else if (asRecord(changes) !== undefined) {
          entries.push(...Object.entries(changes as Record<string, unknown>));
        }
        const single = str(item["path"]);
        if (single !== undefined) entries.push([single, item]);
        entries.forEach(([path, change], index) => {
          const counts = unifiedDiffCounts(asRecord(change)?.["unified_diff"]);
          files.touch(path, counts?.added, counts?.removed);
          fromItems.add(
            newTool(`${str(item["id"]) ?? id}:${index}`, "edit", at, {
              target: basename(path),
              path,
              state: "ok",
            }),
          );
        });
        break;
      }
      default:
        break; // Reasoning and the rest are not the conversation.
    }
  };

  const handle = (fields: Record<string, unknown>, line: string): void => {
    const payload = asRecord(fields["payload"]);
    if (payload === undefined) return;
    const type = fields["type"];
    const id = `h${hash(line)}`;
    const at = timeOf(fields["timestamp"]);

    if (type === "turn_context") {
      const next = str(payload["model"]);
      if (next !== undefined) model = next;
    } else if (type === "event_msg" && payload["type"] === "item_completed") {
      const item = asRecord(payload["item"]);
      if (item !== undefined) handleItem(item, id, at);
    } else if (type === "event_msg" && payload["type"] === "token_count") {
      const total = asRecord(asRecord(payload["info"])?.["last_token_usage"])?.["total_tokens"];
      if (typeof total === "number" && total > 0) tokens = total;
      const found = codexLimits(payload["rate_limits"]);
      if (found !== undefined) limits = found.length > 0 ? found : undefined;
    } else if (type === "response_item" && payload["type"] === "message") {
      const role = payload["role"];
      if (role !== "user" && role !== "assistant") return; // developer
      const words = partsText(payload["content"]).trim();
      if (words === "") return;
      if (role === "user" && INJECTED_PREFIXES.some((prefix) => words.startsWith(prefix))) return;
      addMessage(fromResponses, `${id}:0`, role === "user" ? "user" : "text", clean(words), at);
    } else if (type === "response_item") {
      handleResponse(payload, id, at);
    }
  };

  const handleResponse = (
    payload: Record<string, unknown>,
    id: string,
    at: number | undefined,
  ): void => {
    const kind = payload["type"];
    const callId = str(payload["call_id"]);
    if (kind === "function_call" && payload["name"] === "update_plan") {
      const args = copilotArguments(payload["arguments"]);
      const steps = args?.["plan"];
      if (!Array.isArray(steps)) return;
      const todos: ChatTodo[] = [];
      for (const step of steps) {
        const fieldsOfStep = asRecord(step);
        const text = str(fieldsOfStep?.["step"]);
        const state = todoState(fieldsOfStep?.["status"]);
        if (text !== undefined && state !== undefined) {
          todos.push({ text: clean(text, 500), state });
        }
      }
      plan = todos;
    } else if (kind === "function_call" && EXEC_NAMES.has(String(payload["name"]))) {
      const args = copilotArguments(payload["arguments"]);
      const raw = args?.["command"] ?? args?.["cmd"];
      const command = Array.isArray(raw)
        ? raw.filter((part) => typeof part === "string").join(" ")
        : str(raw);
      const parts: Partial<ChatToolItem> = {};
      const target = commandTarget(raw);
      if (target !== undefined) parts.target = clean(target, 400);
      if (command !== undefined) parts.command = clean(command, MAX_COMMAND_CHARS);
      fromResponses.add(newTool(callId ?? `${id}:0`, "exec", at, parts));
    } else if (kind === "function_call_output" && callId !== undefined) {
      const tool = fromResponses.toolById.get(callId);
      if (tool === undefined) return;
      const result = codexOutput(payload["output"]);
      tool.state = result.failed ? "error" : "ok";
      if (at !== undefined) tool.endAt = at;
      setOutput(tool, result.text);
    } else if (
      (kind === "custom_tool_call" || kind === "function_call") &&
      payload["name"] === "apply_patch"
    ) {
      const args = copilotArguments(payload["arguments"]);
      const input = typeof payload["input"] === "string" ? payload["input"] : args?.["input"];
      if (typeof input !== "string") return;
      const made: ChatToolItem[] = [];
      patchFiles(input).forEach((file, index) => {
        responseFiles.touch(file.path, file.added, file.removed);
        const tool = newTool(`${callId ?? id}:${index}`, "edit", at, {
          target: basename(file.path),
          path: file.path,
          ...(file.diff.length > 0 ? { diff: file.diff } : {}),
        });
        fromResponses.add(tool);
        made.push(tool);
      });
      if (callId !== undefined && made.length > 0) {
        patchCalls.set(callId, made);
        if (patchCalls.size > 500) patchCalls.delete(patchCalls.keys().next().value as string);
      }
    } else if (
      (kind === "custom_tool_call_output" || kind === "function_call_output") &&
      callId !== undefined
    ) {
      const made = patchCalls.get(callId);
      if (made === undefined) return;
      for (const tool of made) {
        tool.state = "ok";
        if (at !== undefined) tool.endAt = at;
      }
      const result = codexOutput(payload["output"]);
      if (made[0] !== undefined) setOutput(made[0], result.text);
    }
  };

  const build = (): ChatDoc => {
    const store = sawItem ? fromItems : fromResponses;
    const doc = store.doc({ agents: [], files: (sawItem ? files : responseFiles).list() });
    const out = withOptional(
      doc,
      model,
      tokens,
      plan?.map((t) => ({ ...t })),
    );
    if (limits !== undefined) out.limits = limits.map((l) => ({ ...l }));
    return out;
  };
  return createReader(handle, build);
}

export function parseCodexDoc(text: string, options: ChatDocOptions = {}): ChatDoc {
  const reader = createCodexDocReader(options);
  reader.push(text);
  return reader.doc();
}
