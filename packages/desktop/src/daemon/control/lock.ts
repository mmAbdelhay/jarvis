// The single-instance lock (Phase 2, task 2.4; review I2 ruling).
//
// 1. A pid file, `run/jarvisd.pid`, created exclusively. If it exists and its
//    pid is dead, it is stale: set aside and retried once. Setting it aside is
//    a rename, then a check that what moved is still the dead pid we read —
//    if another starter replaced it in between, it is put back and we lose.
// 2. Then the endpoint. Unix: a socket file nobody answers on is what a killed
//    daemon leaves behind; it is unlinked (only if it is a socket) and bound.
//    Windows: the pipe name is fresh and random at every start, so there is
//    nothing stale to clear; a name in use still reads as busy.
// 3. server.ts then connects to the endpoint once and checks the connection
//    reached this server, the last word on who owns it.
import type { Server, Socket } from "node:net";
import { type ControlDeps, errorCode } from "./deps.js";
import { controlPaths, windowsPipeName } from "./endpoint.js";
import { createExclusiveFile, tempName } from "./run-dir.js";

export type PidLock = { kind: "acquired"; release(): Promise<void> } | { kind: "busy" };

export type DaemonLock =
  | { kind: "acquired"; server: Server; endpoint: string; release(): Promise<void> }
  | { kind: "busy" };

export interface AcquireDaemonLockOptions {
  platform: NodeJS.Platform;
  runDirectory: string;
  deps: ControlDeps;
  onConnection(socket: Socket): void;
  /** Writes whatever clients must read (secret, pipe name) — before the endpoint listens. */
  publish(endpoint: string): Promise<void>;
}

function parsePid(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[1-9][0-9]{0,9}$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/** Moves a stale lock aside; false if it turned out to be a fresh one after all. */
async function removeStale(
  pidPath: string,
  seen: string,
  deps: Pick<ControlDeps, "fs" | "randomBytes">,
): Promise<boolean> {
  const aside = tempName(pidPath, deps, "stale");
  try {
    await deps.fs.rename(pidPath, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  const moved = await deps.fs.readFile(aside, "utf8");
  if (moved !== seen) {
    await deps.fs.link(aside, pidPath).catch(() => {});
    await deps.fs.unlink(aside);
    return false;
  }
  await deps.fs.unlink(aside);
  return true;
}

export async function acquirePidLock(
  pidPath: string,
  deps: Pick<ControlDeps, "fs" | "process" | "randomBytes">,
): Promise<PidLock> {
  const own = String(deps.process.pid);
  const release = async () => {
    try {
      if ((await deps.fs.readFile(pidPath, "utf8")) === own) await deps.fs.unlink(pidPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await createExclusiveFile(pidPath, own, deps)) return { kind: "acquired", release };
    let holder: string;
    try {
      holder = await deps.fs.readFile(pidPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const pid = parsePid(holder);
    if (pid !== undefined && deps.process.isAlive(pid)) return { kind: "busy" };
    if (!(await removeStale(pidPath, holder, deps))) return { kind: "busy" };
  }
  return { kind: "busy" };
}

type Probe = "live" | "refused" | "absent";

// Any other connect error (EAGAIN on a full Linux backlog, say) makes the
// start fail outright; the daemon's entry reports it rather than guessing.
function probe(deps: Pick<ControlDeps, "net">, endpoint: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const socket = deps.net.connect(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve("live");
    });
    socket.once("error", (error) => {
      socket.destroy();
      const code = errorCode(error);
      // ENOTSOCK: macOS, dialling a non-socket file — the lstat check below refuses it.
      if (code === "ECONNREFUSED" || code === "ENOTSOCK") resolve("refused");
      else if (code === "ENOENT") resolve("absent");
      else reject(error);
    });
  });
}

function listen(server: Server, endpoint: string): Promise<"listening" | "in-use"> {
  return new Promise((resolve, reject) => {
    const onError = (error: unknown) => {
      server.off("listening", onListening);
      if (errorCode(error) === "EADDRINUSE") resolve("in-use");
      else reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve("listening");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

export async function acquireDaemonLock(options: AcquireDaemonLockOptions): Promise<DaemonLock> {
  const { deps, platform } = options;
  const paths = controlPaths(platform, options.runDirectory);
  const pidLock = await acquirePidLock(paths.pidPath, deps);
  if (pidLock.kind === "busy") return { kind: "busy" };
  try {
    let endpoint: string;
    if (platform === "win32") {
      endpoint = windowsPipeName(deps.randomBytes(8));
    } else {
      endpoint = paths.socketPath;
      const state = await probe(deps, endpoint);
      if (state === "live") {
        await pidLock.release();
        return { kind: "busy" };
      }
      if (state === "refused") {
        // Only ever a socket: a regular file here is not ours to delete.
        if (!(await deps.fs.lstat(endpoint)).isSocket()) {
          throw new Error("The control endpoint exists and is not a socket");
        }
        try {
          await deps.fs.unlink(endpoint);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      }
    }
    await options.publish(endpoint);
    const server = deps.net.createServer(options.onConnection);
    if ((await listen(server, endpoint)) === "in-use") {
      await pidLock.release();
      return { kind: "busy" };
    }
    return { kind: "acquired", server, endpoint, release: pidLock.release };
  } catch (error) {
    await pidLock.release();
    throw error;
  }
}
