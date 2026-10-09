import { type ModelChatRequest, type ModelEvent, ProviderError } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import { probeProvider } from "./probe.js";

function chatThat(behaviour: (request: ModelChatRequest) => ModelEvent[] | Error) {
  const requests: ModelChatRequest[] = [];
  return {
    requests,
    chat: async function* (request: ModelChatRequest): AsyncGenerator<ModelEvent> {
      requests.push(request);
      const result = behaviour(request);
      if (result instanceof Error) throw result;
      yield* result;
    },
  };
}

const done: ModelEvent = { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };

describe("probeProvider", () => {
  it("reports models and tool support when the model calls the ping tool", async () => {
    const { chat } = chatThat(() => [
      { type: "tool_call", id: "1", name: "ping", input: {} },
      done,
    ]);
    await expect(probeProvider({ listModels: async () => ["a", "b"], chat })).resolves.toEqual({
      ok: true,
      supportsTools: true,
      models: ["a", "b"],
    });
  });

  it("saves a chat-only model as ok without tools", async () => {
    const { chat, requests } = chatThat((request) =>
      request.tools.length > 0
        ? new ProviderError("http", "400 model does not support tools", 400)
        : [done],
    );
    await expect(probeProvider({ listModels: async () => ["gemma:2b"], chat })).resolves.toEqual({
      ok: true,
      supportsTools: false,
      models: ["gemma:2b"],
    });
    expect(requests).toHaveLength(2);
  });

  it("is not ok when models cannot be listed (bad key, unreachable)", async () => {
    const { chat } = chatThat(() => [done]);
    await expect(
      probeProvider({
        listModels: async () => {
          throw new ProviderError("auth", "401 invalid key", 401);
        },
        chat,
      }),
    ).resolves.toEqual({ ok: false, supportsTools: false, models: [], error: "401 invalid key" });
  });

  it("is not ok when the chat fails for another reason", async () => {
    const { chat } = chatThat(() => new ProviderError("http", "404 model not found", 404));
    await expect(probeProvider({ listModels: async () => ["x"], chat })).resolves.toEqual({
      ok: false,
      supportsTools: false,
      models: ["x"],
      error: "404 model not found",
    });
  });
});
