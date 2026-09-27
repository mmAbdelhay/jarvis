import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Clock, RandomBytes, RemoteFs } from "./io.js";
import { ensurePrivateDir, isMissing, tightenFileMode, writeFileAtomic } from "./io.js";

export const ACCESS_TTL_MS = 15 * 60 * 1_000;
export const REFRESH_IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const REFRESH_ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const FAMILY_ID_PATTERN = /^[0-9a-f]{32}$/;

type RefreshRecord = {
  hash: string;
  deviceId: string;
  familyId: string;
  createdAt: number;
  lastUsedAt: number;
  rotatedTo?: string;
};

type AccessRecord = { deviceId: string; familyId: string; expiresAt: number };

export type IssuedSession = {
  access: string;
  refresh: string;
  accessExpiresAt: number;
  familyId: string;
};

export type RefreshResult =
  | ({ kind: "ok" } & IssuedSession)
  | { kind: "reuse"; familyId: string }
  | { kind: "invalid" };

export type SessionStore = {
  load(): Promise<void>;
  issue(deviceId: string): Promise<IssuedSession>;
  refresh(deviceId: string, token: string): Promise<RefreshResult>;
  verifyAccess(
    deviceId: string,
    token: string,
  ): { familyId: string; expiresAt: number } | undefined;
  revokeFamily(familyId: string): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  revokeAll(): Promise<void>;
  flushed(): Promise<void>;
};

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintToken(random: RandomBytes): string {
  return random(32).toString("hex");
}

function validRecord(value: unknown): value is RefreshRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.hash === "string" &&
    HASH_PATTERN.test(record.hash) &&
    typeof record.deviceId === "string" &&
    typeof record.familyId === "string" &&
    FAMILY_ID_PATTERN.test(record.familyId) &&
    typeof record.createdAt === "number" &&
    Number.isFinite(record.createdAt) &&
    typeof record.lastUsedAt === "number" &&
    Number.isFinite(record.lastUsedAt) &&
    (record.rotatedTo === undefined ||
      (typeof record.rotatedTo === "string" && HASH_PATTERN.test(record.rotatedTo)))
  );
}

function parseFile(text: string): RefreshRecord[] | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const file = value as Record<string, unknown>;
    if (file.version !== 1 || !Array.isArray(file.sessions) || !file.sessions.every(validRecord)) {
      return undefined;
    }
    const hashes = new Set<string>();
    for (const record of file.sessions) {
      if (hashes.has(record.hash)) return undefined;
      hashes.add(record.hash);
    }
    return file.sessions;
  } catch {
    return undefined;
  }
}

function serialize(records: Iterable<RefreshRecord>): string {
  return `${JSON.stringify({ version: 1, sessions: [...records] }, null, 2)}\n`;
}

export function createSessionStore(deps: {
  fs: RemoteFs;
  path: string;
  random: RandomBytes;
  now: Clock;
  enforceFileModes: boolean;
}): SessionStore {
  const { fs, path, random, now, enforceFileModes } = deps;
  const dir = dirname(path);
  const refreshRecords = new Map<string, RefreshRecord>();
  const accessRecords = new Map<string, AccessRecord>();
  let writeChain: Promise<void> = Promise.resolve();

  function expired(record: RefreshRecord, at: number): boolean {
    return (
      (record.rotatedTo === undefined && at - record.lastUsedAt > REFRESH_IDLE_TTL_MS) ||
      at - record.createdAt >= REFRESH_ABSOLUTE_TTL_MS
    );
  }

  function purgeExpired(at: number): boolean {
    const expiredFamilies = new Set<string>();
    for (const record of refreshRecords.values()) {
      if (expired(record, at)) expiredFamilies.add(record.familyId);
    }
    if (expiredFamilies.size === 0) return false;
    for (const [hash, record] of refreshRecords) {
      if (expiredFamilies.has(record.familyId)) refreshRecords.delete(hash);
    }
    for (const [hash, record] of accessRecords) {
      if (expiredFamilies.has(record.familyId)) accessRecords.delete(hash);
    }
    return true;
  }

  function persist(): Promise<void> {
    purgeExpired(now());
    const snapshot = serialize(refreshRecords.values());
    const task = writeChain.then(async () => {
      await ensurePrivateDir(fs, dir, enforceFileModes);
      await writeFileAtomic(fs, path, snapshot, 0o600, random);
    });
    writeChain = task.catch(() => undefined);
    return task;
  }

  function revokeFamilyInMemory(familyId: string): void {
    for (const [hash, record] of refreshRecords) {
      if (record.familyId === familyId) refreshRecords.delete(hash);
    }
    for (const [hash, record] of accessRecords) {
      if (record.familyId === familyId) accessRecords.delete(hash);
    }
  }

  function mintPair(deviceId: string, familyId: string): IssuedSession {
    const access = mintToken(random);
    const refresh = mintToken(random);
    const accessExpiresAt = now() + ACCESS_TTL_MS;
    accessRecords.set(hashToken(access), { deviceId, familyId, expiresAt: accessExpiresAt });
    return { access, refresh, accessExpiresAt, familyId };
  }

  return {
    async load() {
      let text: string;
      try {
        text = await fs.readFile(path);
      } catch (error) {
        if (!isMissing(error)) throw error;
        refreshRecords.clear();
        accessRecords.clear();
        return;
      }

      const records = parseFile(text);
      refreshRecords.clear();
      accessRecords.clear();
      if (records === undefined) return;
      for (const record of records) refreshRecords.set(record.hash, record);
      const purged = purgeExpired(now());
      await tightenFileMode(fs, path, enforceFileModes);
      if (purged) await persist();
    },

    async issue(deviceId) {
      const familyId = random(16).toString("hex");
      const pair = mintPair(deviceId, familyId);
      const createdAt = now();
      refreshRecords.set(hashToken(pair.refresh), {
        hash: hashToken(pair.refresh),
        deviceId,
        familyId,
        createdAt,
        lastUsedAt: createdAt,
      });
      await persist();
      return pair;
    },

    async refresh(deviceId, token) {
      const hash = hashToken(token);
      const record = refreshRecords.get(hash);
      if (record === undefined || record.deviceId !== deviceId) return { kind: "invalid" };
      if (expired(record, now())) {
        revokeFamilyInMemory(record.familyId);
        await persist();
        return { kind: "invalid" };
      }
      if (record.rotatedTo !== undefined) {
        const familyId = record.familyId;
        revokeFamilyInMemory(familyId);
        await persist();
        return { kind: "reuse", familyId };
      }

      const pair = mintPair(deviceId, record.familyId);
      const nextHash = hashToken(pair.refresh);
      const usedAt = now();
      record.lastUsedAt = usedAt;
      record.rotatedTo = nextHash;
      refreshRecords.set(nextHash, {
        hash: nextHash,
        deviceId,
        familyId: record.familyId,
        createdAt: record.createdAt,
        lastUsedAt: usedAt,
      });
      await persist();
      return { kind: "ok", ...pair };
    },

    verifyAccess(deviceId, token) {
      const hash = hashToken(token);
      const record = accessRecords.get(hash);
      if (record === undefined || record.deviceId !== deviceId) return undefined;
      if (now() >= record.expiresAt) {
        accessRecords.delete(hash);
        return undefined;
      }
      return { familyId: record.familyId, expiresAt: record.expiresAt };
    },

    async revokeFamily(familyId) {
      revokeFamilyInMemory(familyId);
      await persist();
    },

    async revokeDevice(deviceId) {
      for (const [hash, record] of refreshRecords) {
        if (record.deviceId === deviceId) refreshRecords.delete(hash);
      }
      for (const [hash, record] of accessRecords) {
        if (record.deviceId === deviceId) accessRecords.delete(hash);
      }
      await persist();
    },

    async revokeAll() {
      refreshRecords.clear();
      accessRecords.clear();
      await persist();
    },

    flushed() {
      return writeChain;
    },
  };
}
