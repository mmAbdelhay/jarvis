import type { ModelEvent } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import type { BrainSdkMessage, SdkQueryFn } from "../brain.js";
import { createAnthropicSubscriptionProvider, renderTranscript } from "./anthropic-subscription.js";

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function fakeQuery(reply: string) {
  const seen: { prompt: string; options: Record<string, unknown> }[] = [];
  const query: SdkQueryFn = (params) => {
    seen.push({
      prompt: params.prompt,
      options: (params.options ?? {}) as Record<string, unknown>,
    });
    const messages: BrainSdkMessage[] = [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", message: { content: [{ type: "text", text: reply }] } },
    ];
    return (async function* () {
      yield* messages;
    })();
  };
  return { query, seen };
}

describe("createAnthropicSubscriptionProvider", () => {
  it("turns fenced jarvis-tool blocks into tool_call events and keeps the prose", async () => {
    const { query, seen } = fakeQuery(
      'Checking.\n```jarvis-tool\n{ "name": "net_status", "input": {} }\n```',
    );
    const provider = createAnthropicSubscriptionProvider({
      cwd: "/tmp/brain",
      query,
      env: { ANTHROPIC_API_KEY: "x", PATH: "/bin" },
    });
    const events = await collect(
      provider.chat({
        system: "sys",
        messages: [{ role: "user", text: "is the network ok?" }],
        tools: [
          {
            name: "net_status",
            description: "Network status",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        signal: new AbortController().signal,
      }),
    );
    expect(events).toEqual([
      { type: "text", delta: "Checking." },
      { type: "tool_call", id: "sub-1", name: "net_status", input: {} },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    const options = seen[0]?.options ?? {};
    expect(options["settingSources"]).toEqual([]);
    expect(options["tools"]).toEqual([]);
    expect((options["env"] as Record<string, string>)["ANTHROPIC_API_KEY"]).toBeUndefined();
  });

  it("renders the whole transcript, tools and results into one prompt", () => {
    const prompt = renderTranscript(
      "sys",
      [
        { role: "user", text: "install vlc" },
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "c1", name: "pkg_install", input: { items: [] } }],
        },
        {
          role: "tool",
          results: [{ callId: "c1", name: "pkg_install", content: "denied", isError: false }],
        },
      ],
      [{ name: "pkg_install", description: "Install apps", inputSchema: { type: "object" } }],
    );
    expect(prompt).toContain("sys");
    expect(prompt).toContain("- pkg_install: Install apps");
    expect(prompt).toContain("User: install vlc");
    expect(prompt).toContain('Assistant called pkg_install {"items":[]}');
    expect(prompt).toContain("Result of pkg_install: denied");
    expect(prompt.trimEnd().endsWith("Assistant:")).toBe(true);
  });
});
