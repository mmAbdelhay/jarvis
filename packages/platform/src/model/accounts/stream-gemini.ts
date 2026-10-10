// `gemini -p … -o stream-json` (geminicli.com/docs/cli/headless): init,
// message {role, content, delta}, tool_use, tool_result, error, result.
// tools.core is [] in our system settings, so any tool_use/tool_result is a
// tool Gemini registered outside the core list — the tripwire.
import { isRecord } from "@jarvis/core";
import {
  type CliStreamEvent,
  type CliStreamParser,
  classifyCliError,
  endWithoutOutcome,
  num,
  parseJsonLine,
} from "./stream-types.js";

export function createGeminiStream(): CliStreamParser {
  let outcome = false;
  let progressed = false;
  return {
    line(raw) {
      const msg = parseJsonLine(raw);
      if (msg === undefined) return [];
      const type = msg["type"];
      if (type === "tool_use" || type === "tool_result") {
        return [
          {
            kind: "tripwire",
            reason: `gemini asked for its own tool ${String(msg["tool_name"] ?? msg["tool_id"] ?? "unknown")}`,
          },
        ];
      }
      if (type === "message" && msg["role"] === "assistant" && typeof msg["content"] === "string") {
        const out: CliStreamEvent[] = [];
        if (!progressed) {
          progressed = true;
          out.push({ kind: "progress" });
        }
        out.push({ kind: "text", text: msg["content"] });
        return out;
      }
      if (type === "result") {
        outcome = true;
        const stats = isRecord(msg["stats"]) ? msg["stats"] : {};
        const events: CliStreamEvent[] = [
          {
            kind: "usage",
            inputTokens: num(stats["input_tokens"]),
            outputTokens: num(stats["output_tokens"]),
          },
        ];
        if (msg["status"] !== "success") {
          const error = isRecord(msg["error"]) ? msg["error"] : {};
          const detail = String(error["message"] ?? "Gemini failed");
          const code = /Authentication|auth/i.test(String(error["type"] ?? ""))
            ? "not-signed-in"
            : classifyCliError(detail);
          events.push({ kind: "error", code, detail });
        }
        return events;
      }
      if (type === "error" && msg["severity"] === "error") {
        const detail = String(msg["message"] ?? "Gemini failed");
        return [{ kind: "error", code: classifyCliError(detail), detail }];
      }
      return [];
    },
    end(exitCode, stderrTail) {
      return outcome ? [] : endWithoutOutcome("gemini", exitCode, stderrTail);
    },
  };
}
