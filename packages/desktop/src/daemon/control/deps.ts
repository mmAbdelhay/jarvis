// The control transport's side effects, injected (conventions: "Injected
// dependencies, always"). nodeControlDeps() is the real set; tests swap the
// clock to fire the handshake timeout without waiting 5 s.
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";

export interface ControlFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string, options: { mode: number; flag: "wx" }): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  unlink(path: string): Promise<void>;
  lstat(path: string): Promise<{ isSocket(): boolean }>;
}

export interface ControlNet {
  createServer(onConnection: (socket: Socket) => void): Server;
  connect(endpoint: string): Socket;
}

export interface ControlClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ControlDeps {
  fs: ControlFs;
  net: ControlNet;
  clock: ControlClock;
  randomBytes(count: number): Uint8Array;
}

export function nodeControlDeps(): ControlDeps {
  return {
    fs: { mkdir, chmod, writeFile, readFile, unlink, lstat },
    net: {
      createServer: (onConnection) => createServer(onConnection),
      connect: (endpoint) => connect(endpoint),
    },
    clock: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
    randomBytes: (count) => randomBytes(count),
  };
}
