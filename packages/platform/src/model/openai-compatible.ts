// Chat Completions with `tools` (spec §4, "openai-compatible"): OpenAI,
// OpenRouter, Groq, DeepSeek, xAI, Mistral, LM Studio, vLLM, any base URL.
// No `stream_options`: several compatible servers refuse unknown fields, and
// usage is read whenever a chunk happens to carry it (zeros otherwise).
// Tool-call fragments are keyed by their `index` and emitted at the end.
import {
  type ModelEvent,
  type ModelMessage,
  type ModelProvider,
  ProviderError,
  isRecord,
} from "@jarvis/core";
import { type FetchLike, readJson, request } from "./http.js";
import { probeProvider } from "./probe.js";
import { readSse } from "./stream.js";

export type OpenAiCompatibleOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch: FetchLike;
  maxTokens?: number;
};

export function toOpenAiMessages(system: string, messages: readonly ModelMessage[]): unknown[] {
  const out: unknown[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "user") {
      out.push({ role: "user", content: message.text });
    } else if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: message.text === "" ? null : message.text,
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: "function",
                function: {
                  name: call.name,
                  arguments: JSON.stringify(isRecord(call.input) ? call.input : {}),
                },
              })),
            }),
      });
    } else {
      for (const result of message.results) {
        out.push({
          role: "tool",
          tool_call_id: result.callId,
          content: result.isError ? `ERROR: ${result.content}` : result.content,
        });
      }
    }
  }
  return out;
}

export function createOpenAiCompatibleProvider(options: OpenAiCompatibleOptions): ModelProvider {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.apiKey !== undefined && options.apiKey !== "") {
    headers["authorization"] = `Bearer ${options.apiKey}`;
  }

  async function listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await request(
      options.fetch,
      `${options.baseUrl}/models`,
      { method: "GET", headers, ...(signal === undefined ? {} : { signal }) },
      options.apiKey,
    );
    const body = await readJson(response, "models");
    const data = isRecord(body) && Array.isArray(body["data"]) ? body["data"] : [];
    return data.flatMap((model) =>
      isRecord(model) && typeof model["id"] === "string" ? [model["id"]] : [],
    );
  }

  const provider: ModelProvider = {
    async *chat(chatRequest) {
      const body = {
        model: options.model,
        messages: toOpenAiMessages(chatRequest.system, chatRequest.messages),
        stream: true,
        ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
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
        `${options.baseUrl}/chat/completions`,
        { method: "POST", headers, body: JSON.stringify(body), signal: chatRequest.signal },
        options.apiKey,
      );
      if (response.body === null)
        throw new ProviderError("bad-response", "The provider sent no body");
      const calls = new Map<number, { id: string; name: string; args: string }>();
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const sse of readSse(response.body)) {
        if (sse.data === "[DONE]") break;
        let chunk: unknown;
        try {
          chunk = JSON.parse(sse.data);
        } catch {
          throw new ProviderError("bad-response", "The provider sent a chunk that is not JSON");
        }
        if (!isRecord(chunk)) continue;
        if (isRecord(chunk["error"])) {
          const message = chunk["error"]["message"];
          throw new ProviderError("http", typeof message === "string" ? message : "stream error");
        }
        const usage = chunk["usage"];
        if (isRecord(usage)) {
          if (typeof usage["prompt_tokens"] === "number") inputTokens = usage["prompt_tokens"];
          if (typeof usage["completion_tokens"] === "number")
            outputTokens = usage["completion_tokens"];
        }
        const choices = Array.isArray(chunk["choices"]) ? chunk["choices"] : [];
        const delta = isRecord(choices[0]) ? choices[0]["delta"] : undefined;
        if (!isRecord(delta)) continue;
        if (typeof delta["content"] === "string" && delta["content"] !== "") {
          yield { type: "text", delta: delta["content"] } satisfies ModelEvent;
        }
        const fragments = Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : [];
        for (const fragment of fragments) {
          if (!isRecord(fragment)) continue;
          const index = typeof fragment["index"] === "number" ? fragment["index"] : calls.size;
          const entry = calls.get(index) ?? { id: "", name: "", args: "" };
          if (typeof fragment["id"] === "string") entry.id = fragment["id"];
          const fn = fragment["function"];
          if (isRecord(fn)) {
            if (typeof fn["name"] === "string") entry.name += fn["name"];
            if (typeof fn["arguments"] === "string") entry.args += fn["arguments"];
          }
          calls.set(index, entry);
        }
      }
      for (const [index, call] of [...calls.entries()].sort(([a], [b]) => a - b)) {
        let input: unknown = {};
        if (call.args.trim() !== "") {
          try {
            input = JSON.parse(call.args);
          } catch {
            throw new ProviderError(
              "bad-response",
              `The model sent unreadable arguments for ${call.name}`,
            );
          }
        }
        yield {
          type: "tool_call",
          id: call.id === "" ? `call_${index}` : call.id,
          name: call.name,
          input,
        };
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
