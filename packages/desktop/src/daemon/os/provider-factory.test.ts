import { USER_TEXT, type ModelProvider, ProviderError } from "@jarvis/core";
import { type FetchLike, KeyringTimeoutError } from "@jarvis/platform/model";
import { describe, expect, it } from "vitest";
import { buildProvider, createLazyKeyProvider, unavailableProvider } from "./provider-factory.js";

// A local double: desktop's tsconfig cannot import platform's test files.
function recordingFetch(responses: Response[]) {
  const calls: { url: string }[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push({ url });
    const next = responses.shift();
    if (next === undefined) throw new Error(`unexpected fetch ${url}`);
    return next;
  };
  return { fetch, calls };
}

const tagsResponse = () => new Response('{"models":[{"name":"qwen3:8b"}]}', { status: 200 });

async function firstError(provider: ModelProvider): Promise<unknown> {
  try {
    for await (const _event of provider.chat({
      system: "",
      messages: [{ role: "user", text: "?" }],
      tools: [],
      signal: new AbortController().signal,
    })) {
      // drain
    }
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("buildProvider", () => {
  it("builds gemini against models.list with the key in a header, and refuses it without a key", async () => {
    const calls: { url: string; key: string | undefined }[] = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, key: init.headers["x-goog-api-key"] });
      return new Response('{"models":[]}', { status: 200 });
    };
    const section = {
      kind: "gemini" as const,
      baseUrl: "https://generativelanguage.googleapis.com",
      model: "gemini-2.5-flash",
      auth: "api-key" as const,
      supportsTools: true,
    };
    await expect(buildProvider(section, "AIza-k", { fetch }).reachable()).resolves.toEqual({
      ok: true,
    });
    expect(calls[0]).toEqual({
      url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      key: "AIza-k",
    });
    const missing = await firstError(buildProvider(section, undefined, { fetch }));
    expect(missing).toMatchObject({ kind: "auth", message: USER_TEXT.en.noKey });
  });

  it("builds each kind against its own endpoint", async () => {
    for (const [kind, baseUrl, url] of [
      ["ollama", "http://localhost:11434", "http://localhost:11434/api/tags"],
      ["openai-compatible", "http://localhost:1234/v1", "http://localhost:1234/v1/models"],
      ["anthropic", "https://api.anthropic.com", "https://api.anthropic.com/v1/models?limit=100"],
    ] as const) {
      const { fetch, calls } = recordingFetch([tagsResponse()]);
      const provider = buildProvider(
        { kind, baseUrl, model: "m", auth: "api-key", supportsTools: true },
        "k",
        { fetch },
      );
      await provider.reachable();
      expect(calls[0]?.url).toBe(url);
    }
  });

  it("answers an Anthropic api-key section with no key with a clear auth error", async () => {
    const { fetch, calls } = recordingFetch([]);
    const provider = buildProvider(
      {
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "m",
        auth: "api-key",
        supportsTools: true,
      },
      undefined,
      { fetch },
    );
    const error = await firstError(provider);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toBe(USER_TEXT.en.noKey);
    expect(calls).toHaveLength(0);
  });

  it("uses the subscription builder when given, and refuses the mode when not", async () => {
    const section = {
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "m",
      auth: "subscription",
      supportsTools: true,
    } as const;
    const marker = unavailableProvider("marker");
    expect(
      buildProvider(section, undefined, {
        fetch: recordingFetch([]).fetch,
        subscription: () => marker,
      }),
    ).toBe(marker);
    const error = await firstError(
      buildProvider(section, undefined, { fetch: recordingFetch([]).fetch }),
    );
    expect((error as Error).message).toBe(USER_TEXT.en.subscriptionUnavailable);
  });
});

describe("unavailableProvider", () => {
  it("fails chat, probe, listModels and reachable with the message", async () => {
    const provider = unavailableProvider("nope");
    await expect(provider.probe()).resolves.toEqual({
      ok: false,
      supportsTools: false,
      models: [],
      error: "nope",
    });
    await expect(provider.reachable()).resolves.toEqual({ ok: false, error: "nope" });
    await expect(provider.listModels()).rejects.toThrow("nope");
  });
});

describe("createLazyKeyProvider (contracts §6 #12)", () => {
  const stub = (label: string): ModelProvider => ({
    async *chat() {
      yield { type: "text", delta: label };
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    },
    probe: async () => ({ ok: true, supportsTools: true, models: [label] }),
    listModels: async () => [label],
    reachable: async () => ({ ok: true }),
  });

  it("does not touch the keyring until first use, retries a locked keyring, then caches the key", async () => {
    let reads = 0;
    const slept: number[] = [];
    const built: (string | undefined)[] = [];
    const provider = createLazyKeyProvider({
      readKey: async () => {
        reads++;
        if (reads < 3) throw new Error("Cannot get secret of a locked object");
        return "sk-ant-123";
      },
      build: (key) => {
        built.push(key);
        return stub(key ?? "none");
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(reads).toBe(0);
    await expect(provider.listModels()).resolves.toEqual(["sk-ant-123"]);
    expect(slept).toEqual([2_000, 2_000]);
    await provider.listModels();
    expect(reads).toBe(3);
    expect(built).toEqual(["sk-ant-123"]);
  });

  it("does not cache a missing key, so a key saved later is picked up", async () => {
    const keys: (string | undefined)[] = [undefined, "sk-later"];
    const built: (string | undefined)[] = [];
    const provider = createLazyKeyProvider({
      readKey: async () => keys.shift(),
      build: (key) => {
        built.push(key);
        return stub(key ?? "none");
      },
      sleep: async () => {},
    });
    await expect(provider.listModels()).resolves.toEqual(["none"]);
    await expect(provider.listModels()).resolves.toEqual(["sk-later"]);
    expect(built).toEqual([undefined, "sk-later"]);
  });

  it("does not retry a keyring that timed out on a password prompt: the key is asked again", async () => {
    let reads = 0;
    const slept: number[] = [];
    const built: (string | undefined)[] = [];
    const provider = createLazyKeyProvider({
      readKey: async () => {
        reads++;
        throw new KeyringTimeoutError(8);
      },
      build: (key) => {
        built.push(key);
        return stub(key ?? "none");
      },
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await expect(provider.listModels()).resolves.toEqual(["none"]);
    expect(reads).toBe(1);
    expect(slept).toEqual([]);
    expect(built).toEqual([undefined]);
  });

  it("builds without a key after the retries run out", async () => {
    const built: (string | undefined)[] = [];
    const provider = createLazyKeyProvider({
      readKey: async () => {
        throw new Error("locked");
      },
      build: (key) => {
        built.push(key);
        return stub("none");
      },
      sleep: async () => {},
      attempts: 2,
    });
    await provider.reachable();
    expect(built).toEqual([undefined]);
  });
});

describe("unavailable provider messages follow the language (M4 §3)", () => {
  it("says the key is missing in the language asked for at use time", async () => {
    let language: "en" | "ar" = "en";
    const provider = buildProvider(
      {
        kind: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-5-5",
        auth: "api-key",
        supportsTools: true,
      },
      undefined,
      { fetch: async () => new Response(""), language: () => language },
    );
    language = "ar";
    const run = async () => {
      for await (const _ of provider.chat({
        system: "",
        messages: [],
        tools: [],
        signal: new AbortController().signal,
      })) {
        // nothing
      }
    };
    await expect(run()).rejects.toThrow(USER_TEXT.ar.noKey);
    await expect(run()).rejects.toBeInstanceOf(ProviderError);
  });
});
