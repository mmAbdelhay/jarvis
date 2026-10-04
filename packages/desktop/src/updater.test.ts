import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHECK_INTERVAL_MS,
  createUpdater,
  legacyCheck,
  countRunning,
  devOverrides,
  nodeExec,
  nodeUpdaterFs,
  swapEnv,
  type UpdaterDeps,
  type UpdateState,
} from "./updater.js";

const API = "https://api.github.com/repos/mmAbdelhay/jarvis/releases/latest";
const BASE = "https://github.com/mmAbdelhay/jarvis/releases/download/v0.1.9/";
const PAGE = "https://github.com/mmAbdelhay/jarvis/releases/tag/v0.1.9";
const DMG = "Jarvis-0.1.9-arm64.dmg";
const APPIMAGE = "Jarvis-0.1.9.AppImage";
const PAYLOAD = "the installer bytes";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type Route = () => Response | Promise<Response>;

let root: string;
let userData: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jarvis-updater-"));
  userData = join(root, "userData");
  mkdirSync(userData);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function release(opts: { tag?: string; names?: string[]; sums?: boolean } = {}) {
  const names = opts.names ?? [DMG, APPIMAGE];
  const assets = names.map((name) => ({
    name,
    browser_download_url: `${BASE}${name}`,
    size: PAYLOAD.length,
  }));
  if (opts.sums !== false) {
    assets.push({ name: "SHA256SUMS", browser_download_url: `${BASE}SHA256SUMS`, size: 10 });
  }
  return { tag_name: opts.tag ?? "v0.1.9", html_url: PAGE, body: "Fixes.", assets };
}

function harness(overrides: Partial<UpdaterDeps> = {}, routes: Record<string, Route> = {}) {
  const table: Record<string, Route> = {
    [API]: () => Response.json(release()),
    [`${BASE}SHA256SUMS`]: () =>
      new Response(`${sha(PAYLOAD)}  ${DMG}\n${sha(PAYLOAD)}  ${APPIMAGE}\n`),
    [`${BASE}${DMG}`]: () => new Response(PAYLOAD),
    [`${BASE}${APPIMAGE}`]: () => new Response(PAYLOAD),
    ...routes,
  };
  const calls: string[] = [];
  const fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const route = table[url];
    return route === undefined ? new Response("no", { status: 404 }) : route();
  }) as typeof globalThis.fetch;
  let clock = 1_000_000;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const pushed: UpdateState[] = [];
  const deps: UpdaterDeps = {
    current: "0.1.8",
    platform: "darwin",
    arch: "arm64",
    pid: 4242,
    execPath: join(root, "Apps", "Jarvis.app", "Contents", "MacOS", "Jarvis"),
    userData,
    env: { PATH: "/usr/bin" },
    fetch,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id as number),
    fs: nodeUpdaterFs,
    exec: vi.fn(async (cmd: string, args: string[]) => {
      if (cmd.endsWith("hdiutil") && args[0] === "attach") {
        return {
          code: 0,
          stdout: "<plist><key>mount-point</key><string>/Volumes/Jarvis</string></plist>",
        };
      }
      return { code: 0, stdout: "" };
    }),
    spawnDetached: vi.fn(),
    openPath: vi.fn(async () => ""),
    quit: vi.fn(),
    runningCounts: vi.fn(async () => ({ terminals: 3, agents: 2 })),
    push: (state) => pushed.push(state),
    ...overrides,
  };
  const updater = createUpdater(deps);
  return {
    updater,
    deps,
    calls,
    pushed,
    timers,
    advance: (ms: number) => {
      clock += ms;
    },
    fireTimers: () => {
      const due = [...timers.entries()];
      timers.clear();
      for (const [, timer] of due) timer.fn();
    },
  };
}

const updatesDir = () => join(userData, "updates");

/** Lets queued promise callbacks (a fired timer's check) run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("createUpdater", () => {
  it("checks at launch and reports the newer release as available", async () => {
    const h = harness();
    await h.updater.start();
    expect(h.updater.state()).toMatchObject({
      phase: "available",
      current: "0.1.8",
      latest: "0.1.9",
      url: PAGE,
      notes: "Fixes.",
      lastChecked: 1_000_000,
    });
    expect(h.pushed.map((state) => state.phase)).toEqual(["checking", "available"]);
    expect(h.calls).toEqual([API]);
    await settle();
    expect(JSON.parse(readFileSync(join(updatesDir(), "state.json"), "utf8"))).toEqual({
      lastChecked: 1_000_000,
    });
  });

  it("shows the persisted last-checked time until a check succeeds", async () => {
    mkdirSync(updatesDir());
    writeFileSync(join(updatesDir(), "state.json"), JSON.stringify({ lastChecked: 5 }));
    const h = harness({}, { [API]: () => new Response("down", { status: 503 }) });
    await h.updater.start();
    expect(h.updater.state()).toMatchObject({ phase: "error", error: "offline", lastChecked: 5 });
  });

  it("removes stale downloads at start but keeps state.json", async () => {
    mkdirSync(updatesDir());
    writeFileSync(join(updatesDir(), "old.dmg"), "x");
    writeFileSync(join(updatesDir(), "state.json"), "{}");
    const h = harness();
    await h.updater.start();
    expect(readdirSync(updatesDir())).toEqual(["state.json"]);
  });

  it("re-checks every 24h and stops when asked", async () => {
    const h = harness();
    await h.updater.start();
    expect([...h.timers.values()].map((timer) => timer.ms)).toEqual([CHECK_INTERVAL_MS]);
    h.advance(CHECK_INTERVAL_MS);
    h.fireTimers();
    await settle();
    expect(h.calls).toEqual([API, API]);
    expect(h.updater.state().lastChecked).toBe(1_000_000 + CHECK_INTERVAL_MS);
    expect(h.timers.size).toBe(1);
    h.updater.stop();
    expect(h.timers.size).toBe(0);
  });

  it("is current when the release is not newer", async () => {
    const h = harness({ current: "0.1.9" });
    expect(await h.updater.checkNow()).toMatchObject({ phase: "current", current: "0.1.9" });
  });

  it("keeps an available update when a later check fails", async () => {
    let up = true;
    const h = harness(
      {},
      { [API]: () => (up ? Response.json(release()) : new Response("", { status: 500 })) },
    );
    await h.updater.checkNow();
    up = false;
    expect(await h.updater.checkNow()).toMatchObject({ phase: "available", latest: "0.1.9" });
  });

  it("reports no-asset when this computer has no build", async () => {
    const h = harness({ platform: "linux", arch: "arm64" });
    expect(await h.updater.checkNow()).toMatchObject({
      phase: "error",
      error: "no-asset",
      latest: "0.1.9",
      url: PAGE,
    });
    expect(await h.updater.download()).toMatchObject({ phase: "error" });
    expect(h.calls).toEqual([API]);
  });

  it("refuses a release version that is not a plain semver", async () => {
    const tag = "v0.1.9-x/../../evil";
    const h = harness({}, { [API]: () => Response.json(release({ tag })) });
    const state = await h.updater.checkNow();
    expect(state).toMatchObject({ phase: "error", error: "no-asset", url: PAGE });
    expect(state.latest).toBeUndefined();
  });

  it("downloads, verifies and becomes ready", async () => {
    const h = harness();
    await h.updater.checkNow();
    const state = await h.updater.download();
    expect(state).toMatchObject({ phase: "ready", latest: "0.1.9" });
    expect(readFileSync(join(updatesDir(), DMG), "utf8")).toBe(PAYLOAD);
    const phases = h.pushed.map((pushed) => pushed.phase);
    expect(phases).toEqual(expect.arrayContaining(["downloading", "verifying", "ready"]));
    expect(h.pushed.some((pushed) => pushed.received === PAYLOAD.length)).toBe(true);
  });

  it("ignores a check while a download is in flight, and cancel returns to available", async () => {
    let release_: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release_ = resolve;
    });
    const h = harness(
      {},
      {
        [`${BASE}${DMG}`]: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              async pull(controller) {
                await gate;
                controller.enqueue(new TextEncoder().encode("x"));
              },
            }),
          ),
      },
    );
    await h.updater.checkNow();
    const downloading = h.updater.download();
    await settle();
    expect(h.updater.state().phase).toBe("downloading");
    expect(await h.updater.checkNow()).toMatchObject({ phase: "downloading" });
    expect(h.calls.filter((url) => url === API)).toHaveLength(1);
    await h.updater.cancel();
    release_();
    expect(await downloading).toMatchObject({ phase: "available" });
    expect(readdirSync(updatesDir()).filter((name) => name.startsWith("Jarvis"))).toEqual([]);
  });

  it("refuses a release without SHA256SUMS", async () => {
    const h = harness({}, { [API]: () => Response.json(release({ sums: false })) });
    await h.updater.checkNow();
    expect(await h.updater.download()).toMatchObject({ phase: "error", error: "no-sums" });
    expect(h.calls).not.toContain(`${BASE}${DMG}`);
  });

  it("refuses when SHA256SUMS has no line for the asset", async () => {
    const h = harness({}, { [`${BASE}SHA256SUMS`]: () => new Response(`${sha("x")}  other\n`) });
    await h.updater.checkNow();
    expect(await h.updater.download()).toMatchObject({ phase: "error", error: "no-sums" });
  });

  it("deletes the download and reports a checksum mismatch", async () => {
    const h = harness({}, { [`${BASE}SHA256SUMS`]: () => new Response(`${sha("x")}  ${DMG}\n`) });
    await h.updater.checkNow();
    expect(await h.updater.download()).toMatchObject({ phase: "error", error: "mismatch" });
    expect(existsSync(join(updatesDir(), DMG))).toBe(false);
    expect(await h.updater.install()).toMatchObject({ phase: "error" });
    expect(h.deps.spawnDetached).not.toHaveBeenCalled();
  });

  it("reports a failed download", async () => {
    const h = harness({}, { [`${BASE}${DMG}`]: () => new Response("", { status: 500 }) });
    await h.updater.checkNow();
    expect(await h.updater.download()).toMatchObject({ phase: "error", error: "download" });
  });

  it("installs on macOS: stages the bundle, spawns the swap script and quits", async () => {
    mkdirSync(join(root, "Apps"));
    const h = harness();
    await h.updater.checkNow();
    await h.updater.download();
    await h.updater.install();
    const bundle = join(root, "Apps", "Jarvis.app");
    expect(h.deps.exec).toHaveBeenCalledWith("/usr/bin/ditto", [
      "/Volumes/Jarvis/Jarvis.app",
      `${bundle}.new`,
    ]);
    const script = join(updatesDir(), "swap.sh");
    expect(h.deps.spawnDetached).toHaveBeenCalledWith("/bin/sh", [script], {
      cwd: updatesDir(),
      env: { PATH: "/usr/bin" },
    });
    const text = readFileSync(script, "utf8");
    expect(text).toContain("pid=4242");
    expect(text).toContain(`app='${bundle}'`);
    expect(h.deps.quit).toHaveBeenCalledTimes(1);
  });

  it("refuses a translocated app without running or spawning anything", async () => {
    const h = harness({
      execPath: "/private/var/folders/x/AppTranslocation/ABC/d/Jarvis.app/Contents/MacOS/Jarvis",
    });
    await h.updater.checkNow();
    await h.updater.download();
    expect(await h.updater.install()).toMatchObject({ phase: "error", error: "translocated" });
    expect(h.deps.exec).not.toHaveBeenCalled();
    expect(h.deps.spawnDetached).not.toHaveBeenCalled();
    expect(h.deps.quit).not.toHaveBeenCalled();
  });

  it("refuses an install folder it cannot write to", async () => {
    const h = harness({ fs: { ...nodeUpdaterFs, writable: () => false } });
    await h.updater.checkNow();
    await h.updater.download();
    expect(await h.updater.install()).toMatchObject({ phase: "error", error: "read-only" });
    expect(h.deps.spawnDetached).not.toHaveBeenCalled();
  });

  it("reports swap when staging the bundle fails, and does not quit", async () => {
    mkdirSync(join(root, "Apps"));
    const h = harness({ exec: vi.fn(async () => ({ code: 1, stdout: "" })) });
    await h.updater.checkNow();
    await h.updater.download();
    expect(await h.updater.install()).toMatchObject({ phase: "error", error: "swap" });
    expect(h.deps.quit).not.toHaveBeenCalled();
  });

  it("uses the development bundle override on macOS", async () => {
    const bundle = join(root, "Scratch", "Jarvis.app");
    mkdirSync(join(root, "Scratch"));
    const h = harness({ bundle, execPath: "/usr/local/bin/electron" });
    await h.updater.checkNow();
    await h.updater.download();
    await h.updater.install();
    expect(readFileSync(join(updatesDir(), "swap.sh"), "utf8")).toContain(`app='${bundle}'`);
  });

  it("installs on Linux: stages the AppImage and strips the AppImage env", async () => {
    const appImage = join(root, "Jarvis.AppImage");
    writeFileSync(appImage, "old");
    const h = harness({
      platform: "linux",
      arch: "x64",
      appImage,
      env: {
        PATH: "/usr/bin",
        APPDIR: "/tmp/.mount",
        LD_LIBRARY_PATH: "/tmp/.mount/lib",
        HOME: "/h",
      },
    });
    await h.updater.checkNow();
    await h.updater.download();
    await h.updater.install();
    expect(readFileSync(`${appImage}.new`, "utf8")).toBe(PAYLOAD);
    expect(h.deps.spawnDetached).toHaveBeenCalledWith("/bin/sh", [join(updatesDir(), "swap.sh")], {
      cwd: updatesDir(),
      env: { PATH: "/usr/bin", HOME: "/h" },
    });
    expect(h.deps.quit).toHaveBeenCalled();
  });

  it("refuses on Linux when not running as an AppImage", async () => {
    const h = harness({ platform: "linux", arch: "x64" });
    await h.updater.checkNow();
    await h.updater.download();
    expect(await h.updater.install()).toMatchObject({ phase: "error", error: "not-appimage" });
    expect(h.deps.spawnDetached).not.toHaveBeenCalled();
  });

  it("opens the installer on Windows and quits nothing", async () => {
    const exe = "Jarvis-Setup-0.1.9.exe";
    const h = harness(
      { platform: "win32", arch: "x64" },
      {
        [API]: () => Response.json(release({ names: [exe] })),
        [`${BASE}SHA256SUMS`]: () => new Response(`${sha(PAYLOAD)}  ${exe}\n`),
        [`${BASE}${exe}`]: () => new Response(PAYLOAD),
      },
    );
    await h.updater.checkNow();
    await h.updater.download();
    expect(await h.updater.install()).toMatchObject({ phase: "ready" });
    expect(h.deps.openPath).toHaveBeenCalledWith(join(updatesDir(), exe));
    expect(h.deps.quit).not.toHaveBeenCalled();
  });

  it("installs only from ready", async () => {
    const h = harness();
    await h.updater.checkNow();
    expect(await h.updater.install()).toMatchObject({ phase: "available" });
    expect(h.deps.spawnDetached).not.toHaveBeenCalled();
  });

  it("passes the running counts through", async () => {
    const h = harness();
    expect(await h.updater.counts()).toEqual({ terminals: 3, agents: 2 });
  });

  it("keeps a verified download ready across a re-check of the same release", async () => {
    const h = harness();
    await h.updater.checkNow();
    await h.updater.download();
    expect(await h.updater.checkNow()).toMatchObject({ phase: "ready" });
  });
});

describe("legacyCheck", () => {
  it("maps states to the old app:checkUpdate answer", () => {
    expect(legacyCheck({ phase: "current", current: "1.0.0" })).toEqual({
      kind: "current",
      current: "1.0.0",
    });
    expect(
      legacyCheck({ phase: "available", current: "1.0.0", latest: "1.0.1", url: PAGE, notes: "n" }),
    ).toEqual({
      kind: "newer",
      current: "1.0.0",
      latest: "1.0.1",
      url: PAGE,
      notes: "n",
      assets: [],
    });
    expect(legacyCheck({ phase: "error", current: "1.0.0", error: "offline" })).toEqual({
      kind: "failed",
      current: "1.0.0",
    });
  });
});

describe("swapEnv", () => {
  it("strips the AppImage runtime variables on Linux only", () => {
    const env = {
      PATH: "/bin",
      APPDIR: "a",
      APPIMAGE: "b",
      OWD: "c",
      ARGV0: "d",
      LD_LIBRARY_PATH: "e",
      LD_PRELOAD: "f",
    };
    expect(swapEnv(env, "linux")).toEqual({ PATH: "/bin" });
    expect(swapEnv(env, "darwin")).toEqual(env);
  });
});

describe("nodeExec", () => {
  it("refuses any program outside the allow-list", async () => {
    await expect(nodeExec("/bin/sh", ["-c", "true"])).rejects.toThrow(/refused/);
  });
});

describe("devOverrides", () => {
  const env = {
    JARVIS_UPDATE_API: "http://127.0.0.1:4567/latest",
    JARVIS_UPDATE_BUNDLE: "/tmp/s/Jarvis.app",
  };
  it("is empty in a packaged app", () => {
    expect(devOverrides(env, true)).toEqual({});
  });
  it("derives the test origin from the API override when unpackaged", () => {
    expect(devOverrides(env, false)).toEqual({
      api: "http://127.0.0.1:4567/latest",
      testOrigin: "http://127.0.0.1:4567",
      bundle: "/tmp/s/Jarvis.app",
    });
    expect(devOverrides({ JARVIS_UPDATE_API: "not a url" }, false)).toEqual({});
  });
});

describe("countRunning", () => {
  it("counts live panes and live sessions only", async () => {
    const panes: Record<string, unknown> = {
      t1: [
        { paneKey: "t1", exited: false },
        { paneKey: "t1:b", exited: true },
      ],
      t2: [{ paneKey: "t2", exited: false }],
    };
    expect(
      await countRunning({
        terminalTabs: () => ["t1", "t2", "t3"],
        panes: async (tabId) => {
          if (tabId === "t3") throw new Error("gone");
          return panes[tabId];
        },
        sessions: async () => [
          { state: "running" },
          { state: "waiting" },
          { state: "starting" },
          { state: "done" },
          { state: "dead" },
        ],
      }),
    ).toEqual({ terminals: 2, agents: 3 });
  });
});
