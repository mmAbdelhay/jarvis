// The sidecar reverse-proxy hop (M11, "sidecar proxy"): the one place that
// actually opens a socket to a loopback sidecar (`code-server`, `dbgate-
// serve`, `headlamp-server`). Everything pure — parsing `/s/{handle}/...`,
// rewriting headers, the handle/key/cookie registry itself — lives in
// proxy-rewrite.ts and sidecar-registry.ts; this file is only the plumbing
// that turns their decisions into a real `http.request`/`net.connect` and
// pipes bytes. Reachable only from server.ts and `@jarvis/remote/listen`
// (listen.ts) — never from the main entry (index.ts), same rule as
// server.ts itself.
//
// Every request is authenticated before a byte of it reaches a sidecar
// (rule 4's "no banner extends to HTTP"): a redeemable one-time `k` or a
// resolvable cookie, or the phone's socket is destroyed with nothing
// written back — never a 401/404, which would itself be a banner. A hop
// error (refused connection, a connect timeout) destroys the phone's own
// socket rather than writing anything about the failure to it (ruling: the
// phone must never learn why a sidecar was unreachable).

import { request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import {
  acceptsHtml,
  cookieFor,
  isPlainHtml,
  parseProxyPath,
  requestHeaders,
  responseHeaders,
  rewriteClusterHtml,
  setCookieHeader,
  takeKey,
} from "./proxy-rewrite.js";
import type { SidecarRegistry, SidecarTarget } from "./sidecar-registry.js";

export type SidecarProxy = {
  handleRequest(request: IncomingMessage, response: ServerResponse): void;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Controller ruling (Task 2 fix round 1): destroys every phone-side socket (a streaming response, a piped upgrade) this proxy currently has open for `deviceId`, returning how many it closed — "a revoked device's handles die with its sockets" made total, not just the registry entries. */
  closeDevice(deviceId: string): number;
};

export type SidecarProxyDeps = {
  registry: SidecarRegistry;
  log(line: string): void;
  connectTimeoutMs?: number;
};

/** Global constraints: the hop to a sidecar has a 10 000 ms connect timeout and no response timeout of its own. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/** Casts a `Duplex` down to the one real-at-runtime method this file needs off it — the same cast server.ts already relies on for the same reason (the event's declared type is generic, the concrete socket is always a `net.Socket`). */
function withSetNoDelay(socket: Duplex): { setNoDelay(enable: boolean): void } {
  return socket as unknown as { setNoDelay(enable: boolean): void };
}

export function createSidecarProxy(deps: SidecarProxyDeps): SidecarProxy {
  const { registry, log } = deps;
  const connectTimeoutMs = deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  // Controller ruling (Task 2 fix round 1): "a revoked device's handles
  // die with its sockets" — the registry alone can't make that true, since
  // an already-piped upgrade or an in-flight streamed response keeps
  // flowing bytes long after its registry entry is gone. Every phone-side
  // socket this proxy currently has open is tracked here by the device
  // whose cookie authenticated it, so `closeDevice` can destroy exactly
  // that device's live connections. `trackedSockets` guards against
  // attaching more than one `close` listener to the same socket — the same
  // `request.socket` resolves for every keep-alive request on one phone
  // connection, and a fresh listener each time would reproduce the exact
  // leak Important #2 (below) fixes.
  const socketsByDevice = new Map<string, Set<Duplex>>();
  const trackedSockets = new WeakSet<Duplex>();

  function trackSocket(deviceId: string, socket: Duplex): void {
    let sockets = socketsByDevice.get(deviceId);
    if (sockets === undefined) {
      sockets = new Set();
      socketsByDevice.set(deviceId, sockets);
    }
    sockets.add(socket);
    if (trackedSockets.has(socket)) return;
    trackedSockets.add(socket);
    socket.once("close", () => {
      trackedSockets.delete(socket);
      for (const [deviceId2, set] of socketsByDevice) {
        set.delete(socket);
        if (set.size === 0) socketsByDevice.delete(deviceId2);
      }
    });
  }

  function closeDevice(deviceId: string): number {
    const sockets = socketsByDevice.get(deviceId);
    if (sockets === undefined) return 0;
    const snapshot = [...sockets];
    for (const socket of snapshot) socket.destroy();
    return snapshot.length;
  }

  /**
   * Streams the sidecar's reply back to the phone once headers are known,
   * and streams the phone's own body in — both directions plain `pipe`s, so
   * an SSE response flows chunk by chunk rather than waiting to buffer
   * (rule 2). A hop error before headers destroys only the phone's socket;
   * after headers, destroying that same socket tears the in-flight response
   * down with it too, since request and response share one TCP connection.
   */
  function forwardRequest(
    request: IncomingMessage,
    response: ServerResponse,
    handle: string,
    target: SidecarTarget,
    rest: string,
  ): void {
    // A Headlamp document is the one body the proxy rewrites (see
    // rewriteClusterHtml) — asked for uncompressed so the bytes are readable,
    // then buffered instead of piped. Everything else streams untouched.
    const rewriteDocument = target.kind === "cluster" && acceptsHtml(request.headers.accept);
    const upstream = httpRequest({
      host: "127.0.0.1",
      port: target.port,
      method: request.method,
      path: rest,
      headers: requestHeaders(request.headers, {
        port: target.port,
        basicAuth: target.basicAuth,
        identity: rewriteDocument,
      }),
      agent: false,
    });

    const connectTimer = setTimeout(() => {
      upstream.destroy(new Error("sidecar connect timeout"));
    }, connectTimeoutMs);

    function clearConnectTimer(): void {
      clearTimeout(connectTimer);
    }

    // The timeout above only ever guards the connect phase — cleared the
    // moment a socket exists and has (or reaches) `connect`, well before any
    // response is expected, so a slow-to-respond sidecar (an SSE stream that
    // idles between events) is never killed by it.
    upstream.once("socket", (socket) => {
      if (socket.connecting) socket.once("connect", clearConnectTimer);
      else clearConnectTimer();
    });

    upstream.on("error", (error) => {
      clearConnectTimer();
      log(`sidecar proxy: hop for ${handle.slice(-4)} failed: ${error.message}`);
      request.socket.destroy();
      upstream.destroy();
    });

    upstream.on("response", (upstreamResponse) => {
      clearConnectTimer();
      const headers = responseHeaders(upstreamResponse.headers, handle);
      if (rewriteDocument && isPlainHtml(upstreamResponse.headers)) {
        const chunks: Buffer[] = [];
        upstreamResponse.on("data", (chunk: Buffer) => chunks.push(chunk));
        upstreamResponse.once("end", () => {
          const body = rewriteClusterHtml(Buffer.concat(chunks).toString("utf8"), handle);
          delete headers["content-length"];
          response.writeHead(upstreamResponse.statusCode ?? 502, {
            ...headers,
            "content-length": Buffer.byteLength(body),
          });
          response.end(body);
        });
        upstreamResponse.once("close", () => {
          if (!upstreamResponse.complete) request.socket.destroy();
        });
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers);
      upstreamResponse.pipe(response);
      // Important #1: a sidecar that drops the connection mid-response
      // never fires "error" on the `ClientRequest` once headers have
      // already arrived — only "close" on the *response*, with `complete`
      // left `false`. `pipe` only ever ends `response` on a clean "end", so
      // without this the phone's connection would hang open forever (rule
      // 2: "after headers were sent -> destroy both" — destroying the
      // phone's socket is "both" here, since request and response share
      // one TCP connection).
      upstreamResponse.once("close", () => {
        if (!upstreamResponse.complete) request.socket.destroy();
      });
    });

    // Important #2: attached to the per-request `response`, never the
    // keep-alive `request.socket` itself (shared by every request on that
    // connection) — a `request.socket.once(...)` here accumulates one
    // listener per request and eventually trips Node's own
    // MaxListenersExceededWarning while keeping every finished `upstream`
    // reachable. `response`'s own "close" fires exactly once, whether the
    // response finished normally (destroying an already-ended `upstream`
    // is a harmless no-op) or the phone hung up mid-request (the case this
    // used to need `request.socket` for).
    response.once("close", () => {
      clearConnectTimer();
      upstream.destroy();
    });

    request.pipe(upstream);
  }

  function handleRequest(request: IncomingMessage, response: ServerResponse): void {
    const parsed = parseProxyPath(request.url ?? "");
    if (parsed === undefined) {
      request.socket.destroy();
      return;
    }
    const { handle, rest } = parsed;

    const keyed = takeKey(rest);
    if (keyed !== undefined) {
      const redeemed = registry.redeemKey(handle, keyed.key);
      if (redeemed === undefined) {
        request.socket.destroy();
        return;
      }
      // Ruling 7: the redirect is path-relative and never carries `k` again
      // — the key is single-use and must not linger in the WebView's
      // address bar once it has done its job.
      response.writeHead(302, {
        location: `/s/${handle}${keyed.rest}`,
        "set-cookie": setCookieHeader(handle, redeemed.cookie),
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      response.end();
      return;
    }

    const cookie = cookieFor(request.headers.cookie, handle);
    const resolved = cookie === undefined ? undefined : registry.resolveCookie(handle, cookie);
    if (resolved === undefined) {
      request.socket.destroy();
      return;
    }

    trackSocket(resolved.deviceId, request.socket);
    forwardRequest(request, response, handle, resolved.target, rest);
  }

  /**
   * Cookie-only auth (a `k` on an upgrade URL is ignored — ruling 10), then
   * a raw two-way pipe to the sidecar: the request line and rewritten
   * headers are written by hand (an upgrade never goes through
   * `http.request`), then whatever bytes already arrived as `head`, then
   * the two sockets are piped straight into each other. No timeout of this
   * file's own applies once connected — only the same 10 000 ms connect
   * guard used for a plain request.
   */
  function handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const parsed = parseProxyPath(request.url ?? "");
    if (parsed === undefined) {
      socket.destroy();
      return;
    }
    const { handle } = parsed;
    // M1: a `k` on an upgrade URL is never redeemed or honoured (ruling
    // 10) — but forwarding it verbatim would land a still-valid 30s
    // one-time key in the sidecar's own access log. `takeKey` only strips
    // it when it's actually well-formed (exactly one, matching
    // KEY_PATTERN); anything else — no `k`, or one that fails validation —
    // passes `rest` through unchanged, exactly as before.
    const rest = takeKey(parsed.rest)?.rest ?? parsed.rest;

    const cookie = cookieFor(request.headers.cookie, handle);
    const resolved = cookie === undefined ? undefined : registry.resolveCookie(handle, cookie);
    if (resolved === undefined) {
      socket.destroy();
      return;
    }
    trackSocket(resolved.deviceId, socket);

    const target = netConnect(resolved.target.port, "127.0.0.1");
    const connectTimer = setTimeout(() => {
      target.destroy();
    }, connectTimeoutMs);

    function teardown(): void {
      clearTimeout(connectTimer);
      socket.destroy();
      target.destroy();
    }

    target.on("error", teardown);
    target.on("close", teardown);
    socket.on("error", teardown);
    socket.on("close", teardown);

    target.once("connect", () => {
      clearTimeout(connectTimer);
      withSetNoDelay(socket).setNoDelay(true);
      target.setNoDelay(true);

      const headers = requestHeaders(request.headers, {
        port: resolved.target.port,
        basicAuth: resolved.target.basicAuth,
        upgrade: true,
      });
      const lines = [`${request.method ?? "GET"} ${rest} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue;
        for (const entry of Array.isArray(value) ? value : [value]) {
          lines.push(`${name}: ${entry}`);
        }
      }
      target.write(`${lines.join("\r\n")}\r\n\r\n`);
      target.write(head);
      socket.pipe(target);
      target.pipe(socket);
    });
  }

  return { handleRequest, handleUpgrade, closeDevice };
}
