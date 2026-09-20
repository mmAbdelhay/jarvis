import { describe, expect, it } from "vitest";
import { createSystemTransport } from "./system-transport";
import type { WebSocketFactory, WebSocketLike } from "./system-transport";
import type { TransportEvent } from "./transport";

const SYSTEM_URL = "wss://mac.tail.ts.net:4317/rpc";
const CONNECTING = 0;
const OPEN = 1;

/** A minimal, fully scriptable stand-in for React Native's `WebSocket` —
 * driven directly by the test, never by a real socket. */
class FakeWebSocket implements WebSocketLike {
  readyState = CONNECTING;
  sent: string[] = [];
  sentBinary: Uint8Array[] = [];
  closeCalls: Array<{ code?: number; reason?: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;

  send(data: string | Uint8Array): void {
    if (typeof data === "string") {
      this.sent.push(data);
    } else {
      this.sentBinary.push(data);
    }
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }
}

function setup() {
  const sockets: FakeWebSocket[] = [];
  const factory: WebSocketFactory = () => {
    const ws = new FakeWebSocket();
    sockets.push(ws);
    return ws;
  };
  const transport = createSystemTransport(factory);
  return { transport, sockets };
}

describe("createSystemTransport: accepted target", () => {
  it("routes onopen/onmessage(string)/onclose to onEvent, and constructs exactly one real socket", () => {
    const { transport, sockets } = setup();
    const events: TransportEvent[] = [];
    transport.open(SYSTEM_URL, { kind: "system" }, (e) => events.push(e));

    expect(sockets).toHaveLength(1);
    const ws = sockets[0] as FakeWebSocket;
    ws.onopen?.();
    ws.onmessage?.({ data: "hello" });
    ws.onclose?.({ code: 1000, reason: "bye" });

    expect(events).toEqual<TransportEvent[]>([
      { kind: "open" },
      { kind: "message", text: "hello" },
      { kind: "close", code: 1000, reason: "bye" },
    ]);
  });

  it("drops a non-string message, never emitting it as a message event", () => {
    const { transport, sockets } = setup();
    const events: TransportEvent[] = [];
    transport.open(SYSTEM_URL, { kind: "system" }, (e) => events.push(e));
    const ws = sockets[0] as FakeWebSocket;

    ws.onmessage?.({ data: new ArrayBuffer(4) });

    expect(events).toEqual([]);
  });

  it("treats a close with no numeric code as 1006", () => {
    const { transport, sockets } = setup();
    const events: TransportEvent[] = [];
    transport.open(SYSTEM_URL, { kind: "system" }, (e) => events.push(e));
    const ws = sockets[0] as FakeWebSocket;

    ws.onclose?.({ reason: "dropped" });

    expect(events).toEqual<TransportEvent[]>([{ kind: "close", code: 1006, reason: "dropped" }]);
  });

  it("send() is a no-op while readyState isn't OPEN(1); forwards once it is", () => {
    const { transport, sockets } = setup();
    const socket = transport.open(SYSTEM_URL, { kind: "system" }, () => {});
    const ws = sockets[0] as FakeWebSocket;

    ws.readyState = CONNECTING;
    socket.send("too early");
    expect(ws.sent).toEqual([]);

    ws.readyState = OPEN;
    socket.send("hi");
    expect(ws.sent).toEqual(["hi"]);
  });

  it("sendBinary() decodes base64 and forwards a real binary frame once OPEN (M8 Task 5, matching nativeTransport's sendBinary)", () => {
    const { transport, sockets } = setup();
    const socket = transport.open(SYSTEM_URL, { kind: "system" }, () => {});
    const ws = sockets[0] as FakeWebSocket;
    ws.readyState = OPEN;

    socket.sendBinary("AAAA");

    expect(ws.sentBinary).toHaveLength(1);
    expect(Array.from(ws.sentBinary[0] as Uint8Array)).toEqual([0, 0, 0]);
  });

  it(
    "sendBinary() throws instead of silently dropping while readyState isn't OPEN(1) " +
      "[rpc-client.ts's upload() catches this and resolves the call offline rather than " +
      "leaving it stuck in flight — bite-proof: a silent no-op here breaks that contract]",
    () => {
      const { transport, sockets } = setup();
      const socket = transport.open(SYSTEM_URL, { kind: "system" }, () => {});
      const ws = sockets[0] as FakeWebSocket;
      ws.readyState = CONNECTING;

      expect(() => socket.sendBinary("AAAA")).toThrow();
      expect(ws.sentBinary).toEqual([]);
    },
  );

  it("close() forwards the code and reason to the real socket", () => {
    const { transport, sockets } = setup();
    const socket = transport.open(SYSTEM_URL, { kind: "system" }, () => {});
    const ws = sockets[0] as FakeWebSocket;

    socket.close(4410, "revoked");

    expect(ws.closeCalls).toEqual([{ code: 4410, reason: "revoked" }]);
  });

  it(
    "synthesises close 1006 exactly once when onerror fires with no real onclose following it " +
      "[bite-proof: dropping the queueMicrotask synthesis leaves `events` stuck at just the error]",
    async () => {
      const { transport, sockets } = setup();
      const events: TransportEvent[] = [];
      transport.open(SYSTEM_URL, { kind: "system" }, (e) => events.push(e));
      const ws = sockets[0] as FakeWebSocket;

      ws.onerror?.({ message: "tls handshake failed" });
      expect(events).toEqual<TransportEvent[]>([
        { kind: "error", message: "tls handshake failed" },
      ]);

      await Promise.resolve();
      await Promise.resolve();

      expect(events).toEqual<TransportEvent[]>([
        { kind: "error", message: "tls handshake failed" },
        { kind: "close", code: 1006, reason: "" },
      ]);

      // One close per socket: a late real close must not add a second one.
      ws.onclose?.({ code: 4410, reason: "late" });
      expect(events).toHaveLength(2);
    },
  );

  it(
    "deterministic rule: a real onclose that arrives in the same tick as onerror wins over the " +
      "synthesised 1006 (documented in system-transport.ts's emitClose comment) — one close, the real code",
    async () => {
      const { transport, sockets } = setup();
      const events: TransportEvent[] = [];
      transport.open(SYSTEM_URL, { kind: "system" }, (e) => events.push(e));
      const ws = sockets[0] as FakeWebSocket;

      ws.onerror?.({ message: "boom" });
      // Fires synchronously, before the queued microtask below runs.
      ws.onclose?.({ code: 4410, reason: "revoked" });

      await Promise.resolve();
      await Promise.resolve();

      expect(events).toEqual<TransportEvent[]>([
        { kind: "error", message: "boom" },
        { kind: "close", code: 4410, reason: "revoked" },
      ]);
    },
  );
});

describe("createSystemTransport: refusal", () => {
  async function expectRefused(events: TransportEvent[], sockets: FakeWebSocket[]): Promise<void> {
    expect(sockets).toHaveLength(0);
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(sockets).toHaveLength(0);
    expect(events).toEqual<TransportEvent[]>([
      { kind: "error", message: "not a system-trust target" },
      { kind: "close", code: 1006, reason: "trust" },
    ]);
  }

  it("refuses pin trust — never calls the factory", async () => {
    const { transport, sockets } = setup();
    const events: TransportEvent[] = [];
    const socket = transport.open(SYSTEM_URL, { kind: "pin", fingerprint: "a".repeat(64) }, (e) =>
      events.push(e),
    );
    await expectRefused(events, sockets);
    // The returned socket is inert.
    socket.send("nope");
    socket.close(1000, "nope");
    expect(sockets).toHaveLength(0);
  });

  it("refuses ws:// (not wss://)", async () => {
    const { transport, sockets } = setup();
    const events: TransportEvent[] = [];
    transport.open("ws://mac.tail.ts.net:4317/rpc", { kind: "system" }, (e) => events.push(e));
    await expectRefused(events, sockets);
  });

  it(
    "refuses an IP host [bite-proof: drop the isHostname check in system-transport.ts and this row " +
      "wrongly opens a real socket]",
    async () => {
      const { transport, sockets } = setup();
      const events: TransportEvent[] = [];
      transport.open("wss://192.168.1.5:4317/rpc", { kind: "system" }, (e) => events.push(e));
      await expectRefused(events, sockets);
    },
  );

  it("refuses a URL with no port (no host/port split possible)", async () => {
    const { transport, sockets } = setup();
    const events: TransportEvent[] = [];
    transport.open("wss://mac.tail.ts.net/rpc", { kind: "system" }, (e) => events.push(e));
    await expectRefused(events, sockets);
  });
});
