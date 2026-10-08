// A ProviderSection plus its key (from the keyring) -> a ModelProvider.
// The subscription auth mode needs the Agent SDK and the claude CLI, which
// the Jarvis OS bundle does not carry; the OS daemon passes no builder for
// it and the user gets a plain message instead.
//
// No electron here (core/no-electron.test.ts).
import { AGENT_TEXT, type ModelProvider, ProviderError } from "@jarvis/core";
import {
  createAnthropicProvider,
  createGeminiProvider,
  createOllamaProvider,
  createOpenAiCompatibleProvider,
  type FetchLike,
} from "@jarvis/platform/model";
import type { ProviderSection } from "./provider-config.js";

export function unavailableProvider(message: string): ModelProvider {
  return {
    // biome-ignore lint/correctness/useYield: it fails before it yields anything.
    async *chat() {
      throw new ProviderError("auth", message);
    },
    probe: async () => ({ ok: false, supportsTools: false, models: [], error: message }),
    listModels: async () => {
      throw new ProviderError("auth", message);
    },
    reachable: async () => ({ ok: false, error: message }),
  };
}

/**
 * Reads the provider key at first use instead of at start (contracts §6 #12):
 * gnome-keyring unlocks with the autologin session, which may be after the
 * user unit started jarvisd. A read that throws (locked, D-Bus not up yet) is
 * retried; a found key is cached; a missing one is not, so a key saved later
 * in settings is picked up on the next use.
 */
export function createLazyKeyProvider(options: {
  readKey(): Promise<string | undefined>;
  build(key: string | undefined): ModelProvider;
  sleep(ms: number): Promise<void>;
  attempts?: number;
  delayMs?: number;
}): ModelProvider {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 2_000;
  let cached: ModelProvider | undefined;

  async function current(): Promise<ModelProvider> {
    if (cached !== undefined) return cached;
    let key: string | undefined;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        key = await options.readKey();
        break;
      } catch {
        if (attempt < attempts) await options.sleep(delayMs);
      }
    }
    const provider = options.build(key);
    if (key !== undefined) cached = provider;
    return provider;
  }

  return {
    async *chat(request) {
      yield* (await current()).chat(request);
    },
    probe: async () => (await current()).probe(),
    listModels: async (signal) => (await current()).listModels(signal),
    reachable: async (signal) => (await current()).reachable(signal),
  };
}

export function buildProvider(
  section: ProviderSection,
  apiKey: string | undefined,
  deps: { fetch: FetchLike; subscription?: (model: string) => ModelProvider },
): ModelProvider {
  switch (section.kind) {
    case "anthropic":
      if (section.auth === "subscription") {
        return (
          deps.subscription?.(section.model) ??
          unavailableProvider(AGENT_TEXT.subscriptionUnavailable)
        );
      }
      if (apiKey === undefined || apiKey === "") return unavailableProvider(AGENT_TEXT.noKey);
      return createAnthropicProvider({
        baseUrl: section.baseUrl,
        model: section.model,
        apiKey,
        fetch: deps.fetch,
      });
    case "openai-compatible":
      return createOpenAiCompatibleProvider({
        baseUrl: section.baseUrl,
        model: section.model,
        ...(apiKey === undefined ? {} : { apiKey }),
        fetch: deps.fetch,
      });
    case "ollama":
      return createOllamaProvider({
        baseUrl: section.baseUrl,
        model: section.model,
        ...(apiKey === undefined ? {} : { apiKey }),
        fetch: deps.fetch,
      });
    case "gemini":
      if (apiKey === undefined || apiKey === "") return unavailableProvider(AGENT_TEXT.noKey);
      return createGeminiProvider({
        baseUrl: section.baseUrl,
        model: section.model,
        apiKey,
        fetch: deps.fetch,
      });
  }
}
