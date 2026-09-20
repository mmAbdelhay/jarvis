// The real TLS 1.3 listener: `node:https` terminates the connection,
// `ws` upgrades exactly `/rpc` and `/pair` onto it, and every socket it
// hands the bridge is wrapped down to the plain `SocketLike` the rest of
// this package already tests against doubles. Nothing here is reachable
// from `@jarvis/remote`'s main entry (index.ts) — only `listen.ts` exports
// it, per the "off by default" rule at the package boundary.

import { createServer as createHttpsServer } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { Listen, ListenOptions, Listener } from "./bridge.js";
import { describeError } from "./io.js";
import type { SocketLike } from "./io.js";
import { MAX_TEXT_FRAME_BYTES } from "./protocol.js";
import { parseProxyPath } from "./proxy-rewrite.js";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
const HEADERS_TIMEOUT_MS = 5_000;
// I4: a hard cap on the raw TCP connections this listener will ever accept
// at once — above the bridge's own 8 authenticated + 16 unauthenticated
// application-level caps, this is the backstop against a source that just
// keeps opening TCP connections without ever completing a handshake or a
// pair/hello frame, which those two caps never see.
export const MAX_CONNECTIONS = 64;

/**
 * True only for an upgrade request `ws` itself would accept as a real
 * WebSocket handshake: `Upgrade: websocket` (case-insensitive, per RFC
 * 6455), `Sec-WebSocket-Version: 13`, and a `Sec-WebSocket-Key` that is
 * genuinely the base64 of 16 bytes (round-trips through decode/re-encode
 * unchanged, not merely base64-shaped). Checked here, before
 * `handleUpgrade`, so a malformed attempt gets the socket destroyed instead
 * of `ws`'s own 400/426 response text.
 */
function isWellFormedUpgrade(request: IncomingMessage): boolean {
  const upgrade = request.headers.upgrade;
  if (typeof upgrade !== "string" || upgrade.toLowerCase() !== "websocket") return false;
  if (request.headers["sec-websocket-version"] !== "13") return false;
  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") return false;
  const decoded = Buffer.from(key, "base64");
  return decoded.length === 16 && decoded.toString("base64") === key;
}

/** Wraps a `ws` `WebSocket` down to the plain `SocketLike` the rest of this package tests against. */
function toSocketLike(ws: WebSocket): SocketLike {
  return {
    send(text) {
      // Only while actually open — a close racing a queued push must never
      // throw, and `ws` itself would throw synchronously on a closed socket.
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    terminate() {
      ws.terminate();
    },
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
  };
}

export const listenTls: Listen = (options: ListenOptions): Promise<Listener> => {
  return new Promise((resolve, reject) => {
    const httpsServer = createHttpsServer({
      cert: options.cert,
      key: options.key,
      minVersion: "TLSv1.3",
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
      // Node only checks the header/request timeouts above against the
      // clock this often (default 30s) — left at the default, garbage sent
      // over an otherwise-idle socket sits unrefused for up to 30s before
      // `requestTimeout` is even noticed. Checking every 1s is what makes
      // that timeout mean something close to what it says.
      connectionsCheckingInterval: 1_000,
    });
    httpsServer.maxConnections = MAX_CONNECTIONS;

    // Never a banner, never a stack trace: a non-upgrade, non-sidecar
    // request gets the wire pulled, not a response (rule 2 — no Origin
    // check either, so there is nothing here to leak by responding at
    // all). A `/s/{handle}/...` request is handed to the injected proxy
    // instead — but only while one is actually configured (M11 rule 1):
    // `options.proxy` is `undefined` whenever the sidecar gate isn't "on",
    // and nothing under `/s/` is ever served in that case either.
    httpsServer.on("request", (request, response) => {
      if (options.proxy !== undefined && parseProxyPath(request.url ?? "") !== undefined) {
        options.proxy.handleRequest(request, response);
        return;
      }
      request.socket.destroy();
    });

    // Swallowed rather than logged: a malformed ClientHello or a probing
    // scanner is expected noise on an open port, not an operator's problem.
    httpsServer.on("tlsClientError", () => {});

    // Three more paths Node itself would otherwise answer before this
    // module gets a say: garbage bytes get Node's own default 400 response,
    // `Expect: 100-continue` gets a "100 Continue" written back, and an
    // upgrade Node itself doesn't like would get `ws`'s own 400/426 text.
    // None of that is "no banner before auth" — the wire goes dead instead,
    // exactly like the destroyed sockets above.
    httpsServer.on("clientError", (_error, socket) => {
      socket.destroy();
    });
    httpsServer.on("checkContinue", (request) => {
      request.socket.destroy();
    });
    httpsServer.on("checkExpectation", (request) => {
      request.socket.destroy();
    });

    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_TEXT_FRAME_BYTES,
      perMessageDeflate: false,
      clientTracking: false,
    });

    httpsServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = request.url;
      const kind = url === "/rpc" ? "rpc" : url === "/pair" ? "pair" : undefined;
      if (kind === undefined) {
        // Not `/rpc` or `/pair`: a sidecar upgrade if a proxy is configured
        // and the path parses, otherwise the same dead wire as any other
        // unrecognised request. `isWellFormedUpgrade` is deliberately not
        // applied here — the sidecar decides what upgrade shape it wants;
        // a malformed one still dies at the proxy's own auth checks.
        if (options.proxy !== undefined && parseProxyPath(url ?? "") !== undefined) {
          options.proxy.handleUpgrade(request, socket, head);
          return;
        }
        socket.destroy();
        return;
      }
      // Malformed-upgrade bytes must never reach `ws`'s own `handleUpgrade`
      // — it answers a bad upgrade with 400/426 response text of its own,
      // which is exactly the banner-before-auth this listener refuses to
      // give anyone else.
      if (!isWellFormedUpgrade(request)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        // The upgrade event's socket is typed as the generic `Duplex`, but
        // an HTTPS server's connections are always `net.Socket` (here, a
        // `tls.TLSSocket`, which extends it) — `setNoDelay` is real at
        // runtime even though the declared type doesn't carry it.
        if (kind === "rpc")
          (socket as unknown as { setNoDelay(enable: boolean): void }).setNoDelay(true);
        const adapter = toSocketLike(ws);
        const handlers = options.onSocket(kind, adapter, request.socket.remoteAddress ?? "");
        ws.on("message", (data: Buffer, isBinary: boolean) => {
          // A binary frame's byte cap (MAX_BLOB_CHUNK_BYTES) is enforced
          // twice: `ws`'s own `maxPayload` (below, MAX_TEXT_FRAME_BYTES)
          // already closes 1009 before this handler ever runs for any
          // single frame over 1 MiB, and connection.ts checks the tighter
          // per-chunk bound itself once a blob is actually in flight — the
          // frame it hands off here (`data`, a `Buffer`, which is a
          // `Uint8Array`) is passed through unmodified either way.
          if (isBinary) handlers.onBinary(data);
          else handlers.onText(data.toString("utf8"));
        });
        ws.on("close", (code: number) => {
          handlers.onClose(code);
        });
        ws.on("error", () => {
          // ws starts a protocol close before emitting receiver errors.
          // Keep that handshake so peers receive the 1009/1002 code.
          if (ws.readyState !== WebSocket.CLOSING) ws.terminate();
        });
      });
    });

    // Every socket the https server itself accepts (before, during or
    // after any upgrade), so `close()` below can force them all shut
    // rather than waiting for clients that never disconnect on their own.
    const sockets = new Set<Duplex>();
    httpsServer.on("connection", (socket: Duplex) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });

    function onListenError(error: Error): void {
      httpsServer.off("listening", onListening);
      reject(error);
    }

    function onListening(): void {
      httpsServer.off("error", onListenError);
      // Past this point a listen failure is no longer this promise's to
      // reject — an `error` here (EMFILE, say) must not crash the process
      // for want of any listener at all. `ListenOptions` carries `log`, so
      // a post-listen error is reported through it rather than swallowed
      // outright.
      httpsServer.on("error", (error: Error) => {
        options.log(`remote server: ${describeError(error)}`);
      });
      const address = httpsServer.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      resolve({
        port,
        close() {
          return new Promise<void>((resolveClose, rejectClose) => {
            for (const socket of sockets) socket.destroy();
            httpsServer.close((error) => {
              if (error) rejectClose(error);
              else resolveClose();
            });
          });
        },
      });
    }

    httpsServer.once("error", onListenError);
    httpsServer.once("listening", onListening);
    httpsServer.listen(options.port, options.host);
  });
};
