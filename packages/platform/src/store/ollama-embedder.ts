// Local embeddings for tool search and memory (design §3.8, §3.9):
// nomic-embed-text through an Ollama on THIS computer only — a LAN or cloud
// URL is refused, so tool descriptions and memories never leave the machine
// for embedding. After a failure (no Ollama, model not pulled) it pauses for
// 10 minutes and callers use BM25 meanwhile.
import { type EmbedPurpose, type TextEmbedder, isRecord } from "@jarvis/core";
import { type FetchLike, readJson, request } from "../model/http.js";
import type { VectorCache } from "./vector-cache.js";

export const LOCAL_OLLAMA_URL = "http://127.0.0.1:11434";
export const EMBED_MODEL = "nomic-embed-text";
export const EMBED_TIMEOUT_MS = 15_000;
export const EMBED_RETRY_AFTER_MS = 10 * 60_000;
const EMBED_BATCH = 32;
const MAX_DIMENSIONS = 8_192;
/** nomic-embed-text's task prefixes. */
const PREFIX: Readonly<Record<EmbedPurpose, string>> = {
  document: "search_document: ",
  query: "search_query: ",
};

export class EmbedderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbedderUnavailableError";
  }
}

function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1";
  } catch {
    return false;
  }
}

export function parseEmbeddings(body: unknown, count: number): Float32Array[] {
  const rows = isRecord(body) ? body["embeddings"] : undefined;
  if (!Array.isArray(rows) || rows.length !== count) {
    throw new EmbedderUnavailableError("Ollama sent no embeddings");
  }
  let dimensions: number | undefined;
  return rows.map((row) => {
    if (
      !Array.isArray(row) ||
      row.length === 0 ||
      row.length > MAX_DIMENSIONS ||
      !row.every((value) => typeof value === "number" && Number.isFinite(value)) ||
      (dimensions !== undefined && row.length !== dimensions)
    ) {
      throw new EmbedderUnavailableError("Ollama sent a malformed embedding");
    }
    dimensions = row.length;
    return Float32Array.from(row as number[]);
  });
}

export function createOllamaEmbedder(options: {
  fetch: FetchLike;
  now(): number;
  log(line: string): void;
  cache?: VectorCache;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}): TextEmbedder {
  const baseUrl = options.baseUrl ?? LOCAL_OLLAMA_URL;
  if (!isLoopback(baseUrl))
    throw new Error("The embedder only talks to an Ollama on this computer");
  const model = options.model ?? EMBED_MODEL;
  let pausedUntil = 0;

  return {
    model,
    async embed(texts, purpose) {
      if (options.now() < pausedUntil) {
        throw new EmbedderUnavailableError("Local embeddings are paused after a failure");
      }
      const inputs = texts.map((text) => `${PREFIX[purpose]}${text}`);
      // Only tool descriptions ('document') are cached, in plaintext on disk.
      // User turns ('query') never are, and the memory service must be given
      // an embedder built without a cache so memories never reach this file.
      const cache = purpose === "document" ? options.cache : undefined;
      const out: (Float32Array | undefined)[] = inputs.map((input) => cache?.get(model, input));
      const missing = out.flatMap((vector, index) => (vector === undefined ? [index] : []));
      try {
        for (let start = 0; start < missing.length; start += EMBED_BATCH) {
          const batch = missing.slice(start, start + EMBED_BATCH);
          const input = batch.map((index) => inputs[index] as string);
          const response = await request(options.fetch, `${baseUrl}/api/embed`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model, input }),
            signal: AbortSignal.timeout(options.timeoutMs ?? EMBED_TIMEOUT_MS),
          });
          const vectors = parseEmbeddings(await readJson(response, "embed"), batch.length);
          batch.forEach((index, k) => {
            const vector = vectors[k] as Float32Array;
            out[index] = vector;
            cache?.set(model, inputs[index] as string, vector);
          });
        }
      } catch (error) {
        pausedUntil = options.now() + EMBED_RETRY_AFTER_MS;
        const message = error instanceof Error ? error.message : String(error);
        options.log(`[embed] local embeddings unavailable for 10 minutes: ${message}`);
        throw new EmbedderUnavailableError(message);
      }
      return out as Float32Array[];
    },
  };
}
