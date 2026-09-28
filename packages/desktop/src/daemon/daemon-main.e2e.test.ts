import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { connectSocketCoreClient } from "../core/socket-core-client.js";
import { ensureConfigFile } from "../config.js";
import { readBuildId } from "./build-id.js";
import { DAEMON_EXIT } from "./args.js";
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

function startDaemon(
  home: string,
  env: NodeJS.ProcessEnv = {},
): { child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [SCRIPT, "run"], {
    env: { ...process.env, HOME: home, USERPROFILE: home, ...env },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  // Stopped, and waited for, before its scratch HOME is removed: a live
  // shell still writing there would make the removal fail.
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
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

  it("gives its terminals an environment without ELECTRON_RUN_AS_NODE", async () => {
    const home = await scratchHome();
    // A project for the terminal to open in, in the scratch config.
    const config = join(home, ".config", "jarvis", "jarvis.yaml");
    await ensureConfigFile(config);
    await appendFile(config, `\nprojects:\n  scratch: ${JSON.stringify(home)}\n`);
    // Started the way the packaged app and the service definitions start it.
    startDaemon(home, { ELECTRON_RUN_AS_NODE: "1" });
    const app = await client(home);
    cleanups.push(() => app.stop());

    await app.invoke("terminal:open", ["scratch"]);
    const tab = app.workspace.state().tabs.find((candidate) => candidate.kind === "terminal");
    expect(tab).toBeDefined();
    const tabId = tab?.id as string;
    const panes = (await app.invoke("terminal:panes", [tabId])) as Array<{ paneKey: string }>;
    const paneKey = panes[0]?.paneKey as string;
    // The shell expands this, not JavaScript.
    const probe = ["echo ERAN=$", "{ELECTRON_RUN_AS_NODE:-unset}\r"].join("");
    await app.invoke("terminal:input", [tabId, probe]);

    const deadline = Date.now() + 15_000;
    let text = "";
    while (Date.now() < deadline) {
      text = ((await app.invoke("terminal:snapshot", [paneKey])) as { text: string }).text;
      if (/ERAN=(unset|1)\s/.test(text)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(text).toMatch(/ERAN=unset\s/);
    expect(text).not.toMatch(/ERAN=1\s/);
  }, 60_000);

  it("exits 75 on Settings' Restart under a service manager, for it to start again", async () => {
    const home = await scratchHome();
    const daemon = startDaemon(home, { JARVISD_SUPERVISOR: "launchd" });
    const app = await client(home);
    cleanups.push(() => app.stop());
    await app.invoke("settings:restart", []);
    await expect(daemon.exited).resolves.toBe(DAEMON_EXIT.restart);
    const log = readFileSync(join(home, ".config", "jarvis", "logs", "jarvisd.log"), "utf8");
    expect(log).toContain("run by launchd");
    expect(log).toContain("stopping (restart)");
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
