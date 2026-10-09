// Semantic tool search (design §3.8): with more than 40 tools, a turn offers
// the core tools plus the 24 − core others closest to the user's message —
// by cosine over local embeddings (nomic-embed-text via a loopback Ollama),
// or by BM25 when no embedder is available. The model can still call any
// registered tool by name; the risk gate applies either way. Pure.
import { type TextEmbedder, cosine, createBm25Index } from "./text-index.js";
import type { ModelToolSpec } from "./types.js";

export const TOOL_SEARCH_MIN_TOOLS = 40;
export const MAX_TOOLS_PER_TURN = 24;
/** Always offered ("pkg/diag/updates always"; see the plan's Decisions). */
export const CORE_TOOLS: readonly string[] = [
  "pkg.search",
  "pkg.install",
  "pkg.remove",
  "pkg.list_installed",
  "sys.health",
  "net.status",
  "logs.query",
  "svc.list_failed",
  "updates.list",
  "updates.apply",
  "registry.search",
];

export function toolSearchText(spec: ModelToolSpec): string {
  return `${spec.name.replace(/[._-]+/g, " ")} ${spec.description}`;
}

async function byEmbedding(
  embedder: TextEmbedder,
  query: string,
  tools: readonly ModelToolSpec[],
): Promise<ModelToolSpec[]> {
  const [queryVector] = await embedder.embed([query], "query");
  const vectors = await embedder.embed(tools.map(toolSearchText), "document");
  if (queryVector === undefined || vectors.length !== tools.length) {
    throw new Error("the embedder answered with the wrong number of vectors");
  }
  return tools
    .map((tool, index) => ({ tool, score: cosine(queryVector, vectors[index] ?? []), index }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.tool);
}

function byKeywords(query: string, tools: readonly ModelToolSpec[]): ModelToolSpec[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return createBm25Index(tools.map((tool) => ({ id: tool.name, text: toolSearchText(tool) })))
    .search(query)
    .flatMap((hit) => {
      const tool = byName.get(hit.id);
      return tool === undefined ? [] : [tool];
    });
}

export async function selectTools(
  all: readonly ModelToolSpec[],
  query: string,
  options: {
    coreModelNames: ReadonlySet<string>;
    embedder: TextEmbedder | null;
    log(line: string): void;
  },
): Promise<ModelToolSpec[]> {
  if (all.length <= TOOL_SEARCH_MIN_TOOLS) return [...all];
  const core = all
    .filter((tool) => options.coreModelNames.has(tool.name))
    .slice(0, MAX_TOOLS_PER_TURN);
  const rest = all.filter((tool) => !options.coreModelNames.has(tool.name));
  const room = MAX_TOOLS_PER_TURN - core.length;
  if (room <= 0) return core;
  let ranked: ModelToolSpec[] | undefined;
  if (options.embedder !== null) {
    try {
      ranked = await byEmbedding(options.embedder, query, rest);
    } catch (error) {
      options.log(
        `[tools] semantic search unavailable, using keywords: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return [...core, ...(ranked ?? byKeywords(query, rest)).slice(0, room)];
}
