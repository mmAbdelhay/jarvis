// `claude -p --output-format stream-json --verbose` (code.claude.com/docs/en/headless).
// The tools list in system/init must be empty: `--tools ""` removed every
// built-in tool and `--strict-mcp-config` every MCP server. Anything else —
// or any tool_use block — is the tripwire.
import { isRecord } from "@jarvis/core";
import {
  type CliStreamEvent,
  type CliStreamParser,
  classifyCliError,
  endWithoutOutcome,
  num,
  parseJsonLine,
} from "./stream-types.js";

const TOOL_BLOCKS = new Set(["tool_use", "server_tool_use", "mcp_tool_use", "tool_result"]);

export function createClaudeStream(): CliStreamParser {
  let outcome = false;
  let progressed = false;
  const progress = (): CliStreamEvent[] => {
    if (progressed) return [];
    progressed = true;
    return [{ kind: "progress" }];
  };
  return {
    line(raw) {
      const msg = parseJsonLine(raw);
      if (msg === undefined) return [];
      const { type, subtype } = msg;
      if (type === "system" && subtype === "init") {
        const tools = Array.isArray(msg["tools"]) ? msg["tools"].map(String) : [];
        const servers = Array.isArray(msg["mcp_servers"]) ? msg["mcp_servers"] : [];
        if (tools.length > 0)
          return [
            {
              kind: "tripwire",
              reason: `claude offered its own tools: ${tools.slice(0, 5).join(", ")}`,
            },
          ];
        if (servers.length > 0)
          return [{ kind: "tripwire", reason: "claude connected MCP servers" }];
        return [];
      }
      if (type === "system" && subtype === "api_retry") {
        const error = String(msg["error"] ?? "");
        return error === "authentication_failed" || error === "oauth_org_not_allowed"
          ? [{ kind: "error", code: "not-signed-in", detail: error }]
          : [];
      }
      if (type === "assistant" || type === "user") {
        const content = isRecord(msg["message"]) ? msg["message"]["content"] : undefined;
        if (!Array.isArray(content)) return [];
        // Check every block for a tool first: text written around a tool call is dropped too.
        for (const block of content) {
          if (isRecord(block) && TOOL_BLOCKS.has(String(block["type"]))) {
            return [
              {
                kind: "tripwire",
                reason: `claude asked for its own tool ${String(block["name"] ?? block["type"])}`,
              },
            ];
          }
        }
        const out: CliStreamEvent[] = [];
        for (const block of content) {
          if (!isRecord(block)) continue;
          if (
            type === "assistant" &&
            block["type"] === "text" &&
            typeof block["text"] === "string"
          ) {
            out.push(...progress(), { kind: "text", text: block["text"] });
          }
        }
        return out;
      }
      if (type === "result") {
        outcome = true;
        const usage = isRecord(msg["usage"]) ? msg["usage"] : {};
        const events: CliStreamEvent[] = [
          {
            kind: "usage",
            inputTokens: num(usage["input_tokens"]),
            outputTokens: num(usage["output_tokens"]),
          },
        ];
        if (msg["is_error"] === true || (typeof subtype === "string" && subtype !== "success")) {
          const detail =
            typeof msg["result"] === "string" && msg["result"] !== ""
              ? msg["result"]
              : String(subtype);
          events.push({ kind: "error", code: classifyCliError(detail), detail });
        }
        return events;
      }
      return [];
    },
    end(exitCode, stderrTail) {
      return outcome ? [] : endWithoutOutcome("claude", exitCode, stderrTail);
    },
  };
}
