// ~/.cache/jarvis/tool-index.sqlite (design §3.8): embeddings keyed by
// sha256(model + text), so tool descriptions are embedded once per model.
// node:sqlite (built into Node 24) — never a native module. Plain text in,
// floats out: nothing secret is cached here (tool names and descriptions;
// memory vectors live sealed in memory.sqlite).
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const VECTOR_CACHE_MAX_ROWS = 5_000;
const PRUNE_EVERY_WRITES = 100;

export interface VectorCache {
  get(model: string, text: string): Float32Array | undefined;
  set(model: string, text: string, vector: Float32Array): void;
  close(): void;
}

export function vectorCacheKey(model: string, text: string): string {
  return createHash("sha256").update(model).update("\n").update(text).digest("hex");
}

export function openVectorCache(options: {
  path: string;
  now(): number;
  maxRows?: number;
}): VectorCache {
  const onDisk = options.path !== ":memory:";
  if (onDisk) mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(options.path);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, data BLOB NOT NULL, used_at INTEGER NOT NULL)",
    );
    if (onDisk) chmodSync(options.path, 0o600);
  } catch (error) {
    db.close();
    throw error;
  }
  const maxRows = options.maxRows ?? VECTOR_CACHE_MAX_ROWS;
  const select = db.prepare("SELECT data FROM vectors WHERE key = ?");
  const touch = db.prepare("UPDATE vectors SET used_at = ? WHERE key = ?");
  const upsert = db.prepare("INSERT OR REPLACE INTO vectors (key, data, used_at) VALUES (?, ?, ?)");
  const prune = db.prepare(
    "DELETE FROM vectors WHERE key NOT IN (SELECT key FROM vectors ORDER BY used_at DESC LIMIT ?)",
  );
  let writes = 0;
  return {
    get(model, text) {
      const key = vectorCacheKey(model, text);
      const row = select.get(key) as { data?: unknown } | undefined;
      const data = row?.data;
      if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength % 4 !== 0) {
        return undefined;
      }
      touch.run(options.now(), key);
      return new Float32Array(
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      );
    },
    set(model, text, vector) {
      upsert.run(
        vectorCacheKey(model, text),
        new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
        options.now(),
      );
      writes++;
      if (writes % PRUNE_EVERY_WRITES === 0) prune.run(maxRows);
    },
    close() {
      db.close();
    },
  };
}
