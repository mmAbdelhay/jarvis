// packages/core/src/agent/images.privacy.test.ts
import { describe, expect, it } from "vitest";
import { IMAGE_WITHHELD, hasImages, stripImages, withImagePolicy } from "./images.js";
import type { ModelChatRequest, ModelEvent, ModelMessage, ModelProvider } from "./types.js";

const messages: ModelMessage[] = [
  { role: "user", text: "go" },
  {
    role: "tool",
    results: [
      {
        callId: "c1",
        name: "screen_look",
        content: "look",
        isError: false,
        image: { mediaType: "image/png", dataBase64: "SECRETPIXELS" },
      },
    ],
  },
];

function recorder(): ModelProvider & { seen: ModelChatRequest[] } {
  const seen: ModelChatRequest[] = [];
  return {
    seen,
    async *chat(request) {
      seen.push(request);
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } } satisfies ModelEvent;
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [] }),
    listModels: async () => [],
    reachable: async () => ({ ok: true }),
  };
}

async function drain(provider: ModelProvider, request: ModelChatRequest) {
  for await (const _event of provider.chat(request)) {
    // consume
  }
}

describe("stripImages", () => {
  it("removes every image and says so", () => {
    const out = stripImages(messages, IMAGE_WITHHELD);
    expect(hasImages(out)).toBe(false);
    expect(JSON.stringify(out)).not.toContain("SECRETPIXELS");
    expect(out[1]?.role === "tool" && out[1].results[0]?.content).toBe(`look\n${IMAGE_WITHHELD}`);
    expect(hasImages(messages)).toBe(true);
  });
});

describe("withImagePolicy", () => {
  const request = (): ModelChatRequest => ({
    system: "s",
    messages,
    tools: [],
    signal: new AbortController().signal,
  });

  it("withholds images from a provider that may not see the screen", async () => {
    const inner = recorder();
    await drain(
      withImagePolicy(inner, () => false),
      request(),
    );
    expect(JSON.stringify(inner.seen[0]?.messages)).not.toContain("SECRETPIXELS");
    expect(JSON.stringify(inner.seen[0]?.messages)).toContain(IMAGE_WITHHELD);
  });

  it("passes images to an allowed provider untouched, and asks at every request", async () => {
    const inner = recorder();
    let allowed = true;
    const guarded = withImagePolicy(inner, () => allowed);
    await drain(guarded, request());
    allowed = false;
    await drain(guarded, request());
    expect(JSON.stringify(inner.seen[0]?.messages)).toContain("SECRETPIXELS");
    expect(JSON.stringify(inner.seen[1]?.messages)).not.toContain("SECRETPIXELS");
  });

  it("keeps the other provider methods", async () => {
    const guarded = withImagePolicy(recorder(), () => false);
    await expect(guarded.reachable()).resolves.toEqual({ ok: true });
    await expect(guarded.listModels()).resolves.toEqual([]);
  });
});
