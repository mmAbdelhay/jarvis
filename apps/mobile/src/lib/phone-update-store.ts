// The phone updater: checks GitHub releases, downloads the APK with
// progress, verifies its SHA-256 against the release's SHA256SUMS, and
// hands only a verified file to Android's installer. Pure: every platform
// piece (network, files, installer, timers, app state) comes in as deps,
// built by phone-update-platform(.web).ts.
//
// Rules (task-3-brief.md):
// - canInstall only on Android; elsewhere update() is a no-op.
// - One operation at a time: check() and update() are ignored while a
//   check, download or verify runs (Update tapped twice → one download).
// - A failed or unreadable verify deletes the file; the installer is never
//   called with anything that did not just hash to the SUMS line.
// - In "ready", update() re-verifies the kept file and re-opens the
//   installer (after "Allow installs from Jarvis"); a missing file is
//   downloaded again.
// - start() deletes stale jarvis-mobile-*.apk files (a download killed with
//   the app), checks once, then every 24 h and on foreground after 24 h.
import { isReleaseDownloadUrl, parseReleaseList, parseSums, type ReleaseAsset } from "@jarvis/wire";
import {
  CHECK_EVERY_MS,
  cachePath,
  FETCH_TIMEOUT_MS,
  isUpdateFileName,
  progressFraction,
  RELEASES_HEADERS,
  RELEASES_URL,
  sha256Hex,
} from "./phone-update";
import type { PhoneUpdateStore, PhoneUpdateView, UpdateState } from "./phone-update-types";

export type FetchResponse = {
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
};

export type PhoneUpdateDeps = {
  /** `Platform.OS`; only "android" can install. */
  platform: string;
  /** The installed app version. */
  current: string;
  fetch(url: string, init?: { headers?: Record<string, string> }): Promise<FetchResponse>;
  /** Downloads `url` to `dest` (a cache path), reporting bytes as it goes. */
  download(
    url: string,
    dest: string,
    onProgress: (written: number, total: number) => void,
  ): Promise<void>;
  /** The file's bytes in bounded chunks; throws when it cannot be read. */
  readChunks(path: string): AsyncIterable<Uint8Array>;
  fileExists(path: string): boolean;
  /** Never throws. */
  deleteFile(path: string): void;
  /** File names directly inside `cacheDir`. */
  listCache(): string[];
  cacheDir: string;
  /** Opens Android's install screen for the file; rejects if it cannot. */
  openInstaller(path: string): Promise<void>;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** Calls `fn` each time the app comes to the foreground; returns the unsubscribe. */
  onForeground(fn: () => void): () => void;
  /** Category tokens only — never URLs or paths. */
  log(token: string): void;
};

type Release = { version: string; apk: ReleaseAsset; sums: ReleaseAsset };

class Timeout extends Error {}

export function createPhoneUpdateStore(deps: PhoneUpdateDeps): PhoneUpdateStore {
  const canInstall = deps.platform === "android";
  const listeners = new Set<(view: PhoneUpdateView) => void>();
  let state: UpdateState = { kind: "idle" };
  let release: Release | undefined;
  /** The file that last verified for `release`, kept for an installer retry. */
  let verifiedPath: string | undefined;
  let busy = false;
  let lastCheckAt: number | undefined;
  let started = false;
  let interval: unknown;
  let stopForeground: (() => void) | undefined;

  function view(): PhoneUpdateView {
    return { state, current: deps.current, canInstall };
  }

  function set(next: UpdateState): void {
    state = next;
    const snapshot = view();
    for (const listener of [...listeners]) listener(snapshot);
  }

  function withTimeout<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = deps.setTimeout(() => reject(new Timeout()), FETCH_TIMEOUT_MS);
      work.then(
        (value) => {
          deps.clearTimeout(handle);
          resolve(value);
        },
        (error: unknown) => {
          deps.clearTimeout(handle);
          reject(error);
        },
      );
    });
  }

  async function check(): Promise<void> {
    if (busy) return;
    busy = true;
    lastCheckAt = deps.now();
    set({ kind: "checking" });
    try {
      const raw = await withTimeout(
        deps.fetch(RELEASES_URL, { headers: RELEASES_HEADERS }).then((response) => {
          if (!response.ok) throw new Error("status");
          return response.json();
        }),
      );
      const result = parseReleaseList(raw, deps.current);
      if (result.kind === "failed") throw new Error("parse");
      if (result.kind === "current") {
        release = undefined;
        verifiedPath = undefined;
        set({ kind: "current", checkedAt: deps.now() });
        return;
      }
      if (release?.version !== result.version) verifiedPath = undefined;
      release = { version: result.version, apk: result.apk, sums: result.sums };
      set({ kind: "available", version: result.version, notes: result.notes });
    } catch {
      deps.log("check-failed");
      set({ kind: "failed", reason: "offline" });
    } finally {
      busy = false;
    }
  }

  /** The SUMS hash for the APK; undefined when SUMS has no line for it. */
  async function expectedHash(target: Release): Promise<string | undefined> {
    const { sums, apk, version } = target;
    if (!isReleaseDownloadUrl(sums.url, version, "SHA256SUMS")) return undefined;
    const text = await withTimeout(
      deps.fetch(sums.url).then((response) => {
        if (!response.ok) throw new Error("status");
        return response.text();
      }),
    );
    return parseSums(text).get(apk.name);
  }

  async function hashMatches(path: string, expected: string): Promise<boolean> {
    try {
      return (await sha256Hex(deps.readChunks(path))) === expected;
    } catch {
      return false;
    }
  }

  async function update(): Promise<void> {
    if (!canInstall || busy || release === undefined) return;
    const target = release;
    const { version, apk } = target;
    busy = true;
    try {
      const path = cachePath(deps.cacheDir, apk.name);
      let expected: string | undefined;
      try {
        expected = await expectedHash(target);
      } catch {
        deps.log("sums-failed");
        set({ kind: "failed", reason: "download", version });
        return;
      }
      if (expected === undefined) {
        deps.log("sums-missing");
        set({ kind: "failed", reason: "checksum", version });
        return;
      }

      const reuse = verifiedPath === path && deps.fileExists(path);
      if (!reuse) {
        verifiedPath = undefined;
        if (!isReleaseDownloadUrl(apk.url, version, apk.name)) {
          set({ kind: "failed", reason: "download", version });
          return;
        }
        deps.deleteFile(path);
        set({ kind: "downloading", version, progress: 0 });
        let shown = 0;
        try {
          await deps.download(apk.url, path, (written, total) => {
            const fraction = progressFraction(written, total, apk.size);
            if (fraction <= shown) return;
            shown = fraction;
            set({ kind: "downloading", version, progress: fraction });
          });
        } catch {
          deps.log("download-failed");
          deps.deleteFile(path);
          set({ kind: "failed", reason: "download", version });
          return;
        }
      }

      set({ kind: "verifying", version });
      if (!(await hashMatches(path, expected))) {
        deps.log("checksum-failed");
        verifiedPath = undefined;
        deps.deleteFile(path);
        set({ kind: "failed", reason: "checksum", version });
        return;
      }
      verifiedPath = path;
      set({ kind: "ready", version });
      try {
        await deps.openInstaller(path);
      } catch {
        deps.log("install-failed");
        set({ kind: "failed", reason: "install", version });
      }
    } finally {
      busy = false;
    }
  }

  function start(): void {
    if (started) return;
    started = true;
    for (const name of deps.listCache()) {
      if (isUpdateFileName(name)) deps.deleteFile(cachePath(deps.cacheDir, name));
    }
    interval = deps.setInterval(() => void check(), CHECK_EVERY_MS);
    stopForeground = deps.onForeground(() => {
      if (lastCheckAt === undefined || deps.now() - lastCheckAt >= CHECK_EVERY_MS) void check();
    });
    void check();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    deps.clearInterval(interval);
    stopForeground?.();
    stopForeground = undefined;
  }

  return {
    get: view,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    check,
    update,
    start,
    stop,
  };
}
