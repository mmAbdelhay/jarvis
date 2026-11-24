import { basename } from "node:path";
import { type ChatTool, type ChatTurn, MAX_CHAT_TURNS, toolTarget } from "./session-import.js";

/**
 * The desktop chat view's reading of a Copilot or Codex transcript: the
 * same turns parseChatTranscript gives for Claude — same fold rule (a
 * wordless assistant turn joins the assistant turn before it) and same cap
 * (the last `maxTurns`) — from the other two formats. Both start from a tail
 * that can begin mid-record: a line that does not parse is skipped, and
 * nothing here throws. A tool call is named and given its target, never its
 * output or its whole input.
 */
export type AgentChat = { turns: ChatTurn[]; model?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Each line that parses to an object. */
function records(text: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = asRecord(JSON.parse(line));
      if (record !== undefined) found.push(record);
    } catch {
      // A cut-off first line, or one still being written.
    }
  }
  return found;
}

/** Adds a turn, folding a wordless assistant turn into the one before it. */
function addTurn(entries: ChatTurn[], role: ChatTurn["role"], text: string, tools: ChatTool[]) {
  if (text === "" && tools.length === 0) return;
  const previous = entries.at(-1);
  if (text === "" && role === "assistant" && previous?.role === "assistant") {
    previous.tools.push(...tools);
    return;
  }
  entries.push({ role, text, tools });
}

function finish(entries: ChatTurn[], maxTurns: number, model: string | undefined): AgentChat {
  const kept = entries.slice(Math.max(0, entries.length - maxTurns));
  return model === undefined ? { turns: kept } : { turns: kept, model };
}

/** A tool's target from its arguments: toolTarget's fields, then `path`. */
function argumentsTarget(args: unknown): string | undefined {
  let fields = asRecord(args);
  if (fields === undefined && typeof args === "string") {
    try {
      fields = asRecord(JSON.parse(args));
    } catch {
      return undefined;
    }
  }
  if (fields === undefined) return undefined;
  const target = toolTarget(fields);
  if (target !== undefined) return target;
  const path = fields["path"];
  return typeof path === "string" && path !== "" ? basename(path) : undefined;
}

export function parseCopilotChat(text: string, maxTurns = MAX_CHAT_TURNS): AgentChat {
  const entries: ChatTurn[] = [];
  let model: string | undefined;
  for (const fields of records(text)) {
    const body = asRecord(fields["data"]);
    if (body === undefined) continue;
    const type = fields["type"];

    if (type === "session.model_change") {
      const next = body["newModel"];
      if (typeof next === "string" && next !== "") model = next;
      continue;
    }
    if (type === "user.message") {
      if (body["source"] !== undefined || body["isAutopilotContinuation"] === true) continue;
      const content = body["content"];
      if (typeof content === "string") addTurn(entries, "user", content.trim(), []);
      continue;
    }
    if (type !== "assistant.message" || body["parentToolCallId"] !== undefined) continue;
    if (typeof body["model"] === "string" && body["model"] !== "") model = body["model"];
    const content = body["content"];
    const tools: ChatTool[] = [];
    const requests = body["toolRequests"];
    if (Array.isArray(requests)) {
      for (const request of requests) {
        const fieldsOfRequest = asRecord(request);
        if (fieldsOfRequest === undefined) continue;
        const name = fieldsOfRequest["name"];
        const tool: ChatTool = { name: typeof name === "string" && name !== "" ? name : "tool" };
        const target = argumentsTarget(fieldsOfRequest["arguments"]);
        if (target !== undefined) tool.target = target;
        tools.push(tool);
      }
    }
    addTurn(entries, "assistant", typeof content === "string" ? content.trim() : "", tools);
  }
  return finish(entries, maxTurns, model);
}

/** Text the CLI injects as a user message; nobody typed it. */
const INJECTED_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<skills_instructions>",
  "# AGENTS.md",
];

/** The words of a message's content parts (or a plain string). */
function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    const text = asRecord(part)?.["text"];
    if (typeof text === "string") out += text;
  }
  return out;
}

function firstLine(value: string): string | undefined {
  const first = value.split(/\r?\n/).find((row) => row.trim() !== "");
  if (first === undefined) return undefined;
  return first.length > 80 ? `${first.slice(0, 80)}…` : first;
}

function commandTarget(command: unknown): string | undefined {
  if (typeof command === "string") return firstLine(command);
  if (Array.isArray(command)) {
    return firstLine(command.filter((part) => typeof part === "string").join(" "));
  }
  return undefined;
}

/** The files a file-change item touched, as chat tools. Shape unverified
 *  against a real rollout, so it accepts a path map, a list, or one path. */
function fileChangeTools(item: Record<string, unknown>): ChatTool[] {
  const paths: string[] = [];
  const changes = item["changes"];
  if (Array.isArray(changes)) {
    for (const change of changes) {
      const path = asRecord(change)?.["path"];
      if (typeof path === "string") paths.push(path);
    }
  } else if (asRecord(changes) !== undefined) {
    paths.push(...Object.keys(changes as Record<string, unknown>));
  }
  if (typeof item["path"] === "string") paths.push(item["path"]);
  return paths
    .filter((path) => path !== "")
    .map((path) => ({ name: "edit", target: basename(path) }));
}

export function parseCodexChat(text: string, maxTurns = MAX_CHAT_TURNS): AgentChat {
  // Newer rollouts record item_completed events; older ones only the model
  // API's response_item messages. Both are read, one is kept: a rollout that
  // has both would show every message twice.
  const items: ChatTurn[] = [];
  const responses: ChatTurn[] = [];
  let sawItem = false;
  let model: string | undefined;
  for (const fields of records(text)) {
    const payload = asRecord(fields["payload"]);
    if (payload === undefined) continue;
    const type = fields["type"];

    if (type === "turn_context") {
      if (typeof payload["model"] === "string" && payload["model"] !== "") model = payload["model"];
      continue;
    }
    if (type === "event_msg" && payload["type"] === "item_completed") {
      sawItem = true;
      const item = asRecord(payload["item"]);
      if (item === undefined) continue;
      switch (item["type"]) {
        case "UserMessage":
          addTurn(
            items,
            "user",
            (partsText(item["content"]) || partsText(item["text"])).trim(),
            [],
          );
          break;
        case "AgentMessage":
          addTurn(
            items,
            "assistant",
            (partsText(item["content"]) || partsText(item["text"])).trim(),
            [],
          );
          break;
        case "CommandExecution": {
          const tool: ChatTool = { name: "exec" };
          const target = commandTarget(item["command"]);
          if (target !== undefined) tool.target = target;
          addTurn(items, "assistant", "", [tool]);
          break;
        }
        case "FileChange":
          addTurn(items, "assistant", "", fileChangeTools(item));
          break;
        default:
          break; // Reasoning and the rest are not the conversation.
      }
      continue;
    }
    if (type === "response_item" && payload["type"] === "message") {
      const role = payload["role"];
      if (role !== "user" && role !== "assistant") continue; // developer
      const words = partsText(payload["content"]).trim();
      if (role === "user" && INJECTED_PREFIXES.some((prefix) => words.startsWith(prefix))) continue;
      addTurn(responses, role, words, []);
    }
  }
  return finish(sawItem ? items : responses, maxTurns, model);
}
