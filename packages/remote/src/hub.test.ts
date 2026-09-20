import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit.js";
import { fakeClock } from "./clock-double.js";
import type {
  AuditPolicy,
  AuthenticatedDevice,
  AuthorizeKey,
  RequestHandler,
  RequestOutcome,
} from "./connection.js";
import { createHub, MAX_CLIENTS, MAX_PENDING } from "./hub.js";
import type { HubDeps } from "./hub.js";
import type { SessionHandlers, SocketLike } from "./io.js";
import type { ChannelPolicies, ChannelPolicy, StreamPolicy } from "./policy.js";
import { CLOSE, PROTOCOL_VERSION } from "./protocol.js";
import { FakeSocket } from "./socket-double.js";

type StreamPayload = { k?: string; c: string; o?: number };

const streamPolicy: StreamPolicy = {
  kind: "stream",
  maxBytes: 262_144,
  keyOf: (p) => (p as StreamPayload).k,
  chunkOf: (p) => (p as StreamPayload).c,
  offsetOf: (p) => (p as StreamPayload).o,
  withChunk: (payload, chunk, offset) => {
    const { k } = payload as StreamPayload;
    const result: StreamPayload = { c: chunk };
    if (k !== undefined) result.k = k;
    if (offset !== undefined) result.o = offset;
    return result;
  },
};

const POLICIES: ChannelPolicies = new Map<string, ChannelPolicy>([
  ["metrics:update", { kind: "latest" }],
  ["sessions:update", { kind: "latest" }],
  ["t:stream", streamPolicy],
]);

const errorText = (code: string) => ({ text: `err:${code}`, language: "en" as const });

/** device n <-> token n (brief's hub test harness), both syntactically valid per protocol.ts's patterns. */
function deviceId(n: number): string {
  return `d${n}`.padEnd(32, "a");
}

function tokenFor(n: number): string {
  return `t${n}${"x".repeat(42 - String(n).length)}`;
}

function authenticate(id: string, token: string): AuthenticatedDevice | undefined {
  const match = /^d(\d+)a*$/.exec(id);
  if (match === null) return undefined;
  const n = match[1] ?? "";
  return token === tokenFor(Number(n)) ? { id, name: `Device ${n}` } : undefined;
}

function helloFrame(n: number, tokenOverride?: string): string {
  return JSON.stringify({
    t: "hello",
    v: PROTOCOL_VERSION,
    deviceId: deviceId(n),
    token: tokenOverride ?? tokenFor(n),
    client: "test/1.0",
  });
}

function subFrame(add: Array<string | { ch: string; key: string }>): string {
  return JSON.stringify({ t: "sub", add });
}

function blobFrame(id: number, ch: string, bytes: number, chunks: number): string {
  return JSON.stringify({ t: "blob", id, ch, a: [], bytes, chunks });
}

function makeHarness(overrides: Partial<HubDeps> = {}) {
  const clock = fakeClock(0);
  const handle: RequestHandler =
    overrides.handle ?? (async () => ({ kind: "value", value: null }) as RequestOutcome);
  const log = vi.fn();
  const audit = { record: vi.fn<(event: AuditEvent) => void>() };
  const touch = vi.fn();
  const onConnectionsChanged = vi.fn();
  const onDeviceDisconnected = vi.fn();
  const pairSession = overrides.pairSession ?? vi.fn();
  const authorizeKey: AuthorizeKey = overrides.authorizeKey ?? (() => true);
  const deps: HubDeps = {
    now: clock.now,
    timers: clock.timers,
    authenticate: overrides.authenticate ?? authenticate,
    handle,
    policies: overrides.policies ?? POLICIES,
    authorizeKey,
    blobLimit: overrides.blobLimit ?? (() => undefined),
    errorText,
    log,
    audit,
    auditPolicy: overrides.auditPolicy ?? (() => "never"),
    touch,
    onConnectionsChanged,
    onDeviceDisconnected,
    pairSession,
    ...overrides,
  };
  const hub = createHub(deps);
  return {
    clock,
    hub,
    log,
    audit,
    touch,
    onConnectionsChanged,
    onDeviceDisconnected,
    pairSession,
    deps,
  };
}

/** Drives a fresh socket through the hub's `accept` to a fully open, authenticated connection for device n. */
function openDevice(
  hub: ReturnType<typeof createHub>,
  n: number,
  source = `10.0.0.${n}:1`,
): { socket: FakeSocket; handlers: SessionHandlers } {
  const socket = new FakeSocket();
  const handlers = hub.accept("rpc", socket, source);
  handlers.onText(helloFrame(n));
  return { socket, handlers };
}

describe("createHub: rpc", () => {
  it("two subscribed connections both receive a push", () => {
    const { hub } = makeHarness();
    const { socket: s1, handlers: h1 } = openDevice(hub, 1);
    const { socket: s2, handlers: h2 } = openDevice(hub, 2);
    h1.onText(subFrame(["metrics:update"]));
    h2.onText(subFrame(["metrics:update"]));
    s1.sent = [];
    s2.sent = [];

    hub.push("metrics:update", { cpu: 1 });

    expect(s1.sent).toEqual([{ t: "psh", ch: "metrics:update", p: { cpu: 1 }, seq: 1 }]);
    expect(s2.sent).toEqual([{ t: "psh", ch: "metrics:update", p: { cpu: 1 }, seq: 1 }]);
  });

  it("a push for a channel not in policies never calls any connection's push", () => {
    const { hub } = makeHarness();
    const { socket: s1, handlers: h1 } = openDevice(hub, 1);
    h1.onText(subFrame(["metrics:update"]));
    s1.sent = [];

    hub.push("remote:update", { any: true });

    expect(s1.sent).toEqual([]);
  });

  it("a keyed push whose keyOf throws or returns 'a b' reaches nobody", () => {
    const { hub } = makeHarness();
    const { socket: s1, handlers: h1 } = openDevice(hub, 1);
    h1.onText(subFrame([{ ch: "t:stream", key: "p1" }]));
    s1.sent = [];

    hub.push("t:stream", { k: undefined, c: "x", o: 0 }); // keyOf -> undefined -> not a subscription key
    hub.push("t:stream", { k: "a b", c: "x", o: 0 }); // fails SUBSCRIPTION_KEY_PATTERN

    expect(s1.sent).toEqual([]);
  });

  it("a keyOf that throws reaches nobody", () => {
    const throwingPolicies: ChannelPolicies = new Map<string, ChannelPolicy>([
      [
        "t:stream",
        {
          ...streamPolicy,
          keyOf: () => {
            throw new Error("boom");
          },
        },
      ],
    ]);
    const { hub } = makeHarness({ policies: throwingPolicies });
    const { socket: s1, handlers: h1 } = openDevice(hub, 1);
    h1.onText(subFrame([{ ch: "t:stream", key: "p1" }]));
    s1.sent = [];

    hub.push("t:stream", { k: "p1", c: "x", o: 0 });

    expect(s1.sent).toEqual([]);
  });

  it("keyOf is called once per push with three subscribed connections", () => {
    let calls = 0;
    const keyOfPolicies: ChannelPolicies = new Map<string, ChannelPolicy>([
      [
        "t:stream",
        {
          ...streamPolicy,
          keyOf: (p) => {
            calls += 1;
            return (p as StreamPayload).k;
          },
        },
      ],
    ]);
    const { hub } = makeHarness({ policies: keyOfPolicies });
    const { handlers: h1 } = openDevice(hub, 1);
    const { handlers: h2 } = openDevice(hub, 2);
    const { handlers: h3 } = openDevice(hub, 3);
    h1.onText(subFrame([{ ch: "t:stream", key: "p1" }]));
    h2.onText(subFrame([{ ch: "t:stream", key: "p1" }]));
    h3.onText(subFrame([{ ch: "t:stream", key: "p1" }]));

    hub.push("t:stream", { k: "p1", c: "x", o: 0 });

    expect(calls).toBe(1);
  });

  it("a connection is audited connected (no token) and the device is touched", () => {
    const { hub, audit, touch } = makeHarness();
    openDevice(hub, 1);

    expect(audit.record).toHaveBeenCalledWith({
      kind: "connected",
      source: "10.0.0.1:1",
      deviceId: deviceId(1),
    });
    for (const call of audit.record.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(tokenFor(1));
    }
    expect(touch).toHaveBeenCalledWith(deviceId(1));
  });

  it("hasSubscriber('metrics:update') is false, then true after one connection subscribes, then false after it closes", () => {
    const { hub } = makeHarness();
    expect(hub.hasSubscriber("metrics:update")).toBe(false);

    const { handlers } = openDevice(hub, 1);
    expect(hub.hasSubscriber("metrics:update")).toBe(false);

    handlers.onText(subFrame(["metrics:update"]));
    expect(hub.hasSubscriber("metrics:update")).toBe(true);

    handlers.onClose(1006);
    expect(hub.hasSubscriber("metrics:update")).toBe(false);
  });

  it("device d1 with two sockets: closing one gives no callback; closing the second fires onDeviceDisconnected('d1') once", () => {
    const { hub, onDeviceDisconnected } = makeHarness();
    const { handlers: h1a } = openDevice(hub, 1);
    const socket1b = new FakeSocket();
    const handlers1b = hub.accept("rpc", socket1b, "10.0.0.9:1");
    handlers1b.onText(helloFrame(1));

    h1a.onClose(1006);
    expect(onDeviceDisconnected).not.toHaveBeenCalled();

    handlers1b.onClose(1006);
    expect(onDeviceDisconnected).toHaveBeenCalledTimes(1);
    expect(onDeviceDisconnected).toHaveBeenCalledWith(deviceId(1));
  });

  it("closeDevice(d1, 4410) fires onDeviceDisconnected once", () => {
    const { hub, onDeviceDisconnected } = makeHarness();
    openDevice(hub, 1);
    const socket1b = new FakeSocket();
    hub.accept("rpc", socket1b, "10.0.0.9:1").onText(helloFrame(1));

    hub.closeDevice(deviceId(1), CLOSE.revoked);

    expect(onDeviceDisconnected).toHaveBeenCalledTimes(1);
    expect(onDeviceDisconnected).toHaveBeenCalledWith(deviceId(1));
  });

  it("a throwing onDeviceDisconnected is logged, never left to escape", () => {
    const onDeviceDisconnected = vi.fn(() => {
      throw new Error("boom");
    });
    const { hub, log } = makeHarness({ onDeviceDisconnected });
    const { handlers } = openDevice(hub, 1);

    handlers.onClose(1006);

    expect(log.mock.calls.some((call) => String(call[0]).includes("boom"))).toBe(true);
  });

  it("[bite-proof: revocation closes live sockets] closeDevice closes only that device's sockets", () => {
    const { hub, onConnectionsChanged } = makeHarness();
    const { socket: d1a } = openDevice(hub, 1);
    const socket1b = new FakeSocket();
    const handlers1b = hub.accept("rpc", socket1b, "10.0.0.9:1");
    handlers1b.onText(helloFrame(1));

    const { socket: d2 } = openDevice(hub, 2);

    onConnectionsChanged.mockClear();
    const count = hub.closeDevice(deviceId(1), CLOSE.revoked);

    expect(count).toBe(2);
    expect(d1a.closed).toEqual({ code: CLOSE.revoked, reason: "" });
    expect(socket1b.closed).toEqual({ code: CLOSE.revoked, reason: "" });
    expect(d2.closed).toBeUndefined();
    expect(hub.connectedDeviceIds()).toEqual(new Set([deviceId(2)]));
    expect(onConnectionsChanged).toHaveBeenCalledTimes(1);

    d1a.sent = [];
    socket1b.sent = [];
    hub.push("metrics:update", "x");
    expect(d1a.sent).toEqual([]);
    expect(socket1b.sent).toEqual([]);
  });

  it("a 9th authenticated client is refused 4503, audited refused capacity, with no welcome frame", () => {
    const { hub, audit } = makeHarness();
    for (let n = 1; n <= MAX_CLIENTS; n++) openDevice(hub, n);

    const socket = new FakeSocket();
    const handlers = hub.accept("rpc", socket, "10.0.0.99:1");
    handlers.onText(helloFrame(99));

    expect(socket.closed).toEqual({ code: CLOSE.overCapacity, reason: "" });
    expect(audit.record).toHaveBeenCalledWith({
      kind: "refused",
      source: "10.0.0.99:1",
      reason: "capacity",
    });
    // Ruling P8: onOpen (the hub's capacity check) runs before welcome is
    // ever sent, so a client refused here never sees one.
    expect(socket.sent).toEqual([]);
  });

  it("a 17th pending socket is refused 4503 before any frame", () => {
    const { hub } = makeHarness();
    const sockets: FakeSocket[] = [];
    for (let i = 0; i < MAX_PENDING; i++) {
      const socket = new FakeSocket();
      hub.accept("rpc", socket, `10.0.1.${i}:1`);
      sockets.push(socket);
    }
    for (const socket of sockets) expect(socket.closed).toBeUndefined();

    const socket17 = new FakeSocket();
    hub.accept("rpc", socket17, "10.0.1.99:1");
    expect(socket17.closed).toEqual({ code: CLOSE.overCapacity, reason: "" });
  });

  it("closing one pending socket frees a slot", () => {
    const { hub } = makeHarness();
    const handlersList: SessionHandlers[] = [];
    for (let i = 0; i < MAX_PENDING; i++) {
      const socket = new FakeSocket();
      handlersList.push(hub.accept("rpc", socket, `10.0.1.${i}:1`));
    }
    handlersList[0]?.onClose(1006); // the first pending socket goes away

    const freed = new FakeSocket();
    hub.accept("rpc", freed, "10.0.1.200:1");
    expect(freed.closed).toBeUndefined();
  });

  it("hub backoff: a bad hello is audited bad-credentials, 4401; a second socket from that source is 4429; +1s recovers", () => {
    const { hub, clock, audit } = makeHarness();
    const source = "10.0.2.1:1";
    const socket1 = new FakeSocket();
    const handlers1 = hub.accept("rpc", socket1, source);
    handlers1.onText(helloFrame(1, tokenFor(999))); // wrong token
    expect(socket1.closed).toEqual({ code: CLOSE.unauthorized, reason: "" });
    expect(audit.record).toHaveBeenCalledWith({
      kind: "auth-failed",
      source,
      reason: "bad-credentials",
    });

    const socket2 = new FakeSocket();
    hub.accept("rpc", socket2, source);
    expect(socket2.closed).toEqual({ code: CLOSE.tooManyRequests, reason: "" });

    clock.advance(1_000);
    const socket3 = new FakeSocket();
    const handlers3 = hub.accept("rpc", socket3, source);
    handlers3.onText(helloFrame(1));
    expect(socket3.closed).toBeUndefined();
  });

  // I4: a source hammering a blocked window would otherwise get one
  // `auth-failed backoff` audit line per attempt.
  it("[bite-proof] logs auth-failed backoff at most once per block period, not once per attempt", () => {
    const { hub, clock, audit } = makeHarness();
    const source = "10.0.2.9:1";
    const first = new FakeSocket();
    hub.accept("rpc", first, source).onText(helloFrame(1, tokenFor(999)));
    audit.record.mockClear();

    // Three more attempts while still blocked — each is refused (4429),
    // but only the first of them should add a new audit line.
    hub.accept("rpc", new FakeSocket(), source);
    hub.accept("rpc", new FakeSocket(), source);
    hub.accept("rpc", new FakeSocket(), source);

    const backoffLines = audit.record.mock.calls.filter(
      ([event]) => event.kind === "auth-failed" && event.reason === "backoff",
    );
    expect(backoffLines).toHaveLength(1);

    // A fresh failed attempt (once unblocked) starts a new block period,
    // which gets its own line again.
    clock.advance(1_000);
    hub.accept("rpc", new FakeSocket(), source).onText(helloFrame(1, tokenFor(999)));
    audit.record.mockClear();
    hub.accept("rpc", new FakeSocket(), source);
    hub.accept("rpc", new FakeSocket(), source);

    const secondPeriodLines = audit.record.mock.calls.filter(
      ([event]) => event.kind === "auth-failed" && event.reason === "backoff",
    );
    expect(secondPeriodLines).toHaveLength(1);
  });
});

describe("createHub: watchingDevices", () => {
  it("answers device ids by channel/key, updating as a device disconnects", () => {
    const policies: ChannelPolicies = new Map<string, ChannelPolicy>([
      ["turn:new", { kind: "latest" }],
      ["session:output", streamPolicy],
    ]);
    const { hub } = makeHarness({ policies });
    const { handlers: h1 } = openDevice(hub, 1);
    const { handlers: h2 } = openDevice(hub, 2);
    h1.onText(subFrame(["turn:new"]));
    h2.onText(subFrame([{ ch: "session:output", key: "s1" }]));

    expect(hub.watchingDevices("turn:new")).toEqual(new Set([deviceId(1)]));
    expect(hub.watchingDevices("session:output", "s1")).toEqual(new Set([deviceId(2)]));
    expect(hub.watchingDevices("session:output")).toEqual(new Set());

    hub.closeDevice(deviceId(1), CLOSE.revoked);
    expect(hub.watchingDevices("turn:new")).toEqual(new Set());
  });
});

describe("createHub: blob upload", () => {
  it("blobLimit reaches the connection: a hub-created connection refuses a blob for a channel the hub's blobLimit does not know", () => {
    const blobLimit = vi.fn((channel: string) => (channel === "test:blob" ? 1_000_000 : undefined));
    const { hub } = makeHarness({ blobLimit });
    const { socket, handlers } = openDevice(hub, 1);
    socket.sent = [];

    handlers.onText(blobFrame(1, "other:blob", 1_000, 1));

    expect(socket.sent).toEqual([
      { t: "err", id: 1, code: "unknown-channel", text: "err:unknown-channel", language: "en" },
    ]);
    expect(blobLimit).toHaveBeenCalledWith("other:blob");
    expect(socket.closed).toBeUndefined();
  });
});

describe("createHub: pair", () => {
  it("accept('pair', ...) calls pairSession(socket, source, fn); calling fn blocks the source", () => {
    let capturedOnFailure: (() => void) | undefined;
    const pairSession = vi.fn(
      (_socket: SocketLike, _source: string, onFailure: () => void): SessionHandlers => {
        capturedOnFailure = onFailure;
        return { onText: vi.fn(), onBinary: vi.fn(), onClose: vi.fn() };
      },
    );
    const { hub } = makeHarness({ pairSession });
    const socket = new FakeSocket();
    hub.accept("pair", socket, "10.0.3.1:1");

    expect(pairSession).toHaveBeenCalledWith(socket, "10.0.3.1:1", expect.any(Function));
    capturedOnFailure?.();

    const socket2 = new FakeSocket();
    hub.accept("pair", socket2, "10.0.3.1:1");
    expect(socket2.closed).toEqual({ code: CLOSE.tooManyRequests, reason: "" });
  });
});

describe("createHub: closeAll and disconnection", () => {
  it("closeAll closes both an authenticated and a pending socket, disarming the pending handshake timer", () => {
    const { hub, clock } = makeHarness();
    const { socket: opened } = openDevice(hub, 1);
    const pending = new FakeSocket();
    hub.accept("rpc", pending, "10.0.4.1:1"); // never sent a hello — still mid-handshake

    hub.closeAll(1001);

    expect(opened.closed).toEqual({ code: 1001, reason: "" });
    expect(pending.closed).toEqual({ code: 1001, reason: "" });
    // Not just "the socket is closed": the pending connection's own 5s
    // handshake timer must be disarmed too, or a real ws peer that delays
    // its close event would later fire a spurious `auth-failed` timeout.
    expect(clock.pending()).toBe(0);
  });

  it("[bite-proof: closeAll disarms a pending pair session] a pending pair socket is closed and its session's onClose runs", () => {
    const pairOnClose = vi.fn();
    const pairSession = vi.fn(
      (): SessionHandlers => ({ onText: vi.fn(), onBinary: vi.fn(), onClose: pairOnClose }),
    );
    const { hub } = makeHarness({ pairSession });
    const socket = new FakeSocket();
    hub.accept("pair", socket, "10.0.4.2:1");

    hub.closeAll(1001);

    expect(socket.closed).toEqual({ code: 1001, reason: "" });
    expect(pairOnClose).toHaveBeenCalledWith(1001);
  });

  it("a socket close is removed from connected and audited disconnected with its code", () => {
    const { hub, audit, onConnectionsChanged } = makeHarness();
    const { handlers } = openDevice(hub, 1);
    onConnectionsChanged.mockClear();

    handlers.onClose(1006);

    expect(hub.connectedDeviceIds()).toEqual(new Set());
    expect(audit.record).toHaveBeenCalledWith({
      kind: "disconnected",
      deviceId: deviceId(1),
      code: 1006,
    });
    expect(onConnectionsChanged).toHaveBeenCalledTimes(1);
  });
});

// M12 Task 3: HubDeps.auditPolicy is a pure pass-through to the connection
// it creates — proven with a spy policy that only this test's own channel
// resolves to "always".
describe("createHub: auditPolicy pass-through", () => {
  it("reaches the connection: a spy policy's channel is audited, everything else is not", async () => {
    const auditPolicy: (channel: string) => AuditPolicy = (channel) =>
      channel === "spy:channel" ? "always" : "never";
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const { hub, audit } = makeHarness({ handle, auditPolicy });
    const { handlers } = openDevice(hub, 1);

    handlers.onText(JSON.stringify({ t: "req", id: 1, ch: "spy:channel", a: [] }));
    handlers.onText(JSON.stringify({ t: "req", id: 2, ch: "other:channel", a: [] }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const remoteCallLines = audit.record.mock.calls.filter(
      (call) => (call[0] as AuditEvent).kind === "remote-call",
    );
    expect(remoteCallLines).toHaveLength(1);
    expect(remoteCallLines[0]?.[0]).toEqual({
      kind: "remote-call",
      deviceId: deviceId(1),
      channel: "spy:channel",
      outcome: "ok",
    });
  });
});
