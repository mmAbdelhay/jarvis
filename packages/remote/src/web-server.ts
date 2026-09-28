import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";

const HANDSHAKE_TIMEOUT_MS = 5_000;
const REQUEST_TIMEOUT_MS = 5_000;
const HEADERS_TIMEOUT_MS = 5_000;
const MAX_CONNECTIONS = 64;
const ETAG_PREFIX_LENGTH = 16;
const TERMINAL_PATH = "/terminal.html";

export type WebAsset = { bytes: Buffer; type: string; etag: string };
export type WebManifest = ReadonlyMap<string, WebAsset>;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff2: "font/woff2",
  ttf: "font/ttf",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
};

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

export function buildWebManifest(files: Iterable<{ path: string; bytes: Buffer }>): WebManifest {
  const manifest = new Map<string, WebAsset>();
  for (const file of files) {
    const digest = createHash("sha256").update(file.bytes).digest("base64url");
    manifest.set(file.path, {
      bytes: file.bytes,
      type: contentType(file.path),
      etag: `"${digest.slice(0, ETAG_PREFIX_LENGTH)}"`,
    });
  }
  return manifest;
}

export function webHeaders(options: {
  name: string;
  bridgePort: number;
  path: string;
  asset: WebAsset;
}): Record<string, string> {
  const cacheControl = options.path.startsWith("/_expo/static/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  // The app renders its terminal in a sandboxed <iframe src="/terminal.html">,
  // so that one exact path may be framed by the app's own origin. Every other
  // response, index.html included, still refuses to be framed at all.
  const frameAncestors = options.path === TERMINAL_PATH ? "'self'" : "'none'";
  return {
    "Content-Security-Policy": `default-src 'self'; script-src 'self'; connect-src wss://${options.name}:${options.bridgePort}; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors ${frameAncestors}; base-uri 'none'; form-action 'none'`,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Type": options.asset.type,
    ETag: options.asset.etag,
    "Cache-Control": cacheControl,
  };
}

type RequestHandlerOptions = {
  name: string;
  port: number;
  bridgePort: number;
  manifest: WebManifest;
};

/**
 * The request's path with the query stripped, or `undefined` when it must be
 * refused: not origin-form (absolute-form, `*`, empty), or carrying `..`, a
 * backslash or NUL — literally or percent-encoded — or malformed encoding.
 */
function safePath(url: string): string | undefined {
  const path = url.split("?", 1)[0] ?? "";
  if (!path.startsWith("/")) return undefined;
  if (path.includes("..") || path.includes("\\") || path.includes("\0")) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return undefined;
  }
  if (decoded.includes("..") || decoded.includes("\\") || decoded.includes("\0")) return undefined;
  return path;
}

/** Host lines as sent; Node's parsed `headers.host` keeps only the first of duplicates. */
function hostLineCount(rawHeaders: readonly string[]): number {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i]?.toLowerCase() === "host") count++;
  }
  return count;
}

export function createWebRequestHandler(
  options: RequestHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => void {
  const expectedHost = options.port === 443 ? options.name : `${options.name}:${options.port}`;
  return (request, response) => {
    // Any Upgrade header is refused here too: Node only raises 'upgrade'
    // when Connection also says upgrade, so this closes the other half.
    if (
      request.headers.host !== expectedHost ||
      hostLineCount(request.rawHeaders) !== 1 ||
      (request.method !== "GET" && request.method !== "HEAD") ||
      request.headers.upgrade !== undefined
    ) {
      request.socket.destroy();
      return;
    }

    const requestedPath = safePath(request.url ?? "");
    if (requestedPath === undefined) {
      request.socket.destroy();
      return;
    }

    let servedPath = requestedPath;
    let asset = options.manifest.get(requestedPath);
    if (asset === undefined) {
      const lastSegment = requestedPath.slice(requestedPath.lastIndexOf("/") + 1);
      if (lastSegment.includes(".")) {
        request.socket.destroy();
        return;
      }
      servedPath = "/index.html";
      asset = options.manifest.get(servedPath);
    }
    if (asset === undefined) {
      request.socket.destroy();
      return;
    }

    // The SPA fallback is headered as /index.html (no-cache), never as the
    // requested path — an extension-less path under /_expo/static/ must not
    // pin index.html as immutable for a year.
    for (const [name, value] of Object.entries(
      webHeaders({ name: options.name, bridgePort: options.bridgePort, path: servedPath, asset }),
    )) {
      response.setHeader(name, value);
    }
    if (request.headers["if-none-match"] === asset.etag) {
      response.statusCode = 304;
      response.end();
      return;
    }
    response.statusCode = 200;
    response.setHeader("Content-Length", String(asset.bytes.length));
    response.end(request.method === "HEAD" ? undefined : asset.bytes);
  };
}

type ListenerSocket = Duplex & { destroy(): void };
type WebServer = {
  maxConnections: number;
  on(event: string, listener: (...args: never[]) => void): WebServer;
  once(event: string, listener: (...args: never[]) => void): WebServer;
  off(event: string, listener: (...args: never[]) => void): WebServer;
  listen(port: number, host: string): WebServer;
  address(): string | { port: number } | null;
  close(callback: (error?: Error) => void): WebServer;
};

export type ListenWebOptions = RequestHandlerOptions & {
  host: string;
  cert: string | Buffer;
  key: string | Buffer;
  createServer?: (options: Record<string, unknown>) => unknown;
};

export function listenWeb(
  options: ListenWebOptions,
): Promise<{ close(): Promise<void>; port: number }> {
  return new Promise((resolve, reject) => {
    const makeServer = options.createServer ?? createHttpsServer;
    const server = makeServer({
      cert: options.cert,
      key: options.key,
      minVersion: "TLSv1.3",
      // Node's default answers a Host-less HTTP/1.1 request with its own
      // "400 Bad Request" before the handler runs; the handler drops it instead.
      requireHostHeader: false,
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
      requestTimeout: REQUEST_TIMEOUT_MS,
      headersTimeout: HEADERS_TIMEOUT_MS,
      connectionsCheckingInterval: 1_000,
    }) as WebServer;
    server.maxConnections = MAX_CONNECTIONS;

    // The Host check needs the port actually bound (port 0 in tests), so the
    // handler is built once listening; no request can arrive before that.
    let handleRequest: ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
    server.on("request", ((request: IncomingMessage, response: ServerResponse) => {
      if (handleRequest === undefined) request.socket.destroy();
      else handleRequest(request, response);
    }) as (...args: never[]) => void);
    // Swallowed rather than logged, as in server.ts: a bad ClientHello is
    // expected noise on an open port.
    server.on("tlsClientError", (() => {}) as (...args: never[]) => void);
    server.on("clientError", ((_error: Error, socket: ListenerSocket) => socket.destroy()) as (
      ...args: never[]
    ) => void);
    server.on("upgrade", ((_request: IncomingMessage, socket: ListenerSocket) =>
      socket.destroy()) as (...args: never[]) => void);
    server.on("checkContinue", ((request: IncomingMessage) => request.socket.destroy()) as (
      ...args: never[]
    ) => void);
    server.on("checkExpectation", ((request: IncomingMessage) => request.socket.destroy()) as (
      ...args: never[]
    ) => void);

    const sockets = new Set<ListenerSocket>();
    server.on("connection", ((socket: ListenerSocket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    }) as (...args: never[]) => void);

    function onListenError(error: Error): void {
      server.off("listening", onListening as (...args: never[]) => void);
      reject(error);
    }

    function onListening(): void {
      server.off("error", onListenError as (...args: never[]) => void);
      server.on("error", (() => {}) as (...args: never[]) => void);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : options.port;
      handleRequest = createWebRequestHandler({ ...options, port });
      resolve({
        port,
        close() {
          return new Promise<void>((resolveClose, rejectClose) => {
            for (const socket of sockets) socket.destroy();
            server.close((error) => {
              if (error) rejectClose(error);
              else resolveClose();
            });
          });
        },
      });
    }

    server.once("error", onListenError as (...args: never[]) => void);
    server.once("listening", onListening as (...args: never[]) => void);
    server.listen(options.port, options.host);
  });
}
