// The index of the machines this phone holds: one short JSON value in the
// secure store, beside the pairing keys. The first pairing is never copied:
// it stays in the original keys as the "legacy slot" and the index records
// which machine owns it, so the rotating refresh token never has two copies.
// This file is the only place the two key layouts meet.

import { REFRESH_TOKEN_KEY } from "./auth-session";
import { LEGACY_PAIRING_KEYS } from "./pairing-record";

export type MachineId = string;

export const MACHINE_INDEX_KEY = "jarvis.machines";
export const MAX_MACHINES = 16;
/** SecureStore warns above 2048. */
export const MAX_INDEX_BYTES = 2000;
export const MACHINE_ID_PATTERN = /^[a-z0-9._-]{1,260}$/;

export type MachineIndex = {
  v: 1;
  ids: MachineId[];
  active?: MachineId;
  legacy?: MachineId;
};

/**
 * `lowercase(name ?? host)` with each `:` replaced by `_`, then `_`, then the
 * port. Deterministic, so a crash during an add leaves keys the next add of
 * the same machine overwrites. `%` goes the same way as `:`: a canonical
 * link-local host can carry a zone (`fe80::1%en0`), and a machine id has to
 * stay a legal SecureStore key.
 */
export function machineIdOf(endpoint: { name?: string; host: string; port: number }): MachineId {
  const address = (endpoint.name ?? endpoint.host).toLowerCase().replace(/[:%]/g, "_");
  return `${address}_${endpoint.port}`;
}

export function machineKeys(
  id: MachineId,
  index: MachineIndex,
): { record: string; token: string; refresh: string } {
  if (id === index.legacy) {
    return { ...LEGACY_PAIRING_KEYS, refresh: REFRESH_TOKEN_KEY };
  }
  return {
    record: `jarvis.m.${id}.pairing`,
    token: `jarvis.m.${id}.token`,
    refresh: `jarvis.m.${id}.refresh`,
  };
}

/** Field by field: a bad id, or an `active` or `legacy` that names no held
 *  machine, is dropped alone. Only a value that cannot be an index at all
 *  answers undefined. */
export function parseMachineIndex(text: string): MachineIndex | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = parsed as Record<string, unknown>;
  if (raw.v !== 1) return undefined;

  const ids: MachineId[] = [];
  if (Array.isArray(raw.ids)) {
    for (const id of raw.ids as unknown[]) {
      if (typeof id === "string" && MACHINE_ID_PATTERN.test(id) && !ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  const index: MachineIndex = { v: 1, ids };
  if (typeof raw.active === "string" && ids.includes(raw.active)) index.active = raw.active;
  if (typeof raw.legacy === "string" && ids.includes(raw.legacy)) index.legacy = raw.legacy;
  return index;
}
