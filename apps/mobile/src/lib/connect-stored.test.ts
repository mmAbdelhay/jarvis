import { describe, expect, it } from "vitest";
import { connectFromStoredPairing } from "./connect-stored";
import { type MachineStore, createMachineStore } from "./machine-store";
import type { PairingRecord } from "./pairing-record";
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

/** The real store, over fake keychains and no prefs on disk. */
function machineStoreOver(secure: SecureStore): MachineStore {
  return createMachineStore({
    secure,
    refresh: createFakeSecureStore(),
    prefs: { read: async () => undefined, write: async () => {} },
    localeTag: "en-US",
    singleSlot: false,
    log: () => {},
  });
}

type Machines = Pick<MachineStore, "activeId" | "load">;

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
    unlock: () => {},
    lock: () => {},
  } satisfies RpcClient;
  return { client, connectCalls };
}

const DEVICE_ID = "d1234567890123456789012345678901";
const FINGERPRINT = `${"a".repeat(60)}beef`;
const RECORD: PairingRecord = {
  deviceId: DEVICE_ID,
  host: "192.168.1.5",
  port: 4317,
  fingerprint: FINGERPRINT,
  pairedAt: 1_000,
};
const CREDENTIAL: Credential = { deviceId: DEVICE_ID, token: "secret-token" };
const ACTIVE_ID = "192.168.1.5_4317";

/** One active machine. Answers `load` only for the id it holds. */
function machinesHolding(record: PairingRecord = RECORD): Machines & { loads: string[] } {
  const loads: string[] = [];
  return {
    loads,
    activeId: () => ACTIVE_ID,
    load: async (id) => {
      loads.push(id);
      return id === ACTIVE_ID ? { record, credential: CREDENTIAL } : undefined;
    },
  };
}

describe("connectFromStoredPairing", () => {
  it("connects with the active machine's endpoint and credential", async () => {
    const machines = machinesHolding();
    const { client, connectCalls } = createFakeClient();

    const outcome = await connectFromStoredPairing({ machines, client });

    expect(outcome).toBe("connected");
    expect(machines.loads).toEqual([ACTIVE_ID]);
    expect(connectCalls).toEqual([
      {
        endpoint: { host: "192.168.1.5", port: 4317, fingerprint: FINGERPRINT },
        credential: CREDENTIAL,
      },
    ]);
  });

  it("passes the stored `name` through to client.connect (M11 system-trust mode)", async () => {
    const machines = machinesHolding({ ...RECORD, name: "mac.tail.ts.net" });
    const { client, connectCalls } = createFakeClient();

    const outcome = await connectFromStoredPairing({ machines, client });

    expect(outcome).toBe("connected");
    expect(connectCalls[0]?.endpoint).toEqual({
      host: "192.168.1.5",
      port: 4317,
      fingerprint: FINGERPRINT,
      name: "mac.tail.ts.net",
    });
  });

  it('no active id answers "unpaired", reads nothing and never connects', async () => {
    const loads: string[] = [];
    const machines: Machines = {
      activeId: () => undefined,
      load: async (id) => {
        loads.push(id);
        return undefined;
      },
    };
    const { client, connectCalls } = createFakeClient();

    expect(await connectFromStoredPairing({ machines, client })).toBe("unpaired");
    expect(loads).toEqual([]);
    expect(connectCalls).toEqual([]);
  });

  it('an active id whose record is gone answers "unpaired"', async () => {
    const machines: Machines = { activeId: () => ACTIVE_ID, load: async () => undefined };
    const { client, connectCalls } = createFakeClient();

    expect(await connectFromStoredPairing({ machines, client })).toBe("unpaired");
    expect(connectCalls).toEqual([]);
  });

  it('a throwing load answers "failed", never a rejection', async () => {
    const machines: Machines = {
      activeId: () => ACTIVE_ID,
      load: async () => {
        throw new Error("keychain unavailable");
      },
    };
    const { client, connectCalls } = createFakeClient();

    expect(await connectFromStoredPairing({ machines, client })).toBe("failed");
    expect(connectCalls).toEqual([]);
  });

  it('a store whose open failed answers "failed", not "unpaired"', async () => {
    const failing: SecureStore = {
      get: async () => {
        throw new Error("keychain unavailable");
      },
      set: async () => {},
      delete: async () => {},
    };
    const machines = machineStoreOver(failing);
    expect(await machines.open()).toBe("failed");
    const { client, connectCalls } = createFakeClient();

    expect(await connectFromStoredPairing({ machines, client })).toBe("failed");
    expect(connectCalls).toEqual([]);
  });

  it("connects through the real store, from a migrated pairing", async () => {
    const machines = machineStoreOver(
      createFakeSecureStore({
        "jarvis.pairing": JSON.stringify(RECORD),
        "jarvis.token": "secret-token",
      }),
    );
    expect(await machines.open()).toBe("ok");
    const { client, connectCalls } = createFakeClient();

    expect(await connectFromStoredPairing({ machines, client })).toBe("connected");
    expect(connectCalls[0]?.credential).toEqual(CREDENTIAL);
  });

  it('answers "unpaired" and clears the orphaned record when the record is there and the token is not', async () => {
    const secure = createFakeSecureStore({
      "jarvis.pairing": JSON.stringify(RECORD),
      "jarvis.token": "secret-token",
    });
    const machines = machineStoreOver(secure);
    expect(await machines.open()).toBe("ok");
    await secure.delete("jarvis.token");
    const { client, connectCalls } = createFakeClient();

    expect(await connectFromStoredPairing({ machines, client })).toBe("unpaired");
    expect(connectCalls).toEqual([]);
    expect(await secure.get("jarvis.pairing")).toBeUndefined();
  });

  describe("shouldConnect", () => {
    it('false answers "unpaired" after the read, with no connect', async () => {
      const machines = machinesHolding();
      const { client, connectCalls } = createFakeClient();

      const outcome = await connectFromStoredPairing({
        machines,
        client,
        shouldConnect: () => false,
      });

      expect(outcome).toBe("unpaired");
      expect(machines.loads).toEqual([ACTIVE_ID]);
      expect(connectCalls).toEqual([]);
    });

    it("[I-A bite-proof] calls client.connect when shouldConnect returns true", async () => {
      const { client, connectCalls } = createFakeClient();

      // Dropping the `shouldConnect`/`!deps.shouldConnect()` check in
      // connect-stored.ts would make the "false" test above fail (connect
      // would be called anyway) — this test is the control that proves the
      // guard isn't just permanently blocking connect outright.
      const outcome = await connectFromStoredPairing({
        machines: machinesHolding(),
        client,
        shouldConnect: () => true,
      });

      expect(outcome).toBe("connected");
      expect(connectCalls).toHaveLength(1);
    });
  });
});
