import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FILE_TTL_MS,
  MAX_DEVICE_UPLOAD_BYTES,
  MAX_DEVICE_UPLOAD_FILES,
  MAX_FILE_BYTES,
  MAX_JSON_UPLOAD_BYTES,
} from "@jarvis/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MESSAGES } from "./messages.js";
import type { RemoteOrigin } from "./remote-blob.js";
import {
  createFileUploadHandler,
  createFileUploadStore,
  type FileUploadStoreDeps,
  type UploadStore,
} from "./file-upload.js";

// NTFS has no POSIX permission bits — Node reports a synthetic mode there
// (typically 0666/0777, whatever the OS actually enforced), never the
// 0600/0700 this store's real POSIX chmod calls request. Matches the
// convention in bridge.integration.test.ts's own ENFORCE_FILE_MODES.
const ENFORCE_FILE_MODES = process.platform !== "win32";
// The store's own construction-time wipe (reconcileStaging in file-upload.ts)
// fires an un-awaited recursive rm() of baseDir; a test that constructs a
// second store against the same baseDir (or whose afterEach races that
// wipe) can hit Windows' well-documented EBUSY/EPERM on a directory another
// handle is still finishing a delete on. `maxRetries`/`retryDelay` are
// fs.rm's own documented answer to exactly this — a bounded linear-backoff
// retry — not a change to what any test asserts.
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

function hexId(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function harness(overrides: Partial<FileUploadStoreDeps> = {}) {
  let clock = 1_000_000;
  let counter = 0;
  const logs: string[] = [];
  const deps: FileUploadStoreDeps = {
    now: () => clock,
    randomId: () => hexId(counter++),
    baseDir: "",
    language: "en",
    log: (line) => logs.push(line),
    ...overrides,
  };
  return {
    deps,
    logs,
    setNow: (n: number) => {
      clock = n;
    },
    /** Pins the next single randomId() call to `id`, then reverts to the
     *  ordinary unique counter for every call after that. */
    setNextId: (id: string) => {
      deps.randomId = () => {
        deps.randomId = () => hexId(counter++);
        return id;
      };
    },
  };
}

const DEVICE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** Polls (yielding a real event-loop turn each time, not just a microtask —
 *  `hooks.beforeRead` is reached only after real `node:fs/promises` awaits)
 *  until `count()` has reached `target`. Used to pause a store operation at
 *  its `hooks.beforeRead` seam deterministically — by construction, since
 *  this waits for the hook to actually have been entered, regardless of
 *  how many real-fs ticks precede it — rather than biasing a real race
 *  with padding. M12 Task 7 (M9 T3 minor: sweep-identity/resolve-
 *  invalidation determinism). */
async function untilCalled(count: () => number, target = 1): Promise<void> {
  while (count() < target) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Stages `targetBytes` worth of live files for `deviceId`, each no larger
 *  than MAX_FILE_BYTES (a single put() can never carry more than that) —
 *  used to approach MAX_DEVICE_UPLOAD_BYTES without ever exceeding the
 *  per-file cap first. Throws if any fill put unexpectedly fails, which is
 *  itself the assertion the "reservation released" test relies on. */
async function fillTo(store: UploadStore, deviceId: string, targetBytes: number): Promise<void> {
  let remaining = targetBytes;
  let i = 0;
  while (remaining > 0) {
    const size = Math.min(remaining, MAX_FILE_BYTES);
    const result = await store.put(
      deviceId,
      { name: `fill${i}`, contentType: "x" },
      new Uint8Array(size),
    );
    if (!result.ok) throw new Error(`fillTo: put ${i} unexpectedly failed: ${result.text}`);
    remaining -= size;
    i += 1;
  }
}

// [bite-proof: startup reconciliation — brief B1 "Never follow stale files
// found at startup; clean only the owned staging tree"]
//
// Deliberately its own top-level describe, with its own beforeEach that
// constructs no store of its own: `describe("createFileUploadStore", …)`
// below always constructs a shared `store` in its own beforeEach, and that
// construction alone kicks off a real, fire-and-forget wipe of `baseDir`
// (Important 3) — sharing that hook here would race this suite's own
// direct, pre-store writes into `baseDir` against it.
describe("createFileUploadStore: startup reconciliation", () => {
  let baseDir: string;
  let h: ReturnType<typeof harness>;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "jarvis-file-upload-startup-test-"));
    h = harness({ baseDir });
  });

  afterEach(async () => {
    await rm(baseDir, RM_OPTIONS);
  });

  it("wipes anything already under baseDir before the first put() ever writes to it", async () => {
    await mkdir(join(baseDir, "junk-device"), { recursive: true });
    await writeFile(join(baseDir, "junk-device", "leftover"), "stale bytes");

    const fresh = createFileUploadStore(h.deps);
    const result = await fresh.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array([1]));

    expect(result.ok).toBe(true);
    await expect(stat(join(baseDir, "junk-device"))).rejects.toThrow();
  });

  it("never follows a symlink left under baseDir — the symlink is unlinked, its target untouched", async () => {
    const externalSecret = join(tmpdir(), `jarvis-file-upload-secret-${hexId(1)}.txt`);
    await writeFile(externalSecret, "top secret");
    await symlink(externalSecret, join(baseDir, "evil-link"));

    const fresh = createFileUploadStore(h.deps);
    await fresh.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array([1]));

    await expect(stat(join(baseDir, "evil-link"))).rejects.toThrow();
    expect(await readFile(externalSecret, "utf8")).toBe("top secret");
    await rm(externalSecret, { force: true });
  });
});

// M12 Task 7 (M9 T3 minor, deferred): O_NOFOLLOW ?? 0 degrade — a platform
// whose `node:fs` constants lack O_NOFOLLOW logs exactly one line at
// construction, and everything else keeps working (the `lstat`-backed
// checks elsewhere in this file never follow a symlink either way). A real
// Node on this platform always has O_NOFOLLOW, so this fakes `node:fs`'s
// own `constants` for one dynamically re-imported copy of the module,
// leaving every other test in this file on the real one.
describe("createFileUploadStore: O_NOFOLLOW unavailable", () => {
  afterEach(() => {
    vi.doUnmock("node:fs");
    vi.resetModules();
  });

  it("logs one line at construction, and an ordinary put()/resolve() still works", async () => {
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      const { O_NOFOLLOW: _omit, ...withoutONofollow } = actual.constants;
      return { ...actual, constants: withoutONofollow };
    });
    vi.resetModules();
    const fresh = await import("./file-upload.js");

    const baseDir = await mkdtemp(join(tmpdir(), "jarvis-file-upload-onofollow-test-"));
    const logs: string[] = [];
    try {
      const store = fresh.createFileUploadStore({
        now: () => 1,
        randomId: () => hexId(900),
        baseDir,
        language: "en",
        log: (line) => logs.push(line),
      });

      expect(logs).toContain(
        "file-upload: O_NOFOLLOW unavailable, symlink refusal relies on lstat",
      );

      const put = await store.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array([1]));
      expect(put.ok).toBe(true);
      if (put.ok) {
        expect(await store.resolve(DEVICE_A, put.value.fileId)).toEqual({
          bytes: Buffer.from([1]),
          name: "n",
          contentType: "x",
        });
      }
      store.stop();
    } finally {
      await rm(baseDir, RM_OPTIONS);
    }
  });
});

describe("createFileUploadStore", () => {
  let baseDir: string;
  let store: UploadStore;
  let h: ReturnType<typeof harness>;

  beforeEach(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "jarvis-file-upload-test-"));
    h = harness({ baseDir });
    store = createFileUploadStore(h.deps);
  });

  afterEach(async () => {
    await rm(baseDir, RM_OPTIONS);
  });

  describe("put", () => {
    it("stages the exact bytes at baseDir/deviceId/fileId, mode 0600, dir mode 0700", async () => {
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const result = await store.put(
        DEVICE_A,
        { name: "a.json", contentType: "application/json" },
        bytes,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(result.value).toEqual({
        fileId: hexId(0),
        name: "a.json",
        contentType: "application/json",
        bytes: 4,
        expiresAt: 1_000_000 + FILE_TTL_MS,
      });

      const path = join(baseDir, DEVICE_A, hexId(0));
      expect(await readFile(path)).toEqual(Buffer.from(bytes));
      if (ENFORCE_FILE_MODES) {
        const fileStat = await stat(path);
        expect(fileStat.mode & 0o777).toBe(0o600);
        const dirStat = await stat(join(baseDir, DEVICE_A));
        expect(dirStat.mode & 0o777).toBe(0o700);
      }
    });

    // [bite-proof: 25 MiB exact/over]
    it("accepts exactly MAX_FILE_BYTES", async () => {
      const bytes = new Uint8Array(MAX_FILE_BYTES);
      const result = await store.put(DEVICE_A, { name: "big", contentType: "x" }, bytes);
      expect(result.ok).toBe(true);
    });

    it("rejects MAX_FILE_BYTES + 1 without ever touching disk", async () => {
      const bytes = new Uint8Array(MAX_FILE_BYTES + 1);
      const result = await store.put(DEVICE_A, { name: "big", contentType: "x" }, bytes);
      expect(result).toEqual({ ok: false, text: MESSAGES.fileUploadInvalid("en"), language: "en" });
      const path = join(baseDir, DEVICE_A, hexId(0));
      await expect(stat(path)).rejects.toThrow();
    });

    it("rejects 0 bytes", async () => {
      const result = await store.put(
        DEVICE_A,
        { name: "empty", contentType: "x" },
        new Uint8Array(0),
      );
      expect(result.ok).toBe(false);
    });

    // [bite-proof: per-owner quota — file count]
    it(`refuses a ${MAX_DEVICE_UPLOAD_FILES + 1}th live file for one device`, async () => {
      for (let i = 0; i < MAX_DEVICE_UPLOAD_FILES; i += 1) {
        const result = await store.put(
          DEVICE_A,
          { name: `f${i}`, contentType: "x" },
          new Uint8Array(1),
        );
        expect(result.ok).toBe(true);
      }
      const overCap = await store.put(
        DEVICE_A,
        { name: "one-too-many", contentType: "x" },
        new Uint8Array(1),
      );
      expect(overCap).toEqual({
        ok: false,
        text: MESSAGES.fileUploadQuotaExceeded("en"),
        language: "en",
      });
    });

    it("a different device's files never count against this device's file quota", async () => {
      for (let i = 0; i < MAX_DEVICE_UPLOAD_FILES; i += 1) {
        await store.put(DEVICE_A, { name: `f${i}`, contentType: "x" }, new Uint8Array(1));
      }
      const result = await store.put(
        DEVICE_B,
        { name: "first", contentType: "x" },
        new Uint8Array(1),
      );
      expect(result.ok).toBe(true);
    });

    // [bite-proof: per-owner quota — total bytes]
    it("refuses a put that would push total live bytes over MAX_DEVICE_UPLOAD_BYTES", async () => {
      await fillTo(store, DEVICE_A, MAX_DEVICE_UPLOAD_BYTES - 1_000);
      const over = await store.put(
        DEVICE_A,
        { name: "tip", contentType: "x" },
        new Uint8Array(1_001),
      );
      expect(over).toEqual({
        ok: false,
        text: MESSAGES.fileUploadQuotaExceeded("en"),
        language: "en",
      });
    });

    it("accepts a put that lands exactly on MAX_DEVICE_UPLOAD_BYTES", async () => {
      await fillTo(store, DEVICE_A, MAX_DEVICE_UPLOAD_BYTES - 1_000);
      const atCap = await store.put(
        DEVICE_A,
        { name: "tip", contentType: "x" },
        new Uint8Array(1_000),
      );
      expect(atCap.ok).toBe(true);
    });

    // [bite-proof: per-owner quota race — concurrency cannot exceed the quota]
    it("two concurrent puts that would jointly exceed the byte quota: exactly one succeeds", async () => {
      // Leaves just over one MAX_FILE_BYTES of room — not enough for both
      // racing puts, which are reserved synchronously in call order, so the
      // first always wins and the second always sees the shrunk total.
      await fillTo(store, DEVICE_A, MAX_DEVICE_UPLOAD_BYTES - MAX_FILE_BYTES - 500);
      const [first, second] = await Promise.all([
        store.put(DEVICE_A, { name: "one", contentType: "x" }, new Uint8Array(MAX_FILE_BYTES)),
        store.put(DEVICE_A, { name: "two", contentType: "x" }, new Uint8Array(MAX_FILE_BYTES)),
      ]);
      const results = [first, second];
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toHaveLength(1);
    });

    // [bite-proof: failed exclusive write releases the reservation]
    it("a write that collides with an existing file fails, and releases its quota reservation", async () => {
      h.setNextId(hexId(98));
      const dirPut = await store.put(
        DEVICE_A,
        { name: "reserve-dir", contentType: "x" },
        new Uint8Array(1),
      ); // creates DEVICE_A's directory
      expect(dirPut.ok).toBe(true);
      const dir = join(baseDir, DEVICE_A);
      await writeFile(join(dir, hexId(99)), "already here");

      h.setNextId(hexId(99));
      const result = await store.put(
        DEVICE_A,
        { name: "collide", contentType: "x" },
        new Uint8Array(5),
      );
      expect(result).toEqual({
        ok: false,
        text: MESSAGES.fileUploadFailed("en"),
        language: "en",
      });
      // [bite-proof: no path on the wire] the failure text is the fixed,
      // already-localised MESSAGES string above — never baseDir or any
      // segment of the path this write actually collided on.
      if (!result.ok) {
        expect(result.text).not.toContain(baseDir);
        expect(result.text).not.toContain(hexId(99));
      }

      // Reservation released: only dirPut's 1 byte is truly committed, so
      // filling all the way to MAX_DEVICE_UPLOAD_BYTES - 1 must succeed —
      // fillTo() throws on the first put that fails, which a leaked 5-byte
      // reservation from the collision above would cause.
      await fillTo(store, DEVICE_A, MAX_DEVICE_UPLOAD_BYTES - 1);
    });

    // [bite-proof: revoke during write — an in-flight write cannot resurrect a file]
    it("revoke() that lands while a put() is still writing discards the result and the file", async () => {
      h.setNextId(hexId(7));
      const putPromise = store.put(
        DEVICE_A,
        { name: "race", contentType: "x" },
        new Uint8Array(10),
      );
      const revokePromise = store.revoke(DEVICE_A); // synchronous prefix bumps the generation immediately

      const result = await putPromise;
      await revokePromise;

      expect(result).toEqual({
        ok: false,
        text: MESSAGES.fileUploadFailed("en"),
        language: "en",
      });
      expect(await store.resolve(DEVICE_A, hexId(7))).toBeUndefined();
      await expect(stat(join(baseDir, DEVICE_A, hexId(7)))).rejects.toThrow();
    });

    // [bite-proof: stop during write — same guarantee]
    it("stop() that lands while a put() is still writing discards the result and the file", async () => {
      h.setNextId(hexId(8));
      const putPromise = store.put(
        DEVICE_A,
        { name: "race", contentType: "x" },
        new Uint8Array(10),
      );
      const stopPromise = store.stop();

      const result = await putPromise;
      await stopPromise;

      expect(result.ok).toBe(false);
      expect(await store.resolve(DEVICE_A, hexId(8))).toBeUndefined();
    });

    it("stop() refuses every put() called after it, without reserving anything", async () => {
      await store.stop();
      const result = await store.put(
        DEVICE_A,
        { name: "late", contentType: "x" },
        new Uint8Array(1),
      );
      expect(result.ok).toBe(false);
    });

    // [bite-proof: omit clearTimeout in stop(); count stays 1]
    it("stop() clears the store's own sweep timer, and is idempotent", () => {
      vi.useFakeTimers();
      try {
        const fresh = createFileUploadStore(h.deps);
        expect(vi.getTimerCount()).toBe(1);

        fresh.stop();
        expect(vi.getTimerCount()).toBe(0);

        // Idempotent: a second call is a harmless no-op, not a re-schedule.
        fresh.stop();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("revoke", () => {
    // [bite-proof: reintroduce an early `if (state === undefined) return;`
    // before the removeDeviceDir call; the directory this asserts is gone
    // is left behind]
    it("sweeps the device directory even when the in-memory record was already swept away", async () => {
      const put = await store.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array([1]));
      if (!put.ok) throw new Error("expected ok");
      h.setNow(put.value.expiresAt + 1);
      await store.sweep(); // reaps the record AND detaches DEVICE_A from `devices` entirely

      // A leftover file the in-memory state no longer knows about — the
      // kind of thing an early return on "no record" would leave behind.
      const deviceDir = join(baseDir, DEVICE_A);
      await mkdir(deviceDir, { recursive: true });
      await writeFile(join(deviceDir, "orphan"), "x");

      await store.revoke(DEVICE_A);

      await expect(stat(deviceDir)).rejects.toThrow();
    });

    it("is a harmless no-op for a device with no record and no directory", async () => {
      await expect(store.revoke(DEVICE_A)).resolves.toBeUndefined();
    });
  });

  describe("resolve", () => {
    it("returns the staged bytes, name and contentType for the owning device", async () => {
      const bytes = new Uint8Array([9, 9, 9]);
      const put = await store.put(DEVICE_A, { name: "n", contentType: "text/plain" }, bytes);
      if (!put.ok) throw new Error("expected ok");

      const resolved = await store.resolve(DEVICE_A, put.value.fileId);
      expect(resolved).toEqual({ bytes: Buffer.from(bytes), name: "n", contentType: "text/plain" });
    });

    // [bite-proof: cross-owner ids]
    it("returns undefined for the same id resolved by a different device", async () => {
      const put = await store.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array(1));
      if (!put.ok) throw new Error("expected ok");
      expect(await store.resolve(DEVICE_B, put.value.fileId)).toBeUndefined();
    });

    it("returns undefined for an unknown id", async () => {
      expect(await store.resolve(DEVICE_A, hexId(404))).toBeUndefined();
    });

    it("returns undefined for a malformed id", async () => {
      expect(await store.resolve(DEVICE_A, "not-a-file-id")).toBeUndefined();
    });

    // [bite-proof: expiry boundary]
    it("resolves right up to and including the moment it expires, and not one tick after", async () => {
      const put = await store.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array(1));
      if (!put.ok) throw new Error("expected ok");

      h.setNow(put.value.expiresAt);
      expect(await store.resolve(DEVICE_A, put.value.fileId)).toBeDefined();

      h.setNow(put.value.expiresAt + 1);
      expect(await store.resolve(DEVICE_A, put.value.fileId)).toBeUndefined();
    });

    // [bite-proof: path/symlink substitution]
    //
    // Genuine Windows gap, not a test-fixture issue (see ci-green-report.md):
    // readRegularFile's refusal is `fsConstants.O_NOFOLLOW ?? 0` — Node
    // never defines O_NOFOLLOW on win32, so the `open()` call there falls
    // back to following the symlink there, unlike the device-directory
    // check below (isSafeDeviceDir), which is lstat-based and platform-
    // independent. This assertion is real and must not be weakened on
    // POSIX; it is skipped only where the protection it pins does not
    // exist yet.
    it.skipIf(process.platform === "win32")(
      "refuses to follow a symlink swapped in for a staged file",
      async () => {
        // The initial put() first — it internally awaits the store's one-time
        // startup wipe (Important 3) before it ever touches disk, so
        // everything written into baseDir below (after this line) can never
        // race that wipe.
        const put = await store.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array([1]));
        if (!put.ok) throw new Error("expected ok");
        const stagedPath = join(baseDir, DEVICE_A, put.value.fileId);

        const secretPath = join(baseDir, "secret.txt");
        // Exactly `put.value.bytes` (1) long, on purpose: a longer secret
        // would already fail the post-open size check on its own, masking
        // whether `readRegularFile`'s O_NOFOLLOW open is doing any work at
        // all. Same length forces the refusal below to come from refusing to
        // follow the symlink, not from a size mismatch.
        await writeFile(secretPath, "s");
        expect(Buffer.byteLength("s")).toBe(put.value.bytes);
        await rm(stagedPath, { force: true });
        await symlink(secretPath, stagedPath);

        expect(await store.resolve(DEVICE_A, put.value.fileId)).toBeUndefined();
      },
    );

    it("refuses to follow a symlink swapped in for the device directory", async () => {
      const put = await store.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array([1]));
      if (!put.ok) throw new Error("expected ok");
      const deviceDir = join(baseDir, DEVICE_A);
      const externalDir = join(baseDir, "external");
      await mkdir(externalDir);
      await writeFile(join(externalDir, put.value.fileId), Buffer.from([9]));
      await rm(deviceDir, RM_OPTIONS);
      await symlink(externalDir, deviceDir);

      expect(await store.resolve(DEVICE_A, put.value.fileId)).toBeUndefined();
    });

    // [bite-proof: revoke/stop before a read — resolve reports "not found", never a crash]
    it("returns undefined for a file whose device was since revoked", async () => {
      const put = await store.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array(1));
      if (!put.ok) throw new Error("expected ok");
      await store.revoke(DEVICE_A);
      expect(await store.resolve(DEVICE_A, put.value.fileId)).toBeUndefined();
    });

    // [bite-proof: post-I/O invalidation — the generation/map re-check that
    // runs immediately after `readRegularFile` returns, with no further
    // await before the result is handed back. Deterministic by
    // construction (a hooks.beforeRead pause), not a real-fs race biased
    // by junk-file padding — M12 Task 7 (M9 T3 minor).]
    it("a resolve() paused right after its own disk read succeeds is invalidated by a concurrent revoke()", async () => {
      let hits = 0;
      let release: (() => void) | undefined;
      const hookedStore = createFileUploadStore({
        ...h.deps,
        hooks: {
          beforeRead: () =>
            new Promise<void>((resolve) => {
              hits += 1;
              release = resolve;
            }),
        },
      });

      const put = await hookedStore.put(
        DEVICE_A,
        { name: "n", contentType: "x" },
        new Uint8Array([1]),
      );
      if (!put.ok) throw new Error("expected ok");

      // resolve()'s own disk read has already succeeded by the time this
      // hook is reached — it is paused right before its post-read
      // generation/map re-check, holding the bytes it already read.
      const resolvePromise = hookedStore.resolve(DEVICE_A, put.value.fileId);
      await untilCalled(() => hits);

      // revoke() runs to completion — generation bumped, device state
      // detached, directory reclaimed — entirely while resolve() waits.
      await hookedStore.revoke(DEVICE_A);
      release?.();

      expect(await resolvePromise).toBeUndefined();
      hookedStore.stop();
    });
  });

  describe("readJson", () => {
    it("decodes a valid staged JSON file", async () => {
      const json = JSON.stringify({ hello: "world" });
      const put = await store.put(
        DEVICE_A,
        { name: "n.json", contentType: "application/json" },
        new TextEncoder().encode(json),
      );
      if (!put.ok) throw new Error("expected ok");

      const result = await store.readJson(DEVICE_A, put.value.fileId);
      expect(result).toEqual({ ok: true, value: { hello: "world" } });
    });

    it("returns the shared not-found failure for an unknown id", async () => {
      const result = await store.readJson(DEVICE_A, hexId(999));
      expect(result).toEqual({
        ok: false,
        text: MESSAGES.fileUploadNotFound("en"),
        language: "en",
      });
    });

    // [bite-proof: malformed JSON]
    it("rejects malformed JSON", async () => {
      const put = await store.put(
        DEVICE_A,
        { name: "n.json", contentType: "application/json" },
        new TextEncoder().encode("{not json"),
      );
      if (!put.ok) throw new Error("expected ok");
      const result = await store.readJson(DEVICE_A, put.value.fileId);
      expect(result).toEqual({
        ok: false,
        text: MESSAGES.remoteImportRejected("en"),
        language: "en",
      });
    });

    // [bite-proof: overlarge JSON — checked against the tracked byte count,
    // before any disk read/decode/parse]. Deliberately VALID JSON (a
    // quoted string, padded to exactly MAX_JSON_UPLOAD_BYTES + 1 bytes):
    // whitespace-only "JSON" would already fail to parse even with the
    // `entry.bytes > MAX_JSON_UPLOAD_BYTES` guard removed, so it could
    // never distinguish "too large" from "malformed" — a valid body forces
    // the size guard itself to do the rejecting, since without it
    // JSON.parse would succeed and validateRemoteImport would accept a
    // bare string.
    it("rejects a staged file over MAX_JSON_UPLOAD_BYTES without reading it back", async () => {
      const padding = "x".repeat(MAX_JSON_UPLOAD_BYTES + 1 - 2); // 2 bytes for the wrapping quotes
      const json = `"${padding}"`;
      const bytes = new TextEncoder().encode(json);
      expect(bytes.length).toBe(MAX_JSON_UPLOAD_BYTES + 1);
      const put = await store.put(
        DEVICE_A,
        { name: "n.json", contentType: "application/json" },
        bytes,
      );
      if (!put.ok) throw new Error("expected ok");
      const result = await store.readJson(DEVICE_A, put.value.fileId);
      expect(result).toEqual({
        ok: false,
        text: MESSAGES.remoteImportRejected("en"),
        language: "en",
      });
      // The store must have logged the too-large category specifically —
      // not the malformed/rejected categories a downstream check would log
      // for a body that made it past the size guard.
      expect(h.logs.some((line) => line.includes("readJson:toolarge"))).toBe(true);
      expect(h.logs.some((line) => line.includes("readJson:invalid"))).toBe(false);
      expect(h.logs.some((line) => line.includes("readJson:rejected"))).toBe(false);
    });

    it("accepts a staged file at exactly MAX_JSON_UPLOAD_BYTES", async () => {
      const padding = "x".repeat(MAX_JSON_UPLOAD_BYTES - '{"a":""}'.length);
      const json = JSON.stringify({ a: padding });
      const bytes = new TextEncoder().encode(json);
      expect(bytes.length).toBeLessThanOrEqual(MAX_JSON_UPLOAD_BYTES);
      const put = await store.put(
        DEVICE_A,
        { name: "n.json", contentType: "application/json" },
        bytes,
      );
      if (!put.ok) throw new Error("expected ok");
      const result = await store.readJson(DEVICE_A, put.value.fileId);
      expect(result.ok).toBe(true);
    });

    it("rejects a value with an own __proto__ key via validateRemoteImport", async () => {
      const json = '{"__proto__":{"polluted":true}}';
      const put = await store.put(
        DEVICE_A,
        { name: "n.json", contentType: "application/json" },
        new TextEncoder().encode(json),
      );
      if (!put.ok) throw new Error("expected ok");
      const result = await store.readJson(DEVICE_A, put.value.fileId);
      expect(result).toEqual({
        ok: false,
        text: MESSAGES.remoteImportRejected("en"),
        language: "en",
      });
    });

    // [bite-proof: readJson after stop — reports not-found, never a crash]
    it("returns not-found for a file whose store has since stopped", async () => {
      const put = await store.put(
        DEVICE_A,
        { name: "n.json", contentType: "application/json" },
        new TextEncoder().encode("{}"),
      );
      if (!put.ok) throw new Error("expected ok");
      await store.stop();
      const result = await store.readJson(DEVICE_A, put.value.fileId);
      expect(result.ok).toBe(false);
    });
  });

  describe("sweep", () => {
    it("removes an expired file from disk and memory", async () => {
      const put = await store.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array(1));
      if (!put.ok) throw new Error("expected ok");
      h.setNow(put.value.expiresAt + 1);

      await store.sweep();

      expect(await store.resolve(DEVICE_A, put.value.fileId)).toBeUndefined();
      await expect(stat(join(baseDir, DEVICE_A, put.value.fileId))).rejects.toThrow();
    });

    it("leaves an unexpired file alone", async () => {
      const put = await store.put(DEVICE_A, { name: "n", contentType: "x" }, new Uint8Array(1));
      if (!put.ok) throw new Error("expected ok");
      await store.sweep();
      expect(await store.resolve(DEVICE_A, put.value.fileId)).toBeDefined();
    });

    // [bite-proof: pruneStale/sweep must never evict a pending entry — M8
    // Task 4 review carry]. Deliberately gives sweep real cleanup work for
    // the SAME device (an expired "done" entry) alongside the pending
    // one: a sweep that wrongly evicted the pending entry too would see
    // this device as empty and detach it from the store's own device map —
    // which put()'s own `ok: true` alone would never reveal (its captured
    // state reference still works even once detached); only a later
    // lookup through the public API does, which is what this actually
    // asserts.
    it("never evicts a pending (still-writing) entry, however old its reservation is, even alongside an expired entry sweep must reap", async () => {
      const already = await store.put(
        DEVICE_A,
        { name: "already-uploaded", contentType: "x" },
        new Uint8Array([9]),
      );
      if (!already.ok) throw new Error("expected ok");

      // Advance the clock before "slow" is reserved, so its own expiresAt
      // lands strictly after "already"'s — otherwise the two would share
      // the same frozen `now` and a single later `setNow` could not
      // distinguish "past already's expiry" from "past slow's".
      h.setNow(h.deps.now() + 5_000);

      h.setNextId(hexId(55));
      const putPromise = store.put(
        DEVICE_A,
        { name: "slow", contentType: "x" },
        new Uint8Array([1]),
      );
      // The reservation is set synchronously before put()'s own first
      // await, so it already exists in state.entries here — advancing the
      // clock now, before sweep runs, means sweep (not this put()'s own
      // pruneExpired, which already ran against the pre-advance clock) is
      // what reaps "already-uploaded". The target is past "already"'s
      // expiry but still at (not past) "slow"'s own, later one.
      h.setNow(already.value.expiresAt + 1);
      await store.sweep();
      const result = await putPromise;

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok");
      expect(await store.resolve(DEVICE_A, result.value.fileId)).toEqual({
        bytes: Buffer.from([1]),
        name: "slow",
        contentType: "x",
      });
      await expect(stat(join(baseDir, DEVICE_A, result.value.fileId))).resolves.toBeDefined();
      // And the expired entry really was reaped by sweep.
      expect(await store.resolve(DEVICE_A, already.value.fileId)).toBeUndefined();
    });

    // [bite-proof: sweep racing a concurrent put — Task 3 review round 1,
    // Important 2] Emptiness must be re-checked synchronously, never after
    // another await, or a put() landing during sweep's own cleanup for
    // this exact device can be silently detached from the device map — a
    // lost upload that also escapes its device's quota.
    it("a put() that lands while sweep() is still removing this device's expired file is never detached from the map", async () => {
      h.setNextId(hexId(60));
      const already = await store.put(
        DEVICE_A,
        { name: "already-uploaded", contentType: "x" },
        new Uint8Array([9]),
      );
      if (!already.ok) throw new Error("expected ok");
      h.setNow(already.value.expiresAt + 1); // expired: sweep will have a real removeFile await to do

      h.setNextId(hexId(61));
      // Neither awaited yet: sweep's synchronous prefix runs up to its own
      // `await removeFile(...)` and suspends there; put()'s synchronous
      // prefix then runs to completion, reserving into the very state
      // object sweep is mid-cleanup on, before sweep ever gets to check
      // whether that device's entries are empty.
      const sweepPromise = store.sweep();
      const putPromise = store.put(
        DEVICE_A,
        { name: "concurrent", contentType: "x" },
        new Uint8Array([1]),
      );

      await sweepPromise;
      const putResult = await putPromise;

      expect(putResult.ok).toBe(true);
      if (!putResult.ok) throw new Error("expected ok");
      expect(await store.resolve(DEVICE_A, putResult.value.fileId)).toEqual({
        bytes: Buffer.from([1]),
        name: "concurrent",
        contentType: "x",
      });
      await expect(stat(join(baseDir, DEVICE_A, putResult.value.fileId))).resolves.toBeDefined();
      expect(await store.resolve(DEVICE_A, already.value.fileId)).toBeUndefined();
    });

    // [bite-proof: sweep identity — re-review r1 residual on Important 2.
    // Deterministic by construction (a hooks.beforeRead pause right before
    // the per-device identity re-check, reached after real cleanup work
    // has already run), not a real-fs race biased by staging
    // MAX_DEVICE_UPLOAD_FILES worth of padding — M12 Task 7 (M9 T3 minor:
    // "10/10 green with the fix, 4/5 red without"). Removing the identity
    // check (`devices.get(deviceId) === state`, leaving only
    // `state.entries.size === 0`) now fails this test every time, not 4/5.]
    // A revoke() during sweep's own cleanup pause replaces this device's
    // DeviceState with a brand-new object (the next put() rebuilds it via
    // deviceState()); sweep must never delete that FRESH state out from
    // under its own in-flight put() just because it still holds the OLD,
    // now-orphaned state object under the same deviceId key — deleting by
    // key alone, instead of by object identity, would do exactly that.
    it("a revoke() followed by a put() for the same device during sweep's own cleanup pause leaves the fresh state mapped", async () => {
      // Only the *first* hook call pauses. Map iteration semantics mean
      // sweep()'s `for (const [deviceId, state] of devices)` legitimately
      // visits DEVICE_A a second time once put() re-inserts it under the
      // same key during the pause (a key deleted then re-added during an
      // in-progress Map iteration is visited again) — that second pass is
      // exactly the fresh state's own, unremarkable turn through the loop
      // and must not itself block.
      let hits = 0;
      let release: (() => void) | undefined;
      const hookedStore = createFileUploadStore({
        ...h.deps,
        hooks: {
          beforeRead: () => {
            hits += 1;
            if (hits > 1) return Promise.resolve();
            return new Promise<void>((resolve) => {
              release = resolve;
            });
          },
        },
      });

      const already = await hookedStore.put(
        DEVICE_A,
        { name: "already", contentType: "x" },
        new Uint8Array([9]),
      );
      if (!already.ok) throw new Error("expected ok");
      h.setNow(already.value.expiresAt + 1);

      // sweep()'s synchronous prefix runs its one real removeFile() await
      // to completion, then pauses at the hook — right before its own
      // post-cleanup identity re-check — still holding the OLD
      // DeviceState object from its `for (const [deviceId, state] of
      // devices)` destructuring.
      const sweepPromise = hookedStore.sweep();
      await untilCalled(() => hits);

      // revoke() runs to completion while sweep waits: bumps the OLD
      // state's generation, deletes it from `devices`, reclaims the
      // directory. put() then starts — its own reservation into a
      // brand-new DeviceState, built via deviceState(), lands in `devices`
      // synchronously before this test releases the hook.
      await hookedStore.revoke(DEVICE_A);
      const putPromise = hookedStore.put(
        DEVICE_A,
        { name: "fresh-after-revoke", contentType: "x" },
        new Uint8Array([1]),
      );
      release?.();

      await sweepPromise;
      const putResult = await putPromise;

      expect(putResult.ok).toBe(true);
      if (!putResult.ok) throw new Error("expected ok");
      expect(await hookedStore.resolve(DEVICE_A, putResult.value.fileId)).toEqual({
        bytes: Buffer.from([1]),
        name: "fresh-after-revoke",
        contentType: "x",
      });
      await expect(stat(join(baseDir, DEVICE_A, putResult.value.fileId))).resolves.toBeDefined();
      hookedStore.stop();
    });
  });

  describe("logging", () => {
    it("logs one fixed-category line per outcome, with the deviceId but never a path, name or dependency message", async () => {
      await store.put(
        DEVICE_A,
        { name: "a.json", contentType: "application/json" },
        new Uint8Array([1]),
      );
      await store.put(
        DEVICE_A,
        { name: "b", contentType: "x" },
        new Uint8Array(MAX_FILE_BYTES + 1),
      );

      expect(
        h.logs.some((line) => line.includes("file-upload: staged") && line.includes(DEVICE_A)),
      ).toBe(true);
      expect(h.logs.some((line) => line.includes("file-upload: invalid"))).toBe(true);
      for (const line of h.logs) {
        expect(line).not.toContain(baseDir);
        expect(line).not.toContain("a.json");
        expect(line).not.toContain("application/json");
      }
    });

    it("logs a category line for a failed write and a readJson outcome — never a path", async () => {
      h.setNextId(hexId(70));
      const dirPut = await store.put(
        DEVICE_A,
        { name: "n", contentType: "x" },
        new Uint8Array([1]),
      );
      if (!dirPut.ok) throw new Error("expected ok");
      const collidingPath = join(baseDir, DEVICE_A, hexId(71));
      await writeFile(collidingPath, "already here");
      h.setNextId(hexId(71));
      await store.put(DEVICE_A, { name: "collide", contentType: "x" }, new Uint8Array([2]));

      const readable = await store.readJson(
        DEVICE_A,
        dirPut.value.fileId, // not JSON — decode fails
      );
      expect(readable.ok).toBe(false);

      expect(h.logs.some((line) => line.includes("file-upload: failed:write"))).toBe(true);
      expect(h.logs.some((line) => line.startsWith("file-upload: readJson:"))).toBe(true);
      for (const line of h.logs) {
        expect(line).not.toContain(baseDir);
        expect(line).not.toContain(collidingPath);
      }
    });
  });
});

describe("createFileUploadHandler", () => {
  function stubStore(put: UploadStore["put"]): UploadStore {
    return {
      put,
      resolve: vi.fn(async () => undefined),
      readJson: vi.fn(async () => ({ ok: false, text: "n/a", language: "en" }) as const),
      revoke: vi.fn(async () => undefined),
      sweep: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
    };
  }

  const ORIGIN: RemoteOrigin = { kind: "remote", deviceId: DEVICE_A, deviceName: "Phone" };

  it("rejects an empty args array without calling store.put", async () => {
    const put = vi.fn();
    const handler = createFileUploadHandler(stubStore(put), "en");
    const result = await handler([], new Uint8Array([1]), ORIGIN);
    expect(result).toEqual({ ok: false, text: MESSAGES.fileUploadInvalid("en"), language: "en" });
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects an extra positional argument without calling store.put", async () => {
    const put = vi.fn();
    const handler = createFileUploadHandler(stubStore(put), "en");
    const meta = { name: "a", contentType: "text/plain" };
    const result = (await handler([meta, "extra"], new Uint8Array([1]), ORIGIN)) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a malformed meta without calling store.put", async () => {
    const put = vi.fn();
    const handler = createFileUploadHandler(stubStore(put), "en");
    const result = (await handler([{ name: "" }], new Uint8Array([1]), ORIGIN)) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects 0 bytes without calling store.put", async () => {
    const put = vi.fn();
    const handler = createFileUploadHandler(stubStore(put), "en");
    const meta = { name: "a", contentType: "text/plain" };
    const result = (await handler([meta], new Uint8Array(0), ORIGIN)) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects MAX_FILE_BYTES + 1 without calling store.put", async () => {
    const put = vi.fn();
    const handler = createFileUploadHandler(stubStore(put), "en");
    const meta = { name: "a", contentType: "text/plain" };
    const result = (await handler([meta], new Uint8Array(MAX_FILE_BYTES + 1), ORIGIN)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  // [bite-proof: shrink the handler's own belt-and-braces bound to
  // MAX_FILE_BYTES - 1; this exact-boundary byte count is then wrongly
  // refused before store.put is ever called]
  it("accepts exactly MAX_FILE_BYTES and calls store.put", async () => {
    const put = vi.fn(async () => ({
      ok: true as const,
      value: { fileId: hexId(2), name: "a", contentType: "text/plain", bytes: 1, expiresAt: 1 },
    }));
    const handler = createFileUploadHandler(stubStore(put), "en");
    const meta = { name: "a", contentType: "text/plain" };
    const result = (await handler([meta], new Uint8Array(MAX_FILE_BYTES), ORIGIN)) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("calls store.put with the origin's deviceId, the parsed meta and the bytes, and forwards its result", async () => {
    const put = vi.fn(async () => ({
      ok: true as const,
      value: { fileId: hexId(1), name: "a", contentType: "text/plain", bytes: 1, expiresAt: 1 },
    }));
    const handler = createFileUploadHandler(stubStore(put), "en");
    const meta = { name: "a", contentType: "text/plain" };
    const bytes = new Uint8Array([1]);

    const result = await handler([meta], bytes, ORIGIN);

    expect(put).toHaveBeenCalledWith(DEVICE_A, meta, bytes);
    expect(result).toEqual({
      ok: true,
      value: { fileId: hexId(1), name: "a", contentType: "text/plain", bytes: 1, expiresAt: 1 },
    });
  });
});
