// The memory store's key and lifecycle in jarvisd (design §3.9 rulings): the
// key lives in Secret Service (account "memory-key"); without a keyring,
// memory is off — never stored in clear. A key is made only when no memory
// file exists: a locked keyring answers "no such item", and making a new key
// then would orphan every memory. Failures retry after a minute. Forget all
// on an unreadable file removes the file and the key and starts over.
//
// No electron here (core/no-electron.test.ts).
import type { MemoryBackend } from "@jarvis/core";
import { MEMORY_KEY_ACCOUNT, type SecretStore } from "@jarvis/platform/model";
import { MemoryKeyError, type MemoryStore, openMemoryStore } from "@jarvis/platform/store";

export const MEMORY_RETRY_MS = 60_000;
const KEY_HEX = /^[0-9a-f]{64}$/;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function loadMemoryKey(deps: {
  secrets: SecretStore;
  fileExists(path: string): boolean;
  path: string;
  randomKey(): Uint8Array;
  log(line: string): void;
}): Promise<Uint8Array | null> {
  let stored: string | undefined;
  try {
    stored = await deps.secrets.get(MEMORY_KEY_ACCOUNT);
  } catch (error) {
    deps.log(`[memory] the keyring is not available, so memory is off for now: ${describe(error)}`);
    return null;
  }
  if (stored !== undefined) {
    const hex = stored.trim();
    if (KEY_HEX.test(hex)) return Buffer.from(hex, "hex");
    deps.log("[memory] the stored memory key is malformed; memory is off");
    return null;
  }
  if (deps.fileExists(deps.path)) {
    deps.log(
      "[memory] memory.sqlite exists but no key was found (keyring locked?); memory is off for now",
    );
    return null;
  }
  const key = deps.randomKey();
  try {
    await deps.secrets.set(MEMORY_KEY_ACCOUNT, Buffer.from(key).toString("hex"));
  } catch (error) {
    deps.log(`[memory] could not store a memory key, so memory is off: ${describe(error)}`);
    return null;
  }
  return key;
}

function asBackend(store: MemoryStore): MemoryBackend {
  return {
    add: async (memory) => store.add(memory),
    list: async (limit) => store.list(limit),
    all: async () => store.all(),
    delete: async (id) => store.delete(id),
    clear: async () => store.clear(),
  };
}

export type MemoryOpener = {
  open(): Promise<MemoryBackend | null>;
  reset(): Promise<void>;
  close(): void;
};

export function createMemoryBackendOpener(deps: {
  path: string;
  secrets: SecretStore;
  fileExists(path: string): boolean;
  removeFile(path: string): void;
  randomKey(): Uint8Array;
  newId(): string;
  now(): number;
  log(line: string): void;
}): MemoryOpener {
  let store: MemoryStore | undefined;
  let backend: MemoryBackend | undefined;
  let opening: Promise<MemoryBackend | null> | undefined;
  let retryAt = 0;

  async function tryOpen(): Promise<MemoryBackend | null> {
    if (deps.now() < retryAt) return null;
    const key = await loadMemoryKey(deps);
    if (key === null) {
      retryAt = deps.now() + MEMORY_RETRY_MS;
      return null;
    }
    try {
      store = openMemoryStore({ path: deps.path, key, newId: deps.newId, log: deps.log });
    } catch (error) {
      retryAt = deps.now() + MEMORY_RETRY_MS;
      deps.log(
        error instanceof MemoryKeyError
          ? "[memory] the memory key does not open memory.sqlite; memory is off until Forget all"
          : `[memory] memory.sqlite could not be opened: ${describe(error)}`,
      );
      return null;
    }
    backend = asBackend(store);
    return backend;
  }

  return {
    open() {
      if (backend !== undefined) return Promise.resolve(backend);
      opening ??= tryOpen().finally(() => {
        opening = undefined;
      });
      return opening;
    },
    async reset() {
      store?.close();
      store = undefined;
      backend = undefined;
      deps.removeFile(deps.path);
      try {
        await deps.secrets.remove(MEMORY_KEY_ACCOUNT);
      } catch (error) {
        deps.log(`[memory] could not remove the old memory key: ${describe(error)}`);
      }
      retryAt = 0;
    },
    close() {
      store?.close();
      store = undefined;
      backend = undefined;
    },
  };
}
