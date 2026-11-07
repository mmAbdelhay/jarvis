// The machines this phone holds, over the index in machine-index.ts. Every
// operation is ordered for a crash at any line:
//
// - Migration is the one write of the index. Before it nothing has changed
//   and the next open repeats it; after it, it is done. Nothing is copied
//   or deleted, so `jarvis.refresh` keeps working under the same key.
// - add: token, record, then index. A crash before the index leaves orphan
//   keys that the next add of that id overwrites.
// - remove: token, record, refresh, flags, then index. A crash leaves an
//   entry whose record is gone, which `load` self-heals by removing it. For
//   the legacy machine `open` finishes the job too: nothing else can address
//   `jarvis.refresh` and the top-level flags once the slot is empty.
//
// Only a read that throws fails an operation that reads. A clean-up or index
// write that fails after good reads never locks the user out: the store takes
// the new index in memory, logs a fixed line, and leaves the old index on disk
// for the next open to finish, in the same order. The exceptions are the keys
// a pairing lives by: `remove` and `add` fail if a token or record delete of
// that id fails, and `add` fails if it cannot write the new keys and index.
//
// A read that throws is never taken for a missing machine: it rejects, or
// answers "failed" from `open`, and changes nothing. Until an open succeeds
// everything but `open` rejects or throws, because the index says nothing
// about the disk yet: a failed store must not look like an empty one, and
// `refreshKey` must not answer a per-machine key for the legacy machine.

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
  LEGACY_REFRESH_KEY,
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
  loadActive(): Promise<
    { id: MachineId; record: PairingRecord; credential: Credential } | undefined
  >;
  add(record: PairingRecord, credential: Credential): Promise<MachineId>;
  setActive(id: MachineId): Promise<void>;
  remove(id: MachineId): Promise<void>;
  nextAfter(id: MachineId): MachineId | undefined;
  findByDeviceId(deviceId: string): Promise<MachineId | undefined>;
  /** With no id (no active machine), the legacy key and flag. */
  refreshKey(id: MachineId | undefined): string;
  refreshFlag(id: MachineId | undefined): RefreshStoredFlag;
  pushFlag(id: MachineId): { read(): Promise<boolean>; write(v: boolean): Promise<void> };
};

const EMPTY_INDEX: MachineIndex = { v: 1, ids: [] };
const NO_FLAGS: MachineFlags = { refreshTokenStored: false, pushRegistered: false };
const CLEANUP_FAILED_LINE = "machines: a clean-up failed, retrying at the next open";
const INDEX_WRITE_FAILED_LINE = "machines: writing the index failed, retrying at the next open";

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

  function activeIdNow(): MachineId | undefined {
    return index.active ?? index.ids[0];
  }

  async function writeIndex(next: MachineIndex): Promise<void> {
    await secure.set(MACHINE_INDEX_KEY, JSON.stringify(next));
    index = next;
  }

  /** Answers whether it worked. Each clean-up runs on its own, so one that
   *  fails does not stop the next. */
  async function tryCleanUp(task: () => Promise<void>): Promise<boolean> {
    try {
      await task();
      return true;
    } catch {
      deps.log(CLEANUP_FAILED_LINE);
      return false;
    }
  }

  /** Takes `next` as the index either way. Answers whether it reached the
   *  disk: after a failed clean-up it stays off, so the old index still says
   *  there is something for the next open to finish. */
  async function adoptIndex(next: MachineIndex, cleaned = true): Promise<boolean> {
    if (cleaned) {
      try {
        await writeIndex(next);
        return true;
      } catch {
        deps.log(INDEX_WRITE_FAILED_LINE);
      }
    }
    index = next;
    return false;
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

  function clearFlagsOf(id: MachineId): Promise<void> {
    return id === index.legacy ? clearLegacyFlags() : clearMachineFlags(id);
  }

  /** Token and record are gone, or `cleaned` says they are not: the rest of
   *  one machine, then lets go of it. */
  async function letGo(id: MachineId, cleaned: boolean): Promise<void> {
    const keys = machineKeys(id, index);
    const refreshGone = await tryCleanUp(() => refresh.delete(keys.refresh));
    const flagsGone = await tryCleanUp(() => clearFlagsOf(id));
    await adoptIndex(indexWithout(index, id), cleaned && refreshGone && flagsGone);
  }

  /** The user's Unpair: a token or record that stays is a failure to show,
   *  since the machine would come back at the next launch. */
  async function removeHeld(id: MachineId): Promise<void> {
    const keys = machineKeys(id, index);
    await secure.delete(keys.token);
    await secure.delete(keys.record);
    await letGo(id, true);
  }

  /** A record found unusable: nothing connects with it either way. */
  async function healHeld(id: MachineId): Promise<void> {
    const keys = machineKeys(id, index);
    const pairingGone = await tryCleanUp(async () => {
      await secure.delete(keys.token);
      await secure.delete(keys.record);
    });
    await letGo(id, pairingGone);
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
      // A crash during `remove`, or the old app's unpair. Once the id goes,
      // nothing can address these: safe to repeat, and before the index.
      // Nothing connects to this machine, so a token left behind by a failed
      // delete cannot be replayed, and it must not stop the user pairing.
      const refreshGone = await tryCleanUp(() => refresh.delete(LEGACY_REFRESH_KEY));
      const flagsGone = await tryCleanUp(clearLegacyFlags);
      await adoptIndex(indexWithout(stored, stored.legacy as MachineId), refreshGone && flagsGone);
      return;
    }

    // The slot now holds this machine, so keys of its own are stale. Deleting
    // is safe to repeat: the delete comes first and the index write decides.
    const keysGone = await tryCleanUp(() => clearKeys(machineKeys(legacyId, EMPTY_INDEX)));
    const flagsGone = await tryCleanUp(() => clearMachineFlags(legacyId));

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
    await adoptIndex(next, keysGone && flagsGone);
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
      else await adoptIndex(rebuilt);
      return;
    }
    if (await adoptIndex(rebuilt ?? EMPTY_INDEX)) deps.log("machines: index unreadable, rebuilt");
  }

  async function loadQueued(
    id: MachineId,
  ): Promise<{ record: PairingRecord; credential: Credential } | undefined> {
    assertOpen();
    if (!index.ids.includes(id)) return undefined;
    const loaded = await loadPairingAt(secure, machineKeys(id, index));
    if (loaded === undefined) await healHeld(id);
    return loaded;
  }

  async function addSingleSlot(record: PairingRecord, credential: Credential): Promise<MachineId> {
    if (index.ids.length > 0 || (await loadPairing(secure)) !== undefined) {
      throw new PairingAlreadyExistsError();
    }
    const id = machineIdOf(record);
    // Whatever is here belongs to an earlier pairing of the slot. The laptop
    // has already approved this one: a failure here must not lose it.
    await tryCleanUp(() => refresh.delete(LEGACY_REFRESH_KEY));
    await tryCleanUp(clearLegacyFlags);
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
    // token must not outlive it, though the laptop has already approved this
    // pairing: only a token or record that stays can fail it.
    await secure.delete(keys.token);
    await secure.delete(keys.record);
    await tryCleanUp(() => refresh.delete(keys.refresh));
    await tryCleanUp(() => clearFlagsOf(id));
    await savePairingAt(secure, keys, record, credential);
    if (!held) await writeIndex({ ...index, ids: [...index.ids, id] });
    return id;
  }

  /** The flag is resolved on each call, because an id's slot can change. */
  function flagOf(id: MachineId | undefined, field: keyof MachineFlags) {
    return {
      async read(): Promise<boolean> {
        assertOpen();
        const current = await loadPrefs(prefs, localeTag);
        if (id === undefined || id === index.legacy) return current[field];
        return current.machineFlags[id]?.[field] ?? false;
      },
      // Queued: load-change-save from two machines at once would lose one.
      write(value: boolean): Promise<void> {
        return enqueue(async () => {
          assertOpen();
          const current = await loadPrefs(prefs, localeTag);
          if (id === undefined || id === index.legacy) {
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
    // Queued: an open in flight answers first.
    await enqueue(async () => assertOpen());
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
          // A reopen too: the index in memory may no longer be what is stored.
          isOpen = false;
          return "failed" as const;
        }
      });
    },
    list,
    activeId() {
      assertOpen();
      return activeIdNow();
    },
    load,
    loadActive() {
      return enqueue(async () => {
        assertOpen();
        const id = activeIdNow();
        if (id === undefined) return undefined;
        const loaded = await loadQueued(id);
        return loaded === undefined ? undefined : { id, ...loaded };
      });
    },
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
      assertOpen();
      return index.ids.find((other) => other !== id);
    },
    async findByDeviceId(deviceId) {
      const entries = await list();
      return entries.find((entry) => entry.record.deviceId === deviceId)?.id;
    },
    refreshKey(id) {
      assertOpen();
      return id === undefined ? LEGACY_REFRESH_KEY : machineKeys(id, index).refresh;
    },
    refreshFlag(id) {
      return flagOf(id, "refreshTokenStored");
    },
    pushFlag(id) {
      return flagOf(id, "pushRegistered");
    },
  };
}

/** One `open` at a time, shared by every caller. One that worked is not
 *  repeated. One that failed is forgotten, so a later attempt can open, for
 *  instance after first unlock. Callers may ignore the outcome: until an open
 *  succeeds the store itself refuses everything, and fails them closed.
 *
 *  `rereadEachTime` is the browser's: tabs share one keychain, each with its
 *  own index in memory, so every call reads the disk again. */
export function createMachineStoreOpener(
  store: Pick<MachineStore, "open">,
  log: (line: string) => void,
  options: { rereadEachTime?: boolean } = {},
): () => Promise<"ok" | "failed"> {
  let opened: Promise<"ok" | "failed"> | undefined;
  return () => {
    opened ??= store.open().then((outcome) => {
      if (outcome === "failed") log("machines: open failed");
      if (outcome === "failed" || options.rereadEachTime === true) opened = undefined;
      return outcome;
    });
    return opened;
  };
}

/** Settings' Unpair, the unpaired handler and /pair's retry. Rejects when the
 *  store could not open, so that is never taken for nothing to remove. */
export async function removeActiveMachine(
  machines: Pick<MachineStore, "activeId" | "remove">,
): Promise<void> {
  const id = machines.activeId();
  if (id !== undefined) await machines.remove(id);
}
