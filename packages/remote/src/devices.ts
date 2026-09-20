// The on-disk `devices.json` store: the set of paired devices, each keyed
// by a salted/hashed token (tokens.ts), with synchronous revocation and
// serialised writes. `authenticate` is the only synchronous entry point —
// everything the bridge calls per-request runs off the in-memory `Map`,
// never touching disk on the request path.

import { dirname } from "node:path";
import { EXPO_PUSH_TOKEN_PATTERN } from "@jarvis/wire";
import type { Clock, RandomBytes, RemoteFs } from "./io.js";
import { ensurePrivateDir, isMissing, tightenFileMode, writeFileAtomic } from "./io.js";
import { DEVICE_ID_PATTERN } from "./protocol.js";
import { HASH_HEX_PATTERN, mintCredential, SALT_HEX_PATTERN, tokenMatches } from "./tokens.js";

export const MAX_DEVICE_NAME_LENGTH = 64;

// Bidi/invisible-format code points a device name is stripped of outright
// (never folded to a space): the Arabic Letter Mark, the zero-width space
// through right-to-left mark block, the explicit bidi embedding/override
// controls, the word-joiner/invisible-operator block, and the BOM/ZWNBSP.
// Written with `\u{...}` codepoint escapes (and the `u` flag they require)
// rather than raw glyphs or plain `\uXXXX` escapes: `biome format --write`
// silently rewrites a plain `\uXXXX` escape for one of these back into its
// literal, invisible-in-a-diff character, but leaves the `\u{...}` form
// alone — verified by running it against both forms directly.
const DROP_PATTERN = /[\u{061C}\u{200B}-\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2069}\u{FEFF}]/gu;
// C0 controls (\x00-\x1F), DEL and the C1 controls (\x7F-\x9F), and any
// run of whitespace — folded together into exactly one space.
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches control code points to strip them, not an accidental escape.
const FOLD_PATTERN = /[\x00-\x1F\x7F-\x9F\s]+/g;

/**
 * Normalises a raw device name (ruling 8): drop bidi/invisible marks, fold
 * every control/whitespace run to one space with no leading or trailing
 * space, then keep at most `MAX_DEVICE_NAME_LENGTH` *code points* — not
 * UTF-16 code units, so an astral emoji counts once — trimming a trailing
 * space truncation may have exposed.
 */
export function sanitizeDeviceName(raw: string): string {
  const dropped = raw.replace(DROP_PATTERN, "");
  const folded = dropped.replace(FOLD_PATTERN, " ").trim();
  const truncated = [...folded].slice(0, MAX_DEVICE_NAME_LENGTH).join("");
  return truncated.endsWith(" ") ? truncated.slice(0, -1) : truncated;
}

export type DeviceSummary = {
  id: string;
  name: string;
  pairedAt: number;
  lastSeenAt: number | undefined;
  /** Platform only — the token itself never leaves the store (M10 rule 1). */
  push?: "ios" | "android";
};

/** A phone's Expo push registration, stored beside its device record (M10 ruling 2). The token is a credential-adjacent secret: kept only here, never in a summary, a log line or an audit line. */
export type DevicePush = {
  token: string;
  platform: "ios" | "android";
  language: "ar" | "en";
  registeredAt: number;
};

type DeviceRecord = {
  id: string;
  name: string;
  salt: string;
  hash: string;
  pairedAt: number;
  lastSeenAt: number | undefined;
  push?: DevicePush;
};

export type DeviceStore = {
  load(): Promise<void>;
  list(): DeviceSummary[];
  count(): number;
  add(name: string): Promise<{ deviceId: string; token: string }>;
  authenticate(deviceId: string, token: string): DeviceSummary | undefined;
  touch(deviceId: string): Promise<void>;
  revoke(deviceId: string): Promise<boolean>;
  /** Unknown id -> "unknown-device", no write. An unchanged token/platform/
   *  language -> "ok", no write (registeredAt is left alone). Otherwise the
   *  record's `push` is replaced (registeredAt = now()) or cleared, and
   *  persisted on the same write chain as add/touch/revoke (M10 rule 2). */
  setPush(deviceId: string, push: DevicePush | undefined): Promise<"ok" | "unknown-device">;
  /** Every device with a registered token — the sender's send list. Never
   *  exposed through `list()`/`authenticate()`, which report platform only. */
  pushTargets(): {
    deviceId: string;
    token: string;
    platform: "ios" | "android";
    language: "ar" | "en";
  }[];
  /** The current tail of the write chain — resolves once every write queued
   *  so far (add/touch/revoke) has actually landed on disk. Mirrors
   *  AuditLog.flushed() (audit.ts); bridge.ts's `stop()` awaits both so a
   *  caller that then deletes the directory (the integration test's own
   *  teardown) never races a write still in flight. */
  flushed(): Promise<void>;
};

// tokenMatches (tokens.ts) is fed this for an unknown device id so that an
// unrecognised id costs exactly the same timingSafeEqual call as a real
// one — nothing about the comparison's timing reveals whether the id
// exists (ruling 5).
const UNKNOWN_CREDENTIAL = { salt: "0".repeat(32), hash: "0".repeat(128) };

function toSummary(record: DeviceRecord): DeviceSummary {
  return {
    id: record.id,
    name: record.name,
    pairedAt: record.pairedAt,
    lastSeenAt: record.lastSeenAt,
    ...(record.push !== undefined ? { push: record.push.platform } : {}),
  };
}

/** Rejects with a message that always names the file, per ruling 2. */
function invalidDevicesFile(): Error {
  return new Error("devices.json is invalid");
}

/** The token-bearing input never influences a persistence error's text. */
function pushWriteFailed(): Error {
  return new Error("devices push write failed");
}

/**
 * Task 6 (M10 T2 deferred): logs a failed push-record persist with the fs
 * error's `code` (e.g. "EACCES", "ENOSPC") when the thrown value carries
 * one — never more than that plus what `describeError` already gives (no
 * raw path contents beyond whatever `error.message` itself already names).
 * `code` is read defensively (never assumed to be a string) since the
 * thrown value is whatever `fs.rename` rejected with, not something this
 * module controls the shape of.
 */
function logPushWriteFailure(log: (line: string) => void, error: unknown): void {
  const code =
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
  // Task 6 fix round 1: `describeError(error)`'s free-text message is
  // deliberately left out — this call now reaches the bridge's real log
  // sink (M12 Task 6 ruling), and `error` here is whatever `fs.rename`
  // rejected with while writing a *push registration*, whose caller-
  // supplied payload carries the device's push token (the M10 token rule:
  // "never logged"). A real `fs.rename` failure's message is paths and an
  // OS code, never caller content — but this module has no way to prove
  // that for every possible `RemoteFs` implementation, and the `code`
  // alone (EACCES, ENOSPC, ...) is already the actionable part. Logging
  // strictly less than `describeError` would give still satisfies "never
  // beyond what describeError already gives."
  log(
    code !== undefined ? `devices: push write failed code=${code}` : "devices: push write failed",
  );
}

/** Parses and fully validates `text` into records, or throws (ruling 2). Never partially applies a bad file. */
function parseDevicesFile(text: string): DeviceRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("devices.json is not valid JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidDevicesFile();
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) throw invalidDevicesFile();
  if (!Array.isArray(obj.devices)) throw invalidDevicesFile();

  const seenIds = new Set<string>();
  const records: DeviceRecord[] = [];
  for (const entry of obj.devices) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw invalidDevicesFile();
    }
    const {
      id,
      name,
      salt,
      hash,
      pairedAt,
      lastSeenAt,
      push: pushRaw,
    } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !DEVICE_ID_PATTERN.test(id)) throw invalidDevicesFile();
    if (typeof name !== "string") throw invalidDevicesFile();
    if (typeof salt !== "string" || !SALT_HEX_PATTERN.test(salt)) throw invalidDevicesFile();
    if (typeof hash !== "string" || !HASH_HEX_PATTERN.test(hash)) throw invalidDevicesFile();
    if (typeof pairedAt !== "number") throw invalidDevicesFile();
    if (lastSeenAt !== undefined && typeof lastSeenAt !== "number") throw invalidDevicesFile();
    if (seenIds.has(id)) throw invalidDevicesFile();
    seenIds.add(id);

    // M10 rule 1: `push` is optional, but when present every field must be
    // valid or the whole file is rejected — never partially applied.
    let push: DevicePush | undefined;
    if (pushRaw !== undefined) {
      if (typeof pushRaw !== "object" || pushRaw === null || Array.isArray(pushRaw)) {
        throw invalidDevicesFile();
      }
      const { token, platform, language, registeredAt } = pushRaw as Record<string, unknown>;
      if (typeof token !== "string" || !EXPO_PUSH_TOKEN_PATTERN.test(token)) {
        throw invalidDevicesFile();
      }
      if (platform !== "ios" && platform !== "android") throw invalidDevicesFile();
      if (language !== "ar" && language !== "en") throw invalidDevicesFile();
      if (typeof registeredAt !== "number") throw invalidDevicesFile();
      push = { token, platform, language, registeredAt };
    }

    records.push({
      id,
      name,
      salt,
      hash,
      pairedAt,
      lastSeenAt,
      ...(push !== undefined ? { push } : {}),
    });
  }
  return records;
}

/** Pretty JSON plus a trailing newline; `lastSeenAt`/`push` are omitted when undefined (ruling 3; M10 rule 1). */
function serializeDevicesFile(records: readonly DeviceRecord[]): string {
  const devices = records.map(({ id, name, salt, hash, pairedAt, lastSeenAt, push }) => {
    const device: Record<string, unknown> = { id, name, salt, hash, pairedAt };
    if (lastSeenAt !== undefined) device.lastSeenAt = lastSeenAt;
    if (push !== undefined) {
      device.push = {
        token: push.token,
        platform: push.platform,
        language: push.language,
        registeredAt: push.registeredAt,
      };
    }
    return device;
  });
  return `${JSON.stringify({ version: 1, devices }, null, 2)}\n`;
}

export function createDeviceStore(deps: {
  fs: RemoteFs;
  path: string;
  random: RandomBytes;
  now: Clock;
  enforceFileModes: boolean;
  /** Task 6: optional, defaults to a no-op so every existing caller (bridge.ts included) keeps compiling unchanged. Only ever used to report a failed push-record persist (logPushWriteFailure). */
  log?(line: string): void;
}): DeviceStore {
  const { fs, path, random, now, enforceFileModes, log = () => {} } = deps;
  const devices = new Map<string, DeviceRecord>();
  const dir = dirname(path);

  // Every write is queued on this single chain, so two writes started close
  // together (e.g. `Promise.all([add(...), add(...)])`) still land on disk
  // one at a time, each with the map state as it stood the instant *that*
  // write was requested — not whatever the map has become by the time its
  // turn comes up.
  let writeChain: Promise<void> = Promise.resolve();
  // A failed write leaves the in-memory record updated so the bridge can
  // report the failure without reviving stale state. Remember which version
  // actually made it to disk, though: an identical later `setPush` must
  // retry an unsaved registration instead of mistaking memory for durable
  // storage.
  let revision = 0;
  let persistedRevision = 0;

  function persist(): Promise<void> {
    const snapshotRevision = revision;
    const snapshot = serializeDevicesFile([...devices.values()]);
    const task = writeChain.then(async () => {
      await ensurePrivateDir(fs, dir, enforceFileModes);
      await writeFileAtomic(fs, path, snapshot, 0o600, random);
      persistedRevision = Math.max(persistedRevision, snapshotRevision);
    });
    // The chain itself must never end up rejected, or every write queued
    // after a failure would fail too even though it has nothing to do with
    // the earlier error; each caller still observes its own `task` reject.
    writeChain = task.catch(() => undefined);
    return task;
  }

  return {
    async load() {
      let text: string;
      try {
        text = await fs.readFile(path);
      } catch (error) {
        if (isMissing(error)) {
          devices.clear();
          return;
        }
        throw error;
      }
      const records = parseDevicesFile(text);
      devices.clear();
      for (const record of records) devices.set(record.id, record);
      await tightenFileMode(fs, path, enforceFileModes);
    },

    list() {
      return [...devices.values()].map(toSummary);
    },

    count() {
      return devices.size;
    },

    async add(name) {
      const sanitized = sanitizeDeviceName(name);
      if (sanitized === "") throw new Error("a device needs a name");

      const credential = mintCredential(random);
      const record: DeviceRecord = {
        id: credential.deviceId,
        name: sanitized,
        salt: credential.salt,
        hash: credential.hash,
        pairedAt: now(),
        lastSeenAt: undefined,
      };
      devices.set(record.id, record);
      revision += 1;
      try {
        await persist();
      } catch (error) {
        // If a second `add` queued right behind this one already captured
        // its own snapshot (including this record) and wrote it out before
        // this `persist()`'s failure is even observed, the file can be left
        // holding this record even though this call is about to reject and
        // remove it from memory. That's accepted, not a bug to chase: nobody
        // has this device's token (the caller never got a return value), so
        // the orphan on disk is harmless — it simply shows up in Settings
        // until someone revokes it.
        devices.delete(record.id);
        revision += 1;
        throw error;
      }
      return { deviceId: record.id, token: credential.token };
    },

    authenticate(deviceId, token) {
      const record = devices.get(deviceId);
      const matches = tokenMatches(token, record ?? UNKNOWN_CREDENTIAL);
      return matches && record !== undefined ? toSummary(record) : undefined;
    },

    async touch(deviceId) {
      const record = devices.get(deviceId);
      if (record === undefined) return;
      record.lastSeenAt = now();
      revision += 1;
      await persist();
    },

    revoke(deviceId) {
      // Deliberately not `async`: the delete below must happen the instant
      // `revoke` is called, before any `await`, so a caller that starts
      // `revoke()` but doesn't yet await it already sees the device gone
      // from `authenticate`/`count` (ruling 6, and the bite-proof test).
      const existed = devices.delete(deviceId);
      if (!existed) return Promise.resolve(false);
      revision += 1;
      // A write failure must not restore the record (ruling 6/20) — persist()
      // rejecting here simply propagates; there is nothing to undo because
      // the delete already happened above.
      return persist().then(() => true);
    },

    async setPush(deviceId, push) {
      const record = devices.get(deviceId);
      if (record === undefined) return "unknown-device";

      if (push === undefined) {
        if (record.push === undefined) {
          if (persistedRevision < revision) {
            try {
              await persist();
            } catch (error) {
              logPushWriteFailure(log, error);
              throw pushWriteFailed();
            }
          }
          return "ok";
        }
        record.push = undefined;
        revision += 1;
        try {
          await persist();
        } catch (error) {
          logPushWriteFailure(log, error);
          throw pushWriteFailed();
        }
        return "ok";
      }

      const current = record.push;
      const unchanged =
        current !== undefined &&
        current.token === push.token &&
        current.platform === push.platform &&
        current.language === push.language;

      let clearedOther = false;
      for (const other of devices.values()) {
        if (other.id !== deviceId && other.push?.token === push.token) {
          other.push = undefined;
          clearedOther = true;
        }
      }
      if (unchanged) {
        if (clearedOther) {
          revision += 1;
        }
        if (clearedOther || persistedRevision < revision) {
          try {
            await persist();
          } catch (error) {
            logPushWriteFailure(log, error);
            throw pushWriteFailed();
          }
        }
        return "ok"; // registeredAt stays as it was
      }

      record.push = {
        token: push.token,
        platform: push.platform,
        language: push.language,
        registeredAt: now(),
      };
      revision += 1;
      try {
        await persist();
      } catch (error) {
        logPushWriteFailure(log, error);
        throw pushWriteFailed();
      }
      return "ok";
    },

    pushTargets() {
      const targets: ReturnType<DeviceStore["pushTargets"]> = [];
      for (const record of devices.values()) {
        if (record.push === undefined) continue;
        targets.push({
          deviceId: record.id,
          token: record.push.token,
          platform: record.push.platform,
          language: record.push.language,
        });
      }
      return targets;
    },

    flushed() {
      return writeChain;
    },
  };
}
