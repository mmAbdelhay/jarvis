import { afterEach, describe, expect, it } from "vitest";
import { nativeTransport, setNativeModuleForTests } from "./native-transport";
import type { NativeSocketModule, PinnedSocketEvents } from "./native-transport";
import type { Trust, TransportEvent } from "./transport";
import { socketUrl } from "./transport";

describe("socketUrl", () => {
  it("formats an IPv4 host for /pair", () => {
    expect(socketUrl("192.168.1.5", 4317, "/pair")).toBe("wss://192.168.1.5:4317/pair");
  });

  it("formats an IPv4 host for /rpc", () => {
    expect(socketUrl("192.168.1.5", 4317, "/rpc")).toBe("wss://192.168.1.5:4317/rpc");
  });

  it("brackets an IPv6 host", () => {
    expect(socketUrl("::1", 4317, "/rpc")).toBe("wss://[::1]:4317/rpc");
  });

  it("brackets an IPv6 host with a zone id, percent-encoding the %", () => {
    expect(socketUrl("fe80::1%en0", 4317, "/pair")).toBe("wss://[fe80::1%25en0]:4317/pair");
  });

  it("does not double-bracket an already-bracketed IPv6 host", () => {
    expect(socketUrl("[::1]", 4317, "/rpc")).toBe("wss://[::1]:4317/rpc");
  });

  it("passes a DNS hostname through verbatim (M11 system-trust mode)", () => {
    expect(socketUrl("mac.tail.ts.net", 7717, "/rpc")).toBe("wss://mac.tail.ts.net:7717/rpc");
  });
});

// A minimal stand-in for `modules/pinned-socket`'s runtime shape, driven
// directly by the test rather than by real native events.
class FakeNativeModule implements NativeSocketModule {
  openCalls: Array<{ url: string; fingerprintHex: string }> = [];
  sendCalls: Array<{ id: number; text: string }> = [];
  sendBinaryCalls: Array<{ id: number; base64: string }> = [];
  closeCalls: Array<{ id: number; code: number; reason: string }> = [];

  private nextId = 1;
  private listeners: {
    [EventName in keyof PinnedSocketEvents]: Array<PinnedSocketEvents[EventName]>;
  } = { onOpen: [], onMessage: [], onClose: [], onError: [] };

  open(url: string, fingerprintHex: string): number {
    this.openCalls.push({ url, fingerprintHex });
    return this.nextId++;
  }

  send(id: number, text: string): void {
    this.sendCalls.push({ id, text });
  }

  sendBinary(id: number, base64: string): void {
    this.sendBinaryCalls.push({ id, base64 });
  }

  close(id: number, code: number, reason: string): void {
    this.closeCalls.push({ id, code, reason });
  }

  addListener<EventName extends keyof PinnedSocketEvents>(
    eventName: EventName,
    listener: PinnedSocketEvents[EventName],
  ): { remove(): void } {
    this.listeners[eventName].push(listener);
    return { remove: () => {} };
  }

  fireOnOpen(id: number): void {
    for (const listener of this.listeners.onOpen) listener({ id });
  }

  fireOnMessage(id: number, text: string): void {
    for (const listener of this.listeners.onMessage) listener({ id, text });
  }

  fireOnClose(id: number, code: number, reason: string): void {
    for (const listener of this.listeners.onClose) listener({ id, code, reason });
  }

  fireOnError(id: number, message: string): void {
    for (const listener of this.listeners.onError) listener({ id, message });
  }
}

const VALID_FINGERPRINT = "a".repeat(64);
const PIN_TRUST: Trust = { kind: "pin", fingerprint: VALID_FINGERPRINT };

afterEach(() => {
  setNativeModuleForTests(undefined);
});

describe("nativeTransport.open", () => {
  it("routes onOpen/onMessage/onClose to the right onEvent when two sockets are open", () => {
    const fake = new FakeNativeModule();
    setNativeModuleForTests(fake);

    const eventsA: TransportEvent[] = [];
    const eventsB: TransportEvent[] = [];
    nativeTransport.open("wss://host:1/rpc", PIN_TRUST, (e) => eventsA.push(e));
    nativeTransport.open("wss://host:1/rpc", PIN_TRUST, (e) => eventsB.push(e));

    // FakeNativeModule hands out ids 1 and 2, in open order.
    fake.fireOnOpen(1);
    fake.fireOnMessage(2, "hello b");
    fake.fireOnMessage(1, "hello a");
    fake.fireOnClose(2, 1000, "bye");

    expect(eventsA).toEqual<TransportEvent[]>([
      { kind: "open" },
      { kind: "message", text: "hello a" },
    ]);
    expect(eventsB).toEqual<TransportEvent[]>([
      { kind: "message", text: "hello b" },
      { kind: "close", code: 1000, reason: "bye" },
    ]);
  });

  it("drops later events for an id after its onClose", () => {
    const fake = new FakeNativeModule();
    setNativeModuleForTests(fake);

    const events: TransportEvent[] = [];
    nativeTransport.open("wss://host:1/rpc", PIN_TRUST, (e) => events.push(e));

    fake.fireOnClose(1, 1000, "bye");
    fake.fireOnMessage(1, "too late");
    fake.fireOnError(1, "too late");

    expect(events).toEqual<TransportEvent[]>([{ kind: "close", code: 1000, reason: "bye" }]);
  });

  it("routes onError to the right socket", () => {
    const fake = new FakeNativeModule();
    setNativeModuleForTests(fake);

    const eventsA: TransportEvent[] = [];
    const eventsB: TransportEvent[] = [];
    nativeTransport.open("wss://host:1/rpc", PIN_TRUST, (e) => eventsA.push(e));
    nativeTransport.open("wss://host:1/rpc", PIN_TRUST, (e) => eventsB.push(e));

    // FakeNativeModule hands out ids 1 and 2, in open order.
    fake.fireOnError(2, "send failed");

    expect(eventsA).toEqual([]);
    expect(eventsB).toEqual<TransportEvent[]>([{ kind: "error", message: "send failed" }]);
  });

  it("forwards send and close to the native module by id", () => {
    const fake = new FakeNativeModule();
    setNativeModuleForTests(fake);

    const socket = nativeTransport.open("wss://host:1/rpc", PIN_TRUST, () => {});
    socket.send("hi");
    socket.close(1000, "done");

    expect(fake.sendCalls).toEqual([{ id: 1, text: "hi" }]);
    expect(fake.closeCalls).toEqual([{ id: 1, code: 1000, reason: "done" }]);
  });

  it("forwards sendBinary to the native module by id", () => {
    const fake = new FakeNativeModule();
    setNativeModuleForTests(fake);

    const socket = nativeTransport.open("wss://host:1/rpc", PIN_TRUST, () => {});
    socket.sendBinary("AAAA");

    expect(fake.sendBinaryCalls).toEqual([{ id: 1, base64: "AAAA" }]);
  });

  it("rejects an invalid fingerprint without ever calling the native module, yielding error then close 1006", async () => {
    const fake = new FakeNativeModule();
    setNativeModuleForTests(fake);

    const events: TransportEvent[] = [];
    const socket = nativeTransport.open(
      "wss://host:1/rpc",
      { kind: "pin", fingerprint: "not-64-hex" },
      (e) => events.push(e),
    );

    // Synchronous return: no events yet, no native call yet.
    expect(events).toEqual([]);
    expect(fake.openCalls).toEqual([]);

    // Bite-proof: with the FINGERPRINT_PATTERN check in native-transport.ts
    // removed, `fake.openCalls` would gain an entry here instead of staying
    // empty — the fake native module would receive the call.
    await Promise.resolve();

    expect(fake.openCalls).toEqual([]);
    expect(events).toEqual<TransportEvent[]>([
      { kind: "error", message: "invalid fingerprint" },
      { kind: "close", code: 1006, reason: "fingerprint" },
    ]);

    // The returned socket is inert.
    socket.send("nope");
    socket.sendBinary("nope");
    socket.close(1000, "nope");
    expect(fake.sendCalls).toEqual([]);
    expect(fake.sendBinaryCalls).toEqual([]);
    expect(fake.closeCalls).toEqual([]);
  });

  it(
    "refuses a system-trust call with the same shape as an invalid fingerprint, never calling the native module " +
      '[bite-proof (M11 rule 2): treat `trust.kind === "system"` as a fingerprint and this test fails]',
    async () => {
      const fake = new FakeNativeModule();
      setNativeModuleForTests(fake);

      const events: TransportEvent[] = [];
      const socket = nativeTransport.open("wss://mac.tail.ts.net:1/rpc", { kind: "system" }, (e) =>
        events.push(e),
      );

      expect(events).toEqual([]);
      expect(fake.openCalls).toEqual([]);

      await Promise.resolve();

      expect(fake.openCalls).toEqual([]);
      expect(events).toEqual<TransportEvent[]>([
        { kind: "error", message: "invalid fingerprint" },
        { kind: "close", code: 1006, reason: "fingerprint" },
      ]);

      socket.send("nope");
      socket.close(1000, "nope");
      expect(fake.sendCalls).toEqual([]);
      expect(fake.closeCalls).toEqual([]);
    },
  );
});
