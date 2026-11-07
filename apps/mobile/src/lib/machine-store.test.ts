import { describe, expect, it } from "vitest";
import { takeClearFailedSignal } from "./clear-failed-signal";
import { MACHINE_INDEX_KEY, parseMachineIndex } from "./machine-index";
import {
  type MachineStore,
  MachineLimitError,
  createMachineStore,
  createMachineStoreOpener,
  removeActiveMachine,
} from "./machine-store";
import { phaseAfterCheck } from "./pair-flow";
import { PairingAlreadyExistsError, type PairingRecord } from "./pairing-record";
import { type PrefsStore, loadPrefs } from "./prefs";
import type { SecureStore } from "./secure-store";
import { createUnpairedHandler } from "./unpaired-handler";

const REFRESH_TOKEN = "R".repeat(43);
const DEVICE_A = "a".repeat(32);
const DEVICE_B = "b".repeat(32);
const DEVICE_C = "c".repeat(32);
const NAME_ID = "mac.tail.ts.net_7717";
const OTHER_ID = "other.tail.ts.net_7717";
const LAN_ID = "192.168.1.5_4317";

class FakeStore implements SecureStore {
  values = new Map<string, string>();
  sets: string[] = [];
  deletes: string[] = [];
  failGet?: (key: string) => boolean;
  failSet?: (key: string) => boolean;
  failDelete?: (key: string) => boolean;

  get(key: string): Promise<string | undefined> {
    if (this.failGet?.(key) === true) return Promise.reject(new Error("keychain read failed"));
    return Promise.resolve(this.values.get(key));
  }

  set(key: string, value: string): Promise<void> {
    if (this.failSet?.(key) === true) return Promise.reject(new Error("keychain write failed"));
    this.sets.push(key);
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    if (this.failDelete?.(key) === true) return Promise.reject(new Error("keychain delete failed"));
    this.deletes.push(key);
    this.values.delete(key);
    return Promise.resolve();
  }

  forgetCalls(): void {
    this.sets = [];
    this.deletes = [];
  }
}

class FakePrefs implements PrefsStore {
  writes = 0;
  failWrite = false;
  constructor(public text?: string) {}
  read(): Promise<string | undefined> {
    return Promise.resolve(this.text);
  }
  write(text: string): Promise<void> {
    if (this.failWrite) return Promise.reject(new Error("prefs write failed"));
    this.writes += 1;
    this.text = text;
    return Promise.resolve();
  }
}

function lanRecord(deviceId = DEVICE_A): PairingRecord {
  return {
    deviceId,
    host: "192.168.1.5",
    port: 4317,
    fingerprint: "f".repeat(64),
    laptopName: "Aziz's MacBook",
    pairedAt: 1_700_000_000_000,
  };
}

function namedRecord(name: string, deviceId = DEVICE_B, port = 7717): PairingRecord {
  return {
    deviceId,
    host: "0.0.0.0",
    port,
    fingerprint: "0".repeat(64),
    name,
    pairedAt: 1_700_000_000_000,
  };
}

function credentialOf(record: PairingRecord, fill = "T") {
  return { deviceId: record.deviceId, token: fill.repeat(43) };
}

function harness(options: { singleSlot?: boolean; prefs?: string } = {}) {
  const secure = new FakeStore();
  const refresh = new FakeStore();
  const prefs = new FakePrefs(options.prefs);
  const logs: string[] = [];
  const build = (): MachineStore =>
    createMachineStore({
      secure,
      refresh,
      prefs,
      localeTag: "en-US",
      singleSlot: options.singleSlot ?? false,
      log: (line) => logs.push(line),
    });
  return { secure, refresh, prefs, logs, build };
}

type Harness = ReturnType<typeof harness>;

function seedLegacy(h: Harness, record = lanRecord()): void {
  h.secure.values.set("jarvis.pairing", JSON.stringify(record));
  h.secure.values.set("jarvis.token", credentialOf(record).token);
  h.refresh.values.set("jarvis.refresh", REFRESH_TOKEN);
}

function seedIndex(h: Harness, index: object): void {
  h.secure.values.set(MACHINE_INDEX_KEY, JSON.stringify({ v: 1, ...index }));
}

function seedMachine(h: Harness, id: string, record: PairingRecord, refreshToken?: string): void {
  h.secure.values.set(`jarvis.m.${id}.pairing`, JSON.stringify(record));
  h.secure.values.set(`jarvis.m.${id}.token`, credentialOf(record).token);
  if (refreshToken !== undefined) h.refresh.values.set(`jarvis.m.${id}.refresh`, refreshToken);
}

function storedIndex(h: Harness) {
  const text = h.secure.values.get(MACHINE_INDEX_KEY);
  return text === undefined ? undefined : JSON.parse(text);
}

async function opened(h: Harness): Promise<MachineStore> {
  const store = h.build();
  expect(await store.open()).toBe("ok");
  return store;
}

describe("open: migrating an existing pairing", () => {
  it("makes one machine of the legacy record, token and refresh, all three keys unchanged", async () => {
    const h = harness();
    seedLegacy(h);
    const store = await opened(h);

    expect(store.activeId()).toBe(LAN_ID);
    expect(storedIndex(h)).toEqual({ v: 1, ids: [LAN_ID], active: LAN_ID, legacy: LAN_ID });
    expect(await store.load(LAN_ID)).toEqual({
      record: lanRecord(),
      credential: credentialOf(lanRecord()),
    });
    expect(store.refreshKey(LAN_ID)).toBe("jarvis.refresh");
    expect(await h.refresh.get(store.refreshKey(LAN_ID))).toBe(REFRESH_TOKEN);
    expect(h.secure.values.get("jarvis.pairing")).toBe(JSON.stringify(lanRecord()));
    expect(h.secure.values.get("jarvis.token")).toBe(credentialOf(lanRecord()).token);
  });

  it("writes exactly one key and calls no delete", async () => {
    const h = harness();
    seedLegacy(h);
    await opened(h);

    expect(h.secure.sets).toEqual([MACHINE_INDEX_KEY]);
    expect(h.secure.deletes).toEqual([]);
    expect(h.refresh.sets).toEqual([]);
    expect(h.refresh.deletes).toEqual([]);
    expect(h.prefs.writes).toBe(0);
  });

  it("a failed index write still opens, leaves the legacy keys intact and the next open migrates", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;

    const failing = await opened(h);
    expect(failing.activeId()).toBe(LAN_ID);
    expect((await failing.loadActive())?.credential).toEqual(credentialOf(lanRecord()));
    expect(failing.refreshKey(LAN_ID)).toBe("jarvis.refresh");
    expect(h.secure.values.has(MACHINE_INDEX_KEY)).toBe(false);
    expect(h.secure.values.get("jarvis.pairing")).toBe(JSON.stringify(lanRecord()));
    expect(h.secure.values.get("jarvis.token")).toBe(credentialOf(lanRecord()).token);
    expect(h.refresh.values.get("jarvis.refresh")).toBe(REFRESH_TOKEN);

    h.secure.failSet = undefined;
    const store = await opened(h);
    expect(store.activeId()).toBe(LAN_ID);
    expect(await store.load(LAN_ID)).toBeDefined();
  });

  it("a repeated open after the migration changes nothing", async () => {
    const h = harness();
    seedLegacy(h);
    await opened(h);
    h.secure.forgetCalls();

    const store = await opened(h);
    expect(store.activeId()).toBe(LAN_ID);
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
  });

  it("writes no index on an empty phone", async () => {
    const h = harness();
    const store = await opened(h);

    expect(h.secure.sets).toEqual([]);
    expect(store.activeId()).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });
});

describe("open: reads that throw", () => {
  it("answers failed and writes nothing when the index read throws", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;

    expect(await h.build().open()).toBe("failed");
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
    expect(h.refresh.deletes).toEqual([]);
  });

  it("answers failed and writes nothing when the legacy read throws on a phone with no index", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.failGet = (key) => key === "jarvis.pairing";

    expect(await h.build().open()).toBe("failed");
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
  });

  it("answers failed and writes nothing when the legacy read throws while reconciling", async () => {
    const h = harness();
    seedLegacy(h);
    seedIndex(h, { ids: [LAN_ID], active: LAN_ID, legacy: LAN_ID });
    h.secure.failGet = (key) => key === "jarvis.pairing";

    expect(await h.build().open()).toBe("failed");
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
  });

  it("answers failed, not corrupt, when the legacy read throws under a corrupt index", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.values.set(MACHINE_INDEX_KEY, "{nope");
    h.secure.failGet = (key) => key === "jarvis.token";

    expect(await h.build().open()).toBe("failed");
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.values.get(MACHINE_INDEX_KEY)).toBe("{nope");
    expect(h.logs).toEqual([]);
  });

  it("a store whose open failed refuses to change anything", async () => {
    // It knows of no machine, so an add would write an index naming only the
    // new one and every other machine would be lost.
    const h = harness();
    seedLegacy(h);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: NAME_ID, legacy: LAN_ID });
    h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;
    const store = h.build();
    expect(await store.open()).toBe("failed");
    h.secure.failGet = undefined;
    const before = h.secure.values.get(MACHINE_INDEX_KEY);

    const record = namedRecord("new.tail.ts.net", DEVICE_C);
    await expect(store.add(record, credentialOf(record))).rejects.toThrow();
    await expect(store.remove(NAME_ID)).rejects.toThrow();
    await expect(store.setActive(NAME_ID)).rejects.toThrow();
    expect(h.secure.values.get(MACHINE_INDEX_KEY)).toBe(before);
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);

    expect(await store.open()).toBe("ok");
    expect(store.activeId()).toBe(NAME_ID);
  });
});

describe("open: a corrupt index", () => {
  it("rebuilds to one machine from a valid legacy slot and logs the fixed line", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.values.set(MACHINE_INDEX_KEY, "{nope");
    const store = await opened(h);

    expect(storedIndex(h)).toEqual({ v: 1, ids: [LAN_ID], active: LAN_ID, legacy: LAN_ID });
    expect(store.activeId()).toBe(LAN_ID);
    expect(h.logs).toEqual(["machines: index unreadable, rebuilt"]);
    expect(h.refresh.values.get("jarvis.refresh")).toBe(REFRESH_TOKEN);
  });

  it("rebuilds empty with no legacy slot", async () => {
    const h = harness();
    h.secure.values.set(MACHINE_INDEX_KEY, "{nope");
    const store = await opened(h);

    expect(storedIndex(h)).toEqual({ v: 1, ids: [] });
    expect(store.activeId()).toBeUndefined();
    expect(h.logs).toEqual(["machines: index unreadable, rebuilt"]);
  });

  it("counts an unknown v as corrupt", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.values.set(MACHINE_INDEX_KEY, JSON.stringify({ v: 2, ids: ["x_1"] }));
    await opened(h);

    expect(storedIndex(h)).toEqual({ v: 1, ids: [LAN_ID], active: LAN_ID, legacy: LAN_ID });
    expect(h.logs).toEqual(["machines: index unreadable, rebuilt"]);
  });
});

describe("open: reconciling after a downgrade", () => {
  it("removes the legacy machine when the old app cleared it, leaving the others", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: LAN_ID, legacy: LAN_ID });
    const store = await opened(h);

    expect(storedIndex(h)).toEqual({ v: 1, ids: [NAME_ID] });
    expect(store.activeId()).toBe(NAME_ID);
    expect(await store.load(NAME_ID)).toBeDefined();
  });

  it("the legacy slot found empty: its refresh key and top-level flags go before the index", async () => {
    const order: string[] = [];
    const h = harness({
      prefs: JSON.stringify({ refreshTokenStored: true, pushRegistered: true }),
    });
    h.refresh.values.set("jarvis.refresh", REFRESH_TOKEN);
    seedIndex(h, { ids: [LAN_ID], active: LAN_ID, legacy: LAN_ID });
    const refreshDelete = h.refresh.delete.bind(h.refresh);
    h.refresh.delete = (key) => {
      order.push(`refresh.delete ${key}`);
      return refreshDelete(key);
    };
    const prefsWrite = h.prefs.write.bind(h.prefs);
    h.prefs.write = (text) => {
      order.push("prefs.write");
      return prefsWrite(text);
    };
    const secureSet = h.secure.set.bind(h.secure);
    h.secure.set = (key, value) => {
      order.push(`secure.set ${key}`);
      return secureSet(key, value);
    };
    await opened(h);

    expect(order).toEqual([
      "refresh.delete jarvis.refresh",
      "prefs.write",
      `secure.set ${MACHINE_INDEX_KEY}`,
    ]);
    expect(h.refresh.values.has("jarvis.refresh")).toBe(false);
    const prefs = await loadPrefs(h.prefs, "en-US");
    expect(prefs.refreshTokenStored).toBe(false);
    expect(prefs.pushRegistered).toBe(false);
  });

  it("the legacy slot found empty: a failed refresh delete opens without the id, keeps it on disk, and the next open finishes", async () => {
    const h = harness();
    h.refresh.values.set("jarvis.refresh", REFRESH_TOKEN);
    seedIndex(h, { ids: [LAN_ID], active: LAN_ID, legacy: LAN_ID });
    h.refresh.failDelete = (key) => key === "jarvis.refresh";

    const failing = await opened(h);
    expect(failing.activeId()).toBeUndefined();
    expect(await failing.list()).toEqual([]);
    expect(storedIndex(h).legacy).toBe(LAN_ID);

    h.refresh.failDelete = undefined;
    await opened(h);
    expect(h.refresh.values.has("jarvis.refresh")).toBe(false);
    expect(storedIndex(h)).toEqual({ v: 1, ids: [] });
  });

  it("replaces the legacy machine when the old app paired another, and active follows", async () => {
    const h = harness();
    const replaced = namedRecord("new.tail.ts.net", DEVICE_C);
    seedLegacy(h, replaced);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: LAN_ID, legacy: LAN_ID });
    const store = await opened(h);

    const newId = "new.tail.ts.net_7717";
    expect(storedIndex(h)).toEqual({ v: 1, ids: [newId, NAME_ID], active: newId, legacy: newId });
    expect(store.refreshKey(newId)).toBe("jarvis.refresh");
    expect((await store.load(newId))?.record.deviceId).toBe(DEVICE_C);
    expect(await store.load(NAME_ID)).toBeDefined();
  });

  it("leaves active on another machine when the legacy slot is replaced", async () => {
    const h = harness();
    const replaced = namedRecord("new.tail.ts.net", DEVICE_C);
    seedLegacy(h, replaced);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: NAME_ID, legacy: LAN_ID });
    await opened(h);

    expect(storedIndex(h).active).toBe(NAME_ID);
  });

  it("adds a legacy record the index has no legacy for", async () => {
    const h = harness();
    seedLegacy(h);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [NAME_ID], active: NAME_ID });
    const store = await opened(h);

    expect(storedIndex(h)).toEqual({
      v: 1,
      ids: [NAME_ID, LAN_ID],
      active: NAME_ID,
      legacy: LAN_ID,
    });
    expect(store.refreshKey(LAN_ID)).toBe("jarvis.refresh");
  });

  it("legacy re-paired to an id with per-machine keys: deletes those and marks it legacy", async () => {
    const h = harness({
      prefs: JSON.stringify({
        refreshTokenStored: true,
        machineFlags: { [NAME_ID]: { refreshTokenStored: true, pushRegistered: true } },
      }),
    });
    const repaired = namedRecord("mac.tail.ts.net", DEVICE_C);
    seedLegacy(h, repaired);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "OLD-PER-MACHINE");
    seedIndex(h, { ids: [NAME_ID], active: NAME_ID });
    const store = await opened(h);

    expect(storedIndex(h)).toEqual({ v: 1, ids: [NAME_ID], active: NAME_ID, legacy: NAME_ID });
    expect(h.secure.values.has(`jarvis.m.${NAME_ID}.pairing`)).toBe(false);
    expect(h.secure.values.has(`jarvis.m.${NAME_ID}.token`)).toBe(false);
    expect(h.refresh.values.has(`jarvis.m.${NAME_ID}.refresh`)).toBe(false);
    expect(h.refresh.values.get("jarvis.refresh")).toBe(REFRESH_TOKEN);
    expect((await store.load(NAME_ID))?.record.deviceId).toBe(DEVICE_C);
    const prefs = await loadPrefs(h.prefs, "en-US");
    expect(prefs.machineFlags).toEqual({});
    expect(prefs.refreshTokenStored).toBe(true);
  });

  it("legacy replaced by an id that already has its own keys: one entry, its keys gone", async () => {
    const h = harness();
    seedLegacy(h, namedRecord("mac.tail.ts.net", DEVICE_C));
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "OLD-PER-MACHINE");
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: LAN_ID, legacy: LAN_ID });
    await opened(h);

    expect(storedIndex(h)).toEqual({ v: 1, ids: [NAME_ID], active: NAME_ID, legacy: NAME_ID });
    expect(h.refresh.values.has(`jarvis.m.${NAME_ID}.refresh`)).toBe(false);
  });

  it("a failed index write in the reconcile still opens, and repeats cleanly on the next open", async () => {
    const h = harness();
    const repaired = namedRecord("mac.tail.ts.net", DEVICE_C);
    seedLegacy(h, repaired);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "OLD-PER-MACHINE");
    seedIndex(h, { ids: [NAME_ID], active: NAME_ID });
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;
    const failing = await opened(h);
    expect(failing.refreshKey(NAME_ID)).toBe("jarvis.refresh");
    expect((await failing.load(NAME_ID))?.record.deviceId).toBe(DEVICE_C);
    expect(storedIndex(h).legacy).toBeUndefined();

    h.secure.failSet = undefined;
    const store = await opened(h);
    expect(storedIndex(h).legacy).toBe(NAME_ID);
    expect((await store.load(NAME_ID))?.record.deviceId).toBe(DEVICE_C);
    expect(h.refresh.values.get("jarvis.refresh")).toBe(REFRESH_TOKEN);
  });

  it("writes nothing when the index and the legacy slot agree", async () => {
    const h = harness();
    seedLegacy(h);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: NAME_ID, legacy: LAN_ID });
    await opened(h);

    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
  });
});

describe("add", () => {
  it("adds a different id, and the first still loads", async () => {
    const h = harness();
    seedLegacy(h);
    const store = await opened(h);
    const record = namedRecord("mac.tail.ts.net");

    expect(await store.add(record, credentialOf(record, "N"))).toBe(NAME_ID);
    expect((await store.load(NAME_ID))?.credential.token).toBe("N".repeat(43));
    expect(await store.load(LAN_ID)).toBeDefined();
    expect(store.activeId()).toBe(LAN_ID);
    expect(h.secure.values.get(`jarvis.m.${NAME_ID}.token`)).toBe("N".repeat(43));
    expect(h.secure.values.get("jarvis.token")).toBe(credentialOf(lanRecord()).token);
  });

  it("throws PairingAlreadyExistsError for the same id, changing nothing", async () => {
    const h = harness();
    seedLegacy(h);
    const store = await opened(h);
    h.secure.forgetCalls();

    const record = lanRecord(DEVICE_C);
    await expect(store.add(record, credentialOf(record, "N"))).rejects.toBeInstanceOf(
      PairingAlreadyExistsError,
    );
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
    expect(h.secure.values.get("jarvis.token")).toBe(credentialOf(lanRecord()).token);
  });

  it("writes token, then record, then index", async () => {
    const h = harness();
    const store = await opened(h);
    const record = namedRecord("mac.tail.ts.net");
    await store.add(record, credentialOf(record));

    expect(h.secure.sets).toEqual([
      `jarvis.m.${NAME_ID}.token`,
      `jarvis.m.${NAME_ID}.pairing`,
      MACHINE_INDEX_KEY,
    ]);
  });

  it("a crash after token and record, before the index: re-add succeeds and overwrites", async () => {
    const h = harness();
    const first = await opened(h);
    const record = namedRecord("mac.tail.ts.net");
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;
    await expect(first.add(record, credentialOf(record, "A"))).rejects.toThrow();
    expect(await first.list()).toEqual([]);
    expect(h.secure.values.get(`jarvis.m.${NAME_ID}.token`)).toBe("A".repeat(43));
    h.secure.failSet = undefined;

    const store = await opened(h);
    expect(await store.list()).toEqual([]);
    expect(await store.add(record, credentialOf(record, "B"))).toBe(NAME_ID);
    expect((await store.load(NAME_ID))?.credential.token).toBe("B".repeat(43));
  });

  it("an id not in the index clears a leftover refresh token and flags", async () => {
    const h = harness({
      prefs: JSON.stringify({
        machineFlags: { [NAME_ID]: { refreshTokenStored: true, pushRegistered: true } },
      }),
    });
    h.refresh.values.set(`jarvis.m.${NAME_ID}.refresh`, "LEFTOVER");
    const store = await opened(h);
    const record = namedRecord("mac.tail.ts.net");
    await store.add(record, credentialOf(record));

    expect(h.refresh.values.has(`jarvis.m.${NAME_ID}.refresh`)).toBe(false);
    expect(await store.refreshFlag(NAME_ID).read()).toBe(false);
    expect(await store.pushFlag(NAME_ID).read()).toBe(false);
  });

  it("an id in the index whose record is invalid is replaced, with its old refresh gone", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "STALE");
    h.secure.values.set(`jarvis.m.${NAME_ID}.pairing`, "{nope");
    seedIndex(h, { ids: [NAME_ID] });
    const store = await opened(h);
    const record = namedRecord("mac.tail.ts.net");

    await store.add(record, credentialOf(record, "N"));
    expect((await store.load(NAME_ID))?.credential.token).toBe("N".repeat(43));
    expect(storedIndex(h).ids).toEqual([NAME_ID]);
    expect(h.refresh.values.has(`jarvis.m.${NAME_ID}.refresh`)).toBe(false);
  });

  it("a throwing read of the same id neither adds nor deletes", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "KEEP");
    seedIndex(h, { ids: [NAME_ID] });
    const store = await opened(h);
    h.secure.forgetCalls();
    h.secure.failGet = (key) => key === `jarvis.m.${NAME_ID}.pairing`;
    const record = namedRecord("mac.tail.ts.net");

    await expect(store.add(record, credentialOf(record))).rejects.toThrow();
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
    expect(h.refresh.values.get(`jarvis.m.${NAME_ID}.refresh`)).toBe("KEEP");
  });
});

describe("the limits", () => {
  // Exactly 40 characters, a valid hostname, unique by `i`.
  const name40 = (i: number) => `m${String(i).padStart(2, "0")}${"x".repeat(30)}.ts.net`;
  // A valid hostname of 253 characters, unique by `i`.
  const longName = (i: number) =>
    `m${String(i).padStart(2, "0")}${"x".repeat(58)}.${"y".repeat(61)}.${"y".repeat(61)}.${"y".repeat(61)}.ts.net`.slice(
      0,
      253,
    );

  it("16 machines of 40-character names fit in 2000 bytes, and a 17th throws MachineLimitError", async () => {
    const h = harness();
    const store = await opened(h);
    for (let i = 0; i < 16; i += 1) {
      const name = name40(i);
      expect(name).toHaveLength(40);
      const record = namedRecord(name);
      await store.add(record, credentialOf(record));
    }
    expect(storedIndex(h).ids).toHaveLength(16);
    expect(h.secure.values.get(MACHINE_INDEX_KEY)?.length ?? 0).toBeLessThanOrEqual(2000);

    const extra = namedRecord(name40(16));
    h.secure.forgetCalls();
    await expect(store.add(extra, credentialOf(extra))).rejects.toBeInstanceOf(MachineLimitError);
    expect(h.secure.sets).toEqual([]);
  });

  it("long names past 2000 bytes throw MachineLimitError with fewer than 16", async () => {
    const h = harness();
    const store = await opened(h);
    let added = 0;
    let thrown: unknown;
    for (let i = 0; i < 16 && thrown === undefined; i += 1) {
      const name = longName(i);
      expect(name).toHaveLength(253);
      const record = namedRecord(name);
      try {
        await store.add(record, credentialOf(record));
        added += 1;
      } catch (error) {
        thrown = error;
      }
    }
    expect(thrown).toBeInstanceOf(MachineLimitError);
    expect(added).toBeLessThan(16);
    expect(h.secure.values.get(MACHINE_INDEX_KEY)?.length ?? 0).toBeLessThanOrEqual(2000);
  });

  it("the size stays within the limit whichever machine later becomes active", async () => {
    const h = harness();
    const store = await opened(h);
    for (let i = 0; i < 16; i += 1) {
      const record = namedRecord(longName(i));
      try {
        await store.add(record, credentialOf(record));
      } catch {
        break;
      }
    }
    const ids = storedIndex(h).ids as string[];
    await store.setActive(ids[ids.length - 1] as string);
    expect(h.secure.values.get(MACHINE_INDEX_KEY)?.length ?? 0).toBeLessThanOrEqual(2000);
  });
});

describe("remove", () => {
  it("removing one machine leaves another's three keys untouched", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "NAME-REFRESH");
    seedMachine(h, OTHER_ID, namedRecord("other.tail.ts.net", DEVICE_C), "OTHER-REFRESH");
    seedIndex(h, { ids: [NAME_ID, OTHER_ID], active: NAME_ID });
    const store = await opened(h);
    await store.remove(NAME_ID);

    expect(h.secure.values.has(`jarvis.m.${NAME_ID}.pairing`)).toBe(false);
    expect(h.secure.values.has(`jarvis.m.${NAME_ID}.token`)).toBe(false);
    expect(h.refresh.values.has(`jarvis.m.${NAME_ID}.refresh`)).toBe(false);
    expect(h.secure.values.has(`jarvis.m.${OTHER_ID}.pairing`)).toBe(true);
    expect(h.secure.values.has(`jarvis.m.${OTHER_ID}.token`)).toBe(true);
    expect(h.refresh.values.get(`jarvis.m.${OTHER_ID}.refresh`)).toBe("OTHER-REFRESH");
  });

  it("deletes token, record, refresh and flags, then writes the index last", async () => {
    const order: string[] = [];
    const h = harness({
      prefs: JSON.stringify({
        machineFlags: { [NAME_ID]: { refreshTokenStored: true, pushRegistered: true } },
      }),
    });
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "R");
    seedIndex(h, { ids: [NAME_ID] });
    const store = await opened(h);
    const spy = <T extends object, K extends keyof T>(target: T, key: K, label: string) => {
      const original = target[key] as (...args: unknown[]) => unknown;
      target[key] = ((...args: unknown[]) => {
        order.push(`${label} ${String(args[0]).startsWith("{") ? "" : args[0]}`.trim());
        return original.apply(target, args);
      }) as T[K];
    };
    spy(h.secure, "delete", "secure.delete");
    spy(h.secure, "set", "secure.set");
    spy(h.refresh, "delete", "refresh.delete");
    spy(h.prefs, "write", "prefs.write");
    await store.remove(NAME_ID);

    expect(order).toEqual([
      `secure.delete jarvis.m.${NAME_ID}.token`,
      `secure.delete jarvis.m.${NAME_ID}.pairing`,
      `refresh.delete jarvis.m.${NAME_ID}.refresh`,
      "prefs.write",
      `secure.set ${MACHINE_INDEX_KEY}`,
    ]);
    expect((await loadPrefs(h.prefs, "en-US")).machineFlags).toEqual({});
  });

  it("removing the legacy machine deletes the three legacy keys and later adds use per-machine keys", async () => {
    const h = harness({
      prefs: JSON.stringify({ refreshTokenStored: true, pushRegistered: true }),
    });
    seedLegacy(h);
    const store = await opened(h);
    await store.remove(LAN_ID);

    expect(h.secure.values.has("jarvis.pairing")).toBe(false);
    expect(h.secure.values.has("jarvis.token")).toBe(false);
    expect(h.refresh.values.has("jarvis.refresh")).toBe(false);
    expect(storedIndex(h)).toEqual({ v: 1, ids: [] });
    const prefs = await loadPrefs(h.prefs, "en-US");
    expect(prefs.refreshTokenStored).toBe(false);
    expect(prefs.pushRegistered).toBe(false);

    const record = lanRecord(DEVICE_C);
    await store.add(record, credentialOf(record, "N"));
    expect(h.secure.values.has("jarvis.pairing")).toBe(false);
    expect(h.secure.values.get(`jarvis.m.${LAN_ID}.token`)).toBe("N".repeat(43));
    expect(store.refreshKey(LAN_ID)).toBe(`jarvis.m.${LAN_ID}.refresh`);
  });

  it("removing the active id leaves active unset, so activeId falls back to the first", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedMachine(h, OTHER_ID, namedRecord("other.tail.ts.net", DEVICE_C));
    seedIndex(h, { ids: [NAME_ID, OTHER_ID], active: OTHER_ID });
    const store = await opened(h);
    await store.remove(OTHER_ID);

    expect(storedIndex(h)).toEqual({ v: 1, ids: [NAME_ID] });
    expect(store.activeId()).toBe(NAME_ID);
  });

  it("a failed index write: gone at once, and the entry left on disk self-heals", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "R");
    seedMachine(h, OTHER_ID, namedRecord("other.tail.ts.net", DEVICE_C));
    seedIndex(h, { ids: [NAME_ID, OTHER_ID], active: NAME_ID });
    const first = await opened(h);
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;
    await first.remove(NAME_ID);
    expect(first.activeId()).toBe(OTHER_ID);
    h.secure.failSet = undefined;

    const store = await opened(h);
    expect(storedIndex(h).ids).toEqual([NAME_ID, OTHER_ID]);
    expect(await store.load(NAME_ID)).toBeUndefined();
    expect(storedIndex(h).ids).toEqual([OTHER_ID]);
    expect(await store.load(OTHER_ID)).toBeDefined();
  });

  function legacyAndAnother(): Harness {
    const h = harness({
      prefs: JSON.stringify({ refreshTokenStored: true, pushRegistered: true }),
    });
    seedLegacy(h);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "NAME-REFRESH");
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: LAN_ID, legacy: LAN_ID });
    return h;
  }

  async function expectLegacyCleanedUp(h: Harness, store: MachineStore): Promise<void> {
    expect(storedIndex(h)).toEqual({ v: 1, ids: [NAME_ID] });
    expect(h.secure.values.has("jarvis.pairing")).toBe(false);
    expect(h.secure.values.has("jarvis.token")).toBe(false);
    expect(h.refresh.values.has("jarvis.refresh")).toBe(false);
    const prefs = await loadPrefs(h.prefs, "en-US");
    expect(prefs.refreshTokenStored).toBe(false);
    expect(prefs.pushRegistered).toBe(false);
    expect(store.activeId()).toBe(NAME_ID);
    expect(h.refresh.values.get(`jarvis.m.${NAME_ID}.refresh`)).toBe("NAME-REFRESH");

    // Idempotent: done once, a further open writes nothing.
    h.secure.forgetCalls();
    h.refresh.forgetCalls();
    await opened(h);
    expect(h.secure.sets).toEqual([]);
    expect(h.refresh.deletes).toEqual([]);
  }

  it("both deletes failing: it attempts each, rejects, and the machine stays held", async () => {
    const h = legacyAndAnother();
    const store = await opened(h);
    h.secure.failDelete = (key) => key === "jarvis.token" || key === "jarvis.pairing";
    const attempted: string[] = [];
    const secureDelete = h.secure.delete.bind(h.secure);
    h.secure.delete = (key) => {
      attempted.push(key);
      return secureDelete(key);
    };

    await expect(store.remove(LAN_ID)).rejects.toThrow();
    expect(attempted).toEqual(["jarvis.token", "jarvis.pairing"]);
    expect(store.activeId()).toBe(LAN_ID);
    expect(h.refresh.values.get("jarvis.refresh")).toBe(REFRESH_TOKEN);
    expect(storedIndex(h).legacy).toBe(LAN_ID);
  });

  it.each([
    ["token", "jarvis.token", "jarvis.pairing"],
    ["record", "jarvis.pairing", "jarvis.token"],
  ])(
    "a failed %s delete: the other key still goes, gone at once, the disk entry retries",
    async (_part, failing, other) => {
      const h = legacyAndAnother();
      const first = await opened(h);
      h.secure.failDelete = (key) => key === failing;
      await first.remove(LAN_ID);

      expect(h.secure.values.has(other)).toBe(false);
      expect(h.secure.values.has(failing)).toBe(true);
      expect(h.refresh.values.has("jarvis.refresh")).toBe(false);
      expect(first.activeId()).toBe(NAME_ID);
      expect(storedIndex(h).legacy).toBe(LAN_ID);
      h.secure.failDelete = undefined;

      await expectLegacyCleanedUp(h, await opened(h));
    },
  );

  it("a failed refresh delete on the legacy machine: gone at once, and the next open leaves nothing behind", async () => {
    const h = legacyAndAnother();
    const first = await opened(h);
    h.refresh.failDelete = (key) => key === "jarvis.refresh";
    await first.remove(LAN_ID);
    expect(first.activeId()).toBe(NAME_ID);
    expect(storedIndex(h).legacy).toBe(LAN_ID);
    h.refresh.failDelete = undefined;

    await expectLegacyCleanedUp(h, await opened(h));
  });

  it("an id not held is a no-op", async () => {
    const h = harness();
    seedLegacy(h);
    const store = await opened(h);
    h.secure.forgetCalls();
    await store.remove("nobody_1");

    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
    expect(h.refresh.deletes).toEqual([]);
  });
});

describe("load", () => {
  it("an invalid record for one id removes only that id", async () => {
    const h = harness();
    seedLegacy(h);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "NAME-REFRESH");
    seedMachine(h, OTHER_ID, namedRecord("other.tail.ts.net", DEVICE_C), "OTHER-REFRESH");
    seedIndex(h, { ids: [LAN_ID, NAME_ID, OTHER_ID], active: NAME_ID, legacy: LAN_ID });
    h.secure.values.set(`jarvis.m.${NAME_ID}.pairing`, "{nope");
    const store = await opened(h);

    expect(await store.load(NAME_ID)).toBeUndefined();
    expect(storedIndex(h)).toEqual({ v: 1, ids: [LAN_ID, OTHER_ID], legacy: LAN_ID });
    expect(h.secure.values.has(`jarvis.m.${NAME_ID}.token`)).toBe(false);
    expect(h.refresh.values.has(`jarvis.m.${NAME_ID}.refresh`)).toBe(false);
    expect(await store.load(LAN_ID)).toBeDefined();
    expect(await store.load(OTHER_ID)).toBeDefined();
    expect(h.refresh.values.get("jarvis.refresh")).toBe(REFRESH_TOKEN);
    expect(h.refresh.values.get(`jarvis.m.${OTHER_ID}.refresh`)).toBe("OTHER-REFRESH");
  });

  it("a throwing read removes nothing", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "R");
    seedIndex(h, { ids: [NAME_ID] });
    const store = await opened(h);
    h.secure.failGet = (key) => key === `jarvis.m.${NAME_ID}.token`;

    await expect(store.load(NAME_ID)).rejects.toThrow();
    h.secure.failGet = undefined;
    expect(storedIndex(h).ids).toEqual([NAME_ID]);
    expect(await store.load(NAME_ID)).toBeDefined();
    expect(h.refresh.values.get(`jarvis.m.${NAME_ID}.refresh`)).toBe("R");
  });

  it("an id not held answers undefined and touches nothing", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    const store = await opened(h);
    h.secure.forgetCalls();

    expect(await store.load(NAME_ID)).toBeUndefined();
    expect(h.secure.deletes).toEqual([]);
    expect(h.secure.values.has(`jarvis.m.${NAME_ID}.token`)).toBe(true);
  });
});

describe("list, active and lookups", () => {
  async function twoMachines(): Promise<{ h: Harness; store: MachineStore }> {
    const h = harness();
    seedLegacy(h);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: LAN_ID, legacy: LAN_ID });
    return { h, store: await opened(h) };
  }

  it("list answers each machine with its record", async () => {
    const { store } = await twoMachines();
    expect(await store.list()).toEqual([
      { id: LAN_ID, record: lanRecord() },
      { id: NAME_ID, record: namedRecord("mac.tail.ts.net") },
    ]);
  });

  it("list drops an entry whose record is gone, and keeps the rest", async () => {
    const { h, store } = await twoMachines();
    h.secure.values.delete(`jarvis.m.${NAME_ID}.pairing`);
    expect((await store.list()).map((entry) => entry.id)).toEqual([LAN_ID]);
    expect(storedIndex(h).ids).toEqual([LAN_ID]);
  });

  it("setActive persists, and a new store reads it back", async () => {
    const { h, store } = await twoMachines();
    await store.setActive(NAME_ID);
    expect(store.activeId()).toBe(NAME_ID);
    expect((await opened(h)).activeId()).toBe(NAME_ID);
  });

  it("setActive of an id not held writes nothing", async () => {
    const { h, store } = await twoMachines();
    h.secure.forgetCalls();
    await expect(store.setActive("nobody_1")).rejects.toThrow();
    expect(h.secure.sets).toEqual([]);
    expect(store.activeId()).toBe(LAN_ID);
  });

  it("a failed setActive keeps the old active", async () => {
    const { h, store } = await twoMachines();
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;
    await expect(store.setActive(NAME_ID)).rejects.toThrow();
    expect(store.activeId()).toBe(LAN_ID);
  });

  it("activeId falls back to the first id when active is unset", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedMachine(h, OTHER_ID, namedRecord("other.tail.ts.net", DEVICE_C));
    seedIndex(h, { ids: [OTHER_ID, NAME_ID] });
    expect((await opened(h)).activeId()).toBe(OTHER_ID);
  });

  it("nextAfter is the first other id, or undefined when there is none", async () => {
    const { store } = await twoMachines();
    expect(store.nextAfter(LAN_ID)).toBe(NAME_ID);
    expect(store.nextAfter(NAME_ID)).toBe(LAN_ID);
    await store.remove(NAME_ID);
    expect(store.nextAfter(LAN_ID)).toBeUndefined();
  });

  it("findByDeviceId answers the machine with that record", async () => {
    const { store } = await twoMachines();
    expect(await store.findByDeviceId(DEVICE_B)).toBe(NAME_ID);
    expect(await store.findByDeviceId(DEVICE_A)).toBe(LAN_ID);
    expect(await store.findByDeviceId(DEVICE_C)).toBeUndefined();
  });

  it("the index holds no credential and no label", async () => {
    const { h } = await twoMachines();
    const text = h.secure.values.get(MACHINE_INDEX_KEY) ?? "";
    expect(parseMachineIndex(text)).toBeDefined();
    expect(text).not.toContain(credentialOf(lanRecord()).token);
    expect(text).not.toContain("Aziz");
  });
});

describe("singleSlot (the browser)", () => {
  it("add uses the legacy keys and marks the machine legacy", async () => {
    const h = harness({ singleSlot: true });
    const store = await opened(h);
    const record = namedRecord("mac.tail.ts.net");

    expect(await store.add(record, credentialOf(record))).toBe(NAME_ID);
    expect(h.secure.sets).toEqual(["jarvis.token", "jarvis.pairing", MACHINE_INDEX_KEY]);
    expect(storedIndex(h)).toEqual({ v: 1, ids: [NAME_ID], active: NAME_ID, legacy: NAME_ID });
    expect(store.refreshKey(NAME_ID)).toBe("jarvis.refresh");
    expect((await store.load(NAME_ID))?.record.name).toBe("mac.tail.ts.net");
  });

  it("refuses a second machine, whatever its id", async () => {
    const h = harness({ singleSlot: true });
    const store = await opened(h);
    const first = namedRecord("mac.tail.ts.net");
    await store.add(first, credentialOf(first));
    h.secure.forgetCalls();

    const second = namedRecord("other.tail.ts.net", DEVICE_C);
    await expect(store.add(second, credentialOf(second))).rejects.toBeInstanceOf(
      PairingAlreadyExistsError,
    );
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
  });

  it("refuses over a valid legacy slot the index does not know of yet", async () => {
    const h = harness({ singleSlot: true });
    const store = await opened(h);
    seedLegacy(h);
    const record = namedRecord("mac.tail.ts.net");
    await expect(store.add(record, credentialOf(record))).rejects.toBeInstanceOf(
      PairingAlreadyExistsError,
    );
  });

  it("does not refuse over an unusable record, and replaces it", async () => {
    const h = harness({ singleSlot: true });
    h.secure.values.set("jarvis.pairing", "{nope");
    h.secure.values.set("jarvis.token", "ORPHAN");
    const store = await opened(h);
    const record = namedRecord("mac.tail.ts.net");

    await store.add(record, credentialOf(record));
    expect((await store.load(NAME_ID))?.credential).toEqual(credentialOf(record));
  });

  it("clears a leftover refresh token and top-level flags before saving", async () => {
    const order: string[] = [];
    const h = harness({
      singleSlot: true,
      prefs: JSON.stringify({ refreshTokenStored: true, pushRegistered: true }),
    });
    h.refresh.values.set("jarvis.refresh", "LEFTOVER");
    const store = await opened(h);
    const refreshDelete = h.refresh.delete.bind(h.refresh);
    h.refresh.delete = (key) => {
      order.push(`refresh.delete ${key}`);
      return refreshDelete(key);
    };
    const secureSet = h.secure.set.bind(h.secure);
    h.secure.set = (key, value) => {
      order.push(`secure.set ${key}`);
      return secureSet(key, value);
    };
    const record = namedRecord("mac.tail.ts.net");
    await store.add(record, credentialOf(record));

    expect(order).toEqual([
      "refresh.delete jarvis.refresh",
      "secure.set jarvis.token",
      "secure.set jarvis.pairing",
      `secure.set ${MACHINE_INDEX_KEY}`,
    ]);
    expect(h.refresh.values.has("jarvis.refresh")).toBe(false);
    expect(await store.refreshFlag(NAME_ID).read()).toBe(false);
    expect(await store.pushFlag(NAME_ID).read()).toBe(false);
  });

  it("refused, it leaves the refresh token and flags of the machine it holds", async () => {
    const h = harness({ singleSlot: true, prefs: JSON.stringify({ refreshTokenStored: true }) });
    seedLegacy(h);
    const store = await opened(h);
    const record = namedRecord("mac.tail.ts.net");

    await expect(store.add(record, credentialOf(record))).rejects.toBeInstanceOf(
      PairingAlreadyExistsError,
    );
    expect(h.refresh.values.get("jarvis.refresh")).toBe(REFRESH_TOKEN);
    expect(await store.refreshFlag(LAN_ID).read()).toBe(true);
  });

  it("a crash before the index write is picked up by the next open", async () => {
    const h = harness({ singleSlot: true });
    const first = await opened(h);
    const record = namedRecord("mac.tail.ts.net");
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;
    await expect(first.add(record, credentialOf(record))).rejects.toThrow();
    h.secure.failSet = undefined;

    expect((await opened(h)).activeId()).toBe(NAME_ID);
  });
});

describe("the flags", () => {
  it("refreshFlag of the legacy machine reads top-level refreshTokenStored, so a migrated true still prompts", async () => {
    const h = harness({ prefs: JSON.stringify({ refreshTokenStored: true }) });
    seedLegacy(h);
    const store = await opened(h);

    expect(await store.refreshFlag(LAN_ID).read()).toBe(true);
    await store.refreshFlag(LAN_ID).write(false);
    const prefs = await loadPrefs(h.prefs, "en-US");
    expect(prefs.refreshTokenStored).toBe(false);
    expect(prefs.machineFlags).toEqual({});
  });

  it("pushFlag of the legacy machine reads top-level pushRegistered", async () => {
    const h = harness({ prefs: JSON.stringify({ pushRegistered: true }) });
    seedLegacy(h);
    const store = await opened(h);

    expect(await store.pushFlag(LAN_ID).read()).toBe(true);
    await store.pushFlag(LAN_ID).write(false);
    expect((await loadPrefs(h.prefs, "en-US")).pushRegistered).toBe(false);
  });

  it("another machine's flags live in machineFlags, and leave the top level alone", async () => {
    const h = harness({ prefs: JSON.stringify({ refreshTokenStored: true }) });
    seedLegacy(h);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [LAN_ID, NAME_ID], legacy: LAN_ID });
    const store = await opened(h);

    expect(await store.refreshFlag(NAME_ID).read()).toBe(false);
    await store.refreshFlag(NAME_ID).write(true);
    await store.pushFlag(NAME_ID).write(true);
    const prefs = await loadPrefs(h.prefs, "en-US");
    expect(prefs.machineFlags).toEqual({
      [NAME_ID]: { refreshTokenStored: true, pushRegistered: true },
    });
    expect(prefs.refreshTokenStored).toBe(true);
    expect(prefs.pushRegistered).toBe(false);
  });

  it("flag writes for different machines at once lose nothing", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedMachine(h, OTHER_ID, namedRecord("other.tail.ts.net", DEVICE_C));
    seedIndex(h, { ids: [NAME_ID, OTHER_ID] });
    const store = await opened(h);

    await Promise.all([
      store.refreshFlag(NAME_ID).write(true),
      store.refreshFlag(OTHER_ID).write(true),
    ]);
    expect(await store.refreshFlag(NAME_ID).read()).toBe(true);
    expect(await store.refreshFlag(OTHER_ID).read()).toBe(true);
  });

  it("a flag follows the slot: it reads the top level again once the id becomes legacy", async () => {
    const h = harness({
      prefs: JSON.stringify({
        refreshTokenStored: true,
        machineFlags: { [NAME_ID]: { refreshTokenStored: false, pushRegistered: false } },
      }),
    });
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [NAME_ID] });
    const store = await opened(h);
    const flag = store.refreshFlag(NAME_ID);
    expect(await flag.read()).toBe(false);

    seedLegacy(h, namedRecord("mac.tail.ts.net", DEVICE_C));
    expect(await store.open()).toBe("ok");
    expect(await flag.read()).toBe(true);
  });
});

describe("the queue", () => {
  it("two adds at once both reach the index", async () => {
    const h = harness();
    const store = await opened(h);
    const a = namedRecord("mac.tail.ts.net");
    const b = namedRecord("other.tail.ts.net", DEVICE_C);

    await Promise.all([store.add(a, credentialOf(a)), store.add(b, credentialOf(b))]);
    expect(storedIndex(h).ids).toEqual([NAME_ID, OTHER_ID]);
  });

  it("a failed write does not block the next one", async () => {
    const h = harness();
    const store = await opened(h);
    const a = namedRecord("mac.tail.ts.net");
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;
    await expect(store.add(a, credentialOf(a))).rejects.toThrow();
    h.secure.failSet = undefined;

    expect(await store.add(a, credentialOf(a))).toBe(NAME_ID);
  });
});

describe("a failed clean-up never locks the user out", () => {
  const CLEANUP_LINE = "machines: a clean-up failed, retrying at the next open";
  const INDEX_LINE = "machines: writing the index failed, retrying at the next open";

  /** What /pair's check does with this store, then the pairing it allows. */
  async function reachesScanAndPairs(store: MachineStore): Promise<void> {
    const held = await store.list();
    expect(phaseAfterCheck({ ok: true, paired: held.length > 0 })).toBe("scan");
    const record = namedRecord("mac.tail.ts.net");
    expect(await store.add(record, credentialOf(record, "N"))).toBe(NAME_ID);
    expect(store.activeId()).toBe(NAME_ID);
    expect((await store.loadActive())?.credential.token).toBe("N".repeat(43));
  }

  function migratedLegacy(): Harness {
    const h = harness({
      prefs: JSON.stringify({ refreshTokenStored: true, pushRegistered: true }),
    });
    seedLegacy(h);
    seedIndex(h, { ids: [LAN_ID], active: LAN_ID, legacy: LAN_ID });
    return h;
  }

  it("a persistent refresh delete failure: unpair ends, every later launch opens, and it can pair", async () => {
    const h = migratedLegacy();
    h.refresh.failDelete = (key) => key === "jarvis.refresh";
    const unpairing = await opened(h);

    await unpairing.remove(LAN_ID);
    expect(unpairing.activeId()).toBeUndefined();
    expect(h.logs).toEqual([CLEANUP_LINE]);

    await opened(h);
    await reachesScanAndPairs(await opened(h));
  });

  it("a persistent prefs write failure: unpair ends, every later launch opens, and it can pair", async () => {
    const h = migratedLegacy();
    h.prefs.failWrite = true;
    const unpairing = await opened(h);

    await unpairing.remove(LAN_ID);
    expect(unpairing.activeId()).toBeUndefined();
    expect(h.refresh.values.has("jarvis.refresh")).toBe(false);

    await opened(h);
    await reachesScanAndPairs(await opened(h));
  });

  it("a persistent index write failure: unpair ends, and the entry on disk stays harmless", async () => {
    const h = migratedLegacy();
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;
    const unpairing = await opened(h);

    await unpairing.remove(LAN_ID);
    expect(unpairing.activeId()).toBeUndefined();
    expect(h.logs).toEqual([INDEX_LINE]);

    const later = await opened(h);
    expect(later.activeId()).toBeUndefined();
    expect(await later.list()).toEqual([]);
  });

  it("a persistent prefs failure does not stop the refresh delete, nor the reverse", async () => {
    const h = migratedLegacy();
    h.refresh.failDelete = () => true;
    await (await opened(h)).remove(LAN_ID);
    expect((await loadPrefs(h.prefs, "en-US")).refreshTokenStored).toBe(false);

    const other = migratedLegacy();
    other.prefs.failWrite = true;
    await (await opened(other)).remove(LAN_ID);
    expect(other.refresh.values.has("jarvis.refresh")).toBe(false);
  });

  it("a failed delete inside a read is not a failed read: an empty slot still opens", async () => {
    const h = harness();
    h.secure.failDelete = (key) => key === "jarvis.token";
    const store = await opened(h);
    expect(store.activeId()).toBeUndefined();
    await reachesScanAndPairs(store);
  });

  it("a corrupt index whose rewrite fails opens from the legacy slot, and the next open rebuilds", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.values.set(MACHINE_INDEX_KEY, "{nope");
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;

    const failing = await opened(h);
    expect(failing.activeId()).toBe(LAN_ID);
    expect(h.secure.values.get(MACHINE_INDEX_KEY)).toBe("{nope");
    expect(h.logs).toEqual([INDEX_LINE]);

    h.secure.failSet = undefined;
    await opened(h);
    expect(storedIndex(h)).toEqual({ v: 1, ids: [LAN_ID], active: LAN_ID, legacy: LAN_ID });
    expect(h.logs).toEqual([INDEX_LINE, "machines: index unreadable, rebuilt"]);
  });

  it.each([
    ["token", "secure", `jarvis.m.${NAME_ID}.token`],
    ["record", "secure", `jarvis.m.${NAME_ID}.pairing`],
    ["refresh", "refresh", `jarvis.m.${NAME_ID}.refresh`],
  ] as const)(
    "a legacy slot replaced with the %s delete failing: the other stale keys still go, and it retries",
    async (_part, which, failing) => {
      const h = harness();
      seedLegacy(h, namedRecord("mac.tail.ts.net", DEVICE_C));
      seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "OLD-PER-MACHINE");
      seedIndex(h, { ids: [NAME_ID], active: NAME_ID });
      h[which].failDelete = (key) => key === failing;

      const store = await opened(h);
      expect(store.refreshKey(NAME_ID)).toBe("jarvis.refresh");
      const stale = [
        h.secure.values.has(`jarvis.m.${NAME_ID}.token`),
        h.secure.values.has(`jarvis.m.${NAME_ID}.pairing`),
        h.refresh.values.has(`jarvis.m.${NAME_ID}.refresh`),
      ];
      expect(stale.filter(Boolean)).toHaveLength(1);
      expect(storedIndex(h).legacy).toBeUndefined();

      h[which].failDelete = undefined;
      await opened(h);
      expect(storedIndex(h).legacy).toBe(NAME_ID);
      expect(h.secure.values.has(`jarvis.m.${NAME_ID}.token`)).toBe(false);
      expect(h.secure.values.has(`jarvis.m.${NAME_ID}.pairing`)).toBe(false);
      expect(h.refresh.values.has(`jarvis.m.${NAME_ID}.refresh`)).toBe(false);
    },
  );

  it.each(["jarvis.token", "jarvis.pairing"])(
    "a revoked machine with %s's delete failing for good: cleared, and every launch reaches the scan and pairs",
    async (failing) => {
      const h = migratedLegacy();
      h.secure.failDelete = (key) => key === failing;
      const revoked = await opened(h);
      const routes: string[] = [];
      const onUnpaired = createUnpairedHandler({
        clearPairing: () => removeActiveMachine(revoked),
        navigateToPair: (outcome) => routes.push(outcome),
        log: () => {},
      });

      expect(await onUnpaired()).toBe("cleared");
      expect(routes).toEqual(["cleared"]);
      expect(await revoked.loadActive()).toBeUndefined();

      // Relaunch, more than once: nothing connects with this machine again.
      expect(await (await opened(h)).loadActive()).toBeUndefined();
      const later = await opened(h);
      expect(await later.loadActive()).toBeUndefined();
      await reachesScanAndPairs(later);
    },
  );

  it("a revoked machine with every keychain delete failing still ends in clearFailed", async () => {
    const h = migratedLegacy();
    h.secure.failDelete = () => true;
    const revoked = await opened(h);
    const onUnpaired = createUnpairedHandler({
      clearPairing: () => removeActiveMachine(revoked),
      navigateToPair: () => {},
      log: () => {},
    });

    expect(await onUnpaired()).toBe("clearFailed");
    expect(takeClearFailedSignal()).toBe(true);
    expect(revoked.activeId()).toBe(LAN_ID);
  });

  it("a legacy slot replaced under a failing clean-up: opens with the new machine, disk unchanged until it works", async () => {
    const h = harness();
    seedLegacy(h, namedRecord("mac.tail.ts.net", DEVICE_C));
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "OLD-PER-MACHINE");
    seedIndex(h, { ids: [NAME_ID], active: NAME_ID });
    h.refresh.failDelete = (key) => key === `jarvis.m.${NAME_ID}.refresh`;

    const failing = await opened(h);
    expect(failing.refreshKey(NAME_ID)).toBe("jarvis.refresh");
    expect(storedIndex(h).legacy).toBeUndefined();

    h.refresh.failDelete = undefined;
    await opened(h);
    expect(storedIndex(h).legacy).toBe(NAME_ID);
    expect(h.refresh.values.has(`jarvis.m.${NAME_ID}.refresh`)).toBe(false);
  });

  it("add survives a failed refresh delete and a failed prefs write", async () => {
    const h = harness({
      prefs: JSON.stringify({
        machineFlags: { [NAME_ID]: { refreshTokenStored: true, pushRegistered: true } },
      }),
    });
    const store = await opened(h);
    h.refresh.failDelete = () => true;
    h.prefs.failWrite = true;
    const record = namedRecord("mac.tail.ts.net");

    expect(await store.add(record, credentialOf(record))).toBe(NAME_ID);
    expect(storedIndex(h).ids).toEqual([NAME_ID]);
    expect(await store.load(NAME_ID)).toBeDefined();
  });

  it("the browser's add survives the same two failures", async () => {
    const h = harness({ singleSlot: true, prefs: JSON.stringify({ refreshTokenStored: true }) });
    const store = await opened(h);
    h.refresh.failDelete = () => true;
    h.prefs.failWrite = true;
    const record = namedRecord("mac.tail.ts.net");

    expect(await store.add(record, credentialOf(record))).toBe(NAME_ID);
    expect(storedIndex(h).legacy).toBe(NAME_ID);
  });

  it.each(["token", "pairing"])(
    "add fails when the delete of that id's %s fails, and writes nothing",
    async (part) => {
      const h = harness();
      const store = await opened(h);
      h.secure.failDelete = (key) => key === `jarvis.m.${NAME_ID}.${part}`;
      const record = namedRecord("mac.tail.ts.net");

      await expect(store.add(record, credentialOf(record))).rejects.toThrow();
      expect(h.secure.sets).toEqual([]);
      expect(await store.list()).toEqual([]);
    },
  );

  it("add fails when a new key or the index cannot be written", async () => {
    const h = harness();
    const store = await opened(h);
    const record = namedRecord("mac.tail.ts.net");

    h.secure.failSet = (key) => key === `jarvis.m.${NAME_ID}.pairing`;
    await expect(store.add(record, credentialOf(record))).rejects.toThrow();
    h.secure.failSet = (key) => key === MACHINE_INDEX_KEY;
    await expect(store.add(record, credentialOf(record))).rejects.toThrow();
    expect(await store.list()).toEqual([]);
  });

  it("load's self-heal survives a failed delete, and lets go of the id", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"), "R");
    seedIndex(h, { ids: [NAME_ID] });
    const store = await opened(h);
    h.secure.values.set(`jarvis.m.${NAME_ID}.pairing`, "{nope");
    h.secure.failDelete = () => true;

    expect(await store.load(NAME_ID)).toBeUndefined();
    expect(store.activeId()).toBeUndefined();
  });

  it("a read that throws still answers failed", async () => {
    const h = migratedLegacy();
    h.secure.failGet = (key) => key === "jarvis.pairing";
    expect(await h.build().open()).toBe("failed");
  });
});

describe("browser tabs, re-reading on each opener call", () => {
  function tabs() {
    const h = harness({ singleSlot: true });
    const tab = () => {
      const store = h.build();
      return { store, open: createMachineStoreOpener(store, () => {}, { rereadEachTime: true }) };
    };
    return { h, a: tab(), b: tab() };
  }

  it("a tab that opened empty sees the other tab's pairing after reopening", async () => {
    const { a, b } = tabs();
    await a.open();
    await b.open();
    expect(b.store.activeId()).toBeUndefined();
    const record = namedRecord("mac.tail.ts.net");
    await a.store.add(record, credentialOf(record));

    expect(await b.open()).toBe("ok");
    expect(b.store.activeId()).toBe(NAME_ID);
    expect((await b.store.list()).map((entry) => entry.id)).toEqual([NAME_ID]);
    expect((await b.store.loadActive())?.credential).toEqual(credentialOf(record));
  });

  it("a tab holding a machine sees the other tab's unpair after reopening", async () => {
    const { a, b } = tabs();
    await a.open();
    const record = namedRecord("mac.tail.ts.net");
    await a.store.add(record, credentialOf(record));
    await b.open();
    expect(b.store.activeId()).toBe(NAME_ID);
    await a.store.remove(NAME_ID);

    expect(await b.open()).toBe("ok");
    expect(b.store.activeId()).toBeUndefined();
    expect(await b.store.list()).toEqual([]);
  });

  it("callers during one reopen still share it", async () => {
    let opens = 0;
    const open = createMachineStoreOpener(
      {
        open: async () => {
          opens += 1;
          return "ok" as const;
        },
      },
      () => {},
      { rereadEachTime: true },
    );
    await Promise.all([open(), open()]);
    expect(opens).toBe(1);
    await open();
    expect(opens).toBe(2);
  });

  it("a reopen whose read throws refuses again, rather than answer from the old index", async () => {
    const { h, a } = tabs();
    await a.open();
    h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;

    expect(await a.open()).toBe("failed");
    expect(() => a.store.activeId()).toThrow("not open");
  });
});

describe("until an open succeeds", () => {
  /** Holds two machines, one legacy, and could not read them. */
  async function failedOpen(): Promise<{ h: Harness; store: MachineStore }> {
    const h = harness({ prefs: JSON.stringify({ refreshTokenStored: true }) });
    seedLegacy(h);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: LAN_ID, legacy: LAN_ID });
    h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;
    const store = h.build();
    expect(await store.open()).toBe("failed");
    h.secure.failGet = undefined;
    return { h, store };
  }

  it("load, loadActive, list and findByDeviceId reject", async () => {
    const { store } = await failedOpen();
    await expect(store.load(LAN_ID)).rejects.toThrow("not open");
    await expect(store.load("nobody_1")).rejects.toThrow("not open");
    await expect(store.loadActive()).rejects.toThrow("not open");
    await expect(store.list()).rejects.toThrow("not open");
    await expect(store.findByDeviceId(DEVICE_A)).rejects.toThrow("not open");
  });

  it("activeId, nextAfter and refreshKey throw, with or without an id", async () => {
    const { store } = await failedOpen();
    expect(() => store.activeId()).toThrow("not open");
    expect(() => store.nextAfter(LAN_ID)).toThrow("not open");
    expect(() => store.refreshKey(LAN_ID)).toThrow("not open");
    expect(() => store.refreshKey(undefined)).toThrow("not open");
  });

  it("flag reads and writes reject, and no write lands in machineFlags", async () => {
    const { h, store } = await failedOpen();
    await expect(store.refreshFlag(LAN_ID).read()).rejects.toThrow("not open");
    await expect(store.refreshFlag(LAN_ID).write(false)).rejects.toThrow("not open");
    await expect(store.pushFlag(LAN_ID).read()).rejects.toThrow("not open");
    await expect(store.pushFlag(LAN_ID).write(true)).rejects.toThrow("not open");
    expect(h.prefs.writes).toBe(0);
    expect((await loadPrefs(h.prefs, "en-US")).machineFlags).toEqual({});
  });

  it("a store never opened answers the same way", async () => {
    const store = harness().build();
    expect(() => store.activeId()).toThrow("not open");
    await expect(store.list()).rejects.toThrow("not open");
  });

  it("a later open recovers everything", async () => {
    const { store } = await failedOpen();
    expect(await store.open()).toBe("ok");
    expect(store.activeId()).toBe(LAN_ID);
    expect(store.refreshKey(LAN_ID)).toBe("jarvis.refresh");
    expect(await store.refreshFlag(LAN_ID).read()).toBe(true);
    expect((await store.list()).map((entry) => entry.id)).toEqual([LAN_ID, NAME_ID]);
  });
});

describe("loadActive", () => {
  it("answers the active machine with its id, record and credential", async () => {
    const h = harness();
    seedLegacy(h);
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [LAN_ID, NAME_ID], active: NAME_ID, legacy: LAN_ID });
    const store = await opened(h);

    expect(await store.loadActive()).toEqual({
      id: NAME_ID,
      record: namedRecord("mac.tail.ts.net"),
      credential: credentialOf(namedRecord("mac.tail.ts.net")),
    });
  });

  it("falls back to the first id when active is unset", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [NAME_ID] });
    expect((await (await opened(h)).loadActive())?.id).toBe(NAME_ID);
  });

  it("answers undefined on an empty phone", async () => {
    expect(await (await opened(harness())).loadActive()).toBeUndefined();
  });

  it("answers undefined when the active record is gone, and self-heals", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [NAME_ID], active: NAME_ID });
    const store = await opened(h);
    h.secure.values.delete(`jarvis.m.${NAME_ID}.pairing`);

    expect(await store.loadActive()).toBeUndefined();
    expect(storedIndex(h)).toEqual({ v: 1, ids: [] });
  });

  it("a throwing read rejects and removes nothing", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedIndex(h, { ids: [NAME_ID], active: NAME_ID });
    const store = await opened(h);
    h.secure.failGet = (key) => key === `jarvis.m.${NAME_ID}.pairing`;

    await expect(store.loadActive()).rejects.toThrow();
    expect(storedIndex(h).ids).toEqual([NAME_ID]);
  });
});

describe("no active id", () => {
  it("refreshKey reads the legacy key, harmlessly, since nothing connects", async () => {
    const store = await opened(harness());
    expect(store.refreshKey(store.activeId())).toBe("jarvis.refresh");
  });

  it("the flags read and write the top level", async () => {
    const h = harness({ prefs: JSON.stringify({ refreshTokenStored: true }) });
    const store = await opened(h);
    const flag = store.refreshFlag(store.activeId());

    expect(await flag.read()).toBe(true);
    await flag.write(false);
    const prefs = await loadPrefs(h.prefs, "en-US");
    expect(prefs.refreshTokenStored).toBe(false);
    expect(prefs.machineFlags).toEqual({});
  });
});

describe("removeActiveMachine", () => {
  it("removes the active machine and leaves the other", async () => {
    const h = harness();
    seedMachine(h, NAME_ID, namedRecord("mac.tail.ts.net"));
    seedMachine(h, OTHER_ID, namedRecord("other.tail.ts.net", DEVICE_C));
    seedIndex(h, { ids: [NAME_ID, OTHER_ID], active: OTHER_ID });
    await removeActiveMachine(await opened(h));

    expect(storedIndex(h).ids).toEqual([NAME_ID]);
    expect(h.secure.values.has(`jarvis.m.${NAME_ID}.token`)).toBe(true);
  });

  it("does nothing with no machine", async () => {
    const h = harness();
    const store = await opened(h);
    h.secure.forgetCalls();
    await removeActiveMachine(store);
    expect(h.secure.sets).toEqual([]);
    expect(h.secure.deletes).toEqual([]);
  });

  it("rejects on a store that could not open, and deletes nothing", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.failGet = (key) => key === MACHINE_INDEX_KEY;
    const store = h.build();
    expect(await store.open()).toBe("failed");

    await expect(removeActiveMachine(store)).rejects.toThrow("not open");
    expect(h.secure.deletes).toEqual([]);
    expect(h.secure.values.has("jarvis.token")).toBe(true);
  });
});

describe("createMachineStoreOpener", () => {
  function fakeStore(outcomes: Array<"ok" | "failed">) {
    let opens = 0;
    return {
      opens: () => opens,
      store: {
        open: async (): Promise<"ok" | "failed"> => {
          opens += 1;
          return outcomes.shift() ?? "ok";
        },
      },
    };
  }

  it("an open that worked is not repeated", async () => {
    const fake = fakeStore(["ok"]);
    const open = createMachineStoreOpener(fake.store, () => {});
    expect(await open()).toBe("ok");
    expect(await open()).toBe("ok");
    expect(fake.opens()).toBe(1);
  });

  it("callers during one open share it", async () => {
    const fake = fakeStore(["ok"]);
    const open = createMachineStoreOpener(fake.store, () => {});
    expect(await Promise.all([open(), open(), open()])).toEqual(["ok", "ok", "ok"]);
    expect(fake.opens()).toBe(1);
  });

  it("a failed open is forgotten, so a later attempt can open, as after first unlock", async () => {
    const fake = fakeStore(["failed", "ok"]);
    const logs: string[] = [];
    const open = createMachineStoreOpener(fake.store, (line) => logs.push(line));

    expect(await open()).toBe("failed");
    expect(logs).toEqual(["machines: open failed"]);
    expect(await open()).toBe("ok");
    expect(await open()).toBe("ok");
    expect(fake.opens()).toBe(2);
  });

  it("recovers a real store whose keychain comes back", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.failGet = () => true;
    const store = h.build();
    const open = createMachineStoreOpener(store, () => {});
    expect(await open()).toBe("failed");
    expect(() => store.activeId()).toThrow("not open");

    h.secure.failGet = undefined;
    expect(await open()).toBe("ok");
    expect(store.activeId()).toBe(LAN_ID);
  });
});

describe("what it logs", () => {
  it("never a token, an id or a record", async () => {
    const h = harness();
    seedLegacy(h);
    h.secure.values.set(MACHINE_INDEX_KEY, "{nope");
    await opened(h);
    expect(h.logs).toEqual(["machines: index unreadable, rebuilt"]);
  });
});
