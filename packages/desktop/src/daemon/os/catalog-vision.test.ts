// packages/desktop/src/daemon/os/catalog-vision.test.ts
import { describe, expect, it } from "vitest";
import { parseVisionTags, readVisionTags, readOllamaVision } from "./catalog-vision.js";

describe("catalog vision tags (v1.1 contracts §3)", () => {
  it("collects the ollamaTag of every vision: true model", () => {
    const tags = parseVisionTags({
      version: 1,
      models: [
        { id: "a", ollamaTag: "qwen2.5vl:7b", vision: true },
        { id: "b", ollamaTag: "qwen3:8b", vision: false },
        { id: "c", ollamaTag: "qwen3:4b" },
        { id: "d", ollamaTag: "BAD TAG", vision: true },
        { id: "e", vision: true },
        "junk",
      ],
    });
    expect([...tags]).toEqual(["qwen2.5vl:7b"]);
    expect([...parseVisionTags(null)]).toEqual([]);
  });

  it("reads nothing (and logs) from a missing or broken catalog", async () => {
    const lines: string[] = [];
    const missing = async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    await expect(readVisionTags("/x", missing, (l) => lines.push(l))).resolves.toEqual(new Set());
    expect(lines).toEqual([]);
    await expect(
      readVisionTags(
        "/x",
        async () => "{",
        (l) => lines.push(l),
      ),
    ).resolves.toEqual(new Set());
    expect(lines.join("\n")).toContain("/x");
  });
});

describe("Ollama show capabilities", () => {
  it("requires an explicit vision capability from a successful response", async () => {
    for (const [body, expected] of [
      [{ capabilities: ["completion", "vision"] }, true],
      [{ capabilities: ["completion"] }, false],
      [{ capabilities: "vision" }, false],
      [null, false],
    ] as const) {
      expect(
        await readOllamaVision("http://localhost:11434/", "custom:7b", async (url, init) => {
          expect(String(url)).toBe("http://localhost:11434/api/show");
          expect(init?.method).toBe("POST");
          expect(JSON.parse(String(init?.body))).toEqual({ model: "custom:7b" });
          return new Response(JSON.stringify(body));
        }),
      ).toBe(expected);
    }
    expect(
      await readOllamaVision(
        "http://localhost:11434",
        "m",
        async () => new Response("{}", { status: 500 }),
      ),
    ).toBe(false);
    expect(
      await readOllamaVision("http://localhost:11434", "m", async () => {
        throw new Error("offline");
      }),
    ).toBe(false);
  });
});

it("fails closed even when the catalog reader rejects with null", async () => {
  const logs: string[] = [];
  await expect(
    readVisionTags(
      "/catalog",
      async () => {
        throw null;
      },
      (line) => logs.push(line),
    ),
  ).resolves.toEqual(new Set());
  expect(logs).toEqual(["[vision] /catalog: catalog unavailable"]);
});
