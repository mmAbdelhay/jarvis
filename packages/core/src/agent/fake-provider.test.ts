import { describe, expect, it } from "vitest";
import { createFakeProvider, parseFakeScript } from "./fake-provider.js";
import { type ModelEvent, type ModelMessage, ProviderError } from "./types.js";

async function collect(iterable: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

const signal = new AbortController().signal;
const chat = (provider: ReturnType<typeof createFakeProvider>, messages: ModelMessage[]) =>
  collect(provider.chat({ system: "s", messages, tools: [], signal }));

describe("parseFakeScript", () => {
  it("accepts the contract's shape", () => {
    expect(
      parseFakeScript([
        {
          expectPromptContains: "install",
          replies: [
            { toolCalls: [{ name: "pkg.install", input: { items: [] } }] },
            { text: "Done." },
          ],
        },
      ]),
    ).toEqual([
      {
        expectPromptContains: "install",
        replies: [
          { toolCalls: [{ name: "pkg.install", input: { items: [] } }] },
          { text: "Done." },
        ],
      },
    ]);
  });

  it("names the broken turn and reply", () => {
    expect(() => parseFakeScript({})).toThrow(/array/);
    expect(() => parseFakeScript([{ replies: [{ nope: 1 }] }])).toThrow(/turn 1 reply 1/);
    expect(() => parseFakeScript([{ replies: [{ toolCalls: [{ input: {} }] }] }])).toThrow(
      /turn 1 reply 1/,
    );
  });
});

describe("createFakeProvider", () => {
  const script = parseFakeScript([
    {
      expectPromptContains: "install hello",
      replies: [
        {
          toolCalls: [{ name: "pkg.install", input: { items: [{ source: "apt", id: "hello" }] } }],
        },
        { text: "Installed." },
      ],
    },
    { replies: [{ text: "Second turn." }] },
  ]);

  it("plays one reply per chat call, starting a turn on each new user message", async () => {
    const provider = createFakeProvider(script);
    const first = await chat(provider, [{ role: "user", text: "please install hello" }]);
    expect(first).toEqual([
      {
        type: "tool_call",
        id: "fake-1-1-1",
        name: "pkg.install",
        input: { items: [{ source: "apt", id: "hello" }] },
      },
      { type: "done", usage: { inputTokens: 0, outputTokens: 0 } },
    ]);
    const second = await chat(provider, [
      { role: "user", text: "please install hello" },
      {
        role: "assistant",
        text: "",
        toolCalls: [{ id: "fake-1-1-1", name: "pkg.install", input: {} }],
      },
      {
        role: "tool",
        results: [{ callId: "fake-1-1-1", name: "pkg.install", content: "ok", isError: false }],
      },
    ]);
    expect(second[0]).toEqual({ type: "text", delta: "Installed." });
    const third = await chat(provider, [{ role: "user", text: "anything" }]);
    expect(third[0]).toEqual({ type: "text", delta: "Second turn." });
    const fourth = await chat(provider, [{ role: "user", text: "more" }]);
    expect(fourth[0]).toEqual({ type: "text", delta: "fake provider: script exhausted" });
  });

  it("fails the turn when the prompt does not contain the expected text", async () => {
    const provider = createFakeProvider(script);
    await expect(chat(provider, [{ role: "user", text: "install vlc" }])).rejects.toBeInstanceOf(
      ProviderError,
    );
  });

  it("probes as a tool-capable model and lists one model", async () => {
    await expect(createFakeProvider(script).probe()).resolves.toEqual({
      ok: true,
      supportsTools: true,
      models: ["fake"],
    });
    await expect(createFakeProvider(script).listModels()).resolves.toEqual(["fake"]);
  });
});
