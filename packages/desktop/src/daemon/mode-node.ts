// The real side effects daemon/mode.ts is given — everything but the
// Electron ones (dialogs, the window, the relaunch), which main.ts adds.
//
//   - the service manager (service.ts) over real files and commands: every
//     command is an argv array run without a shell;
//   - the socket CoreClient (core/socket-core-client.ts) over this user's
//     control endpoint, for this app's build;
//   - the liveness probe and daemon:stop over a control connection;
//   - daemon.enabled in jarvis.yaml (config-file.ts);
//   - the daemon log's last line.
//
// The platform is a parameter: main.ts reads process.platform, not this.
//
// No electron here (core/no-electron.test.ts).
import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { writeAtomically } from "@jarvis/platform";
import { connectSocketCoreClient, type SocketCoreClient } from "../core/socket-core-client.js";
import { readDaemonEnabled, writeDaemonEnabled } from "./config-file.js";
import { connectControl } from "./control/client.js";
import { nodeControlDeps } from "./control/deps.js";
import { runDirectoryFor } from "./control/endpoint.js";
import { daemonAnswers } from "./control/liveness.js";
import { daemonLogPath } from "./log-file.js";
import type { DaemonModeDeps } from "./mode.js";
import { DAEMON_REQUESTS } from "./protocol.js";
import {
  type CommandResult,
  createServiceManager,
  type ServiceFileSystem,
  type ServicePlatform,
} from "./service.js";

/** A service command that has not answered in this long is given up on. */
export const COMMAND_TIMEOUT_MS = 30_000;
/** How much of the log's end is read for its last line. */
const LOG_TAIL_BYTES = 16 * 1024;

export type NodeModeOptions = {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  /** The binary the service runs the daemon with (process.execPath). */
  execPath: string;
  /** daemonScriptPath(...) — Task 21's single resolver. */
  daemonScript: string;
  /** This app's build (readBuildId): the control handshake compares it. */
  build: string;
  configPath: string;
  /** The adapter's answer to restart-required: mode.restartDaemon. */
  restartDaemon(): Promise<void>;
  log(line: string): void;
};

export type NodeModeDeps = Omit<
  DaemonModeDeps<SocketCoreClient>,
  | "confirm"
  | "chooseFallback"
  | "stopInProcess"
  | "useDaemon"
  | "useInProcess"
  | "showError"
  | "relaunch"
  | "log"
>;

export function servicePlatform(platform: NodeJS.Platform): ServicePlatform {
  return platform === "darwin" || platform === "win32" ? platform : "linux";
}

const serviceFs: ServiceFileSystem = {
  writeFile: (path, contents, options) =>
    writeFile(path, contents, options?.mode === undefined ? {} : { mode: options.mode }),
  mkdir: async (path, options) => {
    await mkdir(path, options);
  },
  rm: (path, options) => rm(path, options),
  exists: async (path) => {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
};

/** A command as argv, no shell; its exit code whatever it is. */
export function runCommand(command: string, args: readonly string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code =
          error === null ? 0 : typeof error.code === "number" ? error.code : 1; /* spawn failed */
        resolve({ code, stdout, stderr });
      },
    );
  });
}

/** Starts a process that outlives this one, no console window, no shell. */
export async function spawnDetached(command: string, args: readonly string[]): Promise<void> {
  const child = spawn(command, [...args], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", reject);
  });
  child.unref();
}

/** The last non-empty line of the file's final LOG_TAIL_BYTES. */
export async function lastLineOf(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const { size } = await handle.stat();
    const length = Math.min(size, LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]?.trim();
      if (line) return line;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function nodeDaemonModeDeps(options: NodeModeOptions): NodeModeDeps {
  const { platform } = options;
  const runDirectory = runDirectoryFor({ platform, home: options.home });
  const control = () =>
    connectControl({ platform, runDirectory, build: options.build, deps: nodeControlDeps() });
  const service = createServiceManager({
    platform: servicePlatform(platform),
    home: options.home,
    uid: options.uid,
    execPath: options.execPath,
    daemonScript: options.daemonScript,
    fs: serviceFs,
    run: runCommand,
    spawnDetached,
  });
  const configIo = {
    readFile: (path: string) => readFile(path, "utf8"),
    writeFile: (path: string, text: string) => writeAtomically(path, text),
  };
  return {
    service,
    // launchd's RunAtLoad and systemd's enable --now start it; Windows'
    // Run value runs only at the next login.
    installStarts: platform !== "win32",
    connect: (timeoutMs) =>
      connectSocketCoreClient({
        connect: control,
        restartDaemon: options.restartDaemon,
        now: Date.now,
        timers: {
          setTimeout: (callback, ms) => setTimeout(callback, ms),
          clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
          setInterval: (callback, ms) => setInterval(callback, ms),
          clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
        },
        log: options.log,
        initialTimeoutMs: timeoutMs,
      }),
    daemonAnswers: () => daemonAnswers(platform, runDirectory, nodeControlDeps()),
    async requestDaemonStop() {
      const connection = await control();
      try {
        await connection.invoke(DAEMON_REQUESTS.stop, []);
      } finally {
        connection.close();
      }
    },
    config: {
      read: () => readDaemonEnabled(options.configPath, configIo),
      write: (enabled) => writeDaemonEnabled(options.configPath, enabled, configIo),
    },
    lastLogLine: () => lastLineOf(daemonLogPath(options.home)),
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
