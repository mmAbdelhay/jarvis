// Persisted pairing state (Task 5): a non-secret record (host, port,
// fingerprint, the paired laptop's name, when pairing happened) and the
// device token, kept as two separate keychain entries — `jarvis.pairing`
// (JSON) and `jarvis.token` (the bare token string). The token never goes
// inside the JSON record: `savePairing` writes it to its own key, and
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
 * Thrown by `savePairing` (Important-1) when a valid pairing record is
 * already present: the screen's own mount-time check is not the only line
 * of defence against a confirmed link silently replacing an existing
 * pairing — `clearPairing` must run first.
 */
export class PairingAlreadyExistsError extends Error {
  constructor() {
    super("a pairing record already exists");
    this.name = "PairingAlreadyExistsError";
  }
}

const RECORD_KEY = "jarvis.pairing";
const TOKEN_KEY = "jarvis.token";

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

export async function loadPairing(
  store: SecureStore,
): Promise<{ record: PairingRecord; credential: Credential } | undefined> {
  const recordText = await store.get(RECORD_KEY);
  if (recordText === undefined) {
    // A token with no record (the crash window `savePairing` now writes
    // the token first to shrink) is equally unusable — clear it rather
    // than strand it.
    await store.delete(TOKEN_KEY);
    return undefined;
  }

  const token = await store.get(TOKEN_KEY);
  if (token === undefined) {
    // A record with no matching token is not a usable pairing: clear it
    // rather than leave an orphaned record behind for a future save to
    // collide with.
    await store.delete(RECORD_KEY);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(recordText);
  } catch {
    // Corrupt JSON leaves a token with no usable record to pair it to —
    // clear both rather than strand the token in the keychain.
    await clearPairing(store);
    return undefined;
  }
  const record = parseRecord(parsed);
  if (record === undefined) {
    await clearPairing(store);
    return undefined;
  }

  return { record, credential: { deviceId: record.deviceId, token } };
}

export async function savePairing(
  store: SecureStore,
  record: PairingRecord,
  credential: Credential,
): Promise<void> {
  // Important-1: refuse rather than silently overwrite. Reuses
  // `loadPairing` so an unusable (corrupt/invalid/orphan) record — which
  // `loadPairing` itself already self-heals by clearing — never blocks a
  // fresh save; only a genuinely valid existing pairing does.
  const existing = await loadPairing(store);
  if (existing !== undefined) {
    throw new PairingAlreadyExistsError();
  }

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
  // worst case is a token with no record yet (loadPairing already treats
  // that as "unusable, clear it"), never a record naming a token that was
  // never written.
  await store.set(TOKEN_KEY, credential.token);
  await store.set(RECORD_KEY, JSON.stringify(persisted));
}

export async function clearPairing(store: SecureStore): Promise<void> {
  await store.delete(RECORD_KEY);
  await store.delete(TOKEN_KEY);
}
