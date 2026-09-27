// Phase 0 owner login: the client side of the locked connection state.
// A v2 `welcome` leaves the connection locked (only `auth:*` requests go
// out); `unlock()` re-sends the subscriptions and flushes the queue; an
// `auth:state` push, an `err locked` or the idle lock's `lock()` put it back.

import { AUTH_STATE_CHANNEL, PROTOCOL_VERSION, encodeMessage } from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { ClientState, Credential, Endpoint, RpcResult } from "./rpc-client";
import { createRpcClient } from "./rpc-client";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };

function setup() {
  const transport = createFakeTransport();
  const clock = createFakeClock();
  const client = createRpcClient({
    transport,
    clock,
    random: () => 0.5,
    client: "jarvis-mobile/1.0.0/ios",
    log: () => {},
  });
  const states: ClientState[] = [];
  client.onState((state) => states.push(state));
  client.connect(ENDPOINT, CREDENTIAL);
  const socket = transport.sockets[0] as FakeSocket;
  return { client, socket, clock, states, transport };
}

function welcome(socket: FakeSocket, capabilities: string[] = ["session:output"]): void {
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
}

function frames(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
}

function lastReqId(socket: FakeSocket): number {
  const reqs = frames(socket).filter((f) => f.t === "req");
  return reqs[reqs.length - 1]?.id as number;
}

/** Locked → auth:login res → unlock(): the path auth-session takes. */
function openUnlocked() {
  const ctx = setup();
  welcome(ctx.socket);
  ctx.client.unlock();
  return ctx;
}

describe("rpc-client locked state", () => {
  it("a welcome leaves the connection locked: no sub add, no queued request sent", () => {
    const { client, socket, states } = setup();
    client.subscribe("session:output");
    void client.call("sessions:list", []);
    welcome(socket);
    expect(client.state()).toBe("locked");
    expect(states).toContain("locked");
    expect(states).not.toContain("open");
    expect(frames(socket).map((f) => f.t)).toEqual(["hello"]);
  });

  it("sends auth:* requests while locked but queues every other request", () => {
    const { client, socket } = setup();
    welcome(socket);
    void client.call("sessions:list", []);
    void client.call("auth:login", [{ password: "pw" }]);
    const sent = frames(socket).filter((f) => f.t === "req");
    expect(sent.map((f) => f.ch)).toEqual(["auth:login"]);
  });

  it("an auth:* request made while not connected is offline at once, never queued", async () => {
    const { client } = setup();
    const result = await client.call("auth:status", []);
    expect(result).toEqual({ ok: false, error: { kind: "offline" } });
  });

  it("unlock() re-sends every subscription, flushes the queue, and reports open", () => {
    const { client, socket, states } = setup();
    client.subscribe("session:output");
    void client.call("sessions:list", []);
    welcome(socket);
    client.unlock();
    expect(client.state()).toBe("open");
    expect(states[states.length - 1]).toBe("open");
    const tail = frames(socket).slice(1);
    expect(tail[0]).toEqual({ t: "sub", add: ["session:output"] });
    expect(tail[1]).toMatchObject({ t: "req", ch: "sessions:list" });
  });

  it("unlock() is a no-op unless locked", () => {
    const { client, socket } = openUnlocked();
    const before = socket.sent.length;
    client.unlock();
    expect(socket.sent.length).toBe(before);
  });

  it("an auth:state push locks an open connection and reaches push handlers", () => {
    const { client, socket } = openUnlocked();
    const pushes: unknown[] = [];
    client.onPush(AUTH_STATE_CHANNEL, (payload) => pushes.push(payload));
    client.subscribe("session:output");
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "psh",
        ch: AUTH_STATE_CHANNEL,
        p: { locked: true, reason: "expired" },
        seq: 1,
      }),
    });
    expect(client.state()).toBe("locked");
    expect(pushes).toEqual([{ locked: true, reason: "expired" }]);
    // The server already dropped the subscriptions itself: nothing sent.
    expect(frames(socket).filter((f) => f.t === "sub" && "drop" in f)).toEqual([]);
    // They come back on the next unlock.
    client.unlock();
    const adds = frames(socket).filter((f) => f.t === "sub" && "add" in f);
    expect(adds[adds.length - 1]).toEqual({ t: "sub", add: ["session:output"] });
  });

  it("err locked on a request puts the state in locked", async () => {
    const { client, socket } = openUnlocked();
    const pending = client.call("sessions:list", []);
    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "err",
        id: lastReqId(socket),
        code: "locked",
        text: "locked",
        language: "en",
      }),
    });
    const result: RpcResult = await pending;
    expect(result).toMatchObject({ ok: false, error: { kind: "remote", code: "locked" } });
    expect(client.state()).toBe("locked");
  });

  it("err id 0 locked (a refused sub frame) puts the state in locked", () => {
    const { client, socket } = openUnlocked();
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "err", id: 0, code: "locked", text: "locked", language: "en" }),
    });
    expect(client.state()).toBe("locked");
  });

  it("lock() (the idle lock) drops the subscriptions on the wire and queues later requests", () => {
    const { client, socket } = openUnlocked();
    client.subscribe("session:output");
    client.lock();
    expect(client.state()).toBe("locked");
    expect(frames(socket).filter((f) => f.t === "sub" && "drop" in f)).toEqual([
      { t: "sub", drop: ["session:output"] },
    ]);
    const before = socket.sent.length;
    void client.call("sessions:list", []);
    expect(socket.sent.length).toBe(before);
  });

  it("a reconnect's welcome locks again, and a locked socket still answers pings", () => {
    const { client, socket, clock, transport } = openUnlocked();
    socket.emit({ kind: "close", code: 1006, reason: "" });
    clock.advance(60_000);
    const second = transport.sockets[1] as FakeSocket;
    welcome(second);
    expect(client.state()).toBe("locked");
    second.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 7 }) });
    expect(frames(second).pop()).toEqual({ t: "pong", seq: 7 });
  });
});
