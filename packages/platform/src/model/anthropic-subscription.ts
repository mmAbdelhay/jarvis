// The Claude subscription auth mode (spec §4: "the existing Agent SDK
// subscription path stays available as a second auth mode"). Same isolation
// as brain.ts — no settings, hooks, skills or built-in tools, no inherited
// ANTHROPIC_API_KEY — and the same fenced ```jarvis-tool``` protocol, so the
// SDK never executes anything itself and every call still goes through
// ToolLoop and RiskGate. Stateless: ToolLoop passes the whole history.
//
// Exported from @jarvis/platform's main index only. The Jarvis OS bundle is
// built from @jarvis/platform/model and must not carry the Agent SDK.
import { type Options, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { ModelMessage, ModelProvider, ModelToolSpec } from "@jarvis/core";
import { parseCliReply, type SdkQueryFn } from "../brain.js";
import { resolveClaudeExecutable } from "../sdk-executable.js";

export type SubscriptionOptions = {
  cwd: string;
  model?: string;
  configDir?: string;
  query?: SdkQueryFn;
  env?: NodeJS.ProcessEnv;
};

export function renderTranscript(
  system: string,
  messages: readonly ModelMessage[],
  tools: readonly ModelToolSpec[],
): string {
  const lines = [system, ""];
  if (tools.length > 0) {
    lines.push(
      "Available tools. To call one, emit a fenced block, one per call:",
      "```jarvis-tool",
      '{ "name": "<tool>", "input": { ... } }',
      "```",
      ...tools.map(
        (tool) =>
          `- ${tool.name}: ${tool.description} — input schema: ${JSON.stringify(tool.inputSchema)}`,
      ),
      "",
    );
  }
  lines.push("Conversation so far:");
  for (const message of messages) {
    if (message.role === "user") lines.push(`User: ${message.text}`);
    else if (message.role === "assistant") {
      if (message.text !== "") lines.push(`Assistant: ${message.text}`);
      for (const call of message.toolCalls)
        lines.push(`Assistant called ${call.name} ${JSON.stringify(call.input ?? {})}`);
    } else {
      for (const result of message.results) {
        lines.push(
          `Result of ${result.name}${result.isError ? " (error)" : ""}: ${result.content}`,
        );
      }
    }
  }
  lines.push("", "Assistant:");
  return lines.join("\n");
}

export function createAnthropicSubscriptionProvider(options: SubscriptionOptions): ModelProvider {
  const query: SdkQueryFn = options.query ?? ((params) => sdkQuery(params));
  let callSeq = 0;

  const provider: ModelProvider = {
    async *chat(chatRequest) {
      const env = { ...(options.env ?? process.env) };
      // An inherited key would make the SDK bill by key instead of the
      // subscription (brain.ts has the same guard, for the same reason).
      delete env["ANTHROPIC_API_KEY"];
      const abortController = new AbortController();
      chatRequest.signal.addEventListener("abort", () => abortController.abort(), { once: true });
      const executable = resolveClaudeExecutable();
      const sdkOptions: Options = {
        cwd: options.cwd,
        settingSources: [],
        tools: [],
        abortController,
        ...(executable === undefined ? {} : { pathToClaudeCodeExecutable: executable }),
        ...(options.model === undefined ? {} : { model: options.model }),
        env:
          options.configDir === undefined ? env : { ...env, CLAUDE_CONFIG_DIR: options.configDir },
      };
      let text = "";
      for await (const message of query({
        prompt: renderTranscript(chatRequest.system, chatRequest.messages, chatRequest.tools),
        options: sdkOptions,
      })) {
        if (message.type === "assistant" && "message" in message) {
          for (const block of message.message.content) {
            if (block.type === "text" && block.text !== undefined) text += block.text;
          }
        }
      }
      const reply = parseCliReply(text);
      if (reply.text !== "") yield { type: "text", delta: reply.text };
      for (const call of reply.toolCalls) {
        callSeq += 1;
        yield { type: "tool_call", id: `sub-${callSeq}`, name: call.name, input: call.input };
      }
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    },
    async probe() {
      try {
        for await (const _event of provider.chat({
          system: "You are answering a connectivity check.",
          messages: [{ role: "user", text: "Reply with the word pong." }],
          tools: [],
          signal: AbortSignal.timeout(60_000),
        })) {
          // Draining is the check.
        }
        return { ok: true, supportsTools: true, models: [options.model ?? "default"] };
      } catch (error) {
        return {
          ok: false,
          supportsTools: false,
          models: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    async listModels() {
      return [options.model ?? "default"];
    },
    async reachable() {
      // The CLI owns its own connectivity; a failed turn reports the cause.
      return { ok: true };
    },
  };
  return provider;
}
