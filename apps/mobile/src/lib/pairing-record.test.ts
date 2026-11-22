import { describe, expect, it } from "vitest";
import type { Credential } from "./rpc-client";
import {
  clearPairingAt,
  LEGACY_PAIRING_KEYS,
  loadPairing,
  loadPairingAt,
  type PairingRecord,
  savePairingAt,
} from "./pairing-record";
import type { SecureStore } from "./secure-store";

class FakeSecureStore implements SecureStore {
  private values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  // Test-only helper: lets a test poke a raw value in directly (corrupt
  // JSON, a token embedded in the record) without going through savePairingAt.
  raw(key: string): string | undefined {
    return this.values.get(key);
  }

  putRaw(key: string, value: string): void {
    this.values.set(key, value);
  }
}

const RECORD: PairingRecord = {
  deviceId: "d".repeat(32),
  host: "192.168.1.5",
  port: 4317,
  fingerprint: "a".repeat(64),
  laptopName: "Aziz's MacBook",
  pairedAt: 1_700_000_000_000,
};
const CREDENTIAL: Credential = { deviceId: RECORD.deviceId, token: "T".repeat(43) };

describe("savePairingAt / loadPairing, at the legacy keys", () => {
  it("round-trips a saved record and credential", async () => {
    const store = new FakeSecureStore();
    await savePairingAt(store, LEGACY_PAIRING_KEYS, RECORD, CREDENTIAL);

    const loaded = await loadPairing(store);
    expect(loaded).toEqual({ record: RECORD, credential: CREDENTIAL });
  });

  it("round-trips a record carrying a system-trust `name` (M11)", async () => {
    const store = new FakeSecureStore();
    const record: PairingRecord = { ...RECORD, name: "mac.tail.ts.net" };
    await savePairingAt(store, LEGACY_PAIRING_KEYS, record, CREDENTIAL);

    const loaded = await loadPairing(store);
    expect(loaded?.record.name).toBe("mac.tail.ts.net");
  });

  it("round-trips a record with no `name` (pinned mode) — no such key persists", async () => {
    const store = new FakeSecureStore();
    await savePairingAt(store, LEGACY_PAIRING_KEYS, RECORD, CREDENTIAL);

    const recordText = store.raw("jarvis.pairing");
    expect(recordText).toBeDefined();
    expect(JSON.parse(recordText ?? "{}")).not.toHaveProperty("name");
  });

  it("round-trips a record with no laptopName", async () => {
    const store = new FakeSecureStore();
    const record: PairingRecord = { ...RECORD, laptopName: undefined };
    delete (record as { laptopName?: string }).laptopName;
    await savePairingAt(store, LEGACY_PAIRING_KEYS, record, CREDENTIAL);

    const loaded = await loadPairing(store);
    expect(loaded?.record.laptopName).toBeUndefined();
  });

  it("stores the token only under jarvis.token, never inside the JSON record", async () => {
    const store = new FakeSecureStore();
    await savePairingAt(store, LEGACY_PAIRING_KEYS, RECORD, CREDENTIAL);

    const recordText = store.raw("jarvis.pairing");
    expect(recordText).toBeDefined();
    expect(recordText).not.toContain(CREDENTIAL.token);
    expect(store.raw("jarvis.token")).toBe(CREDENTIAL.token);
  });

  it("returns undefined and clears the record when a record exists but no token does", async () => {
    const store = new FakeSecureStore();
    store.putRaw("jarvis.pairing", JSON.stringify(RECORD));

    const loaded = await loadPairing(store);
    expect(loaded).toBeUndefined();
    expect(store.raw("jarvis.pairing")).toBeUndefined();
  });

  it("returns undefined and clears both keys for corrupt JSON in the record", async () => {
    const store = new FakeSecureStore();
    store.putRaw("jarvis.pairing", "{not json");
    store.putRaw("jarvis.token", CREDENTIAL.token);

    const loaded = await loadPairing(store);
    expect(loaded).toBeUndefined();
    expect(store.raw("jarvis.pairing")).toBeUndefined();
    expect(store.raw("jarvis.token")).toBeUndefined();
  });

  it("returns undefined when no record has ever been saved", async () => {
    const store = new FakeSecureStore();
    const loaded = await loadPairing(store);
    expect(loaded).toBeUndefined();
  });

  it("returns undefined and clears both keys when the record JSON is missing required fields", async () => {
    const store = new FakeSecureStore();
    store.putRaw("jarvis.pairing", JSON.stringify({ deviceId: RECORD.deviceId }));
    store.putRaw("jarvis.token", CREDENTIAL.token);

    const loaded = await loadPairing(store);
    expect(loaded).toBeUndefined();
    expect(store.raw("jarvis.pairing")).toBeUndefined();
    expect(store.raw("jarvis.token")).toBeUndefined();
  });

  it("returns undefined and clears both keys when deviceId doesn't match DEVICE_ID_PATTERN", async () => {
    const store = new FakeSecureStore();
    store.putRaw("jarvis.pairing", JSON.stringify({ ...RECORD, deviceId: "not-hex" }));
    store.putRaw("jarvis.token", CREDENTIAL.token);

    const loaded = await loadPairing(store);
    expect(loaded).toBeUndefined();
    expect(store.raw("jarvis.pairing")).toBeUndefined();
    expect(store.raw("jarvis.token")).toBeUndefined();
  });

  it("returns undefined and clears both keys when fingerprint doesn't match FINGERPRINT_PATTERN", async () => {
    const store = new FakeSecureStore();
    store.putRaw("jarvis.pairing", JSON.stringify({ ...RECORD, fingerprint: "not-hex" }));
    store.putRaw("jarvis.token", CREDENTIAL.token);

    const loaded = await loadPairing(store);
    expect(loaded).toBeUndefined();
    expect(store.raw("jarvis.pairing")).toBeUndefined();
    expect(store.raw("jarvis.token")).toBeUndefined();
  });

  it("returns undefined and clears both keys when the port is out of range", async () => {
    const store = new FakeSecureStore();
    store.putRaw("jarvis.pairing", JSON.stringify({ ...RECORD, port: 70_000 }));
    store.putRaw("jarvis.token", CREDENTIAL.token);

    const loaded = await loadPairing(store);
    expect(loaded).toBeUndefined();
    expect(store.raw("jarvis.pairing")).toBeUndefined();
    expect(store.raw("jarvis.token")).toBeUndefined();
  });

  it("returns undefined and clears both keys when the host isn't a canonical IP literal", async () => {
    const store = new FakeSecureStore();
    store.putRaw("jarvis.pairing", JSON.stringify({ ...RECORD, host: "laptop.local" }));
    store.putRaw("jarvis.token", CREDENTIAL.token);

    const loaded = await loadPairing(store);
    expect(loaded).toBeUndefined();
    expect(store.raw("jarvis.pairing")).toBeUndefined();
    expect(store.raw("jarvis.token")).toBeUndefined();
  });

  it(
    "returns undefined and clears both keys when `name` is an IP literal, not a HOSTNAME_PATTERN " +
      "match (M11) [bite-proof: drop the HOSTNAME_PATTERN check on `name` and this fails]",
    async () => {
      const store = new FakeSecureStore();
      store.putRaw("jarvis.pairing", JSON.stringify({ ...RECORD, name: "192.168.1.2" }));
      store.putRaw("jarvis.token", CREDENTIAL.token);

      const loaded = await loadPairing(store);
      expect(loaded).toBeUndefined();
      expect(store.raw("jarvis.pairing")).toBeUndefined();
      expect(store.raw("jarvis.token")).toBeUndefined();
    },
  );

  it("writes the token before the record, so a crash after the first write never leaves a record with a stale token", async () => {
    const store = new FakeSecureStore();
    const order: string[] = [];
    const originalSet = store.set.bind(store);
    store.set = (key: string, value: string) => {
      order.push(key);
      return originalSet(key, value);
    };

    await savePairingAt(store, LEGACY_PAIRING_KEYS, RECORD, CREDENTIAL);

    expect(order).toEqual(["jarvis.token", "jarvis.pairing"]);
  });
});

describe("a self-heal delete that fails", () => {
  function failingDeletes(): FakeSecureStore {
    const store = new FakeSecureStore();
    store.delete = () => Promise.reject(new Error("keychain delete failed"));
    return store;
  }

  it("still answers undefined for an empty slot", async () => {
    await expect(loadPairing(failingDeletes())).resolves.toBeUndefined();
  });

  it("still answers undefined for a record with no token", async () => {
    const store = failingDeletes();
    store.putRaw("jarvis.pairing", JSON.stringify(RECORD));
    await expect(loadPairing(store)).resolves.toBeUndefined();
  });

  it("still answers undefined for a corrupt record", async () => {
    const store = failingDeletes();
    store.putRaw("jarvis.pairing", "{not json");
    store.putRaw("jarvis.token", CREDENTIAL.token);
    await expect(loadPairing(store)).resolves.toBeUndefined();
  });

  it("still answers undefined for an invalid record", async () => {
    const store = failingDeletes();
    store.putRaw("jarvis.pairing", JSON.stringify({ deviceId: RECORD.deviceId }));
    store.putRaw("jarvis.token", CREDENTIAL.token);
    await expect(loadPairing(store)).resolves.toBeUndefined();
  });
});

describe("the *At functions, at a machine's own keys", () => {
  const KEYS = { record: "jarvis.m.a_1.pairing", token: "jarvis.m.a_1.token" };

  it("round-trips at the given keys and leaves the legacy keys alone", async () => {
    const store = new FakeSecureStore();
    await savePairingAt(store, KEYS, RECORD, CREDENTIAL);

    expect(store.raw(KEYS.token)).toBe(CREDENTIAL.token);
    expect(store.raw("jarvis.pairing")).toBeUndefined();
    expect(store.raw("jarvis.token")).toBeUndefined();
    expect(await loadPairingAt(store, KEYS)).toEqual({ record: RECORD, credential: CREDENTIAL });
  });

  it("savePairingAt overwrites a valid pairing: the caller decides, there is no existing-check", async () => {
    const store = new FakeSecureStore();
    await savePairingAt(store, KEYS, RECORD, CREDENTIAL);
    const next: Credential = { deviceId: RECORD.deviceId, token: "N".repeat(43) };
    await savePairingAt(store, KEYS, RECORD, next);
    expect((await loadPairingAt(store, KEYS))?.credential).toEqual(next);
  });

  it("savePairingAt writes the token before the record, and persists field by field", async () => {
    const writes: string[] = [];
    const store = new FakeSecureStore();
    const set = store.set.bind(store);
    store.set = (key, value) => {
      writes.push(key);
      return set(key, value);
    };
    const leaky = { ...RECORD, token: CREDENTIAL.token } as PairingRecord;
    await savePairingAt(store, KEYS, leaky, CREDENTIAL);
    expect(writes).toEqual([KEYS.token, KEYS.record]);
    expect(store.raw(KEYS.record)).not.toContain(CREDENTIAL.token);
  });

  it("loadPairingAt clears only its own keys for an invalid record", async () => {
    const store = new FakeSecureStore();
    await savePairingAt(store, LEGACY_PAIRING_KEYS, RECORD, CREDENTIAL);
    store.putRaw(KEYS.record, "{not json");
    store.putRaw(KEYS.token, CREDENTIAL.token);

    expect(await loadPairingAt(store, KEYS)).toBeUndefined();
    expect(store.raw(KEYS.record)).toBeUndefined();
    expect(store.raw(KEYS.token)).toBeUndefined();
    expect(await loadPairing(store)).toEqual({ record: RECORD, credential: CREDENTIAL });
  });

  it("clearPairingAt deletes only its own keys", async () => {
    const store = new FakeSecureStore();
    await savePairingAt(store, LEGACY_PAIRING_KEYS, RECORD, CREDENTIAL);
    await savePairingAt(store, KEYS, RECORD, CREDENTIAL);
    await clearPairingAt(store, KEYS);

    expect(store.raw(KEYS.record)).toBeUndefined();
    expect(store.raw(KEYS.token)).toBeUndefined();
    expect(await loadPairing(store)).toBeDefined();
  });
});

describe("clearPairingAt, at the legacy keys", () => {
  it("deletes both the record and token keys", async () => {
    const store = new FakeSecureStore();
    await savePairingAt(store, LEGACY_PAIRING_KEYS, RECORD, CREDENTIAL);

    await clearPairingAt(store, LEGACY_PAIRING_KEYS);

    expect(store.raw("jarvis.pairing")).toBeUndefined();
    expect(store.raw("jarvis.token")).toBeUndefined();
    expect(await loadPairing(store)).toBeUndefined();
  });
});
