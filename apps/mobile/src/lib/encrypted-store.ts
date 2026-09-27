// The browser build's secret storage (Task 13): a `SecureStore` whose
// records are AES-GCM ciphertext under a non-extractable key. Pure over an
// injected key-value backend and SubtleCrypto — idb-backend.ts is the
// IndexedDB backend, secure-store.web.ts / refresh-store.web.ts wire them.
//
// - The key is generated with `extractable: false` and stored as the
//   CryptoKey object itself (IndexedDB structured-clones it); its bytes
//   can never be read back by script, only used by this origin.
// - Every write uses a fresh random 12-byte IV.
// - The additional data binds each record to its namespace and name, so a
//   ciphertext copied under another name (or into the other store) fails
//   to decrypt instead of answering for it.
// - A record that fails to decrypt (tampered, or its key is gone) reads
//   as missing and is removed. A backend failure rejects, so callers that
//   fail closed on an unreadable store (the already-paired check) still do.

import type { SecureStore } from "./secure-store";

export type KeyValueBackend = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  /** Stores `value` only when nothing is stored under `key`, and answers
   *  whatever is stored afterwards (another tab may have won). */
  putIfAbsent(key: string, value: unknown): Promise<unknown>;
  delete(key: string): Promise<void>;
};

export type EncryptedStoreDeps = {
  backend: KeyValueBackend;
  subtle: SubtleCrypto;
  randomBytes(length: number): Uint8Array<ArrayBuffer>;
  /** Bound into every record's additional data. */
  namespace: string;
};

const KEY_RECORD = "key";
const ITEM_PREFIX = "item:";
const IV_BYTES = 12;
const RECORD_VERSION = 1;

type StoredRecord = { v: typeof RECORD_VERSION; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

function isUsableKey(value: unknown): value is CryptoKey {
  if (typeof value !== "object" || value === null) return false;
  const key = value as Partial<CryptoKey>;
  return (
    key.type === "secret" &&
    key.extractable === false &&
    key.algorithm?.name === "AES-GCM" &&
    Array.isArray(key.usages) &&
    key.usages.includes("encrypt") &&
    key.usages.includes("decrypt")
  );
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<StoredRecord>;
  return (
    record.v === RECORD_VERSION &&
    record.iv instanceof Uint8Array &&
    record.iv.length === IV_BYTES &&
    record.data instanceof ArrayBuffer
  );
}

export function createEncryptedStore(deps: EncryptedStoreDeps): SecureStore {
  const { backend, subtle } = deps;
  let keyPromise: Promise<CryptoKey> | undefined;

  async function loadOrCreateKey(): Promise<CryptoKey> {
    const existing = await backend.get(KEY_RECORD);
    if (isUsableKey(existing)) return existing;
    const created = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    if (existing !== undefined) {
      // Not a key this store can use: whatever it sealed is unreadable anyway.
      await backend.put(KEY_RECORD, created);
      return created;
    }
    const stored = await backend.putIfAbsent(KEY_RECORD, created);
    if (!isUsableKey(stored)) throw new Error("encrypted-store: no usable key");
    return stored;
  }

  function key(): Promise<CryptoKey> {
    if (keyPromise === undefined) {
      keyPromise = loadOrCreateKey().catch((error: unknown) => {
        keyPromise = undefined;
        throw error;
      });
    }
    return keyPromise;
  }

  function additionalData(name: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(`${deps.namespace}\n${name}`);
  }

  return {
    async get(name) {
      const record = await backend.get(ITEM_PREFIX + name);
      if (record === undefined) return undefined;
      if (!isStoredRecord(record)) {
        await backend.delete(ITEM_PREFIX + name);
        return undefined;
      }
      const cryptoKey = await key();
      let plain: ArrayBuffer;
      try {
        plain = await subtle.decrypt(
          { name: "AES-GCM", iv: record.iv, additionalData: additionalData(name) },
          cryptoKey,
          record.data,
        );
      } catch {
        await backend.delete(ITEM_PREFIX + name);
        return undefined;
      }
      return new TextDecoder().decode(plain);
    },
    async set(name, value) {
      const cryptoKey = await key();
      const iv = deps.randomBytes(IV_BYTES);
      const data = await subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: additionalData(name) },
        cryptoKey,
        new TextEncoder().encode(value),
      );
      const record: StoredRecord = { v: RECORD_VERSION, iv, data };
      await backend.put(ITEM_PREFIX + name, record);
    },
    async delete(name) {
      await backend.delete(ITEM_PREFIX + name);
    },
  };
}
