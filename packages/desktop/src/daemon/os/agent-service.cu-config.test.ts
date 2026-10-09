import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { CONFIG_PATH, startAgent } from "./__fixtures__/os-agent-harness.js";
import { OsAgentError } from "./agent-service.js";
import { parseComputerUse } from "./cu-config.js";

const YAML = [
  "os:",
  "  providers:",
  "    - { id: work, kind: anthropic, baseUrl: 'https://api.anthropic.com', model: claude-sonnet-4-5 }",
  "    - { id: text, kind: ollama, baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b' }",
  "",
].join("\n");

const saved = (files: Map<string, string>) =>
  parseComputerUse(
    (parse(files.get(CONFIG_PATH) ?? "") as { os?: { computerUse?: unknown } }).os?.computerUse,
  );

describe("cu:setEnabled and cu:consent (v1.1 contracts §2, §4.8)", () => {
  it("enables a vision provider and records consent at the current time", async () => {
    const { agent, files } = await startAgent({ yaml: YAML });
    await expect(agent.cuSetEnabled({ providerId: "work", enabled: true })).resolves.toBeNull();
    await expect(agent.cuConsent("work")).resolves.toBeNull();
    expect(saved(files)).toEqual({
      enabled: { work: true },
      cloudConsent: { work: "1970-01-01T00:00:01.000Z" },
    });
    const entry = (await agent.providerList()).providers.find((p) => p.id === "work");
    expect(entry?.computerUse).toEqual({ enabled: true, consentAt: "1970-01-01T00:00:01.000Z" });
  });

  it("revokes consent and leaves enabled alone", async () => {
    const { agent, files } = await startAgent({ yaml: YAML });
    await agent.cuSetEnabled({ providerId: "work", enabled: true });
    await agent.cuConsent("work");
    await expect(agent.cuConsent("work", true)).resolves.toBeNull();
    expect(saved(files)).toEqual({ enabled: { work: true }, cloudConsent: {} });
    const entry = (await agent.providerList()).providers.find((p) => p.id === "work");
    expect(entry?.computerUse).toEqual({ enabled: true, consentAt: null });
  });

  it("refuses a model without vision and an unknown provider", async () => {
    const { agent } = await startAgent({ yaml: YAML });
    await expect(agent.cuSetEnabled({ providerId: "text", enabled: true })).rejects.toMatchObject({
      code: "bad-request",
    });
    await expect(agent.cuSetEnabled({ providerId: "nope", enabled: true })).rejects.toBeInstanceOf(
      OsAgentError,
    );
    await expect(agent.cuConsent("nope")).rejects.toMatchObject({ code: "bad-request" });
    // Turning it off is always allowed.
    await expect(agent.cuSetEnabled({ providerId: "text", enabled: false })).resolves.toBeNull();
  });

  it("drops enable and consent when a provider is removed or its endpoint changes", async () => {
    const yaml = `${YAML}  computerUse:\n    enabled: { work: true, text: false }\n    cloudConsent: { work: '2026-10-10T09:00:00Z' }\n`;
    const okProvider = {
      async *chat() {
        yield { type: "done" as const, usage: { inputTokens: 0, outputTokens: 0 } };
      },
      probe: async () => ({ ok: true, supportsTools: true, models: [] }),
      listModels: async () => [],
      reachable: async () => ({ ok: true }),
    };
    const { agent, files } = await startAgent({
      yaml,
      overrides: { makeProvider: () => okProvider },
    });
    const result = await agent.save({
      providers: [
        {
          id: "work",
          kind: "anthropic",
          baseUrl: "https://proxy.example.com",
          model: "claude-sonnet-4-5",
        },
      ],
      allowCloudFallback: false,
    });
    expect(result.ok).toBe(true);
    expect(saved(files)).toEqual({ enabled: {}, cloudConsent: {} });
  });

  it("keeps them for an unchanged provider", async () => {
    const yaml = `${YAML}  computerUse:\n    enabled: { work: true }\n    cloudConsent: { work: '2026-10-10T09:00:00Z' }\n`;
    const { agent, files } = await startAgent({ yaml });
    await agent.save({
      providers: [
        {
          id: "work",
          kind: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude-sonnet-4-5",
        },
        { id: "text", kind: "ollama", baseUrl: "http://127.0.0.1:11434", model: "qwen3:8b" },
      ],
      allowCloudFallback: false,
    });
    expect(saved(files)).toEqual({
      enabled: { work: true },
      cloudConsent: { work: "2026-10-10T09:00:00Z" },
    });
  });
});
