// `copilot -p … --output-format json` session events (schemas/session-events.schema.json).
// The reply is assistant.message.data.content; deltas only mark progress.
// Every tool path is a tripwire: tool.execution_start, non-empty toolRequests,
// permission/external-tool/sub-agent/skill events.
import { isRecord } from "@jarvis/core";
import {
  type CliStreamEvent,
  type CliStreamParser,
  classifyCliError,
  endWithoutOutcome,
  num,
  parseJsonLine,
} from "./stream-types.js";

const TOOL_EVENTS = new Set([
  "tool.execution_start",
  "tool.user_requested",
  "permission.requested",
  "external_tool.requested",
  "subagent.started",
  "skill.invoked",
  "mcp_app.tool_call_complete",
]);

export function createCopilotStream(): CliStreamParser {
  let outcome = false;
  let progressed = false;
  const parts: string[] = [];
  const progress = (): CliStreamEvent[] => {
    if (progressed) return [];
    progressed = true;
    return [{ kind: "progress" }];
  };
  return {
    line(raw) {
      const msg = parseJsonLine(raw);
      if (msg === undefined) return [];
      const type = String(msg["type"] ?? "");
      const data = isRecord(msg["data"]) ? msg["data"] : {};
      if (TOOL_EVENTS.has(type)) {
        return [
          ...progress(),
          {
            kind: "tripwire",
            reason: `copilot started its own tool ${String(data["toolName"] ?? type)}`,
          },
        ];
      }
      if (
        type === "assistant.turn_start" ||
        type === "assistant.message_delta" ||
        type === "assistant.reasoning_delta"
      ) {
        return progress();
      }
      if (type === "assistant.message") {
        const requests = Array.isArray(data["toolRequests"]) ? data["toolRequests"] : [];
        if (requests.length > 0) {
          const first = isRecord(requests[0]) ? requests[0] : {};
          return [
            {
              kind: "tripwire",
              reason: `copilot asked for its own tool ${String(first["name"] ?? "unknown")}`,
            },
          ];
        }
        const content = typeof data["content"] === "string" ? data["content"] : "";
        if (content === "") return progress();
        parts.push(content);
        return [...progress(), { kind: "text", text: parts.length > 1 ? `\n${content}` : content }];
      }
      if (type === "assistant.usage") {
        return [
          {
            kind: "usage",
            inputTokens: num(data["inputTokens"]),
            outputTokens: num(data["outputTokens"]),
          },
        ];
      }
      if (type === "session.error") {
        outcome = true;
        const detail = String(data["message"] ?? "Copilot failed");
        const kind = String(data["errorType"] ?? "");
        const code =
          kind === "authentication" || kind === "authorization"
            ? "not-signed-in"
            : kind === "quota" || kind === "rate_limit"
              ? "rate-limit"
              : classifyCliError(detail);
        return [{ kind: "error", code, detail }];
      }
      if (type === "session.idle" || type === "assistant.turn_end") {
        outcome = outcome || parts.length > 0;
        return [];
      }
      return [];
    },
    end(exitCode, stderrTail) {
      // session.error already said why, or a reply arrived (Copilot may exit
      // without session.idle): nothing more to report.
      if (outcome || parts.length > 0) return [];
      return endWithoutOutcome("copilot", exitCode, stderrTail);
    },
  };
}
