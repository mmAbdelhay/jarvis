// `codex exec --json` (learn.chatgpt.com/docs/non-interactive-mode). Only
// agent_message, reasoning and todo_list (the plan tool, which has no off
// switch at 0.159.2 and touches nothing) may appear; any other item type is a
// tool Codex started on its own — the tripwire, on item.started already.
import { isRecord } from "@jarvis/core";
import {
  type CliStreamEvent,
  type CliStreamParser,
  classifyCliError,
  endWithoutOutcome,
  num,
  parseJsonLine,
} from "./stream-types.js";

export const CODEX_ALLOWED_ITEMS: ReadonlySet<string> = new Set([
  "agent_message",
  "reasoning",
  "todo_list",
]);

export function createCodexStream(): CliStreamParser {
  let outcome = false;
  let progressed = false;
  return {
    line(raw) {
      const msg = parseJsonLine(raw);
      if (msg === undefined) return [];
      const type = msg["type"];
      if (type === "item.started" || type === "item.updated" || type === "item.completed") {
        const item = isRecord(msg["item"]) ? msg["item"] : {};
        const itemType = String(item["type"] ?? "");
        if (!CODEX_ALLOWED_ITEMS.has(itemType)) {
          return [
            { kind: "tripwire", reason: `chatgpt started its own tool (${itemType || "unknown"})` },
          ];
        }
        const out: CliStreamEvent[] = [];
        if (!progressed) {
          progressed = true;
          out.push({ kind: "progress" });
        }
        if (
          type === "item.completed" &&
          itemType === "agent_message" &&
          typeof item["text"] === "string"
        ) {
          out.push({ kind: "text", text: item["text"] });
        }
        return out;
      }
      if (type === "turn.completed") {
        outcome = true;
        const usage = isRecord(msg["usage"]) ? msg["usage"] : {};
        return [
          {
            kind: "usage",
            inputTokens: num(usage["input_tokens"]),
            outputTokens: num(usage["output_tokens"]),
          },
        ];
      }
      if (type === "turn.failed" || type === "error") {
        if (outcome) return [];
        outcome = true;
        const error = isRecord(msg["error"]) ? msg["error"] : msg;
        const detail = String(error["message"] ?? "Codex failed");
        return [{ kind: "error", code: classifyCliError(detail), detail }];
      }
      return [];
    },
    end(exitCode, stderrTail) {
      return outcome ? [] : endWithoutOutcome("chatgpt", exitCode, stderrTail);
    },
  };
}
