import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CHECK_EVERY_MS, FETCH_TIMEOUT_MS, RELEASES_URL } from "./phone-update";
import { createPhoneUpdateStore, type PhoneUpdateDeps } from "./phone-update-store";
import type { UpdateState } from "./phone-update-types";

const CACHE = "file:///cache/";
const BASE = "https://github.com/mmAbdelhay/jarvis/releases";
const APK_BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
// sha256 of the bytes 1..10
const APK_HASH = "c848e1013f9f04a9d63fa43ce7fd4af035152c7c669a4a404b67107cee5f2e4e";

type ReleaseOpts = { apk?: boolean; sums?: boolean; draft?: boolean; prerelease?: boolean };

function release(tag: string, opts: ReleaseOpts = {}): Record<string, unknown> {
  const version = tag.replace(/^v/, "");
  const assets: unknown[] = [];
  if (opts.apk !== false) {
    const name = `jarvis-mobile-${version}.apk`;
    assets.push({ name, browser_download_url: `${BASE}/download/v${version}/${name}`, size: 10 });
  }
  if (opts.sums !== false) {
    assets.push({
      name: "SHA256SUMS",
      browser_download_url: `${BASE}/download/v${version}/SHA256SUMS`,
      size: 100,
    });
  }
  return {
    tag_name: tag,
    html_url: `${BASE}/tag/${tag}`,
    draft: opts.draft ?? false,
    prerelease: opts.prerelease ?? false,
    body: `notes ${version}`,
    assets,
  };
}

function sumsFor(version: string, hash = APK_HASH): string {
  return `${hash}  jarvis-mobile-${version}.apk\n${"0".repeat(64)}  Jarvis-${version}.dmg\n`;
}

function response(body: unknown, ok = true) {
  return {
    ok,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  };
}

type Fake = {
  deps: PhoneUpdateDeps;
  files: Map<string, Uint8Array>;
  fetchCalls: string[];
  downloads: string[];
  installs: string[];
  deleted: string[];
  logs: string[];
  foreground: () => void;
  releases: unknown;
  sums: string;
  downloadGate?: Promise<void>;
  downloadBytes: Uint8Array;
  progress: Array<[number, number]>;
  unreadable: boolean;
  installError: boolean;
  offline: boolean;
};

function fake(platform = "android", current = "0.1.10"): Fake {
  const f: Fake = {
    files: new Map(),
    fetchCalls: [],
    downloads: [],
    installs: [],
    deleted: [],
    logs: [],
    foreground: () => {},
    releases: [release("v0.1.12")],
    sums: sumsFor("0.1.12"),
    downloadBytes: APK_BYTES,
    progress: [],
    unreadable: false,
    installError: false,
    offline: false,
    deps: undefined as unknown as PhoneUpdateDeps,
  };
  f.deps = {
    platform,
    current,
    fetch(url) {
      f.fetchCalls.push(url);
      if (f.offline) return Promise.reject(new Error("network"));
      if (url === RELEASES_URL) return Promise.resolve(response(f.releases));
      if (url.endsWith("/SHA256SUMS")) return Promise.resolve(response(f.sums));
      return Promise.resolve(response("", false));
    },
    async download(url, dest, onProgress) {
      f.downloads.push(url);
      if (f.downloadGate) await f.downloadGate;
      for (const [written, total] of f.progress) onProgress(written, total);
      f.files.set(dest, f.downloadBytes);
    },
    async *readChunks(path) {
      const bytes = f.files.get(path);
      if (bytes === undefined || f.unreadable) throw new Error("unreadable");
      for (let i = 0; i < bytes.length; i += 3) yield bytes.subarray(i, i + 3);
    },
    fileExists: (path) => f.files.has(path),
    deleteFile(path) {
      f.deleted.push(path);
      f.files.delete(path);
    },
    listCache: () => [...f.files.keys()].map((path) => path.slice(CACHE.length)),
    cacheDir: CACHE,
    openInstaller(path) {
      f.installs.push(path);
      return f.installError ? Promise.reject(new Error("no activity")) : Promise.resolve();
    },
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    onForeground(fn) {
      f.foreground = fn;
      return () => {
        f.foreground = () => {};
      };
    },
    log: (token) => f.logs.push(token),
  };
  return f;
}

const APK_PATH = `${CACHE}jarvis-mobile-0.1.12.apk`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("phone update store: check", () => {
  test("a newer release with APK and SUMS → available", async () => {
    const f = fake();
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    expect(store.get()).toEqual({
      state: { kind: "available", version: "0.1.12", notes: "notes 0.1.12" },
      current: "0.1.10",
      canInstall: true,
    });
  });

  test("RF1: newest without APK, or APK without SUMS → the older complete release", async () => {
    const f = fake();
    f.releases = [
      release("v0.1.14", { apk: false }),
      release("v0.1.13", { sums: false }),
      release("v0.1.12"),
    ];
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    expect(store.get().state).toMatchObject({ kind: "available", version: "0.1.12" });
  });

  test("RF2: draft, prerelease and malformed tags are skipped", async () => {
    const f = fake();
    f.releases = [
      release("v0.1.15", { draft: true }),
      release("v0.1.14", { prerelease: true }),
      release("latest"),
      { tag_name: 7, assets: [] },
      release("v0.1.12"),
    ];
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    expect(store.get().state).toMatchObject({ kind: "available", version: "0.1.12" });
  });

  test("nothing newer → current with the check time", async () => {
    const f = fake("android", "0.1.12");
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    expect(store.get().state).toEqual({ kind: "current", checkedAt: 1_000_000 });
  });

  test("offline, a bad status or a hung request → failed offline", async () => {
    const f = fake();
    f.offline = true;
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    expect(store.get().state).toEqual({ kind: "failed", reason: "offline" });
    expect(f.logs).toEqual(["check-failed"]);

    const g = fake();
    g.deps.fetch = () => Promise.resolve(response("", false));
    const bad = createPhoneUpdateStore(g.deps);
    await bad.check();
    expect(bad.get().state).toEqual({ kind: "failed", reason: "offline" });

    const h = fake();
    h.deps.fetch = () => new Promise(() => {});
    const hung = createPhoneUpdateStore(h.deps);
    const done = hung.check();
    expect(hung.get().state).toEqual({ kind: "checking" });
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    await done;
    expect(hung.get().state).toEqual({ kind: "failed", reason: "offline" });
  });

  test("subscribers get each view; unsubscribe stops them", async () => {
    const f = fake();
    const store = createPhoneUpdateStore(f.deps);
    const seen: string[] = [];
    const off = store.subscribe((view) => seen.push(view.state.kind));
    await store.check();
    off();
    await store.check();
    expect(seen).toEqual(["checking", "available"]);
  });
});

describe("phone update store: update", () => {
  test("download → verify → installer, with progress reported", async () => {
    const f = fake();
    f.progress = [
      [0, -1],
      [5, -1],
      [5, 10],
      [10, 10],
    ];
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    const states: UpdateState[] = [];
    store.subscribe((view) => states.push(view.state));
    await store.update();
    expect(states).toEqual([
      { kind: "downloading", version: "0.1.12", progress: 0 },
      { kind: "downloading", version: "0.1.12", progress: 0.5 },
      { kind: "downloading", version: "0.1.12", progress: 1 },
      { kind: "verifying", version: "0.1.12" },
      { kind: "ready", version: "0.1.12" },
    ]);
    expect(f.downloads).toEqual([`${BASE}/download/v0.1.12/jarvis-mobile-0.1.12.apk`]);
    expect(f.installs).toEqual([APK_PATH]);
  });

  test("RF3: checksum mismatch → file deleted, failed checksum, installer never called", async () => {
    const f = fake();
    f.sums = sumsFor("0.1.12", "a".repeat(64));
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    await store.update();
    expect(store.get().state).toEqual({ kind: "failed", reason: "checksum", version: "0.1.12" });
    expect(f.files.has(APK_PATH)).toBe(false);
    expect(f.deleted).toContain(APK_PATH);
    expect(f.installs).toEqual([]);
  });

  test("RF3: unreadable file → file deleted, failed checksum, installer never called", async () => {
    const f = fake();
    f.unreadable = true;
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    await store.update();
    expect(store.get().state).toEqual({ kind: "failed", reason: "checksum", version: "0.1.12" });
    expect(f.files.has(APK_PATH)).toBe(false);
    expect(f.installs).toEqual([]);
  });

  test("SUMS without a line for the APK → failed checksum, nothing downloaded", async () => {
    const f = fake();
    f.sums = `${"b".repeat(64)}  something-else.apk\n`;
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    await store.update();
    expect(store.get().state).toEqual({ kind: "failed", reason: "checksum", version: "0.1.12" });
    expect(f.downloads).toEqual([]);
    expect(f.installs).toEqual([]);
  });

  test("a failed download deletes the partial file → failed download", async () => {
    const f = fake();
    f.deps.download = async (_url, dest) => {
      f.files.set(dest, new Uint8Array([1]));
      throw new Error("reset");
    };
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    await store.update();
    expect(store.get().state).toEqual({ kind: "failed", reason: "download", version: "0.1.12" });
    expect(f.files.has(APK_PATH)).toBe(false);
    expect(f.installs).toEqual([]);
  });

  test("RF4: Update tapped twice, or Check during a download → one download, no check", async () => {
    const f = fake();
    let release: () => void = () => {};
    f.downloadGate = new Promise((resolve) => {
      release = resolve;
    });
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    const first = store.update();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get().state.kind).toBe("downloading");
    const fetchesBefore = f.fetchCalls.length;
    await store.update();
    await store.check();
    expect(f.fetchCalls.length).toBe(fetchesBefore);
    release();
    await first;
    expect(f.downloads.length).toBe(1);
    expect(f.installs.length).toBe(1);
    expect(store.get().state).toEqual({ kind: "ready", version: "0.1.12" });
  });

  test("ready + Update again → re-verify and re-open the installer without downloading", async () => {
    const f = fake();
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    await store.update();
    await store.update();
    expect(f.downloads.length).toBe(1);
    expect(f.installs).toEqual([APK_PATH, APK_PATH]);
    expect(store.get().state).toEqual({ kind: "ready", version: "0.1.12" });
  });

  test("ready but the file is gone → download again", async () => {
    const f = fake();
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    await store.update();
    f.files.delete(APK_PATH);
    await store.update();
    expect(f.downloads.length).toBe(2);
    expect(f.installs.length).toBe(2);
  });

  test("the installer cannot open → failed install, file kept for a retry", async () => {
    const f = fake();
    f.installError = true;
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    await store.update();
    expect(store.get().state).toEqual({ kind: "failed", reason: "install", version: "0.1.12" });
    expect(f.files.has(APK_PATH)).toBe(true);
    f.installError = false;
    await store.update();
    expect(f.downloads.length).toBe(1);
    expect(store.get().state).toEqual({ kind: "ready", version: "0.1.12" });
  });

  test("update before any release is known does nothing", async () => {
    const f = fake();
    const store = createPhoneUpdateStore(f.deps);
    await store.update();
    expect(f.fetchCalls).toEqual([]);
    expect(store.get().state).toEqual({ kind: "idle" });
  });

  test.each(["ios", "web"])("%s: canInstall false and update() is a no-op", async (platform) => {
    const f = fake(platform);
    const store = createPhoneUpdateStore(f.deps);
    await store.check();
    expect(store.get().canInstall).toBe(false);
    expect(store.get().state).toMatchObject({ kind: "available", version: "0.1.12" });
    await store.update();
    expect(f.downloads).toEqual([]);
    expect(f.installs).toEqual([]);
    expect(store.get().state.kind).toBe("available");
  });
});

describe("phone update store: start/stop", () => {
  test("RF5: start after a kill mid-download deletes stale APKs only, then checks clean", async () => {
    const f = fake();
    f.files.set(`${CACHE}jarvis-mobile-0.1.12.apk`, new Uint8Array([9, 9]));
    f.files.set(`${CACHE}jarvis-mobile-0.1.11.apk`, new Uint8Array([9]));
    f.files.set(`${CACHE}prefs.json`, new Uint8Array([1]));
    const store = createPhoneUpdateStore(f.deps);
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect([...f.files.keys()]).toEqual([`${CACHE}prefs.json`]);
    expect(store.get().state).toMatchObject({ kind: "available", version: "0.1.12" });
    await store.update();
    expect(f.downloads.length).toBe(1);
    expect(f.installs).toEqual([APK_PATH]);
    store.stop();
  });

  test("checks at start, every 24 h, and on foreground only after 24 h; stop ends both", async () => {
    const f = fake();
    const store = createPhoneUpdateStore(f.deps);
    const releaseChecks = () => f.fetchCalls.filter((url) => url === RELEASES_URL).length;
    store.start();
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseChecks()).toBe(1);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 1000);
    f.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseChecks()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(releaseChecks()).toBe(2);
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 1);
    f.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseChecks()).toBe(2);
    vi.setSystemTime(Date.now() + 10);
    f.foreground();
    await vi.advanceTimersByTimeAsync(0);
    expect(releaseChecks()).toBe(3);
    store.stop();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 3);
    f.foreground();
    expect(releaseChecks()).toBe(3);
  });
});
