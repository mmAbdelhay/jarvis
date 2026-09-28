// The control transport's side effects, injected (conventions: "Injected
// dependencies, always"). nodeControlDeps() is the real set; tests swap the
// clock to fire the handshake timeout without waiting 5 s, and the uid to
// exercise the run-dir ownership check.
import { randomBytes } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";

export interface ControlStat {
  isSocket(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  uid: number;
  mode: number;
}

export interface ControlFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<string | undefined>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string, options: { mode: number; flag: "wx" }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  unlink(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** A hard link: fails with EEXIST if `to` exists, which makes it an atomic create-with-content. */
  link(from: string, to: string): Promise<void>;
  lstat(path: string): Promise<ControlStat>;
}

export interface ControlNet {
  createServer(onConnection: (socket: Socket) => void): Server;
  connect(endpoint: string): Socket;
}

export interface ControlClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ControlProcess {
  pid: number;
  /** undefined where the OS has no uids (Windows). */
  uid(): number | undefined;
  isAlive(pid: number): boolean;
}

export interface ControlDeps {
  fs: ControlFs;
  net: ControlNet;
  clock: ControlClock;
  process: ControlProcess;
  randomBytes(count: number): Uint8Array;
}

export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export function nodeControlDeps(): ControlDeps {
  return {
    fs: { mkdir, chmod, writeFile, readFile, unlink, rename, link, lstat },
    net: {
      createServer: (onConnection) => createServer(onConnection),
      connect: (endpoint) => connect(endpoint),
    },
    clock: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    process: {
      pid: process.pid,
      uid: () => process.getuid?.(),
      isAlive(pid) {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          // EPERM: it exists, it just isn't ours to signal.
          return errorCode(error) !== "ESRCH";
        }
      },
    },
    randomBytes: (count) => randomBytes(count),
  };
}
