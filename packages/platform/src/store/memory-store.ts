// ~/.local/share/jarvis/memory.sqlite (design §3.9). node:sqlite with each
// row sealed by AES-256-GCM under the keyring key (the plan's Decisions:
// SQLCipher needs a native module this build cannot ship). AAD = the row id,
// so a row moved to another id does not open; a sealed check value tells a
// wrong key from a damaged row. In clear: ids, created_at, the row count.
// PRAGMA secure_delete zeroes deleted rows. File 0600, directory 0700.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type MemoryKind, type MemoryRecord, type NewMemory, isRecord } from "@jarvis/core";

export const MEMORY_KEY_BYTES = 32;
const CHECK_TEXT = "jarvis-memory-v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class MemoryKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryKeyError";
  }
}

export function sealRecord(key: Uint8Array, aad: string, plain: Uint8Array): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function openRecord(key: Uint8Array, aad: string, sealed: Uint8Array): Buffer {
  const data = Buffer.from(sealed);
  if (data.length < IV_BYTES + TAG_BYTES) throw new MemoryKeyError("A memory row is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(data.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

function encode(memory: NewMemory): Buffer {
  const vector = memory.embedding;
  return Buffer.from(
    JSON.stringify({
      k: memory.kind,
      t: memory.text,
      e:
        vector === null
          ? null
          : Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64"),
      m: memory.embeddingModel,
    }),
    "utf8",
  );
}

function decode(id: string, createdAt: number, plain: Buffer): MemoryRecord | undefined {
  const value: unknown = JSON.parse(plain.toString("utf8"));
  if (!isRecord(value)) return undefined;
  const { k, t, e, m } = value;
  if ((k !== "summary" && k !== "fact") || typeof t !== "string") return undefined;
  let embedding: Float32Array | null = null;
  if (typeof e === "string") {
    const bytes = Buffer.from(e, "base64");
    if (bytes.length % 4 === 0 && bytes.length > 0) {
      embedding = new Float32Array(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      );
    }
  }
  return {
    id,
    kind: k as MemoryKind,
    text: t,
    createdAt,
    embedding,
    embeddingModel: embedding !== null && typeof m === "string" ? m : null,
  };
}

export interface MemoryStore {
  add(memory: NewMemory): string;
  list(limit: number): MemoryRecord[];
  all(): MemoryRecord[];
  delete(id: string): boolean;
  clear(): void;
  close(): void;
}

export function openMemoryStore(options: {
  path: string;
  key: Uint8Array;
  newId(): string;
  log?(line: string): void;
}): MemoryStore {
  if (options.key.length !== MEMORY_KEY_BYTES)
    throw new MemoryKeyError("The memory key must be 32 bytes");
  const onDisk = options.path !== ":memory:";
  if (onDisk) mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(options.path);
  try {
    db.exec("PRAGMA secure_delete = ON");
    db.exec(
      "CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL);" +
        "CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, sealed BLOB NOT NULL);" +
        "CREATE INDEX IF NOT EXISTS memories_created ON memories (created_at);",
    );
    const check = db.prepare("SELECT v FROM meta WHERE k = 'check'").get() as
      | { v?: unknown }
      | undefined;
    if (check === undefined) {
      db.prepare("INSERT INTO meta (k, v) VALUES ('check', ?)").run(
        sealRecord(options.key, "check", Buffer.from(CHECK_TEXT, "utf8")),
      );
    } else {
      let text = "";
      try {
        text = openRecord(options.key, "check", check.v as Uint8Array).toString("utf8");
      } catch {
        text = "";
      }
      if (text !== CHECK_TEXT)
        throw new MemoryKeyError("The memory key does not open this memory file");
    }
    if (onDisk) chmodSync(options.path, 0o600);
  } catch (error) {
    db.close();
    throw error;
  }

  const insert = db.prepare("INSERT INTO memories (id, created_at, sealed) VALUES (?, ?, ?)");
  const newest = db.prepare(
    "SELECT id, created_at, sealed FROM memories ORDER BY created_at DESC, id DESC LIMIT ?",
  );
  const every = db.prepare(
    "SELECT id, created_at, sealed FROM memories ORDER BY created_at DESC, id DESC",
  );
  const remove = db.prepare("DELETE FROM memories WHERE id = ?");
  let warned = false;

  const rows = (raw: unknown[]): MemoryRecord[] =>
    raw.flatMap((row) => {
      const {
        id,
        created_at: createdAt,
        sealed,
      } = row as { id: unknown; created_at: unknown; sealed: unknown };
      if (
        typeof id !== "string" ||
        typeof createdAt !== "number" ||
        !(sealed instanceof Uint8Array)
      )
        return [];
      try {
        const record = decode(id, createdAt, openRecord(options.key, id, sealed));
        return record === undefined ? [] : [record];
      } catch {
        if (!warned) options.log?.("[memory] a memory row could not be opened; skipped");
        warned = true;
        return [];
      }
    });

  return {
    add(memory) {
      const id = options.newId();
      insert.run(id, Math.trunc(memory.createdAt), sealRecord(options.key, id, encode(memory)));
      return id;
    },
    list: (limit) => rows(newest.all(limit)),
    all: () => rows(every.all()),
    delete: (id) => Number(remove.run(id).changes) > 0,
    clear() {
      db.exec("DELETE FROM memories");
      db.exec("VACUUM");
    },
    close() {
      db.close();
    },
  };
}

export function removeMemoryFile(path: string): void {
  for (const suffix of ["", "-journal", "-wal", "-shm"])
    rmSync(`${path}${suffix}`, { force: true });
}
