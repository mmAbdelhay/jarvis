// IndexedDB as encrypted-store.ts's KeyValueBackend (browser build only).
// Thin and untested: one database per store, one object store, every call
// its own transaction. Values are structured-cloned, which is what lets a
// non-extractable CryptoKey be kept at all. The database opens lazily, on
// first use, never at import.
import type { KeyValueBackend } from "./encrypted-store";

const OBJECT_STORE = "kv";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export function createIdbBackend(databaseName: string): KeyValueBackend {
  let database: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    if (database === undefined) {
      database = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(databaseName, 1);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(OBJECT_STORE)) {
            req.result.createObjectStore(OBJECT_STORE);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
        req.onblocked = () => reject(new Error("IndexedDB open blocked"));
      }).catch((error: unknown) => {
        database = undefined;
        throw error;
      });
    }
    return database;
  }

  async function store(mode: IDBTransactionMode): Promise<IDBObjectStore> {
    return (await open()).transaction(OBJECT_STORE, mode).objectStore(OBJECT_STORE);
  }

  return {
    async get(key) {
      return request((await store("readonly")).get(key));
    },
    async put(key, value) {
      await request((await store("readwrite")).put(value, key));
    },
    async putIfAbsent(key, value) {
      // One readwrite transaction: IndexedDB runs overlapping readwrite
      // transactions one at a time, so two tabs can't both win.
      const objectStore = await store("readwrite");
      const existing = await request(objectStore.get(key));
      if (existing !== undefined) return existing;
      await request(objectStore.put(value, key));
      return value;
    },
    async delete(key) {
      await request((await store("readwrite")).delete(key));
    },
  };
}
