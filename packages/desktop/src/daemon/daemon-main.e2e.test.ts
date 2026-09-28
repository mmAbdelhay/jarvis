import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectSocketCoreClient } from "../core/socket-core-client.js";
import { readBuildId } from "./build-id.js";
import { connectControl } from "./control/client.js";
import { nodeControlDeps } from "./control/deps.js";
import { runDirectoryFor } from "./control/endpoint.js";
import { DAEMON_REQUESTS } from "./protocol.js";

// The real thing, end to end: `node dist/src/daemon-main.js run` under a
// scratch HOME (so ~/.config/jarvis is scratch, never the user's), reached
// through the socket CoreClient the app will use. Needs `pnpm build` first,
// like the other dist tests.

const WINDOWS = process.platform === "win32";
const DIST_SRC = fileURLToPath(new URL("../../dist/src/", import.meta.url));
const SCRIPT = join(DIST_SRC, "daemon-main.js");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratchHome(): Promise<string> {
  // Short: the socket path under it is capped near 104 bytes on macOS.
  const home = await mkdtemp(join(WINDOWS ? tmpdir() : "/tmp", "jd-"));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  return home;
}

function startDaemon(home: string): { child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [SCRIPT, "run"], {
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return { child, exited };
}

function client(home: string) {
  const platform = process.platform;
  const runDirectory = runDirectoryFor({ platform, home });
  const build = readBuildId(join(DIST_SRC, "..", "build-stamp.json"));
  return connectSocketCoreClient({
    connect: () => connectControl({ platform, runDirectory, build, deps: nodeControlDeps() }),
    now: Date.now,
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    },
    log: () => {},
    // The core takes a moment to start; the socket is up before it is, and
    // requests wait for it.
    initialTimeoutMs: 30_000,
  });
}

describe.skipIf(WINDOWS)("jarvisd, end to end", () => {
  it("is built", () => {
    expect(existsSync(SCRIPT), `${SCRIPT} is missing: run pnpm build`).toBe(true);
  });

  it("serves the app over the socket, refuses a second daemon, and stops on SIGTERM", async () => {
    const home = await scratchHome();
    const run = runDirectoryFor({ platform: process.platform, home });
    const daemon = startDaemon(home);
    const app = await client(home);
    cleanups.push(() => app.stop());

    const settings = await app.invoke("settings:read", []);
    expect(settings).toBeTypeOf("object");
    expect(app.firstRun).toBe(true);
    expect(app.workspace.state()).toMatchObject({ tabs: [] });

    // The lock: a second daemon exits 3 and leaves the first serving.
    const second = startDaemon(home);
    await expect(second.exited).resolves.toBe(3);
    await expect(app.invoke("settings:read", [])).resolves.toEqual(settings);

    const secret = readFileSync(join(run, "control.secret"), "utf8").trim();
    daemon.child.kill("SIGTERM");
    await expect(daemon.exited).resolves.toBe(0);
    expect(existsSync(join(run, "jarvisd.pid"))).toBe(false);
    expect(existsSync(join(run, "jarvisd.sock"))).toBe(false);

    const log = readFileSync(join(home, ".config", "jarvis", "logs", "jarvisd.log"), "utf8");
    expect(log).toContain("stopping (SIGTERM)");
    expect(log).toContain("stopped");
    expect(log).not.toContain(secret);
  }, 60_000);

  it("stops on daemon:stop, the Windows path, the same way", async () => {
    const home = await scratchHome();
    const run = runDirectoryFor({ platform: process.platform, home });
    const daemon = startDaemon(home);
    const app = await client(home);
    cleanups.push(() => app.stop());

    await expect(app.invoke(DAEMON_REQUESTS.stop as never, [])).resolves.toEqual({
      stopping: true,
    });
    await expect(daemon.exited).resolves.toBe(0);
    expect(existsSync(join(run, "jarvisd.pid"))).toBe(false);
  }, 60_000);
});
