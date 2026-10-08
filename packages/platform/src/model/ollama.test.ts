import { readFileSync } from "node:fs";
import { type ModelEvent, type ModelMessage, ProviderError } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { recordingFetch, streamResponse } from "./http-double.js";
import { createOllamaProvider, toOllamaMessages } from "./ollama.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8");

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const signal = () => new AbortController().signal;

describe("createOllamaProvider.chat", () => {
  it("asks Ollama for an 8k context so it never cuts the front of the prompt", async () => {
    const { fetch, calls } = recordingFetch([
      streamResponse('{"message":{"content":"hi"},"done":true}\n'),
    ]);
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434", model: "m", fetch });
    await collect(provider.chat({ system: "s", messages: [], tools: [], signal: signal() }));
    expect(JSON.parse(calls[0]?.init.body ?? "{}").options).toEqual({ num_ctx: 8192 });
  });

  it("scrubs proxy keys from in-stream errors", async () => {
    const { fetch } = recordingFetch([streamResponse('{"error":"rejected proxy-secret"}\n')]);
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "big",
      apiKey: "proxy-secret",
      fetch,
    });
    await expect(
      collect(provider.chat({ system: "", messages: [], tools: [], signal: signal() })),
    ).rejects.toThrow("rejected [key]");
  });

  it("caps in-stream error messages at 300 characters", async () => {
    const { fetch } = recordingFetch([
      streamResponse(`${JSON.stringify({ error: "e".repeat(5000) })}\n`),
    ]);
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "big",
      fetch,
    });
    const failure = await collect(
      provider.chat({ system: "", messages: [], tools: [], signal: signal() }),
    ).catch((error: unknown) => error);
    expect((failure as Error).message.length).toBeLessThanOrEqual(300);
  });

  it("numbers calls across requests without trusting wire ids", async () => {
    const chunk =
      '{"message":{"tool_calls":[{"id":"duplicate","function":{"name":"ping","arguments":{}}}]},"done":true}\n';
    const { fetch } = recordingFetch([streamResponse(chunk), streamResponse(chunk)]);
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "qwen3:8b",
      fetch,
    });
    for (const id of ["ollama-1", "ollama-2"]) {
      const events = await collect(
        provider.chat({ system: "", messages: [], tools: [], signal: signal() }),
      );
      expect(events[0]).toEqual({ type: "tool_call", id, name: "ping", input: {} });
    }
  });

  it("streams NDJSON text and whole tool calls, numbering them", async () => {
    const { fetch, calls } = recordingFetch([
      streamResponse(fixture("ollama-tool-stream.ndjson"), { contentType: "application/x-ndjson" }),
    ]);
    const provider = createOllamaProvider({
      baseUrl: "http://192.168.1.20:11434",
      model: "qwen3:8b",
      fetch,
    });
    const events = await collect(
      provider.chat({
        system: "sys",
        messages: [{ role: "user", text: "find vlc" }],
        tools: [{ name: "pkg_search", description: "Search", inputSchema: { type: "object" } }],
        signal: signal(),
      }),
    );
    expect(events).toEqual([
      { type: "text", delta: "Looking" },
      { type: "text", delta: " it up." },
      { type: "tool_call", id: "ollama-1", name: "pkg_search", input: { query: "vlc" } },
      { type: "done", usage: { inputTokens: 98, outputTokens: 21 } },
    ]);
    expect(calls[0]?.url).toBe("http://192.168.1.20:11434/api/chat");
    const body = JSON.parse(calls[0]?.init.body ?? "{}") as Record<string, unknown>;
    expect(body["model"]).toBe("qwen3:8b");
    expect(body["stream"]).toBe(true);
  });

  it("turns an in-stream error line into a ProviderError", async () => {
    const { fetch } = recordingFetch([
      streamResponse('{"error":"model requires more system memory"}\n', {
        contentType: "application/x-ndjson",
      }),
    ]);
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "big",
      fetch,
    });
    await expect(
      collect(
        provider.chat({
          system: "",
          messages: [{ role: "user", text: "?" }],
          tools: [],
          signal: signal(),
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("treats 'does not support tools' (400) as a chat-only model in probe", async () => {
    const { fetch } = recordingFetch([
      new Response(fixture("ollama-tags.json"), { status: 200 }),
      new Response('{"error":"registry.ollama.ai/library/gemma3:4b does not support tools"}', {
        status: 400,
      }),
      streamResponse(
        '{"message":{"role":"assistant","content":"pong"},"done":true,"prompt_eval_count":1,"eval_count":1}\n',
      ),
    ]);
    const provider = createOllamaProvider({
      baseUrl: "http://localhost:11434",
      model: "gemma3:4b",
      fetch,
    });
    await expect(provider.probe()).resolves.toEqual({
      ok: true,
      supportsTools: false,
      models: ["qwen3:8b", "gemma3:4b"],
    });
  });
});

describe("createOllamaProvider.listModels", () => {
  it("lists installed models from /api/tags", async () => {
    const { fetch, calls } = recordingFetch([
      new Response(fixture("ollama-tags.json"), { status: 200 }),
    ]);
    const provider = createOllamaProvider({ baseUrl: "http://localhost:11434", model: "", fetch });
    await expect(provider.listModels()).resolves.toEqual(["qwen3:8b", "gemma3:4b"]);
    expect(calls[0]?.url).toBe("http://localhost:11434/api/tags");
  });
});

describe("toOllamaMessages", () => {
  it("sends tool calls with object arguments and tool results with tool_name", () => {
    const history: ModelMessage[] = [
      { role: "user", text: "find vlc" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "ollama-1", name: "pkg_search", input: { query: "vlc" } }],
      },
      {
        role: "tool",
        results: [{ callId: "ollama-1", name: "pkg_search", content: "fenced", isError: false }],
      },
    ];
    expect(toOllamaMessages("sys", history)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "find vlc" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "pkg_search", arguments: { query: "vlc" } } }],
      },
      { role: "tool", content: "fenced", tool_name: "pkg_search" },
    ]);
  });
});
