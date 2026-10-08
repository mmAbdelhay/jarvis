import { type ModelProvider, ProviderError } from "@jarvis/core";
import { describe, expect, it } from "vitest";
import {
  createBackupProvider,
  parseBackupTag,
  readBackupTag,
  sameOllamaTag,
} from "./backup-model.js";
import type { ProviderSection } from "./provider-config.js";

const model = (extra: Record<string, unknown>) => ({
  id: "x",
  ollamaTag: "qwen3:1.7b",
  toolCalling: "verified",
  ...extra,
});

describe("the catalog's backup model (M4 §1)", () => {
  it("reads the one backup entry", () => {
    expect(
      parseBackupTag({
        version: 1,
        models: [model({ role: "main", ollamaTag: "qwen3:8b" }), model({ role: "backup" })],
      }),
    ).toBe("qwen3:1.7b");
  });

  it("has no backup unless exactly one verified entry with a valid tag says so", () => {
    expect(parseBackupTag({ models: [model({})] })).toBeNull();
    expect(
      parseBackupTag({
        models: [model({ role: "backup" }), model({ role: "backup", ollamaTag: "llama3.2:1b" })],
      }),
    ).toBeNull();
    expect(
      parseBackupTag({ models: [model({ role: "backup", toolCalling: "untested" })] }),
    ).toBeNull();
    expect(
      parseBackupTag({ models: [model({ role: "backup", ollamaTag: "qwen3:1.7b; rm -rf /" })] }),
    ).toBeNull();
    expect(parseBackupTag({ models: "nope" })).toBeNull();
    expect(parseBackupTag(null)).toBeNull();
  });

  it("treats a missing or broken catalog as no backup, and says why once", async () => {
    const lines: string[] = [];
    const missing = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    expect(await readBackupTag("/c.json", missing, (l) => lines.push(l))).toBeNull();
    expect(
      await readBackupTag(
        "/c.json",
        async () => "{",
        (l) => lines.push(l),
      ),
    ).toBeNull();
    expect(lines).toHaveLength(1);
  });

  it("compares Ollama tags with :latest normalised", () => {
    expect(sameOllamaTag("qwen3", "qwen3:latest")).toBe(true);
    expect(sameOllamaTag("qwen3:1.7b", "qwen3:1.7b")).toBe(true);
    expect(sameOllamaTag("qwen3:1.7b", "qwen3:8b")).toBe(false);
  });
});

describe("createBackupProvider", () => {
  const sections: ProviderSection[] = [];
  const inner = (models: string[]): ModelProvider => ({
    async *chat() {
      yield { type: "done", usage: { inputTokens: 0, outputTokens: 0 } };
    },
    probe: async () => ({ ok: true, supportsTools: true, models }),
    listModels: async () => models,
    reachable: async () => ({ ok: true }),
  });

  it("always talks to the fixed loopback Ollama", () => {
    createBackupProvider({
      tag: "qwen3:1.7b",
      make: (section) => {
        sections.push(section);
        return inner([]);
      },
    });
    expect(sections[0]).toEqual({
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3:1.7b",
      auth: "api-key",
      supportsTools: true,
    });
  });

  it("is unreachable when Ollama does not have the backup model", async () => {
    const missing = createBackupProvider({ tag: "qwen3:1.7b", make: () => inner(["qwen3:8b"]) });
    await expect(missing.listModels()).rejects.toBeInstanceOf(ProviderError);
    expect((await missing.reachable()).ok).toBe(false);
    const present = createBackupProvider({ tag: "qwen3:1.7b", make: () => inner(["qwen3:1.7b"]) });
    expect((await present.reachable()).ok).toBe(true);
  });
});
