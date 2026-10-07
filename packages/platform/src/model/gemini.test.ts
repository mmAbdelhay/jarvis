// packages/platform/src/model/gemini.test.ts
import { readFileSync } from "node:fs";
import type { ModelEvent, ModelToolCall, ModelToolSpec } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { createGeminiProvider } from "./gemini.js";
import { recordingFetch, streamResponse } from "./http-double.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const BASE = "https://generativelanguage.googleapis.com";
const KEY = "AIza-test-key-123";
const STREAM_URL = `${BASE}/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse`;
const tools: ModelToolSpec[] = [
  {
    name: "net_status",
    description: "Network status",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "pkg_search",
    description: "Search apps",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  },
];
const signal = () => new AbortController().signal;
const oneText = (text: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }], role: "model" }, finishReason: "STOP" }] })}\n\n`;
const badKey = () =>
  new Response(
    JSON.stringify({
      error: {
        code: 400,
        message: "API key not valid. Please pass a valid API key.",
        status: "INVALID_ARGUMENT",
      },
    }),
    { status: 400 },
  );

describe("createGeminiProvider.chat", () => {
  it("streams text (skipping thoughts), numbered tool calls, and usage; the key is a header only", async () => {
    const { fetch, calls } = recordingFetch([streamResponse(fixture("gemini-tool-stream.sse"))]);
    const provider = createGeminiProvider({
      baseUrl: BASE,
      model: "gemini-2.5-flash",
      apiKey: KEY,
      fetch,
    });
    const events = await collect(
      provider.chat({
        system: "sys",
        messages: [{ role: "user", text: "is my network ok?" }],
        tools,
        signal: signal(),
      }),
    );
    expect(events).toEqual([
      { type: "text", delta: "سأتحقق من الشبكة." },
      { type: "tool_call", id: "gemini-1", name: "net_status", input: {} },
      { type: "tool_call", id: "gemini-2", name: "pkg.search", input: { query: "vlc" } },
      { type: "done", usage: { inputTokens: 210, outputTokens: 43 } },
    ]);
    expect(calls[0]?.url).toBe(STREAM_URL);
    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[0]?.init.headers["x-goog-api-key"]).toBe(KEY);
    expect(calls[0]?.init.headers["authorization"]).toBeUndefined();
    const body = JSON.parse(calls[0]?.init.body ?? "{}") as Record<string, unknown>;
    expect(body["systemInstruction"]).toEqual({ parts: [{ text: "sys" }] });
    expect(body["contents"]).toEqual([{ role: "user", parts: [{ text: "is my network ok?" }] }]);
    expect(body["tools"]).toEqual([
      {
        functionDeclarations: [
          {
            name: "net_status",
            description: "Network status",
            parametersJsonSchema: { type: "object", properties: {} },
          },
          {
            name: "pkg_search",
            description: "Search apps",
            parametersJsonSchema: { type: "object", properties: { query: { type: "string" } } },
          },
        ],
      },
    ]);
    expect(body).not.toHaveProperty("generationConfig");
  });

  it("sends the stored thought signature back with the call it came with, and the results", async () => {
    const { fetch, calls } = recordingFetch([
      streamResponse(fixture("gemini-tool-stream.sse")),
      streamResponse(oneText("Your network is fine.")),
    ]);
    const provider = createGeminiProvider({
      baseUrl: BASE,
      model: "gemini-2.5-flash",
      apiKey: KEY,
      fetch,
    });
    const first = await collect(
      provider.chat({
        system: "sys",
        messages: [{ role: "user", text: "is my network ok?" }],
        tools,
        signal: signal(),
      }),
    );
    const toolCalls: ModelToolCall[] = first.flatMap((e) =>
      e.type === "tool_call" ? [{ id: e.id, name: e.name, input: e.input }] : [],
    );
    await collect(
      provider.chat({
        system: "sys",
        messages: [
          { role: "user", text: "is my network ok?" },
          { role: "assistant", text: "سأتحقق من الشبكة.", toolCalls },
          {
            role: "tool",
            results: toolCalls.map((c) => ({
              callId: c.id,
              name: c.name,
              content: "ok",
              isError: false,
            })),
          },
        ],
        tools,
        signal: signal(),
      }),
    );
    const body = JSON.parse(calls[1]?.init.body ?? "{}") as { contents: { parts: unknown[] }[] };
    expect(body.contents[1]?.parts).toEqual([
      { text: "سأتحقق من الشبكة." },
      { functionCall: { name: "net_status", args: {} }, thoughtSignature: "CiQBVKhc7sig-1" },
      { functionCall: { name: "pkg.search", args: { query: "vlc" } } },
    ]);
    expect(body.contents[2]?.parts).toEqual([
      { functionResponse: { name: "net_status", response: { output: "ok" } } },
      { functionResponse: { name: "pkg.search", response: { output: "ok" } } },
    ]);
  });

  it("declares a name Gemini refuses under a prefix and maps the call back", async () => {
    const answer = `data: ${JSON.stringify({
      candidates: [
        {
          content: { parts: [{ functionCall: { name: "_2fa_check", args: {} } }], role: "model" },
          finishReason: "STOP",
        },
      ],
    })}\n\n`;
    const { fetch, calls } = recordingFetch([streamResponse(answer)]);
    const provider = createGeminiProvider({
      baseUrl: BASE,
      model: "gemini-2.5-flash",
      apiKey: KEY,
      fetch,
    });
    const events = await collect(
      provider.chat({
        system: "",
        messages: [{ role: "user", text: "x" }],
        tools: [{ name: "2fa_check", description: "", inputSchema: { type: "object" } }],
        signal: signal(),
      }),
    );
    expect(events[0]).toEqual({ type: "tool_call", id: "gemini-1", name: "2fa_check", input: {} });
    expect(calls[0]?.init.body).toContain('"name":"_2fa_check"');
  });

  it("reads CRLF-separated events, honours maxTokens and an explicit /v1beta base URL", async () => {
    const crlf = `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "hi" }], role: "model" }, finishReason: "STOP" }] })}\r\n\r\n`;
    const { fetch, calls } = recordingFetch([streamResponse(crlf)]);
    const provider = createGeminiProvider({
      baseUrl: `${BASE}/v1beta`,
      model: "gemini-2.5-flash",
      apiKey: KEY,
      fetch,
      maxTokens: 1024,
    });
    const events = await collect(
      provider.chat({
        system: "",
        messages: [{ role: "user", text: "x" }],
        tools: [],
        signal: signal(),
      }),
    );
    expect(events[0]).toEqual({ type: "text", delta: "hi" });
    expect(calls[0]?.url).toBe(STREAM_URL);
    const body = JSON.parse(calls[0]?.init.body ?? "{}") as Record<string, unknown>;
    expect(body["generationConfig"]).toEqual({ maxOutputTokens: 1024 });
    expect(body).not.toHaveProperty("tools");
  });

  it("maps Gemini's 400 'API key not valid' to an auth error", async () => {
    const { fetch } = recordingFetch([badKey(), badKey()]);
    const provider = createGeminiProvider({
      baseUrl: BASE,
      model: "gemini-2.5-flash",
      apiKey: KEY,
      fetch,
    });
    await expect(provider.reachable()).resolves.toEqual({
      ok: false,
      error: "400 API key not valid. Please pass a valid API key.",
    });
    const failure = await collect(
      provider.chat({
        system: "",
        messages: [{ role: "user", text: "x" }],
        tools: [],
        signal: signal(),
      }),
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ProviderError", kind: "auth", status: 400 });
  });

  it("scrubs the key from HTTP and in-stream errors and caps them at 300 characters", async () => {
    const message = `${"x".repeat(285)}${KEY} ${"z".repeat(5000)}`;
    const { fetch } = recordingFetch([
      new Response(JSON.stringify({ error: { message: `upstream rejected ${KEY}` } }), {
        status: 500,
      }),
      streamResponse(`data: ${JSON.stringify({ error: { code: 500, message } })}\n\n`),
    ]);
    const provider = createGeminiProvider({
      baseUrl: BASE,
      model: "gemini-2.5-flash",
      apiKey: KEY,
      fetch,
    });
    const request = () =>
      collect(
        provider.chat({
          system: "",
          messages: [{ role: "user", text: "x" }],
          tools: [],
          signal: signal(),
        }),
      ).then(
        () => {
          throw new Error("Expected the provider request to fail");
        },
        (error: unknown) => {
          if (!(error instanceof Error)) throw error;
          return error;
        },
      );
    const http = await request();
    expect(http.message).not.toContain(KEY);
    expect(http.message).toContain("[key]");
    const inStream = await request();
    expect(inStream.message).not.toContain("AIza");
    expect(inStream.message.length).toBeLessThanOrEqual(300);
  });

  it("refuses a malformed function call and a blocked prompt with clear errors", async () => {
    const malformed = `data: ${JSON.stringify({ candidates: [{ content: { parts: [], role: "model" }, finishReason: "MALFORMED_FUNCTION_CALL" }] })}\n\n`;
    const blocked = `data: ${JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })}\n\n`;
    const { fetch } = recordingFetch([streamResponse(malformed), streamResponse(blocked)]);
    const provider = createGeminiProvider({
      baseUrl: BASE,
      model: "gemini-2.5-flash",
      apiKey: KEY,
      fetch,
    });
    const run = () =>
      collect(
        provider.chat({
          system: "",
          messages: [{ role: "user", text: "x" }],
          tools,
          signal: signal(),
        }),
      ).catch((error: unknown) => error);
    expect(await run()).toMatchObject({ kind: "bad-response" });
    const second = await run();
    expect(second).toMatchObject({ kind: "http" });
    expect((second as Error).message).toContain("SAFETY");
  });
});

describe("createGeminiProvider.listModels and probe", () => {
  it("lists generateContent models without the models/ prefix, following page tokens", async () => {
    const page1 = {
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
      ],
      nextPageToken: "p2",
    };
    const page2 = {
      models: [
        { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ],
    };
    const { fetch, calls } = recordingFetch([
      new Response(JSON.stringify(page1), { status: 200 }),
      new Response(JSON.stringify(page2), { status: 200 }),
    ]);
    const provider = createGeminiProvider({ baseUrl: BASE, model: "", apiKey: KEY, fetch });
    await expect(provider.listModels()).resolves.toEqual(["gemini-2.5-flash", "gemini-2.5-pro"]);
    expect(calls[0]?.url).toBe(`${BASE}/v1beta/models?pageSize=1000`);
    expect(calls[1]?.url).toBe(`${BASE}/v1beta/models?pageSize=1000&pageToken=p2`);
    expect(calls[0]?.init.headers["x-goog-api-key"]).toBe(KEY);
  });

  it("probes like the M1 adapters: models, then one tool call", async () => {
    const { fetch, calls } = recordingFetch([
      new Response(fixture("gemini-models.json"), { status: 200 }),
      streamResponse(fixture("gemini-tool-stream.sse")),
    ]);
    const provider = createGeminiProvider({
      baseUrl: BASE,
      model: "gemini-2.5-flash",
      apiKey: KEY,
      fetch,
    });
    await expect(provider.probe()).resolves.toEqual({
      ok: true,
      supportsTools: true,
      models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    });
    expect(calls[1]?.url).toBe(STREAM_URL);
    expect(calls[1]?.init.body).toContain('"name":"ping"');
  });
});
