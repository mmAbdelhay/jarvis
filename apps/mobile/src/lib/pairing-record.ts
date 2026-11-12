// Persisted pairing state (Task 5): a non-secret record (host, port,
// fingerprint, the paired laptop's name, when pairing happened) and the
// device token, kept as two separate keychain entries — `jarvis.pairing`
// (JSON) and `jarvis.token` (the bare token string). The token never goes
// inside the JSON record: `savePairingAt` writes it to its own key, and
// `loadPairing` reads the two keys back into a `Credential` rather than
// trusting anything the record JSON might claim about it.
//
// M11: `name` (distinct from `laptopName`, which is only ever a display
// label) is the DNS name a system-trust pairing dials — set only when the
// pairing was made under that mode (rulings.md 1), and the mode never
// changes after pairing. A stored `name` failing `HOSTNAME_PATTERN` makes
// the whole record unusable, same as any other malformed field.

import {
  DEVICE_ID_PATTERN,
  FINGERPRINT_PATTERN,
  HOSTNAME_PATTERN,
  canonicalAddress,
} from "@jarvis/wire";
import type { Credential } from "./rpc-client";
import type { SecureStore } from "./secure-store";

export type PairingRecord = {
  deviceId: string;
  host: string;
  port: number;
  fingerprint: string;
  name?: string;
  laptopName?: string;
  pairedAt: number;
};

export type StoredCredential = Credential;

/**
 * Thrown by machine-store.ts's `add` (Important-1) when a valid pairing
 * record is already present: the screen's own mount-time check is not the
 * only line of defence against a confirmed link silently replacing an
 * existing pairing — the machine must be removed first.
 */
export class PairingAlreadyExistsError extends Error {
  constructor() {
    super("a pairing record already exists");
    this.name = "PairingAlreadyExistsError";
  }
}

/** The keys of one pairing. `LEGACY_PAIRING_KEYS` are the original ones: a
 *  phone paired before the machine index keeps its pairing there for good
 *  (machine-index.ts). */
export type PairingKeys = { record: string; token: string };
export const LEGACY_PAIRING_KEYS: PairingKeys = {
  record: "jarvis.pairing",
  token: "jarvis.token",
};
/** The legacy slot's refresh token, in the refresh store (refresh-store.ts). */
export const LEGACY_REFRESH_KEY = "jarvis.refresh";

/**
 * Defensive, field-by-field parse — never spreads the parsed JSON into a
 * typed value — plus the same shape checks a fresh pairing would satisfy
 * (id/fingerprint patterns, port range, canonical host). A record that
 * fails any of these is not just unparsable, it is not a pairing this app
 * could ever have produced, so the caller treats it identically to corrupt
 * JSON: unusable.
 */
function parseRecord(value: unknown): PairingRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;
  if (typeof obj.deviceId !== "string" || !DEVICE_ID_PATTERN.test(obj.deviceId)) return undefined;
  if (typeof obj.host !== "string" || canonicalAddress(obj.host) !== obj.host) return undefined;
  if (typeof obj.port !== "number" || !Number.isSafeInteger(obj.port)) return undefined;
  if (obj.port < 1 || obj.port > 65535) return undefined;
  if (typeof obj.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(obj.fingerprint)) {
    return undefined;
  }
  if (typeof obj.pairedAt !== "number") return undefined;
  if (obj.laptopName !== undefined && typeof obj.laptopName !== "string") return undefined;
  if (
    obj.name !== undefined &&
    (typeof obj.name !== "string" || !HOSTNAME_PATTERN.test(obj.name))
  ) {
    return undefined;
  }

  const record: PairingRecord = {
    deviceId: obj.deviceId,
    host: obj.host,
    port: obj.port,
    fingerprint: obj.fingerprint,
    pairedAt: obj.pairedAt,
  };
  if (typeof obj.name === "string") {
    record.name = obj.name;
  }
  if (typeof obj.laptopName === "string") {
    record.laptopName = obj.laptopName;
  }
  return record;
}

/** The self-heal below is a clean-up, not part of the read: if it fails the
 *  pairing is still unusable, and the next load tries again. */
async function tryHeal(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch {
    // Nothing to do: see above.
  }
}

export async function loadPairingAt(
  store: SecureStore,
  keys: PairingKeys,
): Promise<{ record: PairingRecord; credential: Credential } | undefined> {
  const recordText = await store.get(keys.record);
  if (recordText === undefined) {
    // A token with no record (the crash window `savePairingAt` writes the
    // token first to shrink) is equally unusable — clear it rather than
    // strand it.
    await tryHeal(() => store.delete(keys.token));
    return undefined;
  }

  const token = await store.get(keys.token);
  if (token === undefined) {
    // A record with no matching token is not a usable pairing: clear it
    // rather than leave an orphaned record behind for a future save to
    // collide with.
    await tryHeal(() => store.delete(keys.record));
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(recordText);
  } catch {
    // Corrupt JSON leaves a token with no usable record to pair it to —
    // clear both rather than strand the token in the keychain.
    await tryHeal(() => clearPairingAt(store, keys));
    return undefined;
  }
  const record = parseRecord(parsed);
  if (record === undefined) {
    await tryHeal(() => clearPairingAt(store, keys));
    return undefined;
  }

  return { record, credential: { deviceId: record.deviceId, token } };
}

/** The record alone, for showing a machine: the token's key is never read, and
 *  nothing here cleans up. Undefined means gone or unusable. */
export async function loadRecordAt(
  store: SecureStore,
  keys: PairingKeys,
): Promise<PairingRecord | undefined> {
  const recordText = await store.get(keys.record);
  if (recordText === undefined) return undefined;
  try {
    return parseRecord(JSON.parse(recordText));
  } catch {
    return undefined;
  }
}

/** Writes one pairing at `keys`, over whatever is there: the existing-check
 *  is the caller's (machine-store.ts's `add`). */
export async function savePairingAt(
  store: SecureStore,
  keys: PairingKeys,
  record: PairingRecord,
  credential: Credential,
): Promise<void> {
  // Built field by field (never `{...record}`) so a caller that has, say, a
  // token accidentally sitting on `record` can never leak it into the
  // persisted JSON.
  const persisted: PairingRecord = {
    deviceId: record.deviceId,
    host: record.host,
    port: record.port,
    fingerprint: record.fingerprint,
    pairedAt: record.pairedAt,
  };
  if (record.name !== undefined) {
    persisted.name = record.name;
  }
  if (record.laptopName !== undefined) {
    persisted.laptopName = record.laptopName;
  }
  // The token first: if the app is killed between the two writes, the
  // worst case is a token with no record yet (loadPairingAt already treats
  // that as "unusable, clear it"), never a record naming a token that was
  // never written.
  await store.set(keys.token, credential.token);
  await store.set(keys.record, JSON.stringify(persisted));
}

export async function clearPairingAt(store: SecureStore, keys: PairingKeys): Promise<void> {
  await store.delete(keys.record);
  await store.delete(keys.token);
}

export async function loadPairing(
  store: SecureStore,
): Promise<{ record: PairingRecord; credential: Credential } | undefined> {
  return loadPairingAt(store, LEGACY_PAIRING_KEYS);
}
