// Real sockets and real TLS on 127.0.0.1 port 0, with a throwaway certificate:
// what `tailscale serve --proxy-protocol=2` does to a connection, played by the
// client writing the header itself. No test here runs `tailscale`.

import { EventEmitter } from "node:events";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { mintSelfSigned } from "./certificate.js";
import { listenProxyFront, sourceOf } from "./proxy-front.js";
import { listenTls } from "./server.js";
import { buildWebManifest, listenWeb } from "./web-server.js";

const HOST = "127.0.0.1";
const SIGNATURE = Buffer.from("\r\n\r\n\0\r\nQUIT\n", "latin1");

function headerOf(family: number, addresses: Buffer, versionCommand = 0x21): Buffer {
  const fixed = Buffer.alloc(4);
  fixed[0] = versionCommand;
  fixed[1] = family;
  fixed.writeUInt16BE(addresses.length, 2);
  return Buffer.concat([SIGNATURE, fixed, addresses]);
}

function v4Header(source: readonly number[]): Buffer {
  return headerOf(0x11, Buffer.from([...source, 127, 0, 0, 1, 0xc8, 0x22, 0x45, 0x35]));
}

function v6Header(sourceHex: string): Buffer {
  const rest = `${"0".repeat(31)}1c8224535`;
  return headerOf(0x21, Buffer.from(sourceHex + rest, "hex"));
}

const SOURCE = [100, 79, 83, 16];
const SOURCE_TEXT = "100.79.83.16";

function openRaw(port: number, first?: Buffer): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, HOST, () => {
      socket.off("error", reject);
      socket.on("error", () => {});
      socket.setNoDelay(true);
      if (first !== undefined) socket.write(first);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

/** Resolves once the socket closes, with what it received; rejects if it stays open past `withinMs`. */
function closedWithin(socket: Socket, withinMs: number): Promise<{ received: number; ms: number }> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let received = 0;
    socket.on("data", (chunk: Buffer) => {
      received += chunk.length;
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`still open after ${withinMs} ms`));
    }, withinMs);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve({ received, ms: Date.now() - started });
    });
  });
}

/** A TLS 1.3 client over `raw`, which has already written its header. */
function secureOver(raw: Socket): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect(
      { socket: raw, rejectUnauthorized: false, minVersion: "TLSv1.3" },
      () => {
        socket.off("error", reject);
        socket.on("error", () => {});
        resolve(socket);
      },
    );
    socket.once("error", reject);
    socket.once("close", () => reject(new Error("closed before the handshake finished")));
  });
}

/** One whole HTTP/1.1 exchange on an open TLS socket: everything until the server closes it. */
function exchange(socket: TLSSocket, request: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
    socket.write(request);
  });
}

/** Until the first response bytes show up: for upgrades, which stay open afterwards. */
function firstBytes(socket: TLSSocket, request: string): Promise<string> {
  return new Promise((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(chunk.toString("latin1")));
    socket.write(request);
  });
}

const UPGRADE =
  "GET /rpc HTTP/1.1\r\nHost: jarvis.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
  "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n";

let cert: string;
let key: string;

beforeAll(async () => {
  ({ cert, key } = await mintSelfSigned(Date.now(), "0a0b0c0d0e0f1011"));
});

describe("listenProxyFront", () => {
  const cleanups: (() => Promise<void> | void)[] = [];

  afterEach(async () => {
    // Last in, first out: a server's close() waits on the sockets opened after it.
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** An HTTPS target that answers every request with "ok", and remembers which socket object it saw. */
  async function start(timeoutMs = 2_000) {
    const seen: TLSSocket[] = [];
    const target: HttpsServer = createHttpsServer(
      { cert, key, minVersion: "TLSv1.3" },
      (request, response) => {
        seen.push(request.socket as TLSSocket);
        response.setHeader("Connection", "close");
        response.end("ok");
      },
    );
    const raws: Socket[] = [];
    target.on("connection", (raw: Socket) => raws.push(raw));
    const front = await listenProxyFront({ host: HOST, port: 0, target, timeoutMs });
    cleanups.push(() => front.close().catch(() => {}));
    return { front, target, seen, raws };
  }

  function track<T extends { destroy(): unknown }>(socket: T): T {
    cleanups.push(() => void socket.destroy());
    return socket;
  }

  it("reports the port it bound", async () => {
    const { front } = await start();
    expect(front.port).toBeGreaterThan(0);
  });

  it("completes a real TLS 1.3 handshake behind a header, and sourceOf reports its address", async () => {
    const { front, seen, raws } = await start();
    const client = track(await secureOver(await openRaw(front.port, v4Header(SOURCE))));
    expect(client.getProtocol()).toBe("TLSv1.3");

    const reply = await exchange(client, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 200 /);
    expect(reply.endsWith("ok")).toBe(true);

    // What the handlers are given is a TLSSocket wrapping the raw socket the
    // front recorded: a different object, reporting the relay's loopback.
    const handed = seen[0] as TLSSocket;
    expect(handed).not.toBe(raws[0]);
    expect(raws).toHaveLength(1);
    expect(sourceOf(raws[0] as Socket)).toBe(SOURCE_TEXT);
    expect(sourceOf(handed)).toBe(SOURCE_TEXT);
  });

  it("still reports the source after the socket has gone", async () => {
    const { front, seen } = await start();
    const client = track(await secureOver(await openRaw(front.port, v4Header(SOURCE))));
    await exchange(client, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    (seen[0] as TLSSocket).destroy();
    await delay(10);
    expect(sourceOf(seen[0] as TLSSocket)).toBe(SOURCE_TEXT);
  });

  it("handshakes when the header and the ClientHello arrive in one packet", async () => {
    const { front, seen } = await start();
    // Holds the client's first flight back, then writes it glued to the header.
    const relay = createNetServer((client) => {
      client.on("error", () => {});
      const upstream = netConnect(front.port, HOST);
      upstream.on("error", () => {});
      upstream.setNoDelay(true);
      client.once("data", (hello: Buffer) => {
        upstream.write(Buffer.concat([v4Header(SOURCE), hello]));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      cleanups.push(() => {
        client.destroy();
        upstream.destroy();
      });
    });
    await new Promise<void>((resolve) => relay.listen(0, HOST, resolve));
    cleanups.push(() => new Promise<void>((resolve) => relay.close(() => resolve())));
    const relayPort = (relay.address() as { port: number }).port;

    const client = track(await secureOver(await openRaw(relayPort)));
    const reply = await exchange(client, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(reply).toMatch(/^HTTP\/1\.1 200 /);
    expect(sourceOf(seen[0] as TLSSocket)).toBe(SOURCE_TEXT);
  });

  it("strips exactly the header and restores what followed it, for the target to read", async () => {
    const target = new EventEmitter();
    const handed = new Promise<Socket>((resolve) => target.once("connection", resolve));
    const front = await listenProxyFront({ host: HOST, port: 0, target, timeoutMs: 2_000 });
    cleanups.push(() => front.close());

    track(await openRaw(front.port, Buffer.concat([v4Header(SOURCE), Buffer.from("after")])));
    const raw = await handed;
    track(raw);
    expect(raw.readableFlowing).toBe(false);
    expect(raw.read()?.toString()).toBe("after");
    expect(sourceOf(raw)).toBe(SOURCE_TEXT);
  });

  it("handles a header split across packets", async () => {
    const { front, seen } = await start();
    const header = v4Header(SOURCE);
    const raw = await openRaw(front.port, header.subarray(0, 5));
    await delay(20);
    raw.write(header.subarray(5, 20));
    await delay(20);
    raw.write(header.subarray(20));
    await delay(20);
    const client = track(await secureOver(raw));
    expect(await exchange(client, "GET / HTTP/1.1\r\nHost: x\r\n\r\n")).toMatch(/^HTTP\/1\.1 200 /);
    expect(sourceOf(seen[0] as TLSSocket)).toBe(SOURCE_TEXT);
  });

  it.each([
    ["an IPv6 source", "fd7a115ca1e000000000000000000001", "fd7a:115c:a1e0::1"],
    ["an IPv4-mapped source", "00000000000000000000ffff644f5310", SOURCE_TEXT],
  ])("reports %s", async (_label, sourceHex, expected) => {
    const { front, seen } = await start();
    const client = track(await secureOver(await openRaw(front.port, v6Header(sourceHex))));
    await exchange(client, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(sourceOf(seen[0] as TLSSocket)).toBe(expected);
  });

  it("closes a socket with no header within the timeout, having sent nothing", async () => {
    const { front } = await start(100);
    const silent = track(await openRaw(front.port));
    const { received, ms } = await closedWithin(silent, 1_500);
    expect(received).toBe(0);
    expect(ms).toBeGreaterThanOrEqual(50);
  });

  it("the timeout is a deadline: trickling bytes of a header does not extend it", async () => {
    const { front } = await start(150);
    const header = v4Header(SOURCE);
    const raw = track(await openRaw(front.port));
    const closed = closedWithin(raw, 1_500);
    for (let index = 0; index < 8 && !raw.destroyed; index++) {
      raw.write(header.subarray(index, index + 1));
      await delay(40);
    }
    expect((await closed).received).toBe(0);
  });

  it.each([
    ["plain TLS bytes with no header", Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00])],
    ["the LOCAL command", headerOf(0x11, Buffer.alloc(12), 0x20)],
    ["UNSPEC", headerOf(0x00, Buffer.alloc(12))],
    ["a declared length over the cap", headerOf(0x11, Buffer.alloc(513))],
  ])("destroys %s at once, with no bytes", async (_label, bytes) => {
    const { front } = await start(5_000);
    const raw = track(await openRaw(front.port, bytes));
    expect((await closedWithin(raw, 1_000)).received).toBe(0);
  });

  it("a real TLS client with no header never gets a handshake", async () => {
    const { front } = await start(5_000);
    const raw = await openRaw(front.port);
    await expect(secureOver(raw)).rejects.toThrow();
  });

  it("swallows a socket error before the hand-off and keeps serving", async () => {
    const { front } = await start();
    const raw = await openRaw(front.port, v4Header(SOURCE).subarray(0, 8));
    await delay(10);
    raw.resetAndDestroy();
    await delay(20);
    const client = track(await secureOver(await openRaw(front.port, v4Header(SOURCE))));
    expect(await exchange(client, "GET / HTTP/1.1\r\nHost: x\r\n\r\n")).toMatch(/^HTTP\/1\.1 200 /);
  });

  it("keeps MAX_CONNECTIONS: the 65th socket is dropped, with no bytes", async () => {
    const { front } = await start(10_000);
    for (let index = 0; index < 64; index++) track(await openRaw(front.port));
    const extra = track(await openRaw(front.port));
    expect((await closedWithin(extra, 2_000)).received).toBe(0);
  });

  it("close() destroys sockets at every stage rather than waiting on them", async () => {
    const { front } = await start(60_000);
    const waiting = track(await openRaw(front.port));
    const handed = track(await secureOver(await openRaw(front.port, v4Header(SOURCE))));
    const closes = [closedWithin(waiting, 1_000), closedWithin(handed, 1_000)];
    await delay(20);
    await front.close();
    await Promise.all(closes);
  });

  it("refuses a non-loopback host before binding anything", async () => {
    const target = new EventEmitter();
    await expect(
      listenProxyFront({ host: "192.0.2.1", port: 0, target, timeoutMs: 100 }),
    ).rejects.toThrow(/loopback/);
  });

  it("sourceOf falls back to remoteAddress when no header was read", () => {
    expect(sourceOf({ remoteAddress: "100.64.0.9" })).toBe("100.64.0.9");
    expect(sourceOf({})).toBe("");
  });
});

describe("listenTls with proxyProtocol", () => {
  function options(sources: string[], overrides: { proxyProtocol?: boolean; host?: string } = {}) {
    return {
      host: HOST,
      port: 0,
      cert,
      key,
      proxy: undefined,
      webOrigin: () => undefined,
      onSocket(_kind: "rpc" | "pair", _socket: unknown, remoteAddress: string) {
        sources.push(remoteAddress);
        return { onText() {}, onBinary() {}, onClose() {} };
      },
      log() {},
      ...overrides,
    };
  }

  it("hands onSocket the header's address over a real upgrade, and reports the front's port", async () => {
    const sources: string[] = [];
    const listener = await listenTls(options(sources, { proxyProtocol: true }));
    expect(listener.port).toBeGreaterThan(0);
    const client = await secureOver(await openRaw(listener.port, v4Header(SOURCE)));

    expect(await firstBytes(client, UPGRADE)).toMatch(/^HTTP\/1\.1 101 /);
    await delay(10);
    expect(sources).toEqual([SOURCE_TEXT]);

    client.destroy();
    await listener.close();
  });

  it("without it, a socket's own address is the source", async () => {
    const sources: string[] = [];
    const listener = await listenTls(options(sources));
    const client = await secureOver(await openRaw(listener.port));

    expect(await firstBytes(client, UPGRADE)).toMatch(/^HTTP\/1\.1 101 /);
    await delay(10);
    expect(sources).toEqual([HOST]);

    client.destroy();
    await listener.close();
  });

  it("without it, a header is TLS garbage and the handshake fails", async () => {
    const listener = await listenTls(options([], { proxyProtocol: false }));
    const raw = await openRaw(listener.port, v4Header(SOURCE));
    await expect(secureOver(raw)).rejects.toThrow();
    raw.destroy();
    await listener.close();
  });

  it("with it, plain TLS gets no fallback", async () => {
    const listener = await listenTls(options([], { proxyProtocol: true }));
    await expect(secureOver(await openRaw(listener.port))).rejects.toThrow();
    await listener.close();
  });

  it("rejects on a non-loopback host", async () => {
    await expect(
      listenTls(options([], { proxyProtocol: true, host: "192.0.2.1" })),
    ).rejects.toThrow(/loopback/);
  });

  it("close() resolves with sockets still open, and a restart can follow", async () => {
    const listener = await listenTls(options([], { proxyProtocol: true }));
    const silent = await openRaw(listener.port);
    const client = await secureOver(await openRaw(listener.port, v4Header(SOURCE)));
    const closes = [closedWithin(silent, 1_000), closedWithin(client, 1_000)];
    await listener.close();
    await Promise.all(closes);

    const next = await listenTls(
      options([], { proxyProtocol: true, port: listener.port } as never),
    );
    await next.close();
  });

  it("keeps the request timeout: a stalled request is cut off with no bytes", {
    timeout: 10_000,
  }, async () => {
    const listener = await listenTls(options([], { proxyProtocol: true }));
    const client = await secureOver(await openRaw(listener.port, v4Header(SOURCE)));
    client.write("GET /rpc HTTP/1.1\r\n");
    expect((await closedWithin(client, 8_000)).received).toBe(0);
    await listener.close();
  });
});

describe("listenWeb with proxyProtocol", () => {
  const manifest = buildWebManifest([{ path: "/index.html", bytes: Buffer.from("<main>") }]);

  function options(overrides: Record<string, unknown> = {}) {
    return {
      host: HOST,
      port: 0,
      cert,
      key,
      name: "jarvis.test",
      bridgePort: 9443,
      manifest,
      proxyProtocol: true,
      ...overrides,
    };
  }

  let listener: { close(): Promise<void>; port: number };

  beforeAll(async () => {
    listener = await listenWeb(options());
  });

  afterAll(async () => {
    await listener.close();
  });

  it("serves through the front, checking Host against the front's bound port", async () => {
    expect(listener.port).toBeGreaterThan(0);
    const client = await secureOver(await openRaw(listener.port, v4Header(SOURCE)));
    const reply = await exchange(
      client,
      `GET / HTTP/1.1\r\nHost: jarvis.test:${listener.port}\r\nConnection: close\r\n\r\n`,
    );
    expect(reply).toMatch(/^HTTP\/1\.1 200 /);
    expect(reply.endsWith("<main>")).toBe(true);
  });

  it("plain TLS gets no fallback", async () => {
    await expect(secureOver(await openRaw(listener.port))).rejects.toThrow();
  });

  it("without it, a header is TLS garbage", async () => {
    const plain = await listenWeb(options({ proxyProtocol: false }));
    const raw = await openRaw(plain.port, v4Header(SOURCE));
    await expect(secureOver(raw)).rejects.toThrow();
    raw.destroy();
    await plain.close();
  });

  it("rejects on a non-loopback host", async () => {
    await expect(listenWeb(options({ host: "192.0.2.1" }))).rejects.toThrow(/loopback/);
  });

  it("keeps the handshake timeout: a client that stops after its header is cut off", async () => {
    const quick = await listenWeb(
      options({
        createServer: (serverOptions: Record<string, unknown>) =>
          createHttpsServer({ ...serverOptions, handshakeTimeout: 100 }),
      }),
    );
    const raw = await openRaw(quick.port, v4Header(SOURCE));
    expect((await closedWithin(raw, 2_000)).received).toBe(0);
    await quick.close();
  });

  it("keeps the request timeout: a stalled request is cut off with no bytes", async () => {
    const quick = await listenWeb(
      options({
        createServer: (serverOptions: Record<string, unknown>) =>
          createHttpsServer({
            ...serverOptions,
            requestTimeout: 200,
            headersTimeout: 200,
            connectionsCheckingInterval: 50,
          }),
      }),
    );
    const client = await secureOver(await openRaw(quick.port, v4Header(SOURCE)));
    client.write("GET / HTTP/1.1\r\n");
    expect((await closedWithin(client, 2_000)).received).toBe(0);
    await quick.close();
  });
});
