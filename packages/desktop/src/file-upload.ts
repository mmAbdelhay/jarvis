// Private per-device file staging (M9 Task 3, spec "workspace"): the blob
// handler behind `remote:uploadFile`, and the store it stages into —
// `~/.config/jarvis/remote/uploads/<deviceId>/<fileId>`, never a
// phone-supplied name or a filename in the path (rule "Names never become
// disk paths": every file is keyed by a random 32-hex id `deps.randomId()`
// hands out, `name`/`contentType` are metadata kept in memory only).
//
// Same discipline as voice-upload.ts throughout:
//   - validate before touching disk or reserving memory (parseFileUploadMeta
//     runs before a single byte is written, quota is reserved synchronously
//     before the write's own `await` so two concurrent uploads from one
//     device can never both slip past the same check);
//   - exclusive, non-following writes (`wx` + 0600) and reads (`open` with
//     `O_NOFOLLOW` before `fstat`/read, refusing anything that is not a
//     plain file of the exact tracked size — a symlink swapped in after the
//     write, or a same-user swap for a different regular file, is treated
//     exactly like a missing file, never followed or trusted);
//   - one shared, generic failure for every reason `resolve`/`readJson`
//     cannot hand back a file (unknown id, expired, owned by another
//     device, symlink-swapped) — MESSAGES.fileUploadNotFound never lets a
//     phone tell "wrong device" apart from "gone";
//   - nothing about a rejection is ever logged with a path, a filename or a
//     dependency's own error message — only a fixed category token per
//     failure site (matching voice-upload.ts's own `logOutcome`) and this
//     module's own generic, already-localised text ever leave it.
//
// The M8 Task 4 review carry this store is built to hold: `pruneStale`
// (here, `pruneExpired`) never evicts a `pending` entry — a write still in
// flight keeps its reservation regardless of what the clock does — and a
// device's memory (not just its files) is reclaimed on `revoke`, not only
// on disconnect. `revoke`/`stop` both bump the owning device's `generation`
// *before* any cleanup runs, so a write that was already in flight when
// either fired always notices — after its own `await` returns — that its
// generation is stale, and discards what it just wrote instead of ever
// committing a record for a device whose staging tree has already been
// reclaimed. A disconnect alone touches neither: it is not one of
// `put`'s/`sweep`'s own JSDoc's triggers, precisely so an explicit retry
// after a dropped connection can still find its files within their TTL.
//
// Task 3 review round 1 (Important 1/2): cleanup on every path means every
// path — `pruneExpired`'s lazy reap now unlinks the file it drops a record
// for, not just the record, and `sweep()` re-checks a device's own
// emptiness synchronously, immediately after that device's own cleanup
// awaits (never after another device's, and never in a second pass at the
// end) — so a `put()` that reserves into a device's state during `sweep`'s
// own `removeFile` await can never be detached from `devices` out from
// under it.
//
// Task 3 review round 1 (Important 3, brief B1 "Never follow stale files
// found at startup; clean only the owned staging tree"): device/file
// ownership lives only in this process's memory, never on disk, so nothing
// left under `baseDir` by an earlier run can ever be legitimately
// reattached to a record after a restart regardless of age or shape — a
// selective "keep what still looks unexpired" reconciliation would give a
// phone no more access than a full wipe while adding a class of parsing
// bugs. `createFileUploadStore` therefore wipes `baseDir` wholesale, once,
// the moment it is constructed, before any `put()` is allowed to write into
// it — `rm(..., {recursive: true, force: true})` unlinks a symlink it
// encounters rather than following it, so this never leaves `baseDir` even
// if something has replaced an entry with one.
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import {
  FILE_TTL_MS,
  FILE_UPLOAD_SWEEP_INTERVAL_MS,
  isFileId,
  MAX_DEVICE_UPLOAD_BYTES,
  MAX_DEVICE_UPLOAD_FILES,
  MAX_FILE_BYTES,
  MAX_JSON_UPLOAD_BYTES,
  parseFileUploadMeta,
  type FileUploadMeta,
  type UploadedFile,
} from "@jarvis/wire";
import type { GitViewResult } from "./ipc.js";
import { MESSAGES } from "./messages.js";
import { validateRemoteImport } from "./remote-import-guard.js";
import type { BlobHandler } from "./remote-blob.js";

/** Store implementation/deps own every filesystem operation; only the
 *  clock and the random id generator are injected — tests point `baseDir`
 *  at a real temporary directory rather than doubling `node:fs`. `log` is
 *  the same shape as every other desktop module's: one fixed-category line
 *  per failure/outcome site, never a path or a dependency's own message. */
export type FileUploadStoreDeps = {
  now(): number;
  /** 32 lowercase hex characters — `@jarvis/wire`'s FILE_ID_PATTERN. */
  randomId(): string;
  /** `~/.config/jarvis/remote/uploads` in production. */
  baseDir: string;
  language: "ar" | "en";
  log(line: string): void;
  /** M12 Task 7 test seam only — never set in production. A real caller
   *  interleaves `resolve`/`readJson`/`sweep` with `revoke`/`stop`/`put`
   *  purely through real timing; a test that needs a *deterministic*
   *  interleave (rather than biasing a real-fs race with padding) instead
   *  hands in `beforeRead`, awaited once, right before the operation's own
   *  final post-I/O consistency check (the generation/map re-check in
   *  `resolve`/`readJson`, the emptiness/identity re-check in `sweep`) — the
   *  exact point a concurrent `revoke()`/`stop()`/`put()` needs to have
   *  already run to completion for the regression it is proving. */
  hooks?: { beforeRead?(): Promise<void> };
};

export type UploadStore = {
  put(
    deviceId: string,
    meta: FileUploadMeta,
    bytes: Uint8Array,
  ): Promise<GitViewResult<UploadedFile>>;
  resolve(
    deviceId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; name: string; contentType: string } | undefined>;
  readJson(deviceId: string, fileId: string): Promise<GitViewResult<unknown>>;
  revoke(deviceId: string): Promise<void>;
  sweep(): Promise<void>;
  /** Clears the store's own periodic sweep timer (idempotent — a second
   *  call is a no-op) and stops accepting new work. The generation bump,
   *  `stopped` flag and in-memory clearing that make every in-flight
   *  `put()`/`resolve()`/`readJson()` notice a stop happen synchronously,
   *  before this function's first `await`; the returned promise resolves
   *  once the on-disk device-directory cleanup has run (main.ts already
   *  calls this at app quit with a `.catch()` — kept `Promise<void>` so
   *  that pre-existing call keeps compiling. Runtime disable is
   *  `apply({ enabled: false })`; staged files expire by TTL under this
   *  store's own sweep, and `stop()` is called once at app quit only. */
  stop(): Promise<void>;
};

type Entry =
  | { status: "pending"; bytes: number; generation: number }
  | {
      status: "done";
      bytes: number;
      expiresAt: number;
      name: string;
      contentType: string;
      path: string;
      generation: number;
    };

type DeviceState = {
  generation: number;
  entries: Map<string, Entry>;
};

function fail(language: "ar" | "en", text: string): GitViewResult<never> {
  return { ok: false, text, language };
}

/** One line per outcome/failure site — deviceId and a byte count only,
 *  never a path, a name or a dependency's own message (same contract as
 *  voice-upload.ts's logOutcome). Never allowed to break the call that
 *  triggered it. */
function logLine(
  log: (line: string) => void,
  kind: string,
  deviceId: string,
  bytes?: number,
): void {
  try {
    log(`file-upload: ${kind} device=${deviceId}${bytes === undefined ? "" : ` bytes=${bytes}`}`);
  } catch {
    // Diagnostics can't break an upload.
  }
}

/** `lstat`-guarded — refuses to create the device directory over anything
 *  that is not already a real directory (a symlink or a plain file
 *  squatting the slot), so a device id can never be pointed somewhere else
 *  on disk by whatever happens to already exist at that path. */
async function ensureDeviceDir(baseDir: string, deviceId: string): Promise<string | undefined> {
  try {
    await mkdir(baseDir, { recursive: true, mode: 0o700 });
  } catch {
    return undefined;
  }
  const dir = join(baseDir, deviceId);
  try {
    const stat = await lstat(dir);
    return stat.isDirectory() ? dir : undefined;
  } catch {
    try {
      await mkdir(dir, { mode: 0o700 });
      return dir;
    } catch {
      return undefined;
    }
  }
}

/** `wx` + 0600: fails with EEXIST if anything — a file, a symlink, a
 *  directory — already sits at `path`, so this can never overwrite or
 *  follow whatever is already there. */
async function writeFileExclusive(path: string, bytes: Uint8Array): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (handle !== undefined) await removeFile(path);
    throw error;
  }
}

async function isSafeDeviceDir(baseDir: string, deviceDir: string): Promise<boolean> {
  try {
    const [baseStat, deviceStat, baseReal, deviceReal] = await Promise.all([
      lstat(baseDir),
      lstat(deviceDir),
      realpath(baseDir),
      realpath(deviceDir),
    ]);
    return (
      baseStat.isDirectory() &&
      deviceStat.isDirectory() &&
      (deviceReal === baseReal || deviceReal.startsWith(`${baseReal}${sep}`))
    );
  } catch {
    return false;
  }
}

/** Opens with `O_NOFOLLOW` — a symlink swapped in for a staged file is
 *  never followed, regardless of what it points to (a plain `lstat`-then-
 *  `readFile` pair leaves a TOCTOU window between the two calls; opening
 *  the handle first and `fstat`-ing *that* handle closes it). The open
 *  handle's own size is then compared against `expectedBytes` — the
 *  tracked size from `put()` — before any read, so a same-user swap for a
 *  different (larger) regular file is refused too, not just a symlink. */
async function readRegularFile(
  path: string,
  expectedBytes: number,
): Promise<Uint8Array | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expectedBytes) return undefined;
    return await handle.readFile();
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => {});
  }
}

async function removeFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    // Best effort — a removal that fails leaves an orphaned file the next
    // sweep (or, at worst, the next startup reconciliation) can still find,
    // but must never fail whatever operation triggered the cleanup.
  }
}

async function removeDeviceDir(baseDir: string, deviceId: string): Promise<void> {
  try {
    await rm(join(baseDir, deviceId), { recursive: true, force: true });
  } catch {
    // Same contract as removeFile.
  }
}

/** Brief B1: "Never follow stale files found at startup; clean only the
 *  owned staging tree." Wipes `baseDir` wholesale — see the file comment
 *  above for why a selective reconciliation would keep nothing a wipe
 *  doesn't already give up (ownership is memory-only, so nothing on disk
 *  survives a restart as a *reachable* file either way). `rm` unlinks a
 *  symlink entry rather than following it, so this stays inside `baseDir`
 *  even if something has replaced an entry there with one.
 *
 *  M12 Task 7 (M9 T3 minor, "the second-instance wipe comment says what
 *  actually happens"): `baseDir` is `~/.config/jarvis/remote/uploads` in
 *  production — a single fixed path under the user's home directory, not
 *  scoped by Electron's userData dir. main.ts does not call
 *  `app.requestSingleInstanceLock()`, so a genuinely concurrent second
 *  Jarvis process (including one deliberately started with
 *  `--user-data-dir`) constructs its own store against this exact same
 *  path — its own one-time wipe at construction really does delete the
 *  first instance's live staged uploads out from under it the moment it
 *  starts, not merely stale leftovers from a prior run. This is a real,
 *  accepted limitation of the wipe-on-construction design, not a scenario
 *  this function guards against — flagged here rather than left unsaid. */
async function reconcileStaging(baseDir: string): Promise<void> {
  try {
    await rm(baseDir, { recursive: true, force: true });
  } catch {
    // Best effort — a failed reconciliation just means the next launch
    // tries again; it must never stop the store from ever accepting a put.
  }
}

export function createFileUploadStore(deps: FileUploadStoreDeps): UploadStore {
  const devices = new Map<string, DeviceState>();
  let stopped = false;
  // Kicked off once, at construction — every put() awaits this before it
  // ever touches disk, so the very first real upload can never race the
  // wipe (and, after the first await, this is just a resolved promise).
  const staged = reconcileStaging(deps.baseDir);

  // M12 Task 7 (M9 T3 minor): a platform without O_NOFOLLOW would silently
  // fall back to an ordinary open (the `?? 0` in readRegularFile), which
  // still refuses a symlink — `lstat`-backed checks elsewhere in this file
  // (isSafeDeviceDir, ensureDeviceDir) never follow one either — but no
  // longer closes the TOCTOU window between a path check and the open
  // itself. One line, once, so that degraded posture is visible rather than
  // silent; behaviour is otherwise unchanged.
  if (fsConstants.O_NOFOLLOW === undefined) {
    try {
      deps.log("file-upload: O_NOFOLLOW unavailable, symlink refusal relies on lstat");
    } catch {
      // Diagnostics can't break construction.
    }
  }

  let sweepTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleSweep(): void {
    sweepTimer = setTimeout(() => {
      void sweep().finally(() => {
        if (!stopped) scheduleSweep();
      });
    }, FILE_UPLOAD_SWEEP_INTERVAL_MS);
    // Node only: never keeps the process (or a test run) alive on its own.
    sweepTimer.unref?.();
  }
  scheduleSweep();

  function deviceState(deviceId: string): DeviceState {
    let state = devices.get(deviceId);
    if (state === undefined) {
      state = { generation: 0, entries: new Map() };
      devices.set(deviceId, state);
    }
    return state;
  }

  /** Never evicts a `pending` entry (review carry) — only a committed
   *  `done` entry past its own `expiresAt` is ever pruned here, and its
   *  file is unlinked in the same pass (Important 1): a record dropped
   *  without its file would orphan up to 25 MiB on disk with nothing left
   *  to ever reap it. */
  function pruneExpired(state: DeviceState, now: number): void {
    for (const [fileId, entry] of state.entries) {
      if (entry.status === "done" && now > entry.expiresAt) {
        state.entries.delete(fileId);
        void removeFile(entry.path);
      }
    }
  }

  function liveTotals(state: DeviceState): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const entry of state.entries.values()) {
      count += 1;
      bytes += entry.bytes;
    }
    return { count, bytes };
  }

  /** Owner + opaque id + unexpired record, all required — anything else
   *  (unknown id, another device's id, an expired one) answers `undefined`
   *  the same way. Lazily reaps an expired record and its file the moment
   *  it is looked up, independent of the periodic `sweep()`. */
  function liveEntry(
    deviceId: string,
    fileId: string,
    now: number,
  ): Extract<Entry, { status: "done" }> | undefined {
    if (!isFileId(fileId)) return undefined;
    const state = devices.get(deviceId);
    if (state === undefined) return undefined;
    const entry = state.entries.get(fileId);
    if (entry === undefined || entry.status !== "done") return undefined;
    if (now > entry.expiresAt) {
      state.entries.delete(fileId);
      void removeFile(entry.path);
      return undefined;
    }
    return entry;
  }

  async function put(
    deviceId: string,
    meta: FileUploadMeta,
    bytes: Uint8Array,
  ): Promise<GitViewResult<UploadedFile>> {
    if (stopped) {
      logLine(deps.log, "failed:stopped", deviceId, bytes.length);
      return fail(deps.language, MESSAGES.fileUploadFailed(deps.language));
    }
    if (bytes.length < 1 || bytes.length > MAX_FILE_BYTES) {
      logLine(deps.log, "invalid", deviceId, bytes.length);
      return fail(deps.language, MESSAGES.fileUploadInvalid(deps.language));
    }

    const now = deps.now();
    const state = deviceState(deviceId);
    pruneExpired(state, now);

    const totals = liveTotals(state);
    if (
      totals.count + 1 > MAX_DEVICE_UPLOAD_FILES ||
      totals.bytes + bytes.length > MAX_DEVICE_UPLOAD_BYTES
    ) {
      logLine(deps.log, "quota", deviceId, bytes.length);
      return fail(deps.language, MESSAGES.fileUploadQuotaExceeded(deps.language));
    }

    const fileId = deps.randomId();
    const generation = state.generation;
    // Reserved synchronously — no `await` runs between the totals check
    // above and this set, so a second concurrent put() for the same device
    // always sees this reservation's bytes/count before it runs its own
    // check.
    state.entries.set(fileId, { status: "pending", bytes: bytes.length, generation });

    // Gated here, not before the reservation above: `staged` is purely a
    // disk-cleanup guard (Important 3) and must never delay the in-memory
    // reservation that makes the quota check synchronous-and-safe against a
    // concurrent put(). By the time any real launch's first upload reaches
    // this line the startup wipe is essentially always already resolved;
    // this `await` only ever actually suspends in the pathological case of
    // an upload landing in the same tick as construction (tests exercise
    // exactly that).
    await staged;

    const dir = await ensureDeviceDir(deps.baseDir, deviceId);
    if (dir === undefined || !(await isSafeDeviceDir(deps.baseDir, dir))) {
      state.entries.delete(fileId);
      logLine(deps.log, "failed:mkdir", deviceId, bytes.length);
      return fail(deps.language, MESSAGES.fileUploadFailed(deps.language));
    }

    const path = join(dir, fileId);
    try {
      await writeFileExclusive(path, bytes);
    } catch {
      state.entries.delete(fileId);
      logLine(deps.log, "failed:write", deviceId, bytes.length);
      return fail(deps.language, MESSAGES.fileUploadFailed(deps.language));
    }

    // revoke()/stop() bump `state.generation` before they clean up — if
    // either ran while the write above was in flight, this write must not
    // resurrect a file (or a record) for a staging tree that is already
    // gone.
    if (stopped || state.generation !== generation) {
      await removeFile(path);
      state.entries.delete(fileId);
      logLine(deps.log, "discarded:generation", deviceId, bytes.length);
      return fail(deps.language, MESSAGES.fileUploadFailed(deps.language));
    }

    const expiresAt = now + FILE_TTL_MS;
    state.entries.set(fileId, {
      status: "done",
      bytes: bytes.length,
      expiresAt,
      name: meta.name,
      contentType: meta.contentType,
      path,
      generation,
    });

    logLine(deps.log, "staged", deviceId, bytes.length);
    return {
      ok: true,
      value: {
        fileId,
        name: meta.name,
        contentType: meta.contentType,
        bytes: bytes.length,
        expiresAt,
      },
    };
  }

  async function resolve(
    deviceId: string,
    fileId: string,
  ): Promise<{ bytes: Uint8Array; name: string; contentType: string } | undefined> {
    const state = devices.get(deviceId);
    const generation = state?.generation;
    const entry = liveEntry(deviceId, fileId, deps.now());
    if (entry === undefined || state === undefined || generation === undefined) return undefined;
    if (!(await isSafeDeviceDir(deps.baseDir, dirname(entry.path)))) return undefined;
    const bytes = await readRegularFile(entry.path, entry.bytes);
    if (bytes === undefined) return undefined;
    // Test seam (M12 Task 7): awaited once, right here — after the real
    // disk read has already succeeded, before this function trusts it. A
    // deterministic test pauses exactly here to let a concurrent
    // revoke()/stop() run to completion first, then resumes: the check
    // right below is what must catch that, not the read having failed.
    await deps.hooks?.beforeRead?.();
    if (
      stopped ||
      devices.get(deviceId) !== state ||
      state.generation !== generation ||
      state.entries.get(fileId) !== entry ||
      deps.now() > entry.expiresAt
    ) {
      return undefined;
    }
    return { bytes, name: entry.name, contentType: entry.contentType };
  }

  async function readJson(deviceId: string, fileId: string): Promise<GitViewResult<unknown>> {
    const state = devices.get(deviceId);
    const generation = state?.generation;
    const entry = liveEntry(deviceId, fileId, deps.now());
    if (entry === undefined) {
      logLine(deps.log, "readJson:notfound", deviceId);
      return fail(deps.language, MESSAGES.fileUploadNotFound(deps.language));
    }
    // The size check runs against the record's own tracked byte count —
    // known since `put()` — before a single byte is read off disk, let
    // alone decoded or parsed.
    if (entry.bytes > MAX_JSON_UPLOAD_BYTES) {
      logLine(deps.log, "readJson:toolarge", deviceId, entry.bytes);
      return fail(deps.language, MESSAGES.remoteImportRejected(deps.language));
    }

    if (
      state === undefined ||
      generation === undefined ||
      !(await isSafeDeviceDir(deps.baseDir, dirname(entry.path)))
    ) {
      logLine(deps.log, "readJson:notfound", deviceId, entry.bytes);
      return fail(deps.language, MESSAGES.fileUploadNotFound(deps.language));
    }
    const raw = await readRegularFile(entry.path, entry.bytes);
    // Test seam — see the identical comment in resolve().
    await deps.hooks?.beforeRead?.();
    if (
      raw === undefined ||
      stopped ||
      devices.get(deviceId) !== state ||
      state.generation !== generation ||
      state.entries.get(fileId) !== entry ||
      deps.now() > entry.expiresAt
    ) {
      logLine(deps.log, "readJson:notfound", deviceId, entry.bytes);
      return fail(deps.language, MESSAGES.fileUploadNotFound(deps.language));
    }

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    } catch {
      logLine(deps.log, "readJson:invalid", deviceId, entry.bytes);
      return fail(deps.language, MESSAGES.remoteImportRejected(deps.language));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      logLine(deps.log, "readJson:invalid", deviceId, entry.bytes);
      return fail(deps.language, MESSAGES.remoteImportRejected(deps.language));
    }

    if (!validateRemoteImport(parsed)) {
      logLine(deps.log, "readJson:rejected", deviceId, entry.bytes);
      return fail(deps.language, MESSAGES.remoteImportRejected(deps.language));
    }

    logLine(deps.log, "readJson:ok", deviceId, entry.bytes);
    return { ok: true, value: parsed };
  }

  async function revoke(deviceId: string): Promise<void> {
    const state = devices.get(deviceId);
    // M12 Task 7 (M9 T3 minor): no early return when `state` is already
    // gone (a sweep() already reclaimed the last of this device's live
    // entries, or a previous revoke()/stop() already ran) — the device
    // directory itself is swept unconditionally below, since a device with
    // no in-memory record can still have a directory on disk (removeDir is
    // `force: true`, so sweeping an already-empty/missing one is a no-op).
    if (state !== undefined) {
      // Invalidate before cleanup: any put() already past its write for
      // this device now sees a stale generation once its own await
      // returns.
      state.generation += 1;
      devices.delete(deviceId);
    }
    await removeDeviceDir(deps.baseDir, deviceId);
    logLine(deps.log, "revoked", deviceId);
  }

  async function sweep(): Promise<void> {
    const now = deps.now();
    for (const [deviceId, state] of devices) {
      const expiredIds: string[] = [];
      for (const [fileId, entry] of state.entries) {
        if (entry.status === "done" && now > entry.expiresAt) expiredIds.push(fileId);
      }
      for (const fileId of expiredIds) {
        const entry = state.entries.get(fileId);
        state.entries.delete(fileId);
        if (entry?.status === "done") await removeFile(entry.path);
      }
      // Test seam (M12 Task 7) — see the identical comment in resolve():
      // awaited once, right here, after this device's own cleanup awaits
      // above have already run, before the identity re-check right below
      // trusts `state`/`devices`.
      await deps.hooks?.beforeRead?.();
      // Re-checked synchronously, right here — immediately after this
      // device's own cleanup awaits, never after another device's, and
      // never in a second pass once every device has been walked
      // (Important 2). A put() that reserved into this exact device's
      // state during one of the `removeFile` awaits above has already set
      // its entry by the time control returns here, so `size` reflects it
      // and this device is correctly left in `devices` — the reservation
      // is never detached from the map out from under an in-flight write.
      //
      // Identity, not just key (re-review r1, residual on I2): a revoke()
      // of this exact device during one of the `removeFile` awaits above
      // replaces `devices.get(deviceId)` with a *fresh* DeviceState (a
      // subsequent put() for the same id builds a new one via
      // `deviceState()`). Deleting by key alone would then delete that
      // fresh state out from under its own in-flight put() even though
      // `state` — the stale object this loop iterated over — is what's
      // actually empty. Only delete when the map still points at the same
      // object this loop is holding.
      if (state.entries.size === 0 && devices.get(deviceId) === state) devices.delete(deviceId);
    }
  }

  // M12 Task 7: main.ts already calls `uploadStore.stop().catch(...)` at
  // app quit (a pre-existing call this task does not touch), so `stop()`
  // keeps its `Promise<void>` return — resolving once the best-effort disk
  // cleanup below has run, the same "may not finish before a fast quit"
  // gap main.ts's own comment already documents. Everything that must be
  // visible to a racing `put()`/`resolve()`/`readJson()` — the sweep timer,
  // the `stopped` flag, the generation bump, `devices.clear()` — still
  // happens synchronously, before this function's first `await`.
  async function stop(): Promise<void> {
    if (sweepTimer !== undefined) {
      clearTimeout(sweepTimer);
      sweepTimer = undefined;
    }
    if (stopped) return;
    stopped = true;
    const deviceIds = [...devices.keys()];
    for (const deviceId of deviceIds) {
      const state = devices.get(deviceId);
      if (state !== undefined) state.generation += 1;
    }
    devices.clear();
    await Promise.all(deviceIds.map((deviceId) => removeDeviceDir(deps.baseDir, deviceId)));
  }

  return { put, resolve, readJson, revoke, sweep, stop };
}

/** `remote:uploadFile`'s BlobHandler: validates the header's meta and the
 *  byte count (belt-and-braces — connection.ts's own `blobLimit` already
 *  bounds `bytes.length` to MAX_FILE_BYTES before a handler ever runs)
 *  before handing anything to the store. `origin.deviceId` — never a value
 *  from `args` — is the only owner a staged file is ever written under. */
export function createFileUploadHandler(store: UploadStore, language: "ar" | "en"): BlobHandler {
  return async (args, bytes, origin) => {
    const meta = args.length === 1 ? parseFileUploadMeta(args[0]) : undefined;
    if (meta === undefined || bytes.length < 1 || bytes.length > MAX_FILE_BYTES) {
      return fail(language, MESSAGES.fileUploadInvalid(language));
    }
    return store.put(origin.deviceId, meta, bytes);
  };
}
