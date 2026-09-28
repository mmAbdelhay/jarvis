// The single-instance lock (Phase 2, task 2.4): the listening endpoint *is*
// the lock. Before listening, probe it — a live daemon accepts the connection,
// so this one must step aside. On Unix a refused (or missing) socket file is
// what a killed daemon leaves behind; it is unlinked so listen() can bind.
// Windows removes a named pipe with its last handle, so there is nothing
// stale to clean up there, and a pipe another process still holds surfaces
// as EADDRINUSE from listen().
import type { Server, Socket } from "node:net";
import type { ControlDeps } from "./deps.js";

export type DaemonLock = { kind: "acquired"; server: Server } | { kind: "busy" };

export interface AcquireDaemonLockOptions {
  endpoint: string;
  platform: NodeJS.Platform;
  deps: Pick<ControlDeps, "fs" | "net">;
  onConnection(socket: Socket): void;
}

type Probe = "live" | "refused" | "absent";

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

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
      if (code === "ECONNREFUSED") resolve("refused");
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
  const { deps, endpoint, platform } = options;
  const state = await probe(deps, endpoint);
  if (state === "live") return { kind: "busy" };
  if (state === "refused" && platform !== "win32") {
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
  const server = deps.net.createServer(options.onConnection);
  // A daemon that raced us between the probe and listen() won the lock.
  if ((await listen(server, endpoint)) === "in-use") return { kind: "busy" };
  return { kind: "acquired", server };
}
