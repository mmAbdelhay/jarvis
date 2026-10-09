// packages/desktop/src/daemon/os/agent-service.vision.test.ts
import { describe, expect, it } from "vitest";
import { scripted, startAgent } from "./__fixtures__/os-agent-harness.js";

describe("provider:list vision (v1.1 contracts §2)", () => {
  it("flags each configured provider by its model and the catalog", async () => {
    const yaml = [
      "os:",
      "  providers:",
      "    - { id: local, kind: ollama, baseUrl: 'http://127.0.0.1:11434', model: 'qwen3:8b' }",
      "    - { id: eyes, kind: ollama, baseUrl: 'http://127.0.0.1:11434', model: 'acme-vl:3b' }",
      "    - { id: work, kind: anthropic, baseUrl: 'https://api.anthropic.com', model: claude-sonnet-4-5 }",
      "",
    ].join("\n");
    const { agent } = await startAgent({
      yaml,
      overrides: { readVisionTags: async () => new Set(["acme-vl:3b"]) },
    });
    const list = await agent.providerList();
    expect(list.providers.map((p) => [p.id, p.vision])).toEqual([
      ["local", false],
      ["eyes", true],
      ["work", true],
    ]);
  });
  it("uses explicit Ollama capabilities and fails closed on probe errors", async () => {
    const { agent } = await startAgent({
      yaml: "os:\n  providers:\n    - { id: local, kind: ollama, baseUrl: 'http://127.0.0.1:11434', model: 'llava:7b' }\n",
      overrides: { readOllamaVision: async () => true },
    });
    expect((await agent.providerList()).providers[0]?.vision).toBe(true);
    const failed = await startAgent({
      yaml: "os:\n  providers:\n    - { id: local, kind: ollama, baseUrl: 'http://127.0.0.1:11434', model: 'llava:7b' }\n",
      overrides: {
        readOllamaVision: async () => {
          throw new Error("offline");
        },
      },
    });
    expect((await failed.agent.providerList()).providers[0]?.vision).toBe(false);
  });
  it("refreshes catalog and capability evidence when a provider is saved", async () => {
    let tags: ReadonlySet<string> = new Set(["catalog:latest"]);
    let supportsVision = true;
    const probes: string[] = [];
    const local = {
      id: "local",
      kind: "ollama" as const,
      baseUrl: "http://127.0.0.1:11434",
      model: "catalog",
    };
    const { agent } = await startAgent({
      yaml: "os:\n  providers:\n    - { id: local, kind: ollama, baseUrl: 'http://127.0.0.1:11434', model: catalog }\n",
      overrides: {
        makeProvider: () => scripted([]),
        readVisionTags: async () => tags,
        readOllamaVision: async (baseUrl, model) => {
          probes.push(`${baseUrl}/${model}`);
          return supportsVision;
        },
      },
    });
    expect((await agent.providerList()).providers[0]).toMatchObject({
      vision: true,
      computerUse: { enabled: false, consentAt: null },
    });
    expect(probes).toEqual([]);
    tags = new Set();
    await agent.save({ providers: [{ ...local, model: "custom:7b" }], allowCloudFallback: false });
    expect((await agent.providerList()).providers[0]?.vision).toBe(true);
    supportsVision = false;
    await agent.save({ providers: [{ ...local, model: "text:7b" }], allowCloudFallback: false });
    expect((await agent.providerList()).providers[0]?.vision).toBe(false);
    expect(probes).toEqual(["http://127.0.0.1:11434/custom:7b", "http://127.0.0.1:11434/text:7b"]);
  });
});
