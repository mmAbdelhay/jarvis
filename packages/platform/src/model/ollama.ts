// Ollama's native API (spec §4, "ollama"): /api/chat streams NDJSON, one
// object per line; a tool call arrives whole inside one message chunk and
// has no id, so the adapter numbers them. /api/tags lists installed models.
// M1 connects to an Ollama that is already running (localhost or LAN).
import {
  type ModelEvent,
  type ModelMessage,
  type ModelProvider,
  ProviderError,
  isRecord,
} from "@jarvis/core";
import { type FetchLike, readJson, request, streamErrorText } from "./http.js";
import { probeProvider } from "./probe.js";
import { readLines } from "./stream.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";

export type OllamaOptions = { baseUrl: string; model: string; apiKey?: string; fetch: FetchLike };

export function toOllamaMessages(system: string, messages: readonly ModelMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.text });
    } else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text,
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                function: { name: call.name, arguments: isRecord(call.input) ? call.input : {} },
              })),
            }),
      });
    } else {
      for (const result of message.results) {
        out.push({
          role: "tool",
          content: result.isError ? `ERROR: ${result.content}` : result.content,
          tool_name: result.name,
        });
      }
    }
  }
  return out;
}

export function createOllamaProvider(options: OllamaOptions): ModelProvider {
  const headers: Record<string, string> = { "content-type": "application/json" };
  // A LAN Ollama behind an authenticating proxy is the only reason for a key.
  if (options.apiKey !== undefined && options.apiKey !== "") {
    headers["authorization"] = `Bearer ${options.apiKey}`;
  }
  let callCounter = 0;

  async function listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await request(
      options.fetch,
      `${options.baseUrl}/api/tags`,
      { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
      options.apiKey,
    );
    const body = await readJson(response, "tags");
    const models = isRecord(body) && Array.isArray(body["models"]) ? body["models"] : [];
    return models.flatMap((model) =>
      isRecord(model) && typeof model["name"] === "string" ? [model["name"]] : [],
    );
  }

  const provider: ModelProvider = {
    async *chat(chatRequest) {
      const body = {
        model: options.model,
        messages: toOllamaMessages(chatRequest.system, chatRequest.messages),
        stream: true,
        ...(chatRequest.tools.length === 0
          ? {}
          : {
              tools: chatRequest.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.inputSchema,
                },
              })),
            }),
      };
      const response = await request(
        options.fetch,
        `${options.baseUrl}/api/chat`,
        { method: "POST", headers, body: JSON.stringify(body), signal: chatRequest.signal },
        options.apiKey,
      );
      if (response.body === null)
        throw new ProviderError("bad-response", "The provider sent no body");
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const line of readLines(response.body)) {
        if (line.trim() === "") continue;
        let chunk: unknown;
        try {
          chunk = JSON.parse(line);
        } catch {
          throw new ProviderError("bad-response", "Ollama sent a line that is not JSON");
        }
        if (!isRecord(chunk)) continue;
        if (typeof chunk["error"] === "string")
          throw new ProviderError("http", streamErrorText(chunk["error"], options.apiKey));
        const message = chunk["message"];
        if (isRecord(message)) {
          if (typeof message["content"] === "string" && message["content"] !== "") {
            yield { type: "text", delta: message["content"] } satisfies ModelEvent;
          }
          const toolCalls = Array.isArray(message["tool_calls"]) ? message["tool_calls"] : [];
          for (const call of toolCalls) {
            const fn = isRecord(call) ? call["function"] : undefined;
            if (!isRecord(fn) || typeof fn["name"] !== "string") continue;
            callCounter += 1;
            const id = `ollama-${callCounter}`;
            yield { type: "tool_call", id, name: fn["name"], input: fn["arguments"] ?? {} };
          }
        }
        if (chunk["done"] === true) {
          if (typeof chunk["prompt_eval_count"] === "number")
            inputTokens = chunk["prompt_eval_count"];
          if (typeof chunk["eval_count"] === "number") outputTokens = chunk["eval_count"];
          break;
        }
      }
      yield { type: "done", usage: { inputTokens, outputTokens } };
    },
    probe: () => probeProvider({ listModels, chat: (r) => provider.chat(r) }),
    listModels: (signal) => listModels(signal),
    async reachable(signal) {
      try {
        await listModels(signal ?? AbortSignal.timeout(5_000));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  return provider;
}
