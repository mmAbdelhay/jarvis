// `codex exec --json` (learn.chatgpt.com/docs/non-interactive-mode). Owner
// ruling G2: the tripwire ends the turn on any non-message item. Only
// agent_message and reasoning (the model's own text, not a tool) may appear;
// todo_list is the plan tool, so it trips like every other item type, on
// item.started already.
import { isRecord } from "@jarvis/core";
import {
  type CliStreamEvent,
  type CliStreamParser,
  classifyCliError,
  endWithoutOutcome,
  num,
  parseJsonLine,
} from "./stream-types.js";

export const CODEX_ALLOWED_ITEMS: ReadonlySet<string> = new Set(["agent_message", "reasoning"]);

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
