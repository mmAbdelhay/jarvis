import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MEMORY_KEY_ACCOUNT,
  createMemorySecretStore,
  type SecretStore,
} from "@jarvis/platform/model";
import { removeMemoryFile } from "@jarvis/platform/store";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_RETRY_MS, createMemoryBackendOpener, loadMemoryKey } from "./memory-backend.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function opener(secrets: SecretStore, clock = { now: 0 }) {
  const dir = await mkdtemp(join(tmpdir(), "mb-"));
  dirs.push(dir);
  const path = join(dir, "memory.sqlite");
  const logs: string[] = [];
  let ids = 0;
  const memory = createMemoryBackendOpener({
    path,
    secrets,
    fileExists: existsSync,
    removeFile: removeMemoryFile,
    randomKey: () => randomBytes(32),
    newId: () => `m${++ids}`,
    now: () => clock.now,
    log: (l) => logs.push(l),
  });
  return { memory, path, logs, clock };
}

describe("loadMemoryKey (ruling: no keyring → memory off)", () => {
  it("creates a key on first use only when no memory file exists", async () => {
    const secrets = createMemorySecretStore();
    const key = await loadMemoryKey({
      secrets,
      fileExists: () => false,
      path: "/x",
      randomKey: () => Buffer.alloc(32, 7),
      log: () => {},
    });
    expect(key).toEqual(Buffer.alloc(32, 7));
    await expect(secrets.get(MEMORY_KEY_ACCOUNT)).resolves.toBe("07".repeat(32));
  });

  it("never makes a new key while memory.sqlite exists (a locked keyring looks empty)", async () => {
    const secrets = createMemorySecretStore();
    let made = 0;
    const key = await loadMemoryKey({
      secrets,
      fileExists: () => true,
      path: "/x",
      randomKey: () => {
        made++;
        return Buffer.alloc(32);
      },
      log: () => {},
    });
    expect(key).toBeNull();
    expect(made).toBe(0);
    await expect(secrets.get(MEMORY_KEY_ACCOUNT)).resolves.toBeUndefined();
  });

  it("is off when the keyring throws or holds a malformed key", async () => {
    const throwing: SecretStore = {
      ...createMemorySecretStore(),
      get: async () => {
        throw new Error("The system keyring is not available");
      },
    };
    const base = {
      fileExists: () => false,
      path: "/x",
      randomKey: () => Buffer.alloc(32),
      log: () => {},
    };
    await expect(loadMemoryKey({ ...base, secrets: throwing })).resolves.toBeNull();
    await expect(
      loadMemoryKey({
        ...base,
        secrets: createMemorySecretStore({ [MEMORY_KEY_ACCOUNT]: "nope" }),
      }),
    ).resolves.toBeNull();
  });
});

describe("createMemoryBackendOpener", () => {
  it("opens once and reuses the store", async () => {
    const { memory } = await opener(createMemorySecretStore());
    const [a, b] = await Promise.all([memory.open(), memory.open()]);
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    await a?.add({ kind: "fact", text: "x", createdAt: 1, embedding: null, embeddingModel: null });
    await expect(a?.list(5)).resolves.toHaveLength(1);
    memory.close();
  });

  it("retries a failed open only after a minute", async () => {
    let reads = 0;
    const flaky: SecretStore = {
      ...createMemorySecretStore(),
      get: async () => {
        reads++;
        throw new Error("locked");
      },
    };
    const { memory, clock } = await opener(flaky);
    await expect(memory.open()).resolves.toBeNull();
    await expect(memory.open()).resolves.toBeNull();
    expect(reads).toBe(1);
    clock.now = MEMORY_RETRY_MS;
    await memory.open();
    expect(reads).toBe(2);
  });

  it("turns off on a wrong key, and Forget all starts over with a new key", async () => {
    const secrets = createMemorySecretStore();
    const first = await opener(secrets);
    await (await first.memory.open())?.add({
      kind: "fact",
      text: "x",
      createdAt: 1,
      embedding: null,
      embeddingModel: null,
    });
    first.memory.close();
    await secrets.set(MEMORY_KEY_ACCOUNT, "ab".repeat(32));
    const second = createMemoryBackendOpener({
      path: first.path,
      secrets,
      fileExists: existsSync,
      removeFile: removeMemoryFile,
      randomKey: () => randomBytes(32),
      newId: () => "n1",
      now: () => 0,
      log: () => {},
    });
    await expect(second.open()).resolves.toBeNull();
    await second.reset();
    expect(existsSync(first.path)).toBe(false);
    const fresh = await second.open();
    await expect(fresh?.all()).resolves.toEqual([]);
    second.close();
  });
});
