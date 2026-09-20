// Unit tests for listenTls's own configuration of the underlying
// node:https server — no real network. The one real-network test for this
// package is bridge.integration.test.ts, on 127.0.0.1 port 0; this file
// mocks node:https and ws instead, so it can assert a property Node only
// otherwise proves by actually exceeding it (I4: opening 65 real sockets
// in CI to prove a cap is exactly the flaky test the brief warns against).
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

type FakeHttpsServer = EventEmitter & {
  maxConnections?: number;
  listen: (port: number, host: string) => void;
  address: () => { port: number };
  close: (cb: (error?: Error) => void) => void;
};

const createdServers: FakeHttpsServer[] = [];

vi.mock("node:https", () => ({
  createServer: vi.fn(() => {
    const server = new EventEmitter() as FakeHttpsServer;
    server.listen = (_port: number, _host: string) => {
      queueMicrotask(() => server.emit("listening"));
    };
    server.address = () => ({ port: 4443 });
    server.close = (cb: (error?: Error) => void) => cb();
    createdServers.push(server);
    return server;
  }),
}));

type FakeWss = { handleUpgrade: ReturnType<typeof vi.fn> };
const createdWssInstances: FakeWss[] = [];

vi.mock("ws", () => ({
  WebSocketServer: vi.fn().mockImplementation(function FakeWebSocketServer() {
    const instance: FakeWss = { handleUpgrade: vi.fn() };
    createdWssInstances.push(instance);
    return instance;
  }),
  WebSocket: { OPEN: 1 },
}));

const { listenTls, MAX_CONNECTIONS } = await import("./server.js");

describe("listenTls", () => {
  it("sets a hard cap on raw TCP connections before it starts listening (I4)", async () => {
    createdServers.length = 0;
    const listener = await listenTls({
      host: "127.0.0.1",
      port: 0,
      cert: "cert",
      key: "key",
      proxy: undefined,
      onSocket: () => ({ onText: () => {}, onBinary: () => {}, onClose: () => {} }),
      log: () => {},
    });

    expect(createdServers).toHaveLength(1);
    expect(createdServers[0]?.maxConnections).toBe(MAX_CONNECTIONS);
    expect(MAX_CONNECTIONS).toBe(64);

    await listener.close();
  });
});

describe("listenTls: sidecar proxy routing", () => {
  const HANDLE = "a".repeat(32);

  type FakeSocket = { destroy: ReturnType<typeof vi.fn> };
  type FakeIncomingMessage = EventEmitter & {
    url: string;
    method: string;
    headers: Record<string, string>;
    socket: FakeSocket;
  };

  function fakeRequest(url: string): { req: FakeIncomingMessage; res: object; socket: FakeSocket } {
    const socket: FakeSocket = { destroy: vi.fn() };
    const req = Object.assign(new EventEmitter(), {
      url,
      method: "GET",
      headers: {},
      socket,
    }) as FakeIncomingMessage;
    return { req, res: {}, socket };
  }

  function fakeProxy() {
    return { handleRequest: vi.fn(), handleUpgrade: vi.fn(), closeDevice: vi.fn(() => 0) };
  }

  async function startListener(proxy: ReturnType<typeof fakeProxy> | undefined) {
    createdServers.length = 0;
    createdWssInstances.length = 0;
    const listener = await listenTls({
      host: "127.0.0.1",
      port: 0,
      cert: "cert",
      key: "key",
      proxy,
      onSocket: () => ({ onText: () => {}, onBinary: () => {}, onClose: () => {} }),
      log: () => {},
    });
    const server = createdServers[0];
    if (server === undefined) throw new Error("no https server created");
    return { listener, server };
  }

  // [bite-proof: remove the `options.proxy !== undefined` guard (route /s/
  // to a proxy even when it's undefined) — this test would then throw
  // instead of observing a destroyed socket, since `undefined.handleRequest`
  // is not a function]
  it("destroys the socket for a /s/<handle>/ request, never routing it, when no proxy is configured", async () => {
    const { server, listener } = await startListener(undefined);
    const { req, res, socket } = fakeRequest(`/s/${HANDLE}/`);

    server.emit("request", req, res);

    expect(socket.destroy).toHaveBeenCalled();

    await listener.close();
  });

  it("routes a /s/<handle>/x request to a defined proxy's handleRequest, untouched", async () => {
    const proxy = fakeProxy();
    const { server, listener } = await startListener(proxy);
    const { req, res, socket } = fakeRequest(`/s/${HANDLE}/x`);

    server.emit("request", req, res);

    expect(proxy.handleRequest).toHaveBeenCalledWith(req, res);
    expect(socket.destroy).not.toHaveBeenCalled();

    await listener.close();
  });

  it("still destroys a non-sidecar, non-upgrade request even with a proxy configured", async () => {
    const proxy = fakeProxy();
    const { server, listener } = await startListener(proxy);
    const { req, res, socket } = fakeRequest("/");

    server.emit("request", req, res);

    expect(proxy.handleRequest).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalled();

    await listener.close();
  });

  it("routes a /s/<handle>/x upgrade to a defined proxy's handleUpgrade", async () => {
    const proxy = fakeProxy();
    const { server, listener } = await startListener(proxy);
    const { req, socket } = fakeRequest(`/s/${HANDLE}/x`);
    const head = Buffer.from("");

    server.emit("upgrade", req, socket, head);

    expect(proxy.handleUpgrade).toHaveBeenCalledWith(req, socket, head);
    expect(socket.destroy).not.toHaveBeenCalled();

    await listener.close();
  });

  it("destroys a non-sidecar upgrade even with a proxy configured, and never calls its handleUpgrade", async () => {
    const proxy = fakeProxy();
    const { server, listener } = await startListener(proxy);
    const { req, socket } = fakeRequest("/other");
    const head = Buffer.from("");

    server.emit("upgrade", req, socket, head);

    expect(proxy.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalled();

    await listener.close();
  });

  it("an /rpc upgrade still reaches ws's handleUpgrade even when a proxy is defined", async () => {
    const proxy = fakeProxy();
    const { server, listener } = await startListener(proxy);
    const { req, socket } = fakeRequest("/rpc");
    req.headers = {
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.alloc(16, 7).toString("base64"),
    };
    const head = Buffer.from("");

    server.emit("upgrade", req, socket, head);

    const wss = createdWssInstances[createdWssInstances.length - 1];
    expect(wss?.handleUpgrade).toHaveBeenCalled();
    expect(proxy.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();

    await listener.close();
  });
});
