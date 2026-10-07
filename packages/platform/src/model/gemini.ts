// packages/platform/src/model/gemini.ts
// Gemini's generateContent API (M2 design §10, contracts §3 kind "gemini"):
// streamGenerateContent?alt=sse with functionDeclarations, function calls
// that arrive whole inside one chunk (numbered here: Gemini's own ids are not
// relied on), function responses sent back as user turns, models.list for
// the model picker and probe. The key travels only in x-goog-api-key, never
// in a URL, and every error text is scrubbed of it (M1 streamErrorText).
// Gemini answers a bad key with 400 "API key not valid"; that becomes an
// auth error so provider:status and the probe say what is wrong.
import { isRecord, type ModelEvent, type ModelProvider, ProviderError } from "@jarvis/core";
import {
  createThoughtSignatures,
  geminiApiRoot,
  geminiModelPath,
  geminiNameMap,
  needsThoughtSignatures,
  toGeminiContents,
  toGeminiTools,
} from "./gemini-format.js";
import { type FetchLike, readJson, request, streamErrorText } from "./http.js";
import { probeProvider } from "./probe.js";
import { readSse } from "./stream.js";

export type GeminiOptions = {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetch: FetchLike;
  maxTokens?: number;
};

const MAX_MODEL_PAGES = 10;

const count = (value: unknown): number => (typeof value === "number" && value >= 0 ? value : 0);

export function createGeminiProvider(options: GeminiOptions): ModelProvider {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-goog-api-key": options.apiKey,
  };
  const root = geminiApiRoot(options.baseUrl);
  const signatures = createThoughtSignatures();
  const dummySignatures = needsThoughtSignatures(options.model);
  let callCounter = 0;

  async function call(url: string, init: Parameters<FetchLike>[1]): Promise<Response> {
    try {
      return await request(options.fetch, url, init, options.apiKey);
    } catch (error) {
      if (
        error instanceof ProviderError &&
        error.kind === "http" &&
        error.status === 400 &&
        /api key/i.test(error.message)
      ) {
        throw new ProviderError("auth", error.message, 400);
      }
      throw error;
    }
  }

  async function listModels(signal?: AbortSignal): Promise<string[]> {
    const out: string[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const query = new URLSearchParams({ pageSize: "1000" });
      if (pageToken !== undefined) query.set("pageToken", pageToken);
      const response = await call(`${root}/models?${query.toString()}`, {
        method: "GET",
        headers,
        ...(signal === undefined ? {} : { signal }),
      });
      const body = await readJson(response, "models");
      const models = isRecord(body) && Array.isArray(body["models"]) ? body["models"] : [];
      for (const model of models) {
        if (!isRecord(model) || typeof model["name"] !== "string") continue;
        const methods = Array.isArray(model["supportedGenerationMethods"])
          ? model["supportedGenerationMethods"]
          : [];
        if (!methods.includes("generateContent")) continue;
        out.push(model["name"].replace(/^models\//, ""));
      }
      const next = isRecord(body) ? body["nextPageToken"] : undefined;
      if (typeof next !== "string" || next === "") break;
      pageToken = next;
    }
    return out;
  }

  const provider: ModelProvider = {
    async *chat(chatRequest) {
      const names = geminiNameMap(chatRequest.tools);
      const tools = toGeminiTools(chatRequest.tools);
      const body = {
        systemInstruction: { parts: [{ text: chatRequest.system }] },
        contents: toGeminiContents(chatRequest.messages, signatures, { dummySignatures }),
        ...(tools.length === 0 ? {} : { tools }),
        ...(options.maxTokens === undefined
          ? {}
          : { generationConfig: { maxOutputTokens: options.maxTokens } }),
      };
      const response = await call(
        `${root}/${geminiModelPath(options.model)}:streamGenerateContent?alt=sse`,
        { method: "POST", headers, body: JSON.stringify(body), signal: chatRequest.signal },
      );
      if (response.body === null)
        throw new ProviderError("bad-response", "The provider sent no body");
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const sse of readSse(response.body)) {
        let chunk: unknown;
        try {
          chunk = JSON.parse(sse.data);
        } catch {
          throw new ProviderError("bad-response", "Gemini sent a chunk that is not JSON");
        }
        if (!isRecord(chunk)) continue;
        if (isRecord(chunk["error"])) {
          const message = chunk["error"]["message"];
          throw new ProviderError(
            "http",
            streamErrorText(typeof message === "string" ? message : "stream error", options.apiKey),
          );
        }
        const feedback = chunk["promptFeedback"];
        if (isRecord(feedback) && typeof feedback["blockReason"] === "string") {
          throw new ProviderError(
            "http",
            streamErrorText(
              `Gemini refused the request (${feedback["blockReason"]})`,
              options.apiKey,
            ),
          );
        }
        const usage = chunk["usageMetadata"];
        if (isRecord(usage)) {
          if (typeof usage["promptTokenCount"] === "number")
            inputTokens = usage["promptTokenCount"];
          const produced =
            count(usage["candidatesTokenCount"]) + count(usage["thoughtsTokenCount"]);
          if (produced > 0) outputTokens = produced;
        }
        const candidates = Array.isArray(chunk["candidates"]) ? chunk["candidates"] : [];
        const candidate = candidates[0];
        if (!isRecord(candidate)) continue;
        if (candidate["finishReason"] === "MALFORMED_FUNCTION_CALL") {
          throw new ProviderError(
            "bad-response",
            "The model sent a tool call Gemini could not read",
          );
        }
        const content = candidate["content"];
        const parts = isRecord(content) && Array.isArray(content["parts"]) ? content["parts"] : [];
        for (const part of parts) {
          if (!isRecord(part) || part["thought"] === true) continue;
          if (typeof part["text"] === "string" && part["text"] !== "") {
            yield { type: "text", delta: part["text"] } satisfies ModelEvent;
          }
          const fn = part["functionCall"];
          if (isRecord(fn) && typeof fn["name"] === "string") {
            callCounter += 1;
            const id = `gemini-${callCounter}`;
            if (typeof part["thoughtSignature"] === "string") {
              signatures.set(id, part["thoughtSignature"]);
            }
            yield {
              type: "tool_call",
              id,
              name: names.get(fn["name"]) ?? fn["name"],
              input: isRecord(fn["args"]) ? fn["args"] : {},
            };
          }
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
