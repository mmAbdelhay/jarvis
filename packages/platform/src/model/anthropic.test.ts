import { readFileSync } from "node:fs";
import { type ModelEvent, type ModelMessage, ProviderError } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { createAnthropicProvider, toAnthropicMessages } from "./anthropic.js";
import { recordingFetch, streamResponse } from "./http-double.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const tools = [
  {
    name: "net_status",
    description: "Network status",
    inputSchema: { type: "object", properties: {} },
  },
];

describe("createAnthropicProvider.chat", () => {
  it("streams text, tool calls with assembled JSON input, and usage", async () => {
    const { fetch, calls } = recordingFetch([streamResponse(fixture("anthropic-tool-stream.sse"))]);
    const provider = createAnthropicProvider({
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-5",
      apiKey: "sk-ant-test",
      fetch,
    });
    const events = await collect(
      provider.chat({
        system: "sys",
        messages: [{ role: "user", text: "my internet isn't working" }],
        tools,
        signal: new AbortController().signal,
      }),
    );
    expect(events).toEqual([
      { type: "text", delta: "Let me check " },
      { type: "text", delta: "the network." },
      { type: "tool_call", id: "toolu_01A", name: "net_status", input: {} },
      {
        type: "tool_call",
        id: "toolu_01B",
        name: "logs_query",
        input: { unit: "NetworkManager", limit: 50 },
      },
      { type: "done", usage: { inputTokens: 412, outputTokens: 87 } },
    ]);
    const call = calls[0];
    expect(call?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(call?.init.headers["x-api-key"]).toBe("sk-ant-test");
    expect(call?.init.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(call?.init.body ?? "{}") as Record<string, unknown>;
    expect(body["model"]).toBe("claude-sonnet-4-5");
    expect(body["stream"]).toBe(true);
    expect(body["system"]).toBe("sys");
    expect(body["tools"]).toEqual([
      {
        name: "net_status",
        description: "Network status",
        input_schema: { type: "object", properties: {} },
      },
    ]);
  });

  it("keeps Arabic text intact across 7-byte chunks", async () => {
    const { fetch } = recordingFetch([streamResponse(fixture("anthropic-arabic-stream.sse"))]);
    const provider = createAnthropicProvider({
      baseUrl: "https://api.anthropic.com",
      model: "m",
      apiKey: "k",
      fetch,
    });
    const events = await collect(
      provider.chat({
        system: "",
        messages: [{ role: "user", text: "?" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    );
    expect(events[0]).toEqual({ type: "text", delta: "الشبكة تعمل الآن ✓" });
  });

  it("maps 401 to an auth error with the key scrubbed from the message", async () => {
    const { fetch } = recordingFetch([
      new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "invalid x-api-key sk-ant-bad" },
        }),
        { status: 401 },
      ),
    ]);
    const provider = createAnthropicProvider({
      baseUrl: "https://api.anthropic.com",
      model: "m",
      apiKey: "sk-ant-bad",
      fetch,
    });
    const failure = await collect(
      provider.chat({
        system: "",
        messages: [{ role: "user", text: "?" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect((failure as ProviderError).kind).toBe("auth");
    expect((failure as ProviderError).message).not.toContain("sk-ant-bad");
  });

  it("maps a refused connection to a network error", async () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const { fetch } = recordingFetch([refused]);
    const provider = createAnthropicProvider({
      baseUrl: "https://api.anthropic.com",
      model: "m",
      apiKey: "k",
      fetch,
    });
    const failure = await collect(
      provider.chat({
        system: "",
        messages: [{ role: "user", text: "?" }],
        tools: [],
        signal: new AbortController().signal,
      }),
    ).catch((error: unknown) => error);
    expect((failure as ProviderError).kind).toBe("network");
    expect((failure as ProviderError).message).toContain("ECONNREFUSED");
  });
  it.each(["stream", "json", "text"])(
    "scrubs keys before truncation in %s errors",
    async (kind) => {
      const apiKey = "sk-ant-private-key";
      const message = "x".repeat(kind === "text" ? 190 : 285) + apiKey;
      const response =
        kind === "stream"
          ? streamResponse(`data: ${JSON.stringify({ type: "error", error: { message } })}\n\n`)
          : new Response(kind === "json" ? JSON.stringify({ error: { message } }) : message, {
              status: 400,
            });
      const { fetch } = recordingFetch([response]);
      const provider = createAnthropicProvider({
        baseUrl: "https://api.anthropic.com",
        model: "m",
        apiKey,
        fetch,
      });
      const failure = await collect(
        provider.chat({
          system: "",
          messages: [],
          tools: [],
          signal: new AbortController().signal,
        }),
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderError);
      expect((failure as ProviderError).message).not.toContain("sk-ant-");
    },
  );
});

describe("createAnthropicProvider.listModels", () => {
  it('lists model ids without a chat request (provider:probe with model "")', async () => {
    const { fetch, calls } = recordingFetch([
      new Response(fixture("anthropic-models.json"), { status: 200 }),
    ]);
    const provider = createAnthropicProvider({
      baseUrl: "https://api.anthropic.com",
      model: "",
      apiKey: "k",
      fetch,
    });
    await expect(provider.listModels()).resolves.toEqual(["claude-sonnet-4-5", "claude-haiku-4-5"]);
    expect(calls).toHaveLength(1);
  });
});

describe("toAnthropicMessages", () => {
  it("maps history: tool_use blocks, tool_result blocks, merged consecutive user turns", () => {
    const history: ModelMessage[] = [
      { role: "user", text: "install vlc" },
      {
        role: "assistant",
        text: "Installing.",
        toolCalls: [{ id: "c1", name: "pkg_install", input: { items: [] } }],
      },
      {
        role: "tool",
        results: [
          {
            callId: "c1",
            name: "pkg_install",
            content: "<untrusted-data>ok</untrusted-data>",
            isError: false,
          },
        ],
      },
      { role: "user", text: "thanks" },
      { role: "assistant", text: "", toolCalls: [] },
    ];
    expect(toAnthropicMessages(history)).toEqual([
      { role: "user", content: [{ type: "text", text: "install vlc" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Installing." },
          { type: "tool_use", id: "c1", name: "pkg_install", input: { items: [] } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "c1",
            content: "<untrusted-data>ok</untrusted-data>",
            is_error: false,
          },
          { type: "text", text: "thanks" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "…" }] },
    ]);
  });
});
