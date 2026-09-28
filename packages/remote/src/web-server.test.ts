import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mintSelfSigned } from "./certificate.js";
import {
  buildWebManifest,
  createWebRequestHandler,
  listenWeb,
  webHeaders,
  type WebAsset,
} from "./web-server.js";

const INDEX: WebAsset = {
  bytes: Buffer.from("<main>Jarvis</main>"),
  type: "text/html; charset=utf-8",
  etag: '"index-etag"',
};
const SCRIPT: WebAsset = {
  bytes: Buffer.from("console.log('jarvis')"),
  type: "text/javascript; charset=utf-8",
  etag: '"script-etag"',
};
const TERMINAL: WebAsset = {
  bytes: Buffer.from("<main>terminal</main>"),
  type: "text/html; charset=utf-8",
  etag: '"terminal-etag"',
};
const MANIFEST = new Map([
  ["/index.html", INDEX],
  ["/terminal.html", TERMINAL],
  ["/_expo/static/js/web/entry-abc123.js", SCRIPT],
]);

type FakeSocket = { destroy: ReturnType<typeof vi.fn> };

function request(
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage & { socket: FakeSocket } {
  const merged = {
    method: "GET",
    url: "/index.html",
    headers: { host: "jarvis.test:8443" },
    socket: { destroy: vi.fn() },
    ...overrides,
  };
  // Node's parsed `headers` keeps only the first Host; `rawHeaders` keeps every line.
  const rawHeaders =
    overrides.rawHeaders ??
    Object.entries(merged.headers).flatMap(([name, value]) => [name, String(value)]);
  return { ...merged, rawHeaders } as IncomingMessage & { socket: FakeSocket };
}

function response(): ServerResponse & {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
} {
  const result = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: Buffer.alloc(0) as Buffer,
    setHeader(name: string, value: string) {
      result.headers[name] = value;
      return result;
    },
    end(chunk?: Buffer) {
      if (chunk !== undefined) result.body = chunk;
      return result;
    },
  };
  return result as unknown as ReturnType<typeof response>;
}

function handle(overrides: Partial<IncomingMessage> = {}) {
  const req = request(overrides);
  const res = response();
  createWebRequestHandler({
    name: "jarvis.test",
    port: 8443,
    bridgePort: 9443,
    manifest: MANIFEST,
  })(req, res);
  return { req, res };
}

describe("buildWebManifest", () => {
  it("maps URL paths to bytes, extension content types, and strong sha256 base64url etags", () => {
    const bytes = Buffer.from("hello");
    const manifest = buildWebManifest([
      { path: "/index.html", bytes },
      { path: "/asset.unknown", bytes },
    ]);

    expect(manifest.get("/index.html")).toEqual({
      bytes,
      type: "text/html; charset=utf-8",
      etag: '"LPJNul-wow4m6Dsq"',
    });
    expect(manifest.get("/asset.unknown")?.type).toBe("application/octet-stream");
  });

  it.each([
    ["js", "text/javascript; charset=utf-8"],
    ["css", "text/css; charset=utf-8"],
    ["json", "application/json; charset=utf-8"],
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
    ["svg", "image/svg+xml"],
    ["ico", "image/x-icon"],
    ["woff2", "font/woff2"],
    ["ttf", "font/ttf"],
    ["map", "application/json; charset=utf-8"],
    ["txt", "text/plain; charset=utf-8"],
    ["webmanifest", "application/manifest+json; charset=utf-8"],
  ])("uses the specified .%s content type", (extension, type) => {
    const asset = buildWebManifest([{ path: `/asset.${extension}`, bytes: Buffer.alloc(0) }]).get(
      `/asset.${extension}`,
    );
    expect(asset?.type).toBe(type);
  });
});

describe("webHeaders", () => {
  it("returns the exact security policy and ordinary no-cache asset headers", () => {
    expect(
      webHeaders({ name: "jarvis.test", bridgePort: 9443, path: "/app.json", asset: SCRIPT }),
    ).toEqual({
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; connect-src wss://jarvis.test:9443; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Type": "text/javascript; charset=utf-8",
      ETag: '"script-etag"',
      "Cache-Control": "no-cache",
    });
  });

  it("lets only /terminal.html be framed, and only by the app's own origin", () => {
    expect(
      webHeaders({
        name: "jarvis.test",
        bridgePort: 9443,
        path: "/terminal.html",
        asset: TERMINAL,
      })["Content-Security-Policy"],
    ).toBe(
      "default-src 'self'; script-src 'self'; connect-src wss://jarvis.test:9443; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    );
  });

  it.each([
    "/index.html",
    "/terminal.htm",
    "/terminal.html/",
    "/x/terminal.html",
    "/Terminal.html",
    "/terminal.86caae84490bea57.js",
  ])("keeps frame-ancestors 'none' for %s", (path) => {
    expect(
      webHeaders({ name: "jarvis.test", bridgePort: 9443, path, asset: INDEX })[
        "Content-Security-Policy"
      ],
    ).toBe(
      "default-src 'self'; script-src 'self'; connect-src wss://jarvis.test:9443; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
  });

  it.each([
    ["/index.html", "no-cache"],
    ["/projects/alpha", "no-cache"],
    ["/_expo/static/js/web/entry-abc123.js", "public, max-age=31536000, immutable"],
  ])("uses the required cache policy for %s", (path, expected) => {
    expect(
      webHeaders({ name: "jarvis.test", bridgePort: 9443, path, asset: INDEX })["Cache-Control"],
    ).toBe(expected);
  });
});

describe("createWebRequestHandler", () => {
  it("serves an exact GET with headers and body", () => {
    const { req, res } = handle({ url: "/_expo/static/js/web/entry-abc123.js?cache=ignored" });
    expect(req.socket.destroy).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.headers.ETag).toBe('"script-etag"');
    expect(res.body).toEqual(SCRIPT.bytes);
  });

  it("serves /terminal.html (query ignored) framable by 'self', and index.html not", () => {
    const terminal = handle({ url: "/terminal.html?v=1" }).res;
    expect(terminal.body).toEqual(TERMINAL.bytes);
    expect(terminal.headers["Content-Security-Policy"]).toContain("frame-ancestors 'self';");
    const index = handle({ url: "/" }).res;
    expect(index.body).toEqual(INDEX.bytes);
    expect(index.headers["Content-Security-Policy"]).toContain("frame-ancestors 'none';");
  });

  it("serves HEAD headers without a body", () => {
    const { res } = handle({ method: "HEAD" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(res.body).toEqual(Buffer.alloc(0));
  });

  it("returns 304 with headers and no body for an exact If-None-Match", () => {
    const { res } = handle({
      headers: { host: "jarvis.test:8443", "if-none-match": '"index-etag"' },
    });
    expect(res.statusCode).toBe(304);
    expect(res.headers.ETag).toBe('"index-etag"');
    expect(res.body).toEqual(Buffer.alloc(0));
  });

  it("serves index.html with no-cache for an extension-less SPA path", () => {
    const { res } = handle({ url: "/projects/alpha?tab=files" });
    expect(res.body).toEqual(INDEX.bytes);
    expect(res.headers["Cache-Control"]).toBe("no-cache");
  });

  it("serves an extension-less path under /_expo/static/ as index.html with no-cache, never immutable", () => {
    const { res } = handle({ url: "/_expo/static/js/web/unknown" });
    expect(res.body).toEqual(INDEX.bytes);
    expect(res.headers["Cache-Control"]).toBe("no-cache");
  });

  it("sets Content-Length on GET and HEAD", () => {
    expect(handle({}).res.headers["Content-Length"]).toBe(String(INDEX.bytes.length));
    expect(handle({ method: "HEAD" }).res.headers["Content-Length"]).toBe(
      String(INDEX.bytes.length),
    );
  });

  it.each([
    ["wrong Host", { headers: { host: "evil.test:8443" } }],
    ["IP Host", { headers: { host: "127.0.0.1:8443" } }],
    ["missing Host", { headers: {} }],
    ["POST", { method: "POST" }],
    ["unknown extension", { url: "/missing.js" }],
    ["literal traversal", { url: "/../index.html" }],
    ["backslash traversal", { url: "/..\\index.html" }],
    ["encoded traversal", { url: "/%2e%2e/index.html" }],
    ["encoded backslash", { url: "/%5cindex.html" }],
    ["encoded NUL", { url: "/asset%00.js" }],
    ["malformed encoding", { url: "/asset%ZZ" }],
    [
      "duplicate Host",
      {
        headers: { host: "jarvis.test:8443" },
        rawHeaders: ["Host", "jarvis.test:8443", "host", "evil.test:8443"],
      },
    ],
    [
      "Upgrade header on a plain request",
      { headers: { host: "jarvis.test:8443", upgrade: "websocket" } },
    ],
    ["absolute-form URL", { url: "https://jarvis.test:8443/projects" }],
    ["asterisk URL", { url: "*" }],
    ["empty URL", { url: "" }],
    ["port-443 bare Host on another port", { headers: { host: "jarvis.test" } }],
    ["uppercase Host", { headers: { host: "JARVIS.TEST:8443" } }],
  ] satisfies [string, Partial<IncomingMessage>][])(
    "destroys the socket for %s",
    (_label, overrides) => {
      const { req, res } = handle(overrides);
      expect(req.socket.destroy).toHaveBeenCalledOnce();
      expect(res.body).toEqual(Buffer.alloc(0));
      expect(res.headers).toEqual({});
    },
  );

  it("accepts the bare name as Host only on port 443", () => {
    const req = request({ headers: { host: "jarvis.test" } });
    const res = response();
    createWebRequestHandler({
      name: "jarvis.test",
      port: 443,
      bridgePort: 9443,
      manifest: MANIFEST,
    })(req, res);
    expect(req.socket.destroy).not.toHaveBeenCalled();
    expect(res.body).toEqual(INDEX.bytes);
  });
});

class FakeServer extends EventEmitter {
  options: Record<string, unknown> = {};
  maxConnections = 0;
  listened?: { port: number; host: string };
  closed = false;

  listen(port: number, host: string) {
    this.listened = { port, host };
    queueMicrotask(() => this.emit("listening"));
    return this;
  }

  address() {
    return { address: "127.0.0.1", family: "IPv4", port: 43210 };
  }

  close(callback: (error?: Error) => void) {
    this.closed = true;
    callback();
    return this;
  }
}

describe("listenWeb", () => {
  it("creates a TLS 1.3 listener, wires refusal events, reports the bound port, and closes", async () => {
    const server = new FakeServer();
    const createServer = vi.fn((options: Record<string, unknown>) => {
      server.options = options;
      return server;
    });
    const listener = await listenWeb({
      host: "127.0.0.1",
      port: 0,
      cert: "cert",
      key: "key",
      name: "jarvis.test",
      bridgePort: 9443,
      manifest: MANIFEST,
      createServer,
    });

    expect(server.options).toMatchObject({ cert: "cert", key: "key", minVersion: "TLSv1.3" });
    expect(server.listened).toEqual({ port: 0, host: "127.0.0.1" });
    expect(listener.port).toBe(43210);

    expect(server.listenerCount("tlsClientError")).toBe(1);
    for (const event of ["clientError", "upgrade"] as const) {
      const socket = { destroy: vi.fn() };
      if (event === "clientError") server.emit(event, new Error("bad"), socket);
      else server.emit(event, request(), socket, Buffer.alloc(0));
      expect(socket.destroy).toHaveBeenCalledOnce();
    }
    for (const event of ["checkContinue", "checkExpectation"] as const) {
      const req = request();
      server.emit(event, req, response());
      expect(req.socket.destroy).toHaveBeenCalledOnce();
    }

    const openSocket = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
    openSocket.destroy = vi.fn();
    server.emit("connection", openSocket);
    await listener.close();
    expect(openSocket.destroy).toHaveBeenCalledOnce();
    expect(server.closed).toBe(true);
  });
});

/** Raw HTTP/1.1 over TLS so a refusal can be checked for zero response bytes. */
function rawExchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      socket.write(request);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.setTimeout(5_000, () => socket.destroy(new Error("timed out")));
  });
}

describe("listenWeb over real TLS", () => {
  let listener: { close(): Promise<void>; port: number };

  beforeAll(async () => {
    const { cert, key } = await mintSelfSigned(Date.now(), "0a0b0c0d0e0f1011");
    listener = await listenWeb({
      host: "127.0.0.1",
      port: 0,
      cert,
      key,
      name: "jarvis.test",
      bridgePort: 9443,
      manifest: MANIFEST,
    });
  });

  afterAll(async () => {
    await listener.close();
  });

  function get(
    path: string,
    host: string,
    extra = "",
    method = "GET",
    connection = "close",
  ): Promise<string> {
    return rawExchange(
      listener.port,
      `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\n${extra}Connection: ${connection}\r\n\r\n`,
    );
  }

  it("serves index.html with the exact CSP when Host matches the bound port", async () => {
    const reply = await get("/projects/alpha", `jarvis.test:${listener.port}`);
    expect(reply.startsWith("HTTP/1.1 200")).toBe(true);
    expect(reply).toContain(
      "Content-Security-Policy: default-src 'self'; script-src 'self'; connect-src wss://jarvis.test:9443;",
    );
    expect(reply.endsWith("<main>Jarvis</main>")).toBe(true);
  });

  it("answers 304 for a matching If-None-Match", async () => {
    const reply = await get(
      "/index.html",
      `jarvis.test:${listener.port}`,
      'If-None-Match: "index-etag"\r\n',
    );
    expect(reply.startsWith("HTTP/1.1 304")).toBe(true);
    expect(reply).toContain('ETag: "index-etag"');
    // Zero body bytes: the reply ends at the blank line closing the headers.
    expect(reply.indexOf("\r\n\r\n")).toBe(reply.length - 4);
  });

  it.each([
    ["wrong Host", () => get("/index.html", `evil.test:${listener.port}`)],
    [
      "missing Host",
      () => rawExchange(listener.port, "GET /index.html HTTP/1.1\r\nConnection: close\r\n\r\n"),
    ],
    [
      "duplicate Host",
      () =>
        get("/index.html", `jarvis.test:${listener.port}`, `Host: evil.test:${listener.port}\r\n`),
    ],
    ["IP Host", () => get("/index.html", `127.0.0.1:${listener.port}`)],
    [
      "POST",
      () => get("/index.html", `jarvis.test:${listener.port}`, "Content-Length: 0\r\n", "POST"),
    ],
    ["unknown .js", () => get("/missing.js", `jarvis.test:${listener.port}`)],
    [
      "upgrade",
      () =>
        get(
          "/index.html",
          `jarvis.test:${listener.port}`,
          "Upgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
          "GET",
          "Upgrade",
        ),
    ],
    [
      "Upgrade header without Connection: upgrade",
      () => get("/index.html", `jarvis.test:${listener.port}`, "Upgrade: websocket\r\n"),
    ],
    [
      "Expect: 100-continue",
      () => get("/index.html", `jarvis.test:${listener.port}`, "Expect: 100-continue\r\n"),
    ],
    ["garbage", () => rawExchange(listener.port, "NOT HTTP AT ALL\r\n\r\n")],
  ])("destroys %s with zero response bytes", async (_label, send) => {
    expect(await send()).toBe("");
  });
});
