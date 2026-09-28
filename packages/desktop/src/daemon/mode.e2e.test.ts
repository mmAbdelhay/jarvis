import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ensureConfigFile } from "../config.js";
import type { SocketCoreClient } from "../core/socket-core-client.js";
import { readBuildId } from "./build-id.js";
import { createDaemonMode, type DaemonMode } from "./mode.js";
import { nodeDaemonModeDeps } from "./mode-node.js";
import type { ServiceManager } from "./service.js";
import { writeDaemonEnabled } from "./config-file.js";
import { writeAtomically } from "@jarvis/platform";
import { readFile } from "node:fs/promises";

// Task 23 against the real daemon: `node dist/src/daemon-main.js run` in the
// foreground under a scratch HOME — never the user's ~/.config/jarvis — and
// the real mode dependencies (socket CoreClient, liveness probe, daemon:stop,
// jarvis.yaml) pointed at it. The service manager is a recording double, so
// nothing is installed on this machine, and the app's relaunch is faked.
// Needs `pnpm build` first, like the other dist tests.

const WINDOWS = process.platform === "win32";
const DIST_SRC = fileURLToPath(new URL("../../dist/src/", import.meta.url));
const SCRIPT = join(DIST_SRC, "daemon-main.js");

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function scratchHome(): Promise<string> {
  // Short: the socket path under it is capped near 104 bytes on macOS.
  const home = await mkdtemp(join(WINDOWS ? tmpdir() : "/tmp", "jm-"));
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
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  });
  return { child, exited };
}

/** A service manager that installs nothing: it records, and — like Windows,
 *  which has no manager to signal the daemon — answers stop and restart with
 *  "use the control socket", so the real daemon:stop path runs. */
function recordingService(calls: string[]): ServiceManager {
  const record = (name: string) => async () => {
    calls.push(name);
  };
  return {
    install: record("install"),
    uninstall: record("uninstall"),
    start: record("start"),
    async stop() {
      calls.push("stop");
      return { ok: false, reason: "use-control-socket" };
    },
    async restart() {
      calls.push("restart");
      return { ok: false, reason: "use-control-socket" };
    },
    status: async () => "stopped",
  };
}

async function setup(home: string) {
  const configPath = join(home, ".config", "jarvis", "jarvis.yaml");
  await ensureConfigFile(configPath);
  const io = {
    readFile: (path: string) => readFile(path, "utf8"),
    writeFile: (path: string, text: string) => writeAtomically(path, text),
  };
  await writeDaemonEnabled(configPath, true, io);
  const serviceCalls: string[] = [];
  const events: string[] = [];
  const links: SocketCoreClient[] = [];
  const real = nodeDaemonModeDeps({
    platform: process.platform,
    home,
    uid: process.getuid?.() ?? 0,
    execPath: process.execPath,
    daemonScript: SCRIPT,
    build: readBuildId(join(DIST_SRC, "..", "build-stamp.json")),
    configPath,
    restartDaemon: async () => {
      throw new Error("no restart in this test");
    },
    log: () => {},
  });
  const mode: DaemonMode<SocketCoreClient> = createDaemonMode<SocketCoreClient>({
    ...real,
    service: recordingService(serviceCalls),
    // As main.ts does: through the attached daemon's own config writer.
    config: {
      read: real.config.read,
      write: (enabled) => {
        const link = links.at(-1);
        if (link !== undefined && link.connection().kind === "connected") {
          events.push(`daemon writes ${enabled}`);
          return link.setDaemonEnabled(enabled);
        }
        return real.config.write(enabled);
      },
    },
    async connect(timeoutMs) {
      const link = await real.connect(timeoutMs);
      links.push(link);
      cleanups.push(() => link.stop());
      return link;
    },
    confirm: async (change) => {
      events.push(`confirm ${change}`);
      return true;
    },
    chooseFallback: async () => {
      events.push("fallback");
      return "quit";
    },
    stopInProcess: async () => {
      events.push("stopInProcess");
    },
    useDaemon: () => events.push("useDaemon"),
    useInProcess: async () => {
      events.push("useInProcess");
    },
    showError: async () => {
      events.push("showError");
    },
    relaunch: ({ inApp }) => events.push(`relaunch inApp=${inApp}`),
    log: () => {},
  });
  return { mode, real, configPath, serviceCalls, events, links };
}

async function until(check: () => Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe.skipIf(WINDOWS)("background mode against a real foreground jarvisd", () => {
  it("is built", () => {
    expect(existsSync(SCRIPT), `${SCRIPT} is missing: run pnpm build`).toBe(true);
  });

  it("attaches at launch over the socket with no service call, reports pid and uptime, and turns off with a faked relaunch", async () => {
    const home = await scratchHome();
    const daemon = startDaemon(home);
    const { mode, real, configPath, serviceCalls, events, links } = await setup(home);
    await until(() => real.daemonAnswers(), "the daemon's socket");

    const launch = await mode.launch({ inAppThisSession: false });
    expect(launch.kind).toBe("daemon");
    expect(serviceCalls).toEqual([]);
    const link = links[0] as SocketCoreClient;
    await expect(link.invoke("settings:read", [])).resolves.toBeTypeOf("object");

    await until(async () => (await mode.status()).state.kind === "running", "running");
    const status = await mode.status();
    expect(status).toMatchObject({
      enabled: true,
      inApp: false,
      state: { kind: "running", pid: daemon.child.pid },
    });
    expect(status.state.kind === "running" && status.state.uptimeMs).toBeGreaterThanOrEqual(0);

    // Off: the service is asked, the real daemon is stopped over the
    // control socket and waited for, the setting is written, the app
    // relaunches — faked here.
    expect(await mode.setEnabled(false)).toEqual({ ok: true });
    await expect(daemon.exited).resolves.toBe(0);
    expect(serviceCalls).toEqual(["stop", "uninstall"]);
    expect(events).toEqual(["confirm disable", "daemon writes false", "relaunch inApp=false"]);
    expect(await real.daemonAnswers()).toBe(false);
    expect(readFileSync(configPath, "utf8")).not.toContain("daemon");
  }, 90_000);

  it("stop now: the real daemon exits cleanly, the setting stays on, the app relaunches in-app", async () => {
    const home = await scratchHome();
    const daemon = startDaemon(home);
    const { mode, real, configPath, serviceCalls, events } = await setup(home);
    await until(() => real.daemonAnswers(), "the daemon's socket");
    await mode.launch({ inAppThisSession: false });

    expect(await mode.stopNow()).toEqual({ ok: true });
    await expect(daemon.exited).resolves.toBe(0);
    expect(serviceCalls).toEqual([]);
    expect(events).toEqual(["relaunch inApp=true"]);
    expect(readFileSync(configPath, "utf8")).toContain("daemon:\n  enabled: true");
  }, 90_000);

  it("with no daemon: starts it through the service manager, then offers the fallback when it never answers", async () => {
    const home = await scratchHome();
    const { mode, serviceCalls, events } = await setup(home);
    const started = Date.now();
    expect(await mode.launch({ inAppThisSession: false })).toEqual({ kind: "quit" });
    expect(serviceCalls).toEqual(["start"]);
    expect(events).toEqual(["fallback"]);
    // The 10 s socket wait, really waited.
    expect(Date.now() - started).toBeGreaterThanOrEqual(9_000);
  }, 60_000);
});
