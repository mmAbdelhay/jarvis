import { describe, expect, it } from "vitest";
import { createEncryptedStore, type KeyValueBackend } from "./encrypted-store";

function memoryBackend(): KeyValueBackend & { entries: Map<string, unknown> } {
  const entries = new Map<string, unknown>();
  return {
    entries,
    async get(key) {
      return entries.get(key);
    },
    async put(key, value) {
      entries.set(key, value);
    },
    async putIfAbsent(key, value) {
      if (!entries.has(key)) entries.set(key, value);
      return entries.get(key);
    },
    async delete(key) {
      entries.delete(key);
    },
  };
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

function storeOver(backend: KeyValueBackend, namespace = "jarvis.secure") {
  return createEncryptedStore({ backend, subtle: crypto.subtle, randomBytes, namespace });
}

const TOKEN = "a".repeat(64);

function itemRecords(backend: { entries: Map<string, unknown> }) {
  return [...backend.entries.entries()].filter(([key]) => key.startsWith("item:"));
}

describe("createEncryptedStore", () => {
  it("round-trips a value and reads undefined for a missing key", async () => {
    const store = storeOver(memoryBackend());
    expect(await store.get("jarvis.token")).toBeUndefined();
    await store.set("jarvis.token", TOKEN);
    expect(await store.get("jarvis.token")).toBe(TOKEN);
    await store.delete("jarvis.token");
    expect(await store.get("jarvis.token")).toBeUndefined();
  });

  it("stores only ciphertext: the plaintext is nowhere in the backend", async () => {
    const backend = memoryBackend();
    const store = storeOver(backend);
    await store.set("jarvis.token", TOKEN);
    const [[, record]] = itemRecords(backend) as [[string, { iv: Uint8Array; data: ArrayBuffer }]];
    const cipherText = new TextDecoder("latin1").decode(new Uint8Array(record.data));
    expect(cipherText).not.toContain(TOKEN);
    expect(JSON.stringify([...backend.entries.keys()])).not.toContain(TOKEN);
  });

  it("holds a non-extractable AES-GCM key that cannot be exported", async () => {
    const backend = memoryBackend();
    await storeOver(backend).set("k", "v");
    const key = backend.entries.get("key") as CryptoKey;
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("uses a fresh 12-byte IV on every write, even of the same value", async () => {
    const backend = memoryBackend();
    const store = storeOver(backend);
    await store.set("k", "same");
    const first = backend.entries.get("item:k") as { iv: Uint8Array; data: ArrayBuffer };
    await store.set("k", "same");
    const second = backend.entries.get("item:k") as { iv: Uint8Array; data: ArrayBuffer };
    expect(first.iv).toHaveLength(12);
    expect(second.iv).toHaveLength(12);
    expect([...second.iv]).not.toEqual([...first.iv]);
    expect([...new Uint8Array(second.data)]).not.toEqual([...new Uint8Array(first.data)]);
  });

  it("a second store over the same backend (a page reload) reads what the first wrote", async () => {
    const backend = memoryBackend();
    await storeOver(backend).set("jarvis.pairing", '{"name":"laptop"}');
    expect(await storeOver(backend).get("jarvis.pairing")).toBe('{"name":"laptop"}');
  });

  it("two stores starting at once agree on one key", async () => {
    const backend = memoryBackend();
    const a = storeOver(backend);
    const b = storeOver(backend);
    await Promise.all([a.set("x", "1"), b.set("y", "2")]);
    expect(await a.get("y")).toBe("2");
    expect(await b.get("x")).toBe("1");
  });

  it("a tampered record reads as undefined and is removed", async () => {
    const backend = memoryBackend();
    const store = storeOver(backend);
    await store.set("k", "v");
    const record = backend.entries.get("item:k") as { iv: Uint8Array; data: ArrayBuffer };
    const data = new Uint8Array(record.data.slice(0));
    data[0] = (data[0] ?? 0) ^ 1;
    backend.entries.set("item:k", { ...record, data: data.buffer });
    expect(await store.get("k")).toBeUndefined();
    expect(backend.entries.has("item:k")).toBe(false);
  });

  it("a record copied under another name or namespace does not decrypt", async () => {
    const backend = memoryBackend();
    const store = storeOver(backend);
    await store.set("jarvis.token", TOKEN);
    backend.entries.set("item:other", backend.entries.get("item:jarvis.token"));
    expect(await store.get("other")).toBeUndefined();

    const shared = memoryBackend();
    await storeOver(shared, "jarvis.refresh").set("k", TOKEN);
    expect(await storeOver(shared, "jarvis.secure").get("k")).toBeUndefined();
  });

  it("a malformed record reads as undefined", async () => {
    const backend = memoryBackend();
    const store = storeOver(backend);
    backend.entries.set("item:k", "plain text");
    expect(await store.get("k")).toBeUndefined();
  });

  it("replaces a stored key that is not a usable AES-GCM key", async () => {
    const backend = memoryBackend();
    backend.entries.set("key", { algorithm: { name: "AES-GCM" } });
    const store = storeOver(backend);
    await store.set("k", "v");
    expect(await store.get("k")).toBe("v");
    expect((backend.entries.get("key") as CryptoKey).extractable).toBe(false);
  });

  it("a backend failure surfaces as a rejection (the pairing check fails closed)", async () => {
    const backend = memoryBackend();
    backend.get = async () => {
      throw new Error("blocked");
    };
    await expect(storeOver(backend).get("k")).rejects.toThrow();
  });
});
