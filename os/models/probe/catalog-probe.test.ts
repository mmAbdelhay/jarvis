// Runs the M1 provider probe (list models + one tool call, the check the
// shell's provider setup uses) against one catalog model on a local Ollama.
// toolCalling: "verified" in os/models/catalog.json means this passes.
import { createOllamaProvider } from "@jarvis/platform/model";
import { describe, expect, it } from "vitest";

const tag = process.env.CATALOG_MODEL_TAG ?? "";
const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";

describe.skipIf(tag === "")("catalog model", () => {
  it(`${tag} lists and calls a tool`, async () => {
    const provider = createOllamaProvider({ baseUrl, model: tag, fetch: globalThis.fetch });
    const result = await provider.probe();
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.models).toContain(tag);
    expect(result.supportsTools).toBe(true);
  });
});
