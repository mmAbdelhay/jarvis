import { describe, expect, it } from "vitest";
import { recordingFetch } from "../model/http-double.js";
import { EMBED_RETRY_AFTER_MS, createOllamaEmbedder } from "./ollama-embedder.js";
import { openVectorCache } from "./vector-cache.js";

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("createOllamaEmbedder (design §3.8: local only)", () => {
  it("embeds with nomic's task prefixes against the loopback Ollama", async () => {
    const { fetch, calls } = recordingFetch([
      json({
        embeddings: [
          [1, 0],
          [0, 1],
        ],
      }),
    ]);
    const embedder = createOllamaEmbedder({ fetch, now: () => 0, log: () => {} });
    const vectors = await embedder.embed(["a", "b"], "document");
    expect(vectors.map((v) => [...v])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/embed");
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({
      model: "nomic-embed-text",
      input: ["search_document: a", "search_document: b"],
    });
    expect(embedder.model).toBe("nomic-embed-text");
  });

  it("serves repeated documents from the cache without a request", async () => {
    const { fetch, calls } = recordingFetch([json({ embeddings: [[3, 4]] })]);
    const cache = openVectorCache({ path: ":memory:", now: () => 0 });
    const embedder = createOllamaEmbedder({ fetch, now: () => 0, log: () => {}, cache });
    await embedder.embed(["d"], "document");
    const again = await embedder.embed(["d"], "document");
    expect([...(again[0] ?? [])]).toEqual([3, 4]);
    expect(calls).toHaveLength(1);
  });

  it("never reads or writes the cache for queries (user text stays off disk)", async () => {
    const { fetch, calls } = recordingFetch([
      json({ embeddings: [[3, 4]] }),
      json({ embeddings: [[3, 4]] }),
    ]);
    const cache = openVectorCache({ path: ":memory:", now: () => 0 });
    const embedder = createOllamaEmbedder({ fetch, now: () => 0, log: () => {}, cache });
    await embedder.embed(["q"], "query");
    await embedder.embed(["q"], "query");
    expect(calls).toHaveLength(2);
    expect(cache.get("nomic-embed-text", "search_query: q")).toBeUndefined();
  });

  it("refuses any Ollama that is not on this computer", () => {
    for (const baseUrl of ["http://10.0.0.2:11434", "https://api.example.com"]) {
      expect(() =>
        createOllamaEmbedder({
          fetch: recordingFetch([]).fetch,
          now: () => 0,
          log: () => {},
          baseUrl,
        }),
      ).toThrow(/this computer/);
    }
  });

  it("pauses for 10 minutes after a failure, then tries again", async () => {
    let now = 0;
    const logs: string[] = [];
    const { fetch, calls } = recordingFetch([
      json({ error: 'model "nomic-embed-text" not found' }, 404),
      json({ embeddings: [[1]] }),
    ]);
    const embedder = createOllamaEmbedder({ fetch, now: () => now, log: (l) => logs.push(l) });
    await expect(embedder.embed(["x"], "query")).rejects.toThrow("not found");
    await expect(embedder.embed(["x"], "query")).rejects.toThrow(/paused/);
    expect(calls).toHaveLength(1);
    now = EMBED_RETRY_AFTER_MS;
    await expect(embedder.embed(["x"], "query")).resolves.toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it("refuses malformed answers", async () => {
    const cases: { body: unknown; count: number }[] = [
      { body: {}, count: 1 },
      { body: { embeddings: [[1], [1, 2]] }, count: 2 },
      { body: { embeddings: [["x"]] }, count: 1 },
      { body: { embeddings: [] }, count: 1 },
    ];
    for (const { body, count } of cases) {
      const { fetch } = recordingFetch([json(body)]);
      const embedder = createOllamaEmbedder({ fetch, now: () => 0, log: () => {} });
      await expect(embedder.embed(["a", "b"].slice(0, count), "document")).rejects.toThrow();
    }
  });
});
