// The updater: main's one owner of "is there a newer Jarvis, and install it".
// It ties the pure update modules together — check (update-check.ts), pick
// the asset (update-asset.ts), fetch SHA256SUMS and the installer
// (update-download.ts), verify (update-verify.ts), stage and swap
// (update-install-darwin.ts / update-install-linux.ts) — into one state
// machine whose every change is pushed to the renderer as an UpdateState.
//
// The user chose automatic checks: one at launch, then one every 24h while
// the app runs. The request carries no machine data and no token. Installing
// is always the user's click. Only one operation runs at a time: a check,
// a download or an install asked for while another is in flight is ignored.
// Every failure leaves the installed app untouched.

import { execFile } from "node:child_process";
import { constants as fsConstants, accessSync } from "node:fs";
import {
  chmod as fsChmod,
  copyFile as fsCopyFile,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  readdir as fsReaddir,
  rm as fsRm,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pickAsset, SUMS_NAME } from "./update-asset.js";
import { checkForUpdate, type ReleaseAsset, type UpdateCheck } from "./update-check.js";
import { downloadFile, downloadText } from "./update-download.js";
import {
  appBundleOf,
  darwinSwapScript,
  installBlocker,
  prepareDarwin,
  type Exec,
} from "./update-install-darwin.js";
import { linuxSwapScript, prepareLinux } from "./update-install-linux.js";
import { parseSums, verifyFile } from "./update-verify.js";

export type UpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "verifying"
  | "ready"
  | "installing"
  | "error";

export type UpdateError =
  | "offline"
  | "no-asset"
  | "no-sums"
  | "mismatch"
  | "download"
  | "read-only"
  | "translocated"
  | "not-appimage"
  | "dev-build"
  | "swap";

export type UpdateState = {
  phase: UpdatePhase;
  /** This app's own version. */
  current: string;
  /** The newer release's version, once one is known. */
  latest?: string;
  /** Release notes (plain text, already capped by update-check.ts). */
  notes?: string;
  /** The release page on github.com — the only link ever offered. */
  url?: string;
  /** Download progress in bytes, while downloading. */
  received?: number;
  total?: number;
  /** Set only when `phase` is "error". */
  error?: UpdateError;
  /** Epoch ms of the last successful check, for display only. */
  lastChecked?: number;
};

export type RunningCounts = { terminals: number; agents: number };

/** The file operations the updater itself does (the download is written by
 *  update-download.ts). */
export type UpdaterFs = {
  mkdir(dir: string): Promise<void>;
  readdir(dir: string): Promise<string[]>;
  /** Recursive and forced: a missing path is not an error. */
  rm(path: string): Promise<void>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  writable(dir: string): boolean;
};

export const nodeUpdaterFs: UpdaterFs = {
  mkdir: async (dir) => {
    await fsMkdir(dir, { recursive: true });
  },
  readdir: (dir) => fsReaddir(dir),
  rm: (path) => fsRm(path, { recursive: true, force: true }),
  readFile: (path) => fsReadFile(path, "utf8"),
  writeFile: (path, data) => fsWriteFile(path, data),
  copyFile: (src, dest) => fsCopyFile(src, dest),
  chmod: (path, mode) => fsChmod(path, mode),
  writable: (dir) => {
    try {
      accessSync(dir, fsConstants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/** The only programs prepareDarwin may run. */
const EXEC_ALLOWED = new Set([
  "/usr/bin/hdiutil",
  "/usr/bin/ditto",
  "/usr/bin/xattr",
  "/bin/test",
  "/bin/rm",
]);

/** prepareDarwin's real exec: execFile (no shell) of an allow-listed
 *  absolute path. A refused command rejects without running anything. */
export const nodeExec: Exec = (cmd, args) => {
  if (!EXEC_ALLOWED.has(cmd)) return Promise.reject(new Error(`refused command: ${cmd}`));
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
      resolve({ code, stdout: String(stdout) });
    });
  });
};

/** Variables an AppImage's runtime sets for its own mount; a swap script
 *  that inherited them would start the new AppImage against the old one's
 *  libraries and paths. */
const APPIMAGE_ENV = [
  "APPDIR",
  "APPIMAGE",
  "OWD",
  "ARGV0",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "PYTHONHOME",
  "PYTHONPATH",
  "GSETTINGS_SCHEMA_DIR",
];

/** The environment the detached swap script runs with. */
export function swapEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const copy = { ...env };
  if (platform === "linux") for (const name of APPIMAGE_ENV) delete copy[name];
  return copy;
}

/** A release version Jarvis will build a file path from: `1.2.3` or
 *  `1.2.3-beta.1`, nothing else. */
const SAFE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Bounds the API check and the SHA256SUMS fetch, which are small. */
const SMALL_REQUEST_TIMEOUT_MS = 30_000;
/** Progress pushes during a download are at most this often. */
const PROGRESS_EVERY_MS = 200;

const STATE_FILE = "state.json";
const SWAP_FILE = "swap.sh";

export type UpdaterDeps = {
  current: string;
  /** app.isPackaged. An unpackaged run installs only into JARVIS_UPDATE_BUNDLE:
   *  its own bundle is node_modules' Electron.app. */
  packaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  pid: number;
  execPath: string;
  /** The running AppImage's own file (Linux), when running as one. */
  appImage?: string;
  /** Development override of the macOS bundle to replace
   *  (JARVIS_UPDATE_BUNDLE, honoured only when not packaged). */
  bundle?: string;
  /** Development override of the swap script's relaunch command
   *  (JARVIS_UPDATE_LAUNCH, honoured only when not packaged). */
  launch?: string;
  userData: string;
  /** The releases API; undefined means GitHub's (update-check.ts). */
  api?: string;
  /** Development override for a local release server's downloads. */
  testOrigin?: string;
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  fs: UpdaterFs;
  exec: Exec;
  spawnDetached(cmd: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }): void;
  /** Windows: hands the verified installer to the OS (shell.openPath). */
  openPath(path: string): Promise<string>;
  quit(): void;
  runningCounts(): Promise<RunningCounts>;
  push(state: UpdateState): void;
};

export type Updater = {
  /** Clears stale downloads, checks once, then every 24h. */
  start(): Promise<void>;
  /** Clears the timer and aborts a download (app quit). */
  stop(): void;
  checkNow(): Promise<UpdateState>;
  download(): Promise<UpdateState>;
  cancel(): Promise<UpdateState>;
  counts(): Promise<RunningCounts>;
  install(): Promise<UpdateState>;
  state(): UpdateState;
};

/** Phases the daily background re-check leaves alone. */
const QUIET_RECHECK: ReadonlySet<UpdatePhase> = new Set([
  "downloading",
  "verifying",
  "ready",
  "installing",
]);

type Release = { latest: string; url: string; notes: string; assets: ReleaseAsset[] };

const BUSY: ReadonlySet<UpdatePhase> = new Set([
  "checking",
  "downloading",
  "verifying",
  "installing",
]);

export function createUpdater(deps: UpdaterDeps): Updater {
  const dir = join(deps.userData, "updates");
  let state: UpdateState = { phase: "idle", current: deps.current };
  let release: Release | undefined;
  let asset: ReleaseAsset | undefined;
  let readyFile: string | undefined;
  let abort: AbortController | undefined;
  let timer: unknown;
  let stopped = false;

  const set = (next: UpdateState): UpdateState => {
    state = next;
    deps.push({ ...state });
    return { ...state };
  };
  const base = (): UpdateState => ({
    phase: "idle",
    current: deps.current,
    ...(state.lastChecked === undefined ? {} : { lastChecked: state.lastChecked }),
    ...(release === undefined
      ? {}
      : { latest: release.latest, url: release.url, notes: release.notes }),
  });
  const fail = (error: UpdateError): UpdateState => set({ ...base(), phase: "error", error });

  /** A fetch whose requests give up after 30s unless the caller set a signal. */
  const boundedFetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    deps.fetch(input, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(SMALL_REQUEST_TIMEOUT_MS),
    })) as typeof fetch;

  /** Removes everything in the updates dir except the last-checked record. */
  async function clearDownloads(): Promise<void> {
    let names: string[];
    try {
      names = await deps.fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name !== STATE_FILE) await deps.fs.rm(join(dir, name)).catch(() => undefined);
    }
  }

  async function readLastChecked(): Promise<number | undefined> {
    try {
      const parsed = JSON.parse(await deps.fs.readFile(join(dir, STATE_FILE))) as unknown;
      const value = (parsed as { lastChecked?: unknown } | null)?.lastChecked;
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    } catch {
      return undefined;
    }
  }

  async function writeLastChecked(at: number): Promise<void> {
    try {
      await deps.fs.mkdir(dir);
      await deps.fs.writeFile(join(dir, STATE_FILE), JSON.stringify({ lastChecked: at }));
    } catch {
      // Display only: a failed write costs nothing but the label.
    }
  }

  /** What would stop the install on this machine, known before a byte is
   *  downloaded: an unpackaged run with nothing to install into, a
   *  translocated or unwritable macOS bundle, or a Linux run that is not an
   *  AppImage or whose AppImage sits in a read-only folder. Downloading the
   *  whole build only to fail at Install would waste it. */
  function blocker(): UpdateError | undefined {
    // Linux needs an AppImage, which an unpackaged run is not unless the
    // developer set APPIMAGE on purpose; that case stays as it was.
    if (!deps.packaged && deps.bundle === undefined && deps.platform !== "linux") {
      return "dev-build";
    }
    if (deps.platform === "darwin") {
      const bundle = deps.bundle ?? appBundleOf(deps.execPath);
      // No bundle at all is a swap failure, reported at install as before.
      return bundle === undefined
        ? undefined
        : installBlocker(bundle, (path) => deps.fs.writable(path));
    }
    if (deps.platform === "linux") {
      if (deps.appImage === undefined || deps.appImage === "") return "not-appimage";
      if (!deps.fs.writable(dirname(deps.appImage))) return "read-only";
    }
    return undefined;
  }

  async function checkNow(): Promise<UpdateState> {
    if (BUSY.has(state.phase)) return { ...state };
    const before = state.phase;
    set({ ...state, phase: "checking" });
    const result: UpdateCheck = await checkForUpdate({
      current: deps.current,
      ...(deps.api === undefined ? {} : { api: deps.api }),
      fetch: (url, init) => boundedFetch(url, init),
    });
    if (result.kind === "failed") {
      // A background re-check that fails must not take away an install
      // the user can still make.
      if (before === "available" || before === "ready") return set({ ...state, phase: before });
      return set({ ...base(), phase: "error", error: "offline" });
    }
    const at = deps.now();
    state = { ...state, lastChecked: at };
    void writeLastChecked(at);
    if (result.kind === "current") {
      release = undefined;
      asset = undefined;
      readyFile = undefined;
      return set({ ...base(), phase: "current" });
    }
    if (!SAFE_VERSION.test(result.latest)) {
      // Never build a path from it; offer the release page only.
      release = undefined;
      asset = undefined;
      readyFile = undefined;
      return set({ ...base(), phase: "error", error: "no-asset", url: result.url });
    }
    const sameRelease = release?.latest === result.latest;
    release = {
      latest: result.latest,
      url: result.url,
      notes: result.notes,
      assets: result.assets,
    };
    asset = pickAsset(result.assets, result.latest, deps.platform, deps.arch, {
      ...(deps.testOrigin === undefined ? {} : { testOrigin: deps.testOrigin }),
    });
    if (asset === undefined) {
      readyFile = undefined;
      return fail("no-asset");
    }
    const blocked = blocker();
    if (blocked !== undefined) {
      readyFile = undefined;
      return fail(blocked);
    }
    if (sameRelease && readyFile !== undefined) return set({ ...base(), phase: "ready" });
    readyFile = undefined;
    return set({ ...base(), phase: "available" });
  }

  async function download(): Promise<UpdateState> {
    if (BUSY.has(state.phase) || state.phase === "ready") return { ...state };
    const chosen = asset;
    const rel = release;
    if (chosen === undefined || rel === undefined) return { ...state };
    const blocked = blocker();
    if (blocked !== undefined) return fail(blocked);
    // The download clears the updates dir, so an earlier verified file is gone.
    readyFile = undefined;
    const controller = new AbortController();
    abort = controller;
    set({ ...base(), phase: "downloading", received: 0, total: chosen.size });
    try {
      await deps.fs.mkdir(dir);
      await clearDownloads();
      const sumsAsset = rel.assets.find((candidate) => candidate.name === SUMS_NAME);
      if (sumsAsset === undefined) return fail("no-sums");
      const sumsText = await downloadText(sumsAsset.url, boundedFetch, {
        ...(deps.testOrigin === undefined ? {} : { testOrigin: deps.testOrigin }),
      });
      if (controller.signal.aborted) return set({ ...base(), phase: "available" });
      if (sumsText === undefined) return fail("download");
      const expected = parseSums(sumsText).get(chosen.name);
      if (expected === undefined) return fail("no-sums");

      const dest = join(dir, basename(chosen.name));
      let lastPush = deps.now();
      const result = await downloadFile({
        url: chosen.url,
        dest,
        expectedSize: chosen.size,
        signal: controller.signal,
        fetch: deps.fetch,
        ...(deps.testOrigin === undefined ? {} : { testOrigin: deps.testOrigin }),
        onProgress: (received, total) => {
          state = { ...state, received, ...(total === undefined ? {} : { total }) };
          const now = deps.now();
          if (now - lastPush >= PROGRESS_EVERY_MS || received === total) {
            lastPush = now;
            deps.push({ ...state });
          }
        },
      });
      if (!result.ok) {
        if (result.reason === "aborted") return set({ ...base(), phase: "available" });
        return fail("download");
      }

      set({ ...base(), phase: "verifying" });
      let matches: boolean;
      try {
        matches = await verifyFile(dest, expected);
      } catch {
        await deps.fs.rm(dest).catch(() => undefined);
        return fail("download");
      }
      if (!matches) {
        await deps.fs.rm(dest).catch(() => undefined);
        return fail("mismatch");
      }
      readyFile = dest;
      return set({ ...base(), phase: "ready" });
    } catch {
      return fail("download");
    } finally {
      if (abort === controller) abort = undefined;
    }
  }

  async function cancel(): Promise<UpdateState> {
    if (state.phase === "downloading") abort?.abort();
    return { ...state };
  }

  /** Writes the swap script, starts it detached and quits. */
  async function spawnSwap(script: string): Promise<void> {
    const file = join(dir, SWAP_FILE);
    await deps.fs.writeFile(file, script);
    deps.spawnDetached("/bin/sh", [file], { cwd: dir, env: swapEnv(deps.env, deps.platform) });
  }

  async function installDarwin(file: string): Promise<UpdateState> {
    const bundle = deps.bundle ?? appBundleOf(deps.execPath);
    // install() has already checked the blockers.
    if (bundle === undefined) return fail("swap");
    const prepared = await prepareDarwin({ dmg: file, bundle, workDir: dir, exec: deps.exec });
    if (!prepared.ok) return fail("swap");
    await spawnSwap(
      darwinSwapScript({
        pid: deps.pid,
        bundle,
        staged: prepared.staged,
        ...(deps.launch === undefined ? {} : { launch: deps.launch }),
      }),
    );
    deps.quit();
    return { ...state };
  }

  async function installLinux(file: string): Promise<UpdateState> {
    const prepared = await prepareLinux({
      file,
      appImage: deps.appImage,
      copy: (src, dest) => deps.fs.copyFile(src, dest),
      chmod: (path, mode) => deps.fs.chmod(path, mode),
      remove: (path) => deps.fs.rm(path),
      writable: (path) => deps.fs.writable(path),
    });
    if (!prepared.ok) {
      if (prepared.reason === "io") return fail("swap");
      return fail(prepared.reason);
    }
    const appImage = deps.appImage as string;
    try {
      await spawnSwap(linuxSwapScript({ pid: deps.pid, appImage, staged: prepared.staged }));
    } catch (error) {
      await deps.fs.rm(prepared.staged).catch(() => undefined);
      throw error;
    }
    deps.quit();
    return { ...state };
  }

  async function install(): Promise<UpdateState> {
    const file = readyFile;
    if (state.phase !== "ready" || file === undefined) return { ...state };
    // The folder may have changed since the download (moved, made read-only).
    const blocked = blocker();
    if (blocked !== undefined) return fail(blocked);
    set({ ...base(), phase: "installing" });
    try {
      if (deps.platform === "darwin") return await installDarwin(file);
      if (deps.platform === "linux") return await installLinux(file);
      if (deps.platform === "win32") {
        const failure = await deps.openPath(file);
        if (failure !== "") return fail("swap");
        return set({ ...base(), phase: "ready" });
      }
      return fail("no-asset");
    } catch {
      return fail("swap");
    }
  }

  function arm(): void {
    if (stopped) return;
    timer = deps.setTimer(() => {
      timer = undefined;
      // Never under a download or a pending install: the check would push
      // "checking" and take the confirm away from the user.
      if (QUIET_RECHECK.has(state.phase)) {
        arm();
        return;
      }
      void checkNow().finally(arm);
    }, CHECK_INTERVAL_MS);
  }

  return {
    async start() {
      const lastChecked = await readLastChecked();
      if (lastChecked !== undefined) state = { ...state, lastChecked };
      await clearDownloads();
      if (stopped) return;
      await checkNow();
      arm();
    },
    stop() {
      stopped = true;
      if (timer !== undefined) deps.clearTimer(timer);
      timer = undefined;
      abort?.abort();
    },
    checkNow,
    download,
    cancel,
    counts: () => deps.runningCounts(),
    install,
    state: () => ({ ...state }),
  };
}

/** Development overrides, read only from an unpackaged run:
 *  JARVIS_UPDATE_API points the check at a local release server (whose
 *  origin then also passes the download allow-list), and
 *  JARVIS_UPDATE_BUNDLE names a scratch macOS bundle to replace, and
 *  JARVIS_UPDATE_LAUNCH replaces the swap script's `open` relaunch. */
export type DevOverrides = { api?: string; testOrigin?: string; bundle?: string; launch?: string };

export function devOverrides(env: NodeJS.ProcessEnv, packaged: boolean): DevOverrides {
  if (packaged) return {};
  const out: DevOverrides = {};
  const api = env["JARVIS_UPDATE_API"];
  if (api !== undefined && api !== "") {
    try {
      const origin = new URL(api).origin;
      out.api = api;
      if (origin !== "null") out.testOrigin = origin;
    } catch {
      // Not a URL: ignored, the real API is used.
    }
  }
  const bundle = env["JARVIS_UPDATE_BUNDLE"];
  if (bundle !== undefined && bundle !== "") out.bundle = bundle;
  const launch = env["JARVIS_UPDATE_LAUNCH"];
  if (launch !== undefined && launch !== "") out.launch = launch;
  return out;
}

const LIVE_SESSION: ReadonlySet<string> = new Set(["starting", "running", "waiting"]);

/** Sends the updater's state to a page each time it finishes loading, so a
 *  reloaded renderer (the menu's Reload, or a daemon-mode switch) draws the
 *  Updates card again instead of waiting for a push that may never come. */
export function replayStateOnLoad(
  page: { on(event: "did-finish-load", listener: () => void): unknown },
  updater: Pick<Updater, "state">,
  push: (state: UpdateState) => void,
): void {
  page.on("did-finish-load", () => push(updater.state()));
}

/** What a restart would end, from the core's existing answers: the
 *  workspace's terminal tabs, each tab's panes (terminal:panes) and the
 *  session list (sessions:list). Exited panes and ended sessions do not
 *  count; a failed lookup counts as none. */
export async function countRunning(source: {
  terminalTabs(): string[];
  panes(tabId: string): Promise<unknown>;
  sessions(): Promise<unknown>;
}): Promise<RunningCounts> {
  const lists = await Promise.all(
    source.terminalTabs().map((tabId) => source.panes(tabId).catch(() => [])),
  );
  let terminals = 0;
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const pane of list as unknown[]) {
      if (
        typeof pane === "object" &&
        pane !== null &&
        (pane as { exited?: unknown }).exited === false
      ) {
        terminals += 1;
      }
    }
  }
  const sessions = await source.sessions().catch(() => []);
  const agents = Array.isArray(sessions)
    ? (sessions as unknown[]).filter((session) => {
        const value = (session as { state?: unknown } | null)?.state;
        return typeof value === "string" && LIVE_SESSION.has(value);
      }).length
    : 0;
  return { terminals, agents };
}
