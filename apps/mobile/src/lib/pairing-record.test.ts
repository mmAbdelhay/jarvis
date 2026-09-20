import { describe, expect, it } from "vitest";
import type { Credential } from "./rpc-client";
import {
  clearPairing,
  loadPairing,
  PairingAlreadyExistsError,
  type PairingRecord,
  savePairing,
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
  // JSON, a token embedded in the record) without going through savePairing.
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

describe("savePairing / loadPairing", () => {
  it("round-trips a saved record and credential", async () => {
    const store = new FakeSecureStore();
    await savePairing(store, RECORD, CREDENTIAL);

    const loaded = await loadPairing(store);
    expect(loaded).toEqual({ record: RECORD, credential: CREDENTIAL });
  });

  it("round-trips a record carrying a system-trust `name` (M11)", async () => {
    const store = new FakeSecureStore();
    const record: PairingRecord = { ...RECORD, name: "mac.tail.ts.net" };
    await savePairing(store, record, CREDENTIAL);

    const loaded = await loadPairing(store);
    expect(loaded?.record.name).toBe("mac.tail.ts.net");
  });

  it("round-trips a record with no `name` (pinned mode) — no such key persists", async () => {
    const store = new FakeSecureStore();
    await savePairing(store, RECORD, CREDENTIAL);

    const recordText = store.raw("jarvis.pairing");
    expect(recordText).toBeDefined();
    expect(JSON.parse(recordText ?? "{}")).not.toHaveProperty("name");
  });

  it("round-trips a record with no laptopName", async () => {
    const store = new FakeSecureStore();
    const record: PairingRecord = { ...RECORD, laptopName: undefined };
    delete (record as { laptopName?: string }).laptopName;
    await savePairing(store, record, CREDENTIAL);

    const loaded = await loadPairing(store);
    expect(loaded?.record.laptopName).toBeUndefined();
  });

  it("stores the token only under jarvis.token, never inside the JSON record", async () => {
    const store = new FakeSecureStore();
    await savePairing(store, RECORD, CREDENTIAL);

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

    await savePairing(store, RECORD, CREDENTIAL);

    expect(order).toEqual(["jarvis.token", "jarvis.pairing"]);
  });
});

describe("savePairing refuses when a valid record already exists (Important-1)", () => {
  it(
    "throws PairingAlreadyExistsError and does not overwrite the existing record or token " +
      "[bite-proof: drop the existing-record check and this test fails]",
    async () => {
      const store = new FakeSecureStore();
      await savePairing(store, RECORD, CREDENTIAL);

      const otherRecord: PairingRecord = { ...RECORD, deviceId: "e".repeat(32) };
      const otherCredential: Credential = { deviceId: otherRecord.deviceId, token: "U".repeat(43) };

      await expect(savePairing(store, otherRecord, otherCredential)).rejects.toBeInstanceOf(
        PairingAlreadyExistsError,
      );

      const loaded = await loadPairing(store);
      expect(loaded).toEqual({ record: RECORD, credential: CREDENTIAL });
    },
  );

  it("succeeds once the existing record has been cleared first", async () => {
    const store = new FakeSecureStore();
    await savePairing(store, RECORD, CREDENTIAL);
    await clearPairing(store);

    const otherRecord: PairingRecord = { ...RECORD, deviceId: "e".repeat(32) };
    const otherCredential: Credential = { deviceId: otherRecord.deviceId, token: "U".repeat(43) };
    await expect(savePairing(store, otherRecord, otherCredential)).resolves.toBeUndefined();

    const loaded = await loadPairing(store);
    expect(loaded).toEqual({ record: otherRecord, credential: otherCredential });
  });

  it("does not refuse when only an unusable (orphan/corrupt) record is present", async () => {
    const store = new FakeSecureStore();
    store.putRaw("jarvis.pairing", "{not json");
    // No token: loadPairing (which the existence check reuses) treats this
    // as nothing usable, so a fresh save must be allowed to proceed.
    await expect(savePairing(store, RECORD, CREDENTIAL)).resolves.toBeUndefined();
  });

  it(
    "does not refuse when a token is present alongside a corrupt/unusable record " +
      "[bite-proof: task-5-rereview-r2.md Minor 5 — the no-token case above already " +
      "passes, but a token key surviving next to a corrupt record has never been " +
      "exercised; savePairing must still clear the orphan token via loadPairing " +
      "and let the fresh save proceed]",
    async () => {
      const store = new FakeSecureStore();
      store.putRaw("jarvis.pairing", "{not json");
      store.putRaw("jarvis.token", CREDENTIAL.token);

      await expect(savePairing(store, RECORD, CREDENTIAL)).resolves.toBeUndefined();

      const loaded = await loadPairing(store);
      expect(loaded).toEqual({ record: RECORD, credential: CREDENTIAL });
    },
  );
});

describe("clearPairing", () => {
  it("deletes both the record and token keys", async () => {
    const store = new FakeSecureStore();
    await savePairing(store, RECORD, CREDENTIAL);

    await clearPairing(store);

    expect(store.raw("jarvis.pairing")).toBeUndefined();
    expect(store.raw("jarvis.token")).toBeUndefined();
    expect(await loadPairing(store)).toBeUndefined();
  });
});
