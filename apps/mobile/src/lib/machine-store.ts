// The machines this phone holds, over the index in machine-index.ts. Every
// operation is ordered for a crash at any line:
//
// - Migration is the one write of the index. Before it nothing has changed
//   and the next launch repeats it; after it, it is done. Nothing is copied
//   or deleted, so `jarvis.refresh` keeps working under the same key.
// - add: token, record, then index. A crash before the index leaves orphan
//   keys that the next add of that id overwrites.
// - remove: token, record, refresh, flags, then index. A crash leaves an
//   entry whose record is gone, which `load` self-heals by removing it.
//
// A read that throws is never taken for a missing machine: it rejects, or
// answers "failed" from `open`, and changes nothing.

import type { RefreshStoredFlag } from "./auth-session";
import {
  MACHINE_INDEX_KEY,
  MAX_INDEX_BYTES,
  MAX_MACHINES,
  type MachineId,
  type MachineIndex,
  machineIdOf,
  machineKeys,
  parseMachineIndex,
} from "./machine-index";
import {
  LEGACY_PAIRING_KEYS,
  PairingAlreadyExistsError,
  type PairingRecord,
  loadPairing,
  loadPairingAt,
  savePairingAt,
} from "./pairing-record";
import { type MachineFlags, type PrefsStore, loadPrefs, savePrefs } from "./prefs";
import type { Credential } from "./rpc-client";
import type { SecureStore } from "./secure-store";

export type MachineEntry = { id: MachineId; record: PairingRecord };

/** Thrown by `add` at 16 machines, or when the index would pass 2000 bytes. */
export class MachineLimitError extends Error {
  constructor() {
    super("the machine limit is reached");
    this.name = "MachineLimitError";
  }
}

export type MachineStore = {
  open(): Promise<"ok" | "failed">;
  list(): Promise<MachineEntry[]>;
  activeId(): MachineId | undefined;
  load(id: MachineId): Promise<{ record: PairingRecord; credential: Credential } | undefined>;
  add(record: PairingRecord, credential: Credential): Promise<MachineId>;
  setActive(id: MachineId): Promise<void>;
  remove(id: MachineId): Promise<void>;
  nextAfter(id: MachineId): MachineId | undefined;
  findByDeviceId(deviceId: string): Promise<MachineId | undefined>;
  refreshKey(id: MachineId): string;
  refreshFlag(id: MachineId): RefreshStoredFlag;
  pushFlag(id: MachineId): { read(): Promise<boolean>; write(v: boolean): Promise<void> };
};

const EMPTY_INDEX: MachineIndex = { v: 1, ids: [] };
const NO_FLAGS: MachineFlags = { refreshTokenStored: false, pushRegistered: false };

function soleMachineIndex(id: MachineId): MachineIndex {
  return { v: 1, ids: [id], active: id, legacy: id };
}

function indexWithout(index: MachineIndex, id: MachineId): MachineIndex {
  const next: MachineIndex = { v: 1, ids: index.ids.filter((other) => other !== id) };
  if (index.active !== undefined && index.active !== id) next.active = index.active;
  if (index.legacy !== undefined && index.legacy !== id) next.legacy = index.legacy;
  return next;
}

export function createMachineStore(deps: {
  secure: SecureStore;
  refresh: SecureStore;
  prefs: PrefsStore;
  localeTag: string;
  singleSlot: boolean;
  log(line: string): void;
}): MachineStore {
  const { secure, refresh, prefs, localeTag } = deps;

  // Only ever what the secure store holds: replaced after a write succeeds.
  let index: MachineIndex = EMPTY_INDEX;
  // Until an open succeeds `index` says nothing about the disk, and writing
  // it would lose every machine it does not name.
  let isOpen = false;

  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = tail.then(task);
    tail = run.catch(() => undefined);
    return run;
  }

  function assertOpen(): void {
    if (!isOpen) throw new Error("machines: store is not open");
  }

  async function writeIndex(next: MachineIndex): Promise<void> {
    await secure.set(MACHINE_INDEX_KEY, JSON.stringify(next));
    index = next;
  }

  async function clearKeys(keys: ReturnType<typeof machineKeys>): Promise<void> {
    await secure.delete(keys.token);
    await secure.delete(keys.record);
    await refresh.delete(keys.refresh);
  }

  async function clearMachineFlags(id: MachineId): Promise<void> {
    const current = await loadPrefs(prefs, localeTag);
    if (current.machineFlags[id] === undefined) return;
    const { [id]: _dropped, ...machineFlags } = current.machineFlags;
    await savePrefs(prefs, { ...current, machineFlags });
  }

  async function clearLegacyFlags(): Promise<void> {
    const current = await loadPrefs(prefs, localeTag);
    if (!current.refreshTokenStored && !current.pushRegistered) return;
    await savePrefs(prefs, { ...current, refreshTokenStored: false, pushRegistered: false });
  }

  /** Clears one machine's keys and flags, then lets go of it. */
  async function removeHeld(id: MachineId): Promise<void> {
    await clearKeys(machineKeys(id, index));
    if (id === index.legacy) await clearLegacyFlags();
    else await clearMachineFlags(id);
    await writeIndex(indexWithout(index, id));
  }

  /** Puts the index right when an older build changed the legacy slot. The
   *  old app knows nothing of the index, so the slot is the truth. */
  async function reconcile(stored: MachineIndex): Promise<void> {
    const legacy = await loadPairing(secure);
    const legacyId = legacy === undefined ? undefined : machineIdOf(legacy.record);
    if (legacyId === stored.legacy) {
      index = stored;
      return;
    }
    if (legacyId === undefined) {
      await writeIndex(indexWithout(stored, stored.legacy as MachineId));
      return;
    }

    // The slot now holds this machine, so keys of its own are stale. Deleting
    // is safe to repeat: the delete comes first and the index write decides.
    await clearKeys(machineKeys(legacyId, EMPTY_INDEX));
    await clearMachineFlags(legacyId);

    const replaced = stored.legacy;
    const ids: MachineId[] = [];
    for (const id of stored.ids) {
      const kept = id === replaced ? legacyId : id;
      if (!ids.includes(kept)) ids.push(kept);
    }
    if (!ids.includes(legacyId)) ids.push(legacyId);
    const next: MachineIndex = { v: 1, ids };
    const active = replaced !== undefined && stored.active === replaced ? legacyId : stored.active;
    if (active !== undefined) next.active = active;
    next.legacy = legacyId;
    await writeIndex(next);
  }

  async function openQueued(): Promise<void> {
    const text = await secure.get(MACHINE_INDEX_KEY);
    const stored = text === undefined ? undefined : parseMachineIndex(text);
    if (stored !== undefined) {
      await reconcile(stored);
      return;
    }

    const legacy = await loadPairing(secure);
    const rebuilt = legacy === undefined ? undefined : soleMachineIndex(machineIdOf(legacy.record));
    if (text === undefined) {
      // An empty phone writes nothing; the first add does.
      if (rebuilt === undefined) index = EMPTY_INDEX;
      else await writeIndex(rebuilt);
      return;
    }
    await writeIndex(rebuilt ?? EMPTY_INDEX);
    deps.log("machines: index unreadable, rebuilt");
  }

  async function loadQueued(
    id: MachineId,
  ): Promise<{ record: PairingRecord; credential: Credential } | undefined> {
    if (!index.ids.includes(id)) return undefined;
    const loaded = await loadPairingAt(secure, machineKeys(id, index));
    if (loaded === undefined) await removeHeld(id);
    return loaded;
  }

  async function addSingleSlot(record: PairingRecord, credential: Credential): Promise<MachineId> {
    if (index.ids.length > 0 || (await loadPairing(secure)) !== undefined) {
      throw new PairingAlreadyExistsError();
    }
    const id = machineIdOf(record);
    await savePairingAt(secure, LEGACY_PAIRING_KEYS, record, credential);
    await writeIndex(soleMachineIndex(id));
    return id;
  }

  function assertRoomFor(id: MachineId): void {
    if (index.ids.length >= MAX_MACHINES) throw new MachineLimitError();
    const ids = [...index.ids, id];
    // Sized with the longest id active, so that no later `setActive` can
    // take the value past the limit. All ids are ASCII: length is bytes.
    const longest = ids.reduce((a, b) => (b.length > a.length ? b : a));
    if (JSON.stringify({ ...index, ids, active: longest }).length > MAX_INDEX_BYTES) {
      throw new MachineLimitError();
    }
  }

  async function addQueued(record: PairingRecord, credential: Credential): Promise<MachineId> {
    assertOpen();
    if (deps.singleSlot) return addSingleSlot(record, credential);

    const id = machineIdOf(record);
    const held = index.ids.includes(id);
    const keys = machineKeys(id, index);
    if (held) {
      if ((await loadPairingAt(secure, keys)) !== undefined) {
        throw new PairingAlreadyExistsError();
      }
    } else {
      assertRoomFor(id);
    }

    // Whatever is here belongs to an earlier pairing of this id: a crashed
    // add, a lost index, or a record that no longer loads. A leftover refresh
    // token must not outlive it.
    await clearKeys(keys);
    if (id === index.legacy) await clearLegacyFlags();
    else await clearMachineFlags(id);
    await savePairingAt(secure, keys, record, credential);
    if (!held) await writeIndex({ ...index, ids: [...index.ids, id] });
    return id;
  }

  /** The flag is resolved on each call, because an id's slot can change. */
  function flagOf(id: MachineId, field: keyof MachineFlags) {
    return {
      async read(): Promise<boolean> {
        const current = await loadPrefs(prefs, localeTag);
        if (id === index.legacy) return current[field];
        return current.machineFlags[id]?.[field] ?? false;
      },
      // Queued: load-change-save from two machines at once would lose one.
      write(value: boolean): Promise<void> {
        return enqueue(async () => {
          const current = await loadPrefs(prefs, localeTag);
          if (id === index.legacy) {
            await savePrefs(prefs, { ...current, [field]: value });
            return;
          }
          const flags = current.machineFlags[id] ?? NO_FLAGS;
          await savePrefs(prefs, {
            ...current,
            machineFlags: { ...current.machineFlags, [id]: { ...flags, [field]: value } },
          });
        });
      },
    };
  }

  function load(
    id: MachineId,
  ): Promise<{ record: PairingRecord; credential: Credential } | undefined> {
    return enqueue(() => loadQueued(id));
  }

  async function list(): Promise<MachineEntry[]> {
    const entries: MachineEntry[] = [];
    for (const id of index.ids) {
      const loaded = await load(id);
      if (loaded !== undefined) entries.push({ id, record: loaded.record });
    }
    return entries;
  }

  return {
    open() {
      return enqueue(async () => {
        try {
          await openQueued();
          isOpen = true;
          return "ok" as const;
        } catch {
          return "failed" as const;
        }
      });
    },
    list,
    activeId() {
      return index.active ?? index.ids[0];
    },
    load,
    add(record, credential) {
      return enqueue(() => addQueued(record, credential));
    },
    setActive(id) {
      return enqueue(async () => {
        assertOpen();
        if (!index.ids.includes(id)) throw new Error("machines: no such machine");
        if (index.active !== id) await writeIndex({ ...index, active: id });
      });
    },
    remove(id) {
      return enqueue(async () => {
        assertOpen();
        if (index.ids.includes(id)) await removeHeld(id);
      });
    },
    nextAfter(id) {
      return index.ids.find((other) => other !== id);
    },
    async findByDeviceId(deviceId) {
      const entries = await list();
      return entries.find((entry) => entry.record.deviceId === deviceId)?.id;
    },
    refreshKey(id) {
      return machineKeys(id, index).refresh;
    },
    refreshFlag(id) {
      return flagOf(id, "refreshTokenStored");
    },
    pushFlag(id) {
      return flagOf(id, "pushRegistered");
    },
  };
}
