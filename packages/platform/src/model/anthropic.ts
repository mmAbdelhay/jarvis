// Anthropic Messages API, native tool use, streamed (spec §4, "anthropic").
// Headers: x-api-key + anthropic-version. Tool input arrives as
// input_json_delta fragments per content block index and is parsed once the
// block stops.
import {
  type ModelEvent,
  type ModelMessage,
  type ModelProvider,
  ProviderError,
  isRecord,
} from "@jarvis/core";
import { type FetchLike, readJson, request, streamErrorText } from "./http.js";
import { probeProvider } from "./probe.js";
import { readSse } from "./stream.js";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";
const API_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4_096;

export type AnthropicOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetch: FetchLike;
  maxTokens?: number;
};

type Block = Record<string, unknown>;

/** History in Messages API form. Consecutive user-role entries (a tool
 *  result followed by a new prompt, after a stopped turn) are merged into
 *  one message, and an empty assistant turn gets a placeholder, because the
 *  API refuses both. */
export function toAnthropicMessages(messages: readonly ModelMessage[]): unknown[] {
  const out: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", content: Block[]) => {
    const last = out[out.length - 1];
    if (role === "user" && last?.role === "user") last.content.push(...content);
    else out.push({ role, content });
  };
  for (const message of messages) {
    if (message.role === "user") {
      push("user", [{ type: "text", text: message.text }]);
    } else if (message.role === "assistant") {
      const content: Block[] = [];
      if (message.text !== "") content.push({ type: "text", text: message.text });
      for (const call of message.toolCalls) {
        content.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: isRecord(call.input) ? call.input : {},
        });
      }
      push("assistant", content.length === 0 ? [{ type: "text", text: "…" }] : content);
    } else {
      push(
        "user",
        message.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.callId,
          content:
            result.image === undefined
              ? result.content
              : [
                  { type: "text", text: result.content },
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: result.image.mediaType,
                      data: result.image.dataBase64,
                    },
                  },
                ],
          is_error: result.isError,
        })),
      );
    }
  }
  return out;
}

export function createAnthropicProvider(options: AnthropicOptions): ModelProvider {
  const headers = {
    "content-type": "application/json",
    "x-api-key": options.apiKey,
    "anthropic-version": API_VERSION,
  };

  async function listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await request(
      options.fetch,
      `${options.baseUrl}/v1/models?limit=100`,
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
        max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
        system: chatRequest.system,
        messages: toAnthropicMessages(chatRequest.messages),
        stream: true,
        ...(chatRequest.tools.length === 0
          ? {}
          : {
              tools: chatRequest.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema,
              })),
            }),
      };
      const response = await request(
        options.fetch,
        `${options.baseUrl}/v1/messages`,
        { method: "POST", headers, body: JSON.stringify(body), signal: chatRequest.signal },
        options.apiKey,
      );
      if (response.body === null)
        throw new ProviderError("bad-response", "The provider sent no body");
      let inputTokens = 0;
      let outputTokens = 0;
      const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
      for await (const sse of readSse(response.body)) {
        let data: unknown;
        try {
          data = JSON.parse(sse.data);
        } catch {
          throw new ProviderError("bad-response", "The provider sent an event that is not JSON");
        }
        if (!isRecord(data)) continue;
        const index = typeof data["index"] === "number" ? data["index"] : -1;
        switch (data["type"]) {
          case "message_start": {
            const usage = isRecord(data["message"]) ? data["message"]["usage"] : undefined;
            if (isRecord(usage) && typeof usage["input_tokens"] === "number")
              inputTokens = usage["input_tokens"];
            break;
          }
          case "content_block_start": {
            const block = data["content_block"];
            if (
              isRecord(block) &&
              block["type"] === "tool_use" &&
              typeof block["id"] === "string" &&
              typeof block["name"] === "string"
            ) {
              toolBlocks.set(index, { id: block["id"], name: block["name"], json: "" });
            }
            break;
          }
          case "content_block_delta": {
            const delta = data["delta"];
            if (!isRecord(delta)) break;
            if (
              delta["type"] === "text_delta" &&
              typeof delta["text"] === "string" &&
              delta["text"] !== ""
            ) {
              yield { type: "text", delta: delta["text"] } satisfies ModelEvent;
            } else if (
              delta["type"] === "input_json_delta" &&
              typeof delta["partial_json"] === "string"
            ) {
              const tool = toolBlocks.get(index);
              if (tool !== undefined) tool.json += delta["partial_json"];
            }
            break;
          }
          case "content_block_stop": {
            const tool = toolBlocks.get(index);
            if (tool === undefined) break;
            toolBlocks.delete(index);
            let input: unknown = {};
            if (tool.json.trim() !== "") {
              try {
                input = JSON.parse(tool.json);
              } catch {
                throw new ProviderError(
                  "bad-response",
                  `The model sent unreadable input for ${tool.name}`,
                );
              }
            }
            yield { type: "tool_call", id: tool.id, name: tool.name, input };
            break;
          }
          case "message_delta": {
            const usage = data["usage"];
            if (isRecord(usage) && typeof usage["output_tokens"] === "number")
              outputTokens = usage["output_tokens"];
            break;
          }
          case "error": {
            const error = data["error"];
            const message =
              isRecord(error) && typeof error["message"] === "string"
                ? error["message"]
                : "stream error";
            throw new ProviderError("http", streamErrorText(message, options.apiKey));
          }
          default:
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
