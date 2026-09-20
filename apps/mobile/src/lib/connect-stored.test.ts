import { describe, expect, it } from "vitest";
import { connectFromStoredPairing } from "./connect-stored";
import type { Credential, Endpoint, RpcClient } from "./rpc-client";
import type { SecureStore } from "./secure-store";

function createFakeSecureStore(initial: Record<string, string> = {}): SecureStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

function createFakeClient() {
  const connectCalls: { endpoint: Endpoint; credential: Credential }[] = [];
  const client = {
    connect: (endpoint: Endpoint, credential: Credential) => {
      connectCalls.push({ endpoint, credential });
    },
    disconnect: () => {},
    call: async () => ({ ok: false as const, error: { kind: "offline" as const } }),
    upload: async () => ({ ok: false as const, error: { kind: "offline" as const } }),
    subscribe: () => ({ ok: true as const, value: undefined }),
    unsubscribe: () => {},
    onPush: () => () => {},
    onState: () => () => {},
    state: () => "idle" as const,
    capabilities: () => [],
    subscriptions: () => [],
    lastFrameAt: () => undefined,
    setAppActive: () => {},
  } satisfies RpcClient;
  return { client, connectCalls };
}

const RECORD_JSON = JSON.stringify({
  deviceId: "d1234567890123456789012345678901",
  host: "192.168.1.5",
  port: 4317,
  fingerprint: `${"a".repeat(60)}beef`,
  pairedAt: 1_000,
});

describe("connectFromStoredPairing", () => {
  it('returns "connected" and calls client.connect with the stored endpoint+credential', async () => {
    const secureStore = createFakeSecureStore({
      "jarvis.pairing": RECORD_JSON,
      "jarvis.token": "secret-token",
    });
    const { client, connectCalls } = createFakeClient();

    const outcome = await connectFromStoredPairing({ secureStore, client });

    expect(outcome).toBe("connected");
    expect(connectCalls).toEqual([
      {
        endpoint: {
          host: "192.168.1.5",
          port: 4317,
          fingerprint: `${"a".repeat(60)}beef`,
        },
        credential: { deviceId: "d1234567890123456789012345678901", token: "secret-token" },
      },
    ]);
  });

  it("passes the stored `name` through to client.connect (M11 system-trust mode)", async () => {
    const namedRecordJson = JSON.stringify({
      deviceId: "d1234567890123456789012345678901",
      host: "192.168.1.5",
      port: 4317,
      fingerprint: `${"a".repeat(60)}beef`,
      name: "mac.tail.ts.net",
      pairedAt: 1_000,
    });
    const secureStore = createFakeSecureStore({
      "jarvis.pairing": namedRecordJson,
      "jarvis.token": "secret-token",
    });
    const { client, connectCalls } = createFakeClient();

    const outcome = await connectFromStoredPairing({ secureStore, client });

    expect(outcome).toBe("connected");
    expect(connectCalls[0]?.endpoint).toEqual({
      host: "192.168.1.5",
      port: 4317,
      fingerprint: `${"a".repeat(60)}beef`,
      name: "mac.tail.ts.net",
    });
  });

  it('returns "unpaired" and never connects when there is no stored pairing', async () => {
    const secureStore = createFakeSecureStore();
    const { client, connectCalls } = createFakeClient();

    const outcome = await connectFromStoredPairing({ secureStore, client });

    expect(outcome).toBe("unpaired");
    expect(connectCalls).toEqual([]);
  });

  it('returns "failed" (never throws) when the keychain read itself throws', async () => {
    const secureStore: SecureStore = {
      get: async () => {
        throw new Error("keychain unavailable");
      },
      set: async () => {},
      delete: async () => {},
    };
    const { client, connectCalls } = createFakeClient();

    const outcome = await connectFromStoredPairing({ secureStore, client });

    expect(outcome).toBe("failed");
    expect(connectCalls).toEqual([]);
  });

  it('returns "unpaired" and clears the orphaned record when the record is present but the token is missing', async () => {
    // The "missing credential" path the ruling names: loadPairing (see
    // pairing-record.ts) treats a record with no matching token as
    // unusable and deletes it, rather than handing back a record with an
    // empty/undefined credential.
    const secureStore = createFakeSecureStore({ "jarvis.pairing": RECORD_JSON });
    const { client, connectCalls } = createFakeClient();

    const outcome = await connectFromStoredPairing({ secureStore, client });

    expect(outcome).toBe("unpaired");
    expect(connectCalls).toEqual([]);
    expect(await secureStore.get("jarvis.pairing")).toBeUndefined();
  });

  describe("shouldConnect", () => {
    it("never calls client.connect when shouldConnect() returns false, even with a valid stored pairing", async () => {
      const secureStore = createFakeSecureStore({
        "jarvis.pairing": RECORD_JSON,
        "jarvis.token": "secret-token",
      });
      const { client, connectCalls } = createFakeClient();

      const outcome = await connectFromStoredPairing({
        secureStore,
        client,
        shouldConnect: () => false,
      });

      expect(outcome).toBe("unpaired");
      expect(connectCalls).toEqual([]);
    });

    it("[I-A bite-proof] calls client.connect when shouldConnect is omitted, or returns true", async () => {
      const secureStore = createFakeSecureStore({
        "jarvis.pairing": RECORD_JSON,
        "jarvis.token": "secret-token",
      });
      const { client, connectCalls } = createFakeClient();

      // Dropping the `shouldConnect`/`!deps.shouldConnect()` check in
      // connect-stored.ts would make the "returns false" test above fail
      // (connect would be called anyway) — this test is the control that
      // proves the guard isn't just permanently blocking connect outright.
      const outcome = await connectFromStoredPairing({
        secureStore,
        client,
        shouldConnect: () => true,
      });

      expect(outcome).toBe("connected");
      expect(connectCalls).toHaveLength(1);
    });
  });
});
