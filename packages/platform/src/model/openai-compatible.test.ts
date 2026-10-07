import { readFileSync } from "node:fs";
import type { ModelEvent, ModelMessage } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { recordingFetch, streamResponse } from "./http-double.js";
import { createOpenAiCompatibleProvider, toOpenAiMessages } from "./openai-compatible.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("createOpenAiCompatibleProvider.chat", () => {
  it("scrubs the key from in-stream errors before capping them at 300 characters", async () => {
    const apiKey = "sk-private-key";
    const message = `${"x".repeat(285)}${apiKey} ${"z".repeat(5000)}`;
    const { fetch } = recordingFetch([
      streamResponse(`data: ${JSON.stringify({ error: { message } })}\n\n`),
    ]);
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      model: "m",
      apiKey,
      fetch,
    });
    const failure = await collect(
      provider.chat({ system: "", messages: [], tools: [], signal: new AbortController().signal }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain("sk-");
    expect((failure as Error).message.length).toBeLessThanOrEqual(300);
  });

  it("streams text, assembles fragmented tool-call arguments per index, reads usage", async () => {
    const { fetch, calls } = recordingFetch([streamResponse(fixture("openai-tool-stream.sse"))]);
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "sk-test",
      fetch,
    });
    const events = await collect(
      provider.chat({
        system: "sys",
        messages: [{ role: "user", text: "find vlc" }],
        tools: [{ name: "pkg_search", description: "Search", inputSchema: { type: "object" } }],
        signal: new AbortController().signal,
      }),
    );
    expect(events).toEqual([
      { type: "text", delta: "Checking." },
      { type: "tool_call", id: "call_abc", name: "pkg_search", input: { query: "vlc" } },
      { type: "tool_call", id: "call_def", name: "disk_usage", input: {} },
      { type: "done", usage: { inputTokens: 120, outputTokens: 18 } },
    ]);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.init.headers["authorization"]).toBe("Bearer sk-test");
    const body = JSON.parse(calls[0]?.init.body ?? "{}") as Record<string, unknown>;
    expect(body["stream"]).toBe(true);
    expect(body["tools"]).toEqual([
      {
        type: "function",
        function: { name: "pkg_search", description: "Search", parameters: { type: "object" } },
      },
    ]);
  });

  it("sends no Authorization header for a keyless local server", async () => {
    const { fetch, calls } = recordingFetch([streamResponse("data: [DONE]\n\n")]);
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "http://localhost:1234/v1",
      model: "local",
      fetch,
    });
    await collect(
      provider.chat({
        system: "",
        messages: [{ role: "user", text: "hi" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );
    expect(calls[0]?.init.headers["authorization"]).toBeUndefined();
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).not.toHaveProperty("tools");
  });

  it("lists models from /models", async () => {
    const { fetch, calls } = recordingFetch([
      new Response(fixture("openai-models.json"), { status: 200 }),
      streamResponse(fixture("openai-tool-stream.sse")),
    ]);
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4.1-mini",
      apiKey: "k",
      fetch,
    });
    const result = await provider.probe();
    expect(result).toEqual({ ok: true, supportsTools: true, models: ["gpt-4.1-mini", "gpt-4.1"] });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
  });
});

describe("createOpenAiCompatibleProvider.listModels", () => {
  it("lists model ids without a chat request", async () => {
    const { fetch, calls } = recordingFetch([
      new Response(fixture("openai-models.json"), { status: 200 }),
    ]);
    const provider = createOpenAiCompatibleProvider({
      baseUrl: "https://api.openai.com/v1",
      model: "",
      apiKey: "k",
      fetch,
    });
    await expect(provider.listModels()).resolves.toEqual(["gpt-4.1-mini", "gpt-4.1"]);
    expect(calls).toHaveLength(1);
  });
});

describe("toOpenAiMessages", () => {
  it("puts the system first, tool calls as functions with JSON-string arguments, one tool message per result", () => {
    const history: ModelMessage[] = [
      { role: "user", text: "find vlc" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "c1", name: "pkg_search", input: { query: "vlc" } }],
      },
      {
        role: "tool",
        results: [{ callId: "c1", name: "pkg_search", content: "fenced", isError: true }],
      },
    ];
    expect(toOpenAiMessages("sys", history)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "find vlc" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "pkg_search", arguments: '{"query":"vlc"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "ERROR: fenced" },
    ]);
  });
});
