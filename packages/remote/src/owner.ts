// The on-disk `owner.json` store: the one owner account's password hash and
// passkey records (Phase 0, owner login). The password itself never reaches
// disk, a log line, an audit line or an error's text — only an scrypt hash,
// its salt and the params it was made with. Writes are serialised on one
// chain and land through writeFileAtomic at 0600, the same discipline
// devices.ts follows.

import { scrypt, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { MAX_PASSWORD_LENGTH } from "@jarvis/wire";
import { sanitizeDeviceName } from "./devices.js";
import type { Clock, RandomBytes, RemoteFs } from "./io.js";
import { ensurePrivateDir, isMissing, tightenFileMode, writeFileAtomic } from "./io.js";

export type OwnerHashParams = { N: number; r: number; p: number };

/** The spec's scrypt cost: N=2^17, r=8, p=1. */
export const OWNER_HASH_PARAMS: OwnerHashParams = { N: 2 ** 17, r: 8, p: 1 };
export const OWNER_SALT_BYTES = 16;
export const OWNER_KEY_BYTES = 64;
/** Counted in code points, so an astral character counts once. */
export const MIN_OWNER_PASSWORD_LENGTH = 12;

// Bounds on what a loaded file may ask scrypt to do: a tampered owner.json
// must not be able to make one verify allocate gigabytes or spin for
// minutes. 2^20 is eight times the spec's own N.
const MAX_N = 2 ** 20;
const MAX_R = 32;
const MAX_P = 16;
// scrypt's memory is ~128·N·r bytes: N·r ≤ 2^21 keeps one verify at or
// under 256MiB (the spec's own N=2^17, r=8 is 2^20, 128MiB).
const MAX_N_TIMES_R = 2 ** 21;

const SALT_HEX = /^[0-9a-f]{32}$/;
const HASH_HEX = /^[0-9a-f]{128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// WebAuthn caps a credential id at 1023 bytes (1364 base64url chars); a
// COSE public key for ES256/RS256 is well under 1KiB — 4096 chars is room
// to spare without being unbounded.
const MAX_CREDENTIAL_ID_CHARS = 1_364;
const MAX_PUBLIC_KEY_CHARS = 4_096;
const MAX_SIGN_COUNT = 0xffff_ffff;
/** The WebAuthn user handle: random bytes, base64url in owner.json. */
export const OWNER_HANDLE_BYTES = 32;
const OWNER_HANDLE = /^[A-Za-z0-9_-]{43}$/;

/** A stored WebAuthn credential (Task 7 verifies against it). */
export type PasskeyRecord = {
  /** base64url */
  credentialId: string;
  /** The COSE public key bytes, base64url. */
  publicKey: string;
  alg: -7 | -257;
  signCount: number;
  label: string;
  createdAt: number;
};

export type SetPasswordResult = "ok" | "too-short" | "too-long";

export type OwnerStore = {
  load(): Promise<void>;
  hasPassword(): boolean;
  /** "too-short"/"too-long" write nothing. Rejects (with a message that
   *  never carries the password) when the write fails, leaving the previous
   *  password in force. Bumps credentialsVersion on success. */
  setPassword(password: string): Promise<SetPasswordResult>;
  /** False when no password is set. */
  verifyPassword(password: string): Promise<boolean>;
  listPasskeys(): PasskeyRecord[];
  /** Rejects on a malformed record or a credential id already stored. */
  addPasskey(record: PasskeyRecord): Promise<void>;
  /** The passkey is gone from memory the instant this is called, whether
   *  or not the write then succeeds. Bumps credentialsVersion when it
   *  existed. */
  deletePasskey(credentialId: string): Promise<boolean>;
  updateSignCount(credentialId: string, signCount: number): Promise<boolean>;
  /**
   * The owner's WebAuthn user handle (base64url): made once from random
   * bytes and kept in owner.json, so every passkey names the same user.
   * Rejects when a first write fails (nothing is kept then).
   */
  ownerHandle(): Promise<string>;
  /** Increments on every password change and every passkey delete. */
  credentialsVersion(): number;
  /** Resolves once every write queued so far has landed. */
  flushed(): Promise<void>;
};

type PasswordRecord = OwnerHashParams & { salt: string; hash: string };

type OwnerState = {
  password: PasswordRecord | undefined;
  passkeys: PasskeyRecord[];
  credentialsVersion: number;
  ownerHandle: string | undefined;
};

function invalidOwnerFile(): Error {
  return new Error("owner.json is invalid");
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value >= 2 && (value & (value - 1)) === 0;
}

function isHashParams(value: Record<string, unknown>): boolean {
  const { N, r, p } = value;
  return (
    typeof N === "number" &&
    isPowerOfTwo(N) &&
    N <= MAX_N &&
    typeof r === "number" &&
    Number.isInteger(r) &&
    r >= 1 &&
    r <= MAX_R &&
    typeof p === "number" &&
    Number.isInteger(p) &&
    p >= 1 &&
    p <= MAX_P &&
    N * r <= MAX_N_TIMES_R
  );
}

function isNonNegativeInteger(value: unknown, max = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

/** A fully validated copy of `raw`, or undefined. Never returns `raw` itself. */
function parsePasskey(raw: unknown): PasskeyRecord | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { credentialId, publicKey, alg, signCount, label, createdAt } = raw as Record<
    string,
    unknown
  >;
  if (
    typeof credentialId !== "string" ||
    credentialId.length > MAX_CREDENTIAL_ID_CHARS ||
    !BASE64URL.test(credentialId)
  ) {
    return undefined;
  }
  if (
    typeof publicKey !== "string" ||
    publicKey.length > MAX_PUBLIC_KEY_CHARS ||
    !BASE64URL.test(publicKey)
  ) {
    return undefined;
  }
  if (alg !== -7 && alg !== -257) return undefined;
  if (!isNonNegativeInteger(signCount, MAX_SIGN_COUNT)) return undefined;
  if (typeof label !== "string") return undefined;
  const sanitized = sanitizeDeviceName(label);
  if (sanitized === "") return undefined;
  if (!isNonNegativeInteger(createdAt)) return undefined;
  return { credentialId, publicKey, alg, signCount, label: sanitized, createdAt };
}

function parseOwnerFile(text: string): OwnerState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("owner.json is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidOwnerFile();
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) throw invalidOwnerFile();
  if (!isNonNegativeInteger(obj.credentialsVersion)) throw invalidOwnerFile();
  if (!Array.isArray(obj.passkeys)) throw invalidOwnerFile();

  let password: PasswordRecord | undefined;
  if (obj.password !== undefined) {
    if (typeof obj.password !== "object" || obj.password === null) throw invalidOwnerFile();
    const record = obj.password as Record<string, unknown>;
    const { salt, hash, N, r, p } = record;
    if (typeof salt !== "string" || !SALT_HEX.test(salt)) throw invalidOwnerFile();
    if (typeof hash !== "string" || !HASH_HEX.test(hash)) throw invalidOwnerFile();
    if (!isHashParams(record)) throw invalidOwnerFile();
    password = { salt, hash, N: N as number, r: r as number, p: p as number };
  }

  let ownerHandle: string | undefined;
  if (obj.ownerHandle !== undefined) {
    if (typeof obj.ownerHandle !== "string" || !OWNER_HANDLE.test(obj.ownerHandle)) {
      throw invalidOwnerFile();
    }
    ownerHandle = obj.ownerHandle;
  }

  const seen = new Set<string>();
  const passkeys: PasskeyRecord[] = [];
  for (const entry of obj.passkeys) {
    const parsed = parsePasskey(entry);
    if (parsed === undefined || seen.has(parsed.credentialId)) throw invalidOwnerFile();
    seen.add(parsed.credentialId);
    passkeys.push(parsed);
  }
  return { password, passkeys, credentialsVersion: obj.credentialsVersion, ownerHandle };
}

function serializeOwnerFile(state: OwnerState): string {
  const file: Record<string, unknown> = { version: 1 };
  if (state.password !== undefined) {
    const { hash, salt, N, r, p } = state.password;
    file.password = { hash, salt, N, r, p };
  }
  file.passkeys = state.passkeys.map((record) => ({ ...record }));
  file.credentialsVersion = state.credentialsVersion;
  if (state.ownerHandle !== undefined) file.ownerHandle = state.ownerHandle;
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** Async scrypt at `params`. `maxmem` is sized from the params themselves
 *  (scrypt needs ~128·N·r bytes; Node's 32MiB default refuses N=2^17, r=8). */
function deriveKey(password: string, salt: Buffer, params: OwnerHashParams): Promise<Buffer> {
  const { N, r, p } = params;
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      OWNER_KEY_BYTES,
      { N, r, p, maxmem: 256 * N * r + 1_048_576 },
      (error, key) => {
        // The error text never names the password (scrypt's own messages
        // are about params and memory), but it is dropped anyway.
        if (error !== null) reject(new Error("owner password hashing failed"));
        else resolve(key);
      },
    );
  });
}

export function createOwnerStore(deps: {
  fs: RemoteFs;
  path: string;
  random: RandomBytes;
  now: Clock;
  enforceFileModes: boolean;
  /** Test-only: a lower scrypt cost. Production omits it (OWNER_HASH_PARAMS). */
  hashParams?: OwnerHashParams;
}): OwnerStore {
  const { fs, path, random, enforceFileModes, hashParams = OWNER_HASH_PARAMS } = deps;
  const dir = dirname(path);
  const state: OwnerState = {
    password: undefined,
    passkeys: [],
    credentialsVersion: 0,
    ownerHandle: undefined,
  };
  let writeChain: Promise<void> = Promise.resolve();

  function persist(): Promise<void> {
    const snapshot = serializeOwnerFile(state);
    const task = writeChain.then(async () => {
      try {
        await ensurePrivateDir(fs, dir, enforceFileModes);
        await writeFileAtomic(fs, path, snapshot, 0o600, random);
      } catch {
        // The underlying error is dropped, not wrapped: this store's
        // callers hold a password, and nothing about a failed write may
        // ever carry caller content into an error's text.
        throw new Error("owner.json write failed");
      }
    });
    writeChain = task.catch(() => undefined);
    return task;
  }

  function find(credentialId: string): PasskeyRecord | undefined {
    return state.passkeys.find((record) => record.credentialId === credentialId);
  }

  return {
    async load() {
      let text: string;
      try {
        text = await fs.readFile(path);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      const loaded = parseOwnerFile(text);
      state.password = loaded.password;
      state.passkeys = loaded.passkeys;
      state.credentialsVersion = loaded.credentialsVersion;
      state.ownerHandle = loaded.ownerHandle;
      await tightenFileMode(fs, path, enforceFileModes);
    },

    hasPassword() {
      return state.password !== undefined;
    },

    async setPassword(password) {
      if ([...password].length < MIN_OWNER_PASSWORD_LENGTH) return "too-short";
      // The wire's own bound (UTF-16 units, as `auth:login` checks it): a
      // longer password could be set here but never typed into a login.
      if (password.length > MAX_PASSWORD_LENGTH) return "too-long";
      const saltBytes = random(OWNER_SALT_BYTES);
      const key = await deriveKey(password, saltBytes, hashParams);
      const previous = state.password;
      state.password = {
        ...hashParams,
        salt: saltBytes.toString("hex"),
        hash: key.toString("hex"),
      };
      state.credentialsVersion += 1;
      try {
        await persist();
      } catch (error) {
        // Memory follows disk: the old password stays the one in force.
        // credentialsVersion stays bumped — it only ever has to move
        // forward, and an extra bump costs nothing but a re-login.
        state.password = previous;
        throw error;
      }
      return "ok";
    },

    async verifyPassword(password) {
      const stored = state.password;
      if (stored === undefined) return false;
      const key = await deriveKey(password, Buffer.from(stored.salt, "hex"), stored);
      return timingSafeEqual(key, Buffer.from(stored.hash, "hex"));
    },

    listPasskeys() {
      return state.passkeys.map((record) => ({ ...record }));
    },

    async addPasskey(record) {
      const parsed = parsePasskey(record);
      if (parsed === undefined) throw new Error("invalid passkey record");
      if (find(parsed.credentialId) !== undefined) throw new Error("passkey already stored");
      state.passkeys.push(parsed);
      try {
        await persist();
      } catch (error) {
        state.passkeys = state.passkeys.filter((entry) => entry !== parsed);
        throw error;
      }
    },

    deletePasskey(credentialId) {
      // Deliberately not `async`: gone from memory before any await, and a
      // failed write never brings it back (the devices.ts revoke rule).
      const before = state.passkeys.length;
      state.passkeys = state.passkeys.filter((record) => record.credentialId !== credentialId);
      if (state.passkeys.length === before) return Promise.resolve(false);
      state.credentialsVersion += 1;
      return persist().then(() => true);
    },

    async updateSignCount(credentialId, signCount) {
      const record = find(credentialId);
      if (record === undefined) return false;
      if (!isNonNegativeInteger(signCount, MAX_SIGN_COUNT)) throw new Error("invalid sign count");
      record.signCount = signCount;
      await persist();
      return true;
    },

    async ownerHandle() {
      if (state.ownerHandle !== undefined) return state.ownerHandle;
      const handle = random(OWNER_HANDLE_BYTES).toString("base64url");
      state.ownerHandle = handle;
      try {
        await persist();
      } catch (error) {
        if (state.ownerHandle === handle) state.ownerHandle = undefined;
        throw error;
      }
      return handle;
    },

    credentialsVersion() {
      return state.credentialsVersion;
    },

    flushed() {
      return writeChain;
    },
  };
}
