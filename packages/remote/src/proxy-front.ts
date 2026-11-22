// What listens in relay mode. `tailscale serve --tcp --proxy-protocol=2`
// forwards raw TLS to a loopback port with a PROXY v2 header in front, so this
// plain TCP listener reads that header before any TLS and hands the socket to
// an https server that never binds a port of its own. The header is required:
// there is no fallback to plain TLS, and nothing is ever written to a socket
// that has not been handed over.

import { createServer, type Socket } from "node:net";
import { isLoopback } from "@jarvis/wire";
import { parseProxyV2 } from "./proxy-header.js";

export const PROXY_HEADER_TIMEOUT_MS = 5_000;
// A socket counts against this from accept until it closes, handed over or
// not: `emit("connection")` bypasses the target's own `maxConnections`.
const MAX_CONNECTIONS = 64;

export type ProxyFront = { close(): Promise<void>; port: number };

export type ProxyFrontOptions = {
  host: string;
  port: number;
  target: { emit(event: string, ...args: unknown[]): unknown };
  timeoutMs: number;
};

// Keyed by the raw socket, because that is the only one this module sees: the
// TLS server wraps it in a new `TLSSocket` while handling `emit("connection")`.
const sources = new WeakMap<object, string>();

type SourceSocket = { remoteAddress?: string | undefined };

/**
 * The PROXY header's address for this socket, or `undefined` if none was
 * recorded. Handlers hold the `TLSSocket`, whose `_parent` is the raw socket:
 * an undocumented internal, and Node exposes that link no other way. The
 * integration test covers it only on the Node the tests run on, not the one
 * that ships, so relay mode treats a miss here as a refusal (server.ts).
 */
export function recordedSourceOf(socket: object): string | undefined {
  const { _parent: parent } = socket as { _parent?: object | null };
  return sources.get(socket) ?? (parent ? sources.get(parent) : undefined);
}

/** The recorded source if any, otherwise `remoteAddress`, which behind a front is only the relay. */
export function sourceOf(socket: SourceSocket): string {
  return recordedSourceOf(socket) ?? socket.remoteAddress ?? "";
}

function readHeader(socket: Socket, target: ProxyFrontOptions["target"], timeoutMs: number): void {
  // Holds only what `parseProxyV2` called `need-more`, which is always under
  // PROXY_V2_MAX_BYTES. Past that it has answered `ok` or `invalid`.
  let pending: Buffer = Buffer.alloc(0);
  // A deadline, not `socket.setTimeout`: an idle timer is reset by every byte,
  // so one byte at a time could hold a connection slot for far longer.
  const deadline = setTimeout(() => socket.destroy(), timeoutMs);

  function onData(chunk: Buffer): void {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    const parsed = parseProxyV2(pending);
    if (parsed.kind === "need-more") return;

    clearTimeout(deadline);
    socket.off("data", onData);
    if (parsed.kind === "invalid") {
      socket.destroy();
      return;
    }
    sources.set(socket, parsed.source);
    // Paused and unshifted: `TLSSocket` takes over the handle synchronously,
    // then reads whatever is buffered on the raw socket before anything new.
    socket.pause();
    const rest = pending.subarray(parsed.headerLength);
    if (rest.length > 0) socket.unshift(rest);
    target.emit("connection", socket);
  }

  socket.on("data", onData);
  socket.once("close", () => clearTimeout(deadline));
}

export function listenProxyFront(options: ProxyFrontOptions): Promise<ProxyFront> {
  return new Promise((resolve, reject) => {
    // Loopback keeps forged headers off the network, and no further: any local
    // process can connect to this port and claim any source address. Relay mode
    // trusts every process on this machine that far.
    if (!isLoopback(options.host)) {
      reject(new Error("the PROXY front binds loopback only"));
      return;
    }
    const sockets = new Set<Socket>();
    // noDelay as https itself asks for: it would have applied it on accept.
    const front = createServer({ noDelay: true }, (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      // Swallowed as a bad ClientHello is: expected noise on an open port.
      // Left on after the hand-off, where `TLSSocket` reacts to errors itself.
      socket.on("error", () => {});
      readHeader(socket, options.target, options.timeoutMs);
    });
    front.maxConnections = MAX_CONNECTIONS;

    front.once("error", reject);
    front.once("listening", () => {
      front.off("error", reject);
      // Past this point (EMFILE, say) it goes where the target's own would.
      front.on("error", (error) => options.target.emit("error", error));
      const address = front.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : options.port,
        close() {
          return new Promise<void>((resolveClose, rejectClose) => {
            for (const socket of sockets) socket.destroy();
            front.close((error) => {
              if (error) rejectClose(error);
              else resolveClose();
            });
          });
        },
      });
    });
    front.listen(options.port, options.host);
  });
}
