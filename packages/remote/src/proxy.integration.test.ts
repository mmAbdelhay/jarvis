// The second real-network test in this package (alongside
// bridge.integration.test.ts, global constraints): a real TLS listener
// (server.ts) with a real self-signed certificate (certificate.ts, under a
// throwaway temp dir) in front of a real loopback `node:http` target
// server, proxying `/s/{handle}/...` through a real `SidecarRegistry` (real
// `randomBytes`, real `Date.now`). Everything pure — the handle/key/cookie
// rules, the header rewriting — is unit-tested in sidecar-registry.test.ts
// and proxy-rewrite.test.ts; this file is the one place that proves the
// wiring between them and an actual socket streams, redirects and rewrites
// the way those unit tests assume it does. It goes straight to `listenTls`
// + `createSidecarProxy` rather than through `createBridge` — the bridge's
// own gate/status wiring is bridge.test.ts's job, not this file's.
//
// The client here is plain `node:https`/`node:tls` with `rejectUnauthorized:
// false` — test-only: verifying the self-signed certificate would mean
// pinning its fingerprint the way the phone does (M6), which
// bridge.integration.test.ts already proves works end to end and which
// this file has no need to repeat.

import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Listener } from "./bridge.js";
import { loadCertificate } from "./certificate.js";
import { nodeFs } from "./node-io.js";
import { createSidecarProxy } from "./proxy.js";
import { setCookieHeader } from "./proxy-rewrite.js";
import { createSidecarRegistry } from "./sidecar-registry.js";
import type { SidecarRegistry } from "./sidecar-registry.js";
import { listenTls } from "./server.js";

const ENFORCE_FILE_MODES = process.platform !== "win32";

// test-only: this listener's certificate is a fresh self-signed pair with
// no DNS SAN, the same shape M6's phone pins by fingerprint rather than
// trusting via a name — verifying it here would only repeat
// bridge.integration.test.ts's own pinning proof.
const insecureAgent = new Agent({ rejectUnauthorized: false });

type Response = { status: number; headers: NodeJS.Dict<string | string[]>; body: string };

function request(options: {
  host: string;
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        agent: insecureAgent,
        host: options.host,
        port: options.port,
        method: options.method ?? "GET",
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Same as `request`, but a server that destroys the socket (never answers) resolves with zero bytes rather than rejecting — exactly what "no banner before auth" (rule 2) looks like from a real client. */
function requestExpectingClose(options: {
  host: string;
  port: number;
  path: string;
  headers?: Record<string, string>;
}): Promise<{ received: number }> {
  return new Promise((resolve) => {
    let received = 0;
    const req = httpsRequest(
      {
        agent: insecureAgent,
        host: options.host,
        port: options.port,
        method: "GET",
        path: options.path,
        headers: options.headers,
      },
      (res) => {
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
        });
        res.on("end", () => resolve({ received }));
      },
    );
    req.on("error", () => resolve({ received }));
    req.end();
  });
}

/** Pulls the 64-hex cookie value out of a `Set-Cookie` line shaped like `setCookieHeader` produces. */
function extractCookie(setCookie: string | string[] | undefined): string {
  const line = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = /=([0-9a-f]{64});/.exec(line ?? "");
  if (match?.[1] === undefined) throw new Error(`no cookie found in ${JSON.stringify(setCookie)}`);
  return match[1];
}

/** A bare TLS connection to the proxy listener — the upgrade test needs byte-level control (writing `head` bytes inline with the handshake) that `node:https`'s own upgrade support can't give it. */
function rawConnect(host: string, port: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { host, port, rejectUnauthorized: false, minVersion: "TLSv1.3" },
      () => {
        socket.off("error", reject);
        resolve(socket);
      },
    );
    socket.once("error", reject);
  });
}

/** Reserves a loopback port, then frees it immediately — a number nothing is listening on, so a connection to it refuses instead of timing out. */
async function reserveClosedPort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

type TargetHandler = (req: IncomingMessage, res: ServerResponse) => void;
type TargetUpgradeHandler = (req: IncomingMessage, socket: TLSSocket, head: Buffer) => void;

describe("proxy.integration", () => {
  let dir: string;
  let listener: Listener;
  let port: number;
  let target: HttpServer;
  let targetPort: number;
  let registry: SidecarRegistry;
  // Hoisted so the closeDevice bite-proof can call it directly, the same
  // instance `listenTls` was handed — `handleRequest`/`handleUpgrade` are
  // reached only through the real listener above, but `closeDevice` is a
  // control-plane call the bridge itself makes, not something a phone-side
  // request ever triggers.
  let proxy: ReturnType<typeof createSidecarProxy>;
  let seenByTarget: IncomingMessage[] = [];
  let currentHandler: TargetHandler = (_req, res) => {
    res.writeHead(200);
    res.end();
  };
  let currentUpgradeHandler: TargetUpgradeHandler = (_req, socket) => socket.destroy();

  beforeEach(() => {
    seenByTarget = [];
    currentHandler = (_req, res) => {
      res.writeHead(200);
      res.end();
    };
    currentUpgradeHandler = (_req, socket) => socket.destroy();
  });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jarvis-proxy-"));
    const random = (size: number) => randomBytes(size);

    const material = await loadCertificate(
      {},
      { fs: nodeFs, dir, random, now: Date.now, enforceFileModes: ENFORCE_FILE_MODES },
    );

    registry = createSidecarRegistry({ random, now: Date.now });

    target = createHttpServer((req, res) => {
      seenByTarget.push(req);
      currentHandler(req, res);
    });
    target.on("upgrade", (req, socket, head) => {
      currentUpgradeHandler(req, socket as TLSSocket, head);
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    targetPort =
      typeof targetAddress === "object" && targetAddress !== null ? targetAddress.port : 0;

    proxy = createSidecarProxy({ registry, log: () => {} });
    listener = await listenTls({
      host: "127.0.0.1",
      port: 0,
      cert: material.cert,
      key: material.key,
      proxy,
      onSocket: () => ({ onText() {}, onBinary() {}, onClose() {} }),
      log: () => {},
    });
    port = listener.port;
  });

  afterAll(async () => {
    await listener.close();
    await new Promise<void>((resolve) => target.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("(a) a key redeem responds 302 with an exact cookie, empty body, and never touches the target", async () => {
    const { handle, key } = registry.publish("device-a", { kind: "editor", port: targetPort });

    const res = await request({ host: "127.0.0.1", port, path: `/s/${handle}/?k=${key}` });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/s/${handle}/`);
    expect(res.body).toBe("");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(seenByTarget).toHaveLength(0);

    const cookieValue = extractCookie(res.headers["set-cookie"]);
    expect(res.headers["set-cookie"]).toEqual([setCookieHeader(handle, cookieValue)]);
  });

  it("[final review] a post-redeem request never forwards a referer containing the one-time key", async () => {
    const { handle, key } = registry.publish("device-referer", {
      kind: "editor",
      port: targetPort,
    });
    const keyedPath = `/s/${handle}/?k=${key}`;
    const redeem = await request({ host: "127.0.0.1", port, path: keyedPath });
    const cookie = extractCookie(redeem.headers["set-cookie"]);

    await request({
      host: "127.0.0.1",
      port,
      path: redeem.headers.location as string,
      headers: {
        cookie: `jarvis_s_${handle}=${cookie}`,
        referer: `https://phone.example${keyedPath}`,
      },
    });

    const seen = seenByTarget.at(-1);
    expect(seen?.url).toBe("/");
    expect(seen?.headers.referer).toBeUndefined();
  });

  it("(b) reusing the same key closes the socket with no bytes", async () => {
    const { handle, key } = registry.publish("device-b", { kind: "editor", port: targetPort });
    await request({ host: "127.0.0.1", port, path: `/s/${handle}/?k=${key}` });

    const result = await requestExpectingClose({
      host: "127.0.0.1",
      port,
      path: `/s/${handle}/?k=${key}`,
    });
    expect(result.received).toBe(0);
  });

  it("(c) a cookie-authenticated request reaches the target with host rewritten and cookie/authorization stripped, basic-auth injected when published, and location/set-cookie rewritten on the way back", async () => {
    currentHandler = (req, res) => {
      if (req.url === "/api/x?y=1") {
        res.writeHead(201, { "set-cookie": "a=b; Path=/", location: "/login" });
        res.end("hello");
        return;
      }
      res.writeHead(200);
      res.end();
    };

    const noAuth = registry.publish("device-c1", { kind: "editor", port: targetPort });
    const redeem1 = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${noAuth.handle}/?k=${noAuth.key}`,
    });
    const cookie1 = extractCookie(redeem1.headers["set-cookie"]);

    const res1 = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${noAuth.handle}/api/x?y=1`,
      // M2: a phone-side Authorization header must be dropped, not merely
      // absent by coincidence — asserted below via `seen1`.
      headers: {
        cookie: `jarvis_s_${noAuth.handle}=${cookie1}`,
        authorization: "Bearer phone-side-secret",
      },
    });

    const seen1 = seenByTarget.at(-1);
    expect(seen1?.url).toBe("/api/x?y=1");
    expect(seen1?.headers.host).toBe(`127.0.0.1:${targetPort}`);
    expect(seen1?.headers.cookie).toBeUndefined();
    expect(seen1?.headers.authorization).toBeUndefined();

    expect(res1.status).toBe(201);
    expect(res1.body).toBe("hello");
    expect(res1.headers["set-cookie"]).toEqual([`a=b; Path=/s/${noAuth.handle}/; Secure`]);
    expect(res1.headers.location).toBe(`/s/${noAuth.handle}/login`);

    const withAuth = registry.publish("device-c2", {
      kind: "database",
      port: targetPort,
      basicAuth: { login: "root", password: "hunter2" },
    });
    const redeem2 = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${withAuth.handle}/?k=${withAuth.key}`,
    });
    const cookie2 = extractCookie(redeem2.headers["set-cookie"]);

    await request({
      host: "127.0.0.1",
      port,
      path: `/s/${withAuth.handle}/api/x?y=1`,
      headers: { cookie: `jarvis_s_${withAuth.handle}=${cookie2}` },
    });
    const seen2 = seenByTarget.at(-1);
    expect(seen2?.headers.authorization).toBe(
      `Basic ${Buffer.from("root:hunter2").toString("base64")}`,
    );
  });

  it("(i) a cluster document is re-based under the handle and asked for uncompressed; a cluster asset and an editor document stream untouched", async () => {
    const page = `<script src="/assets/index.js"></script><script>headlampBaseUrl = '/';</script>`;
    currentHandler = (req, res) => {
      if (req.url === "/assets/index.js") {
        res.writeHead(200, { "content-type": "application/javascript" });
        res.end(`fetch("/config")`);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
    };

    const cluster = registry.publish("device-i1", { kind: "cluster", port: targetPort });
    const redeem = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${cluster.handle}/?k=${cluster.key}`,
    });
    const cookie = extractCookie(redeem.headers["set-cookie"]);
    const auth = { cookie: `jarvis_s_${cluster.handle}=${cookie}` };

    const doc = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${cluster.handle}/`,
      headers: { ...auth, accept: "text/html,*/*;q=0.8", "accept-encoding": "gzip, br" },
    });
    expect(seenByTarget.at(-1)?.headers["accept-encoding"]).toBeUndefined();
    expect(doc.status).toBe(200);
    expect(doc.body).toBe(
      `<script src="/s/${cluster.handle}/assets/index.js"></script><script>headlampBaseUrl = '/s/${cluster.handle}';</script>`,
    );
    expect(doc.headers["content-length"]).toBe(String(Buffer.byteLength(doc.body)));

    const asset = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${cluster.handle}/assets/index.js`,
      headers: { ...auth, accept: "*/*", "accept-encoding": "gzip, br" },
    });
    expect(seenByTarget.at(-1)?.headers["accept-encoding"]).toBe("gzip, br");
    expect(asset.body).toBe(`fetch("/config")`);

    const editor = registry.publish("device-i2", { kind: "editor", port: targetPort });
    const redeemEditor = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${editor.handle}/?k=${editor.key}`,
    });
    const editorCookie = extractCookie(redeemEditor.headers["set-cookie"]);
    const editorDoc = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${editor.handle}/`,
      headers: {
        cookie: `jarvis_s_${editor.handle}=${editorCookie}`,
        accept: "text/html",
        "accept-encoding": "gzip",
      },
    });
    expect(seenByTarget.at(-1)?.headers["accept-encoding"]).toBe("gzip");
    expect(editorDoc.body).toBe(page);
  });

  it("(d) a wrong cookie or an unknown handle closes the socket with no bytes", async () => {
    const { handle } = registry.publish("device-d", { kind: "editor", port: targetPort });

    const wrongCookie = await requestExpectingClose({
      host: "127.0.0.1",
      port,
      path: `/s/${handle}/`,
      headers: { cookie: `jarvis_s_${handle}=${"0".repeat(64)}` },
    });
    expect(wrongCookie.received).toBe(0);

    const unknownHandle = await requestExpectingClose({
      host: "127.0.0.1",
      port,
      path: `/s/${"f".repeat(32)}/`,
    });
    expect(unknownHandle.received).toBe(0);
  });

  // "Security rules with no test": device A's own, genuinely valid cookie
  // must not authenticate anything at device B's handle — `cookieFor` has
  // the unit row (`cookieFor` returns undefined for a cookie naming a
  // different handle), but nothing at the real listener proved the wiring.
  it("[Security rules with no test] device A's valid cookie presented at device B's handle closes the socket with no bytes", async () => {
    const deviceA = registry.publish("device-a-cross", { kind: "editor", port: targetPort });
    const redeemA = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${deviceA.handle}/?k=${deviceA.key}`,
    });
    const cookieA = extractCookie(redeemA.headers["set-cookie"]);

    const deviceB = registry.publish("device-b-cross", { kind: "editor", port: targetPort });

    const result = await requestExpectingClose({
      host: "127.0.0.1",
      port,
      path: `/s/${deviceB.handle}/`,
      // A's real, valid cookie value, named for B's handle — exactly what a
      // client mixing up two open tabs' cookies would send.
      headers: { cookie: `jarvis_s_${deviceB.handle}=${cookieA}` },
    });
    expect(result.received).toBe(0);
  });

  // "Security rules with no test": path traversal is unit-tested against
  // `parseProxyPath` directly (proxy-rewrite.test.ts); this proves the real
  // listener actually calls it before ever reaching a cookie-authenticated
  // sidecar hop.
  it("[Security rules with no test] a %2e%2e path segment with a valid cookie closes the socket with no bytes", async () => {
    const { handle, key } = registry.publish("device-traversal", {
      kind: "editor",
      port: targetPort,
    });
    const redeem = await request({ host: "127.0.0.1", port, path: `/s/${handle}/?k=${key}` });
    const cookie = extractCookie(redeem.headers["set-cookie"]);

    const result = await requestExpectingClose({
      host: "127.0.0.1",
      port,
      path: `/s/${handle}/%2e%2e/x`,
      headers: { cookie: `jarvis_s_${handle}=${cookie}` },
    });
    expect(result.received).toBe(0);
    expect(seenByTarget).toHaveLength(0);
  });

  it("(e) an SSE response streams chunk by chunk rather than buffering", async () => {
    currentHandler = (req, res) => {
      if (req.url !== "/events") {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      let i = 0;
      const timer = setInterval(() => {
        i += 1;
        res.write(`data: ${i}\n\n`);
        if (i === 3) {
          clearInterval(timer);
          res.end();
        }
      }, 50);
    };

    const { handle, key } = registry.publish("device-e", { kind: "editor", port: targetPort });
    const redeem = await request({ host: "127.0.0.1", port, path: `/s/${handle}/?k=${key}` });
    const cookie = extractCookie(redeem.headers["set-cookie"]);

    const received: number[] = [];
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest(
        {
          agent: insecureAgent,
          host: "127.0.0.1",
          port,
          path: `/s/${handle}/events`,
          headers: { cookie: `jarvis_s_${handle}=${cookie}` },
        },
        (res) => {
          res.on("data", () => received.push(Date.now()));
          res.on("end", () => resolve());
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(received).toHaveLength(3);
    expect(received[1]! - received[0]!).toBeGreaterThanOrEqual(30);
    expect(received[2]! - received[1]!).toBeGreaterThanOrEqual(30);
  });

  it("(f) a cookie-authenticated upgrade delivers head bytes and pipes two-way; key-only (no cookie) is refused", async () => {
    let seenHead: Buffer | undefined;
    let seenUpgradeHeaders: IncomingMessage["headers"] | undefined;
    currentUpgradeHandler = (req, socket, head) => {
      seenHead = head;
      seenUpgradeHeaders = req.headers;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: tty\r\nConnection: Upgrade\r\n\r\n",
      );
      // Node's own HTTP parser already pulled `head` off the socket's
      // readable stream before emitting "upgrade" (that's the only way it
      // can hand it to us as a value) — echoing it back needs an explicit
      // write here; only bytes arriving *after* this point are still on the
      // stream for `.pipe(socket)` below to echo on its own.
      if (head.length > 0) socket.write(head);
      socket.pipe(socket);
    };

    const { handle, key } = registry.publish("device-f", { kind: "editor", port: targetPort });
    const redeem = await request({ host: "127.0.0.1", port, path: `/s/${handle}/?k=${key}` });
    const cookie = extractCookie(redeem.headers["set-cookie"]);

    const socket = await rawConnect("127.0.0.1", port);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));

    socket.write(
      [
        `GET /s/${handle}/tty HTTP/1.1`,
        "Host: x",
        "Connection: Upgrade",
        "Upgrade: tty",
        `Cookie: jarvis_s_${handle}=${cookie}`,
        "Origin: https://phone.example:7717",
        "",
        "HEAD-BYTES",
      ].join("\r\n"),
    );

    await delay(200);
    expect(seenHead?.toString("utf8")).toBe("HEAD-BYTES");
    // M2: the sidecar sees the loopback target as its `Host`, never the
    // phone's cookie.
    expect(seenUpgradeHeaders?.host).toBe(`127.0.0.1:${targetPort}`);
    expect(seenUpgradeHeaders?.cookie).toBeUndefined();
    // I1: the phone's own Origin (a real WebSocket handshake always sends
    // one) is rewritten to the loopback target, exactly like Host — never
    // forwarded verbatim, which is what made code-server's own origin check
    // 403 every workbench WebSocket.
    expect(seenUpgradeHeaders?.origin).toBe(`http://127.0.0.1:${targetPort}`);
    const initial = Buffer.concat(chunks).toString("utf8");
    expect(initial).toContain("101 Switching Protocols");
    // The target's own `socket.pipe(socket)` echoes whatever it received —
    // including the "HEAD-BYTES" this proxy wrote before piping — so seeing
    // it come back out proves the pipe runs both ways, not just target-ward.
    expect(initial).toContain("HEAD-BYTES");

    chunks.length = 0;
    socket.write("ping");
    await delay(100);
    expect(Buffer.concat(chunks).toString("utf8")).toBe("ping");
    socket.destroy();

    const { handle: handle2, key: key2 } = registry.publish("device-f2", {
      kind: "editor",
      port: targetPort,
    });
    const socket2 = await rawConnect("127.0.0.1", port);
    let received2 = 0;
    socket2.on("data", (chunk: Buffer) => {
      received2 += chunk.length;
    });
    const closed2 = new Promise<void>((resolve) => socket2.once("close", resolve));
    socket2.write(
      [
        `GET /s/${handle2}/tty?k=${key2} HTTP/1.1`,
        "Host: x",
        "Connection: Upgrade",
        "Upgrade: tty",
        "",
        "",
      ].join("\r\n"),
    );
    await closed2;
    expect(received2).toBe(0);
    // M1: the refused upgrade never redeemed `key2` — a cheap, direct proof
    // that it was neither honoured nor consumed, not merely ignored on the
    // wire but silently redeemed anyway.
    expect(registry.redeemKey(handle2, key2)).toBeDefined();
  });

  // Deferred D1, now required ("Security rules with no test"): a `?k=` on a
  // cookie-authenticated upgrade is stripped from the request line the
  // target sees, not merely ignored for auth purposes — and it is never
  // redeemed, even when it is a real, still-good key. `cookieHandle`/
  // `cookieKey` is the handle the upgrade actually authenticates against
  // (a normal redeem, like every other case here); `spareHandle`/`spareKey`
  // is a second, wholly unrelated handle nobody else ever touches, so
  // `redeemKey` succeeding on it afterwards is a meaningful proof — a fake
  // or already-spent value would trivially "still redeem" as undefined
  // either way, this is a real key. (A handle's own key can't stand in for
  // both roles at once: learning its cookie can only ever happen by
  // redeeming it, per the registry's own design.)
  it("[D1] an upgrade's own ?k= is stripped from the request line and never redeemed, even a real still-valid one", async () => {
    let seenUpgradeUrl: string | undefined;
    currentUpgradeHandler = (req, socket) => {
      seenUpgradeUrl = req.url;
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: tty\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.destroy();
    };

    const { handle: cookieHandle, key: cookieKey } = registry.publish("device-d1", {
      kind: "editor",
      port: targetPort,
    });
    const redeem = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${cookieHandle}/?k=${cookieKey}`,
    });
    const cookie = extractCookie(redeem.headers["set-cookie"]);

    const { handle: spareHandle, key: spareKey } = registry.publish("device-d1-spare", {
      kind: "editor",
      port: targetPort,
    });

    const socket = await rawConnect("127.0.0.1", port);
    socket.on("data", () => {});
    socket.write(
      [
        `GET /s/${cookieHandle}/ws?k=${spareKey} HTTP/1.1`,
        "Host: x",
        "Connection: Upgrade",
        "Upgrade: tty",
        `Cookie: jarvis_s_${cookieHandle}=${cookie}`,
        "",
        "",
      ].join("\r\n"),
    );

    await delay(200);
    expect(seenUpgradeUrl).toBe("/ws");
    expect(registry.redeemKey(spareHandle, spareKey)).toBeDefined();
    socket.destroy();
  });

  it("(g) a refused target connection closes the phone's socket with no bytes", async () => {
    const closedPort = await reserveClosedPort();
    const { handle, key } = registry.publish("device-g", { kind: "editor", port: closedPort });
    const redeem = await request({ host: "127.0.0.1", port, path: `/s/${handle}/?k=${key}` });
    const cookie = extractCookie(redeem.headers["set-cookie"]);

    const result = await requestExpectingClose({
      host: "127.0.0.1",
      port,
      path: `/s/${handle}/`,
      headers: { cookie: `jarvis_s_${handle}=${cookie}` },
    });
    expect(result.received).toBe(0);

    // M2: the same refused-hop case, for an upgrade — `net.connect`'s own
    // "error" (ECONNREFUSED) must destroy the phone's socket exactly like
    // `http.request`'s does above.
    const upgradeHandle = registry.publish("device-g2", { kind: "editor", port: closedPort });
    const upgradeRedeem = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${upgradeHandle.handle}/?k=${upgradeHandle.key}`,
    });
    const upgradeCookie = extractCookie(upgradeRedeem.headers["set-cookie"]);

    const socket = await rawConnect("127.0.0.1", port);
    let receivedUpgrade = 0;
    socket.on("data", (chunk: Buffer) => {
      receivedUpgrade += chunk.length;
    });
    const closed = new Promise<void>((resolve) => socket.once("close", resolve));
    socket.write(
      [
        `GET /s/${upgradeHandle.handle}/tty HTTP/1.1`,
        "Host: x",
        "Connection: Upgrade",
        "Upgrade: tty",
        `Cookie: jarvis_s_${upgradeHandle.handle}=${upgradeCookie}`,
        "",
        "",
      ].join("\r\n"),
    );
    await closed;
    expect(receivedUpgrade).toBe(0);
  });

  it("(h) a POST body is forwarded to the target byte for byte", async () => {
    let seenBody = "";
    currentHandler = (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        seenBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200);
        res.end();
      });
    };

    const { handle, key } = registry.publish("device-h", { kind: "editor", port: targetPort });
    const redeem = await request({ host: "127.0.0.1", port, path: `/s/${handle}/?k=${key}` });
    const cookie = extractCookie(redeem.headers["set-cookie"]);

    await request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: `/s/${handle}/upload`,
      headers: {
        cookie: `jarvis_s_${handle}=${cookie}`,
        "content-length": String(Buffer.byteLength("hello world")),
      },
      body: "hello world",
    });

    expect(seenBody).toBe("hello world");
  });

  it("[Important #1 bite-proof] a sidecar dropping its socket mid-response closes the phone's connection instead of hanging", async () => {
    currentHandler = (req, res) => {
      if (req.url !== "/abort") {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("first chunk\n");
      // Simulates the sidecar dying mid-stream: destroying the raw socket,
      // never calling `res.end()`, is what makes Node fire "close" on the
      // *response* our proxy is piping from (`complete === false`) rather
      // than "error" on the `ClientRequest` — the exact case Important #1
      // fixes.
      setTimeout(() => req.socket.destroy(), 20);
    };

    const { handle, key } = registry.publish("device-abort", { kind: "editor", port: targetPort });
    const redeem = await request({ host: "127.0.0.1", port, path: `/s/${handle}/?k=${key}` });
    const cookie = extractCookie(redeem.headers["set-cookie"]);

    const closed = await new Promise<boolean>((resolve) => {
      const req = httpsRequest(
        {
          agent: insecureAgent,
          host: "127.0.0.1",
          port,
          path: `/s/${handle}/abort`,
          headers: { cookie: `jarvis_s_${handle}=${cookie}` },
        },
        (res) => {
          res.on("data", () => {});
          res.on("close", () => resolve(true));
          res.on("end", () => resolve(false));
        },
      );
      req.on("error", () => resolve(true));
      req.end();
      // Without the fix, nothing above ever fires — this is the "hangs
      // forever" the finding describes, not a flaky race to tune.
      setTimeout(() => resolve(false), 2_000).unref();
    });

    expect(closed).toBe(true);
  });

  it("[Important #2 bite-proof] many sequential requests on one keep-alive connection never trip MaxListenersExceededWarning", async () => {
    const keepAliveAgent = new Agent({
      rejectUnauthorized: false,
      keepAlive: true,
      maxSockets: 1,
    });
    const warnings: string[] = [];
    const onWarning = (warning: Error) => {
      if (warning.name === "MaxListenersExceededWarning") warnings.push(warning.message);
    };
    process.on("warning", onWarning);

    try {
      const { handle, key } = registry.publish("device-keepalive", {
        kind: "editor",
        port: targetPort,
      });
      const redeem = await request({ host: "127.0.0.1", port, path: `/s/${handle}/?k=${key}` });
      const cookie = extractCookie(redeem.headers["set-cookie"]);

      // Node's own default listener-count warning threshold is 10; the
      // finding reports it tripping at 11 — comfortably exceeded here.
      const REQUEST_COUNT = 15;
      for (let i = 0; i < REQUEST_COUNT; i++) {
        await new Promise<void>((resolve, reject) => {
          const req = httpsRequest(
            {
              agent: keepAliveAgent,
              host: "127.0.0.1",
              port,
              path: `/s/${handle}/x${i}`,
              headers: { cookie: `jarvis_s_${handle}=${cookie}` },
            },
            (res) => {
              res.resume();
              res.on("end", () => resolve());
            },
          );
          req.on("error", reject);
          req.end();
        });
      }
    } finally {
      process.off("warning", onWarning);
      keepAliveAgent.destroy();
    }

    expect(warnings).toEqual([]);
  });

  it("[Important #3 bite-proof] closeDevice(id) destroys that device's live streamed response and piped upgrade, leaving another device's stream running", async () => {
    currentHandler = (req, res) => {
      if (req.url === "/a-stream" || req.url === "/b-stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const timer = setInterval(() => res.write("data: tick\n\n"), 20);
        req.socket.once("close", () => clearInterval(timer));
        return;
      }
      res.writeHead(200);
      res.end();
    };
    currentUpgradeHandler = (_req, socket) => {
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: tty\r\nConnection: Upgrade\r\n\r\n",
      );
      socket.pipe(socket);
    };

    const aStream = registry.publish("device-A", { kind: "editor", port: targetPort });
    const aStreamRedeem = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${aStream.handle}/?k=${aStream.key}`,
    });
    const aStreamCookie = extractCookie(aStreamRedeem.headers["set-cookie"]);

    const aUpgrade = registry.publish("device-A", { kind: "editor", port: targetPort });
    const aUpgradeRedeem = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${aUpgrade.handle}/?k=${aUpgrade.key}`,
    });
    const aUpgradeCookie = extractCookie(aUpgradeRedeem.headers["set-cookie"]);

    const bStream = registry.publish("device-B", { kind: "editor", port: targetPort });
    const bStreamRedeem = await request({
      host: "127.0.0.1",
      port,
      path: `/s/${bStream.handle}/?k=${bStream.key}`,
    });
    const bStreamCookie = extractCookie(bStreamRedeem.headers["set-cookie"]);

    let aStreamClosed = false;
    const aStreamReq = httpsRequest(
      {
        agent: insecureAgent,
        host: "127.0.0.1",
        port,
        path: `/s/${aStream.handle}/a-stream`,
        headers: { cookie: `jarvis_s_${aStream.handle}=${aStreamCookie}` },
      },
      (res) => {
        res.on("data", () => {});
        res.on("close", () => {
          aStreamClosed = true;
        });
      },
    );
    aStreamReq.end();

    let bChunks = 0;
    const bStreamReq = httpsRequest(
      {
        agent: insecureAgent,
        host: "127.0.0.1",
        port,
        path: `/s/${bStream.handle}/b-stream`,
        headers: { cookie: `jarvis_s_${bStream.handle}=${bStreamCookie}` },
      },
      (res) => {
        res.on("data", () => {
          bChunks += 1;
        });
      },
    );
    bStreamReq.end();

    const aUpgradeSocket = await rawConnect("127.0.0.1", port);
    let aUpgradeClosed = false;
    aUpgradeSocket.once("close", () => {
      aUpgradeClosed = true;
    });
    // Without a reader, the socket never leaves paused mode and its own
    // "close" would sit un-fired behind unread buffered bytes — same
    // reason (f)'s raw sockets always attach a "data" listener.
    aUpgradeSocket.resume();
    aUpgradeSocket.write(
      [
        `GET /s/${aUpgrade.handle}/tty HTTP/1.1`,
        "Host: x",
        "Connection: Upgrade",
        "Upgrade: tty",
        `Cookie: jarvis_s_${aUpgrade.handle}=${aUpgradeCookie}`,
        "",
        "",
      ].join("\r\n"),
    );

    // Let every connection actually establish and start flowing before revoking A.
    await delay(150);
    expect(aStreamClosed).toBe(false);
    expect(aUpgradeClosed).toBe(false);
    const bChunksBefore = bChunks;
    expect(bChunksBefore).toBeGreaterThan(0);

    const closedCount = proxy.closeDevice("device-A");
    expect(closedCount).toBe(2);

    await delay(150);
    expect(aStreamClosed).toBe(true);
    expect(aUpgradeClosed).toBe(true);
    expect(bChunks).toBeGreaterThan(bChunksBefore);

    aUpgradeSocket.destroy();
  });
});
