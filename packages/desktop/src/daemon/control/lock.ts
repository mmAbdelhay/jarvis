// The single-instance lock (Phase 2, task 2.4; review I2 ruling, re-review).
//
// 1. A pid file, `run/jarvisd.pid`, holding "<pid>:<random token>" and created
//    exclusively (a hard link of a finished temp file, so it is never seen
//    empty). The token makes every holding unique even when a pid repeats.
// 2. A held lock is stale when its pid is dead, when it is this process's own
//    pid (a daemon that got its old pid back after a reboot; the in-process
//    double start is refused before the pid file is read), or when its pid is
//    alive but no daemon answers on the endpoint — now and again after
//    STALE_LOCK_GRACE_MS, which covers a holder still starting up. Pids are
//    reused densely after a reboot, and the pid file outlives a crash, so a
//    live pid alone proves nothing.
// 3. Taking over a stale lock is serialised by a second exclusive file,
//    `jarvisd.pid.takeover`: under it the starter re-reads the lock, removes
//    it only if it is still the stale one it judged, and creates its own.
//    Any other outcome is busy, never acquired — so of any number of racing
//    starters exactly one wins. A takeover marker older than
//    TAKEOVER_STALE_MS was left by a starter that crashed mid-takeover.
// 4. Then the endpoint. Unix: a socket file nobody answers on is what a killed
//    daemon leaves behind; it is unlinked (only if it is a socket) and bound.
//    Windows: the pipe name is fresh and random at every start.
// 5. server.ts then connects to the endpoint once and checks the connection
//    reached this server, the last word on who owns it.
import type { Server, Socket } from "node:net";
import { HANDSHAKE_TIMEOUT_MS } from "@jarvis/wire";
import { type ControlDeps, errorCode } from "./deps.js";
import { controlPaths, windowsPipeName } from "./endpoint.js";
import { daemonAnswers } from "./liveness.js";
import { createExclusiveFile } from "./run-dir.js";

export const STALE_LOCK_GRACE_MS = 2 * HANDSHAKE_TIMEOUT_MS;
export const TAKEOVER_STALE_MS = 30_000;
const MAX_LOCK_ATTEMPTS = 3;

export type PidLock = { kind: "acquired"; release(): Promise<void> } | { kind: "busy" };

export type DaemonLock =
  | {
      kind: "acquired";
      server: Server;
      endpoint: string;
      /** Committed by the caller once it has confirmed it owns the endpoint. */
      publication: Publication;
      release(): Promise<void>;
    }
  | { kind: "busy" };

/** What publish() wrote, to keep (the start won) or undo (it lost the endpoint after all). */
export interface Publication {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface AcquireDaemonLockOptions {
  platform: NodeJS.Platform;
  runDirectory: string;
  deps: ControlDeps;
  onConnection(socket: Socket): void;
  /** Writes whatever clients must read (secret, pipe name): after the pid lock, before listen. */
  publish(endpoint: string): Promise<Publication>;
}

export interface PidLockOptions {
  /** Whether a daemon answers on the endpoint — asked only when the holder's pid is alive. */
  holderAnswers(): Promise<boolean>;
}

type LockDeps = Pick<ControlDeps, "fs" | "process" | "randomBytes" | "clock">;

function parsePid(text: string): number | undefined {
  const match = /^([1-9][0-9]{0,9})(?::[0-9A-Za-z-]*)?$/.exec(text.trim());
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

async function readIfExists(
  path: string,
  deps: Pick<ControlDeps, "fs">,
): Promise<string | undefined> {
  try {
    return await deps.fs.readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function sleep(ms: number, deps: Pick<ControlDeps, "clock">): Promise<void> {
  return new Promise((resolve) => deps.clock.setTimeout(resolve, ms));
}

/** Replaces the stale lock `seen` with `own`, serialised against every other taker. */
async function takeOver(
  pidPath: string,
  seen: string,
  own: string,
  deps: LockDeps,
): Promise<"acquired" | "busy" | "retry"> {
  const markerPath = `${pidPath}.takeover`;
  if (!(await createExclusiveFile(markerPath, own, deps))) {
    try {
      const marker = await deps.fs.lstat(markerPath);
      if (deps.clock.now() - marker.mtimeMs <= TAKEOVER_STALE_MS) return "busy";
      await deps.fs.unlink(markerPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    return "retry";
  }
  try {
    const current = await readIfExists(pidPath, deps);
    if (current !== undefined) {
      if (current !== seen) return "busy";
      await deps.fs.unlink(pidPath);
    }
    return (await createExclusiveFile(pidPath, own, deps)) ? "acquired" : "busy";
  } finally {
    await deps.fs.unlink(markerPath).catch(() => {});
  }
}

export async function acquirePidLock(
  pidPath: string,
  deps: LockDeps,
  options: PidLockOptions,
): Promise<PidLock> {
  const own = `${deps.process.pid}:${Buffer.from(deps.randomBytes(8)).toString("hex")}`;
  const release = async () => {
    if ((await readIfExists(pidPath, deps)) === own) {
      await deps.fs.unlink(pidPath).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") throw error;
      });
    }
  };
  const acquired: PidLock = { kind: "acquired", release };

  const isStale = async (holder: string): Promise<boolean> => {
    const pid = parsePid(holder);
    if (pid === undefined || pid === deps.process.pid || !deps.process.isAlive(pid)) return true;
    if (await options.holderAnswers()) return false;
    await sleep(STALE_LOCK_GRACE_MS, deps);
    return !(await options.holderAnswers());
  };

  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt++) {
    if (await createExclusiveFile(pidPath, own, deps)) return acquired;
    const holder = await readIfExists(pidPath, deps);
    if (holder === undefined) continue;
    if (!(await isStale(holder))) return { kind: "busy" };
    const outcome = await takeOver(pidPath, holder, own, deps);
    if (outcome === "acquired") return acquired;
    if (outcome === "busy") return { kind: "busy" };
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

/** Run dirs this process holds (or is taking) the lock of: a second start in-process is busy. */
const heldInThisProcess = new Set<string>();

export async function acquireDaemonLock(options: AcquireDaemonLockOptions): Promise<DaemonLock> {
  const { deps, platform } = options;
  const paths = controlPaths(platform, options.runDirectory);
  // The pid file cannot tell two starts in one process apart (same pid), and
  // a same-pid holder is otherwise judged stale — so this check comes first.
  if (heldInThisProcess.has(paths.pidPath)) return { kind: "busy" };
  heldInThisProcess.add(paths.pidPath);
  const pidLock = await acquirePidLock(paths.pidPath, deps, {
    holderAnswers: () => daemonAnswers(platform, options.runDirectory, deps),
  }).catch((error: unknown) => {
    heldInThisProcess.delete(paths.pidPath);
    throw error;
  });
  if (pidLock.kind === "busy") {
    heldInThisProcess.delete(paths.pidPath);
    return { kind: "busy" };
  }
  const release = async () => {
    heldInThisProcess.delete(paths.pidPath);
    await pidLock.release();
  };
  try {
    let endpoint: string;
    if (platform === "win32") {
      endpoint = windowsPipeName(deps.randomBytes(8));
    } else {
      endpoint = paths.socketPath;
      const state = await probe(deps, endpoint);
      if (state === "live") {
        await release();
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
    const publication = await options.publish(endpoint);
    const server = deps.net.createServer(options.onConnection);
    let state: "listening" | "in-use";
    try {
      state = await listen(server, endpoint);
    } catch (error) {
      await publication.rollback();
      throw error;
    }
    if (state === "in-use") {
      await publication.rollback();
      await release();
      return { kind: "busy" };
    }
    return { kind: "acquired", server, endpoint, publication, release };
  } catch (error) {
    await release();
    throw error;
  }
}
