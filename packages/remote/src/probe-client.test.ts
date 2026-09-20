// Pure unit coverage for the one part of probe-client.ts that doesn't touch
// a real socket: `runProbe`'s pre-flight host gate, plus `runConnectedProbe`/
// `runTerminalProbe` driven through a fake `DeviceSession`. `openPinned` and
// `pairDevice` stay exercised only by the real network in
// bridge.integration.test.ts — the package's one real-network test. The one
// exception is the "reject pending push waiters on close" describe block
// below: `connectDevice`'s close handling lives inside its own Promise
// executor with no injection seam, so it is unit-tested here against a fake
// `ws.WebSocket` (an in-memory event emitter, never a real socket) rather
// than left uncovered or moved into the real-network test.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Credential, DeviceSession } from "./probe-client.js";
import {
  connectDevice,
  isIpLiteral,
  isLoopback,
  ProbeClosedError,
  PROBE_PUSH_WINDOW,
  renderChunk,
  runConnectedProbe,
  runProbe,
  runTerminalProbe,
} from "./probe-client.js";
import { encodeMessage, formatPairingUri, PROTOCOL_VERSION } from "./protocol.js";
import type { PairingLink } from "./protocol.js";

const VALID_LINK = {
  host: "127.0.0.1",
  port: 1234,
  secret: "a".repeat(43),
  fingerprint: "0".repeat(64),
};

/**
 * A fake `DeviceSession` for unit testing `runConnectedProbe` and
 * `runTerminalProbe` without a real socket. Every method that matters for
 * ordering pushes its name onto the shared `order` log; callers wire the
 * per-channel `call`/`pushes` behaviour they need.
 */
function fakeSession(config: {
  order: string[];
  call(channel: string): Record<string, unknown>;
  /**
   * Either a fixed per-channel array (the common case), or a function
   * called fresh on every `pushes(channel)` — for a test that needs to
   * simulate a live, growing, *evicting* feed (a real `connectDevice`
   * session's `pushLog` past `PROBE_PUSH_WINDOW`) without a real socket.
   */
  pushes?:
    | Record<string, Record<string, unknown>[]>
    | ((channel: string) => Record<string, unknown>[]);
  closed?: Promise<number>;
}): DeviceSession {
  const { order, closed = new Promise<number>(() => {}) } = config;
  return {
    welcome: { capabilities: [] },
    closed,
    async call(channel: string) {
      order.push(`call:${channel}`);
      return config.call(channel);
    },
    async upload() {
      throw new Error("upload is not used by these probes");
    },
    subscribe(targets) {
      order.push(`subscribe:${JSON.stringify(targets)}`);
    },
    unsubscribe() {},
    async nextPush(channel: string) {
      order.push(`nextPush:${channel}`);
      return {};
    },
    pushes(channel: string) {
      if (typeof config.pushes === "function") return config.pushes(channel);
      return [...(config.pushes?.[channel] ?? [])];
    },
    pauseReading() {},
    resumeReading() {},
    async bye() {
      order.push("bye");
      return 1000;
    },
  };
}

function validUri(): string {
  return formatPairingUri(VALID_LINK);
}

describe("isLoopback", () => {
  // The bug this guards against: a string-prefix check
  // (`host.startsWith("127.")` alone) treats any hostname that merely
  // *starts with* "127." as loopback, and DNS lets an attacker register
  // exactly that.
  it.each([
    ["127.evil.example.com", false],
    ["127.0.0.1.evil.com", false],
    ["localhost", false],
    ["127.0.0.5", true],
    ["::1", true],
  ] as const)("isLoopback(%j) is %s", (host, expected) => {
    expect(isLoopback(host)).toBe(expected);
  });
});

describe("isIpLiteral", () => {
  it.each([
    ["127.evil.example.com", false],
    ["127.0.0.1.evil.com", false],
    ["localhost", false],
    ["127.0.0.5", true],
    ["::1", true],
    ["10.0.0.1", true],
  ] as const)("isIpLiteral(%j) is %s", (host, expected) => {
    expect(isIpLiteral(host)).toBe(expected);
  });
});

describe("runProbe: pre-flight host validation (no network reached)", () => {
  it.each(["127.evil.example.com", "127.0.0.1.evil.com", "localhost"])(
    "refuses a --host override of %j before ever touching the network",
    async (host) => {
      await expect(
        runProbe({
          uri: validUri(),
          hostOverride: host,
          deviceName: "Unit test",
          allowNonLoopback: false,
          hold: false,
          log: () => {},
        }),
      ).rejects.toThrow(/IP literal/);
    },
  );

  it("never echoes the URI (or its secret) in the invalid-URI error", async () => {
    const uri = "jarvis://pair?not-a-real-pairing-uri";
    await expect(
      runProbe({
        uri,
        deviceName: "Unit test",
        allowNonLoopback: false,
        hold: false,
        log: () => {},
      }),
    ).rejects.toMatchObject({ message: expect.not.stringContaining(uri) });
  });

  it("refuses a non-loopback host without --allow-non-loopback, before touching the network", async () => {
    await expect(
      runProbe({
        uri: formatPairingUri({ ...VALID_LINK, host: "203.0.113.5" }),
        deviceName: "Unit test",
        allowNonLoopback: false,
        hold: false,
        log: () => {},
      }),
    ).rejects.toThrow(/loopback/);
  });

  it("refuses a --terminal value that isn't a subscription key, before ever touching the network", async () => {
    await expect(
      runProbe({
        uri: validUri(),
        deviceName: "Unit test",
        allowNonLoopback: false,
        hold: false,
        terminal: "a b",
        log: () => {},
      }),
    ).rejects.toThrow(/usage: remote-probe\.mjs/);
  });
});

describe("renderChunk (the ruling-10 client rule)", () => {
  it.each([
    [10, 8, "abcd", "cd"],
    [10, 12, "ab", "ab"],
    [10, 4, "abc", ""],
  ] as const)("renderChunk(end=%d, offset=%d, %j) is %j", (end, offset, chunk, expected) => {
    expect(renderChunk(end, offset, chunk)).toBe(expected);
  });
});

describe("runConnectedProbe: --terminal runs on top of the M4 sequence, not instead of it", () => {
  it("subscribes/calls the M4 checks and the bad-token check before ever touching the terminal channels", async () => {
    const order: string[] = [];
    const session = fakeSession({
      order,
      call(channel) {
        if (channel === "remote:bindChoices") return { t: "err", code: "forbidden" };
        if (channel === "terminal:snapshot") return { t: "res", v: { text: "", end: 0 } };
        return { t: "res", v: {} };
      },
      // The terminal probe's own loop exits immediately: an exit push is
      // already queued before `runTerminalProbe` ever polls, so this test
      // only has to prove ordering, not exercise the poll loop.
      pushes: { "terminal:exit": [{ p: { code: 0 } }] },
    });
    const checkBadToken = async () => {
      order.push("checkBadToken");
      return 4401;
    };

    await runConnectedProbe(
      session,
      VALID_LINK,
      { deviceId: "d1", token: "t1" },
      { hold: false, terminal: "pane-1" },
      () => {},
      checkBadToken,
    );

    const terminalCallIndex = order.indexOf("call:terminal:snapshot");
    expect(terminalCallIndex).toBeGreaterThan(-1);
    // Every M4 step happened strictly before the terminal probe started.
    expect(order.slice(0, terminalCallIndex)).toEqual([
      "call:projects:list",
      'subscribe:["metrics:update"]',
      "nextPush:metrics:update",
      "call:remote:bindChoices",
      "checkBadToken",
      'subscribe:[{"ch":"terminal:data","key":"pane-1"},{"ch":"terminal:exit","key":"pane-1"},"metrics:update"]',
    ]);
  });
});

describe("runTerminalProbe: exits on session.closed even with no terminal:exit push", () => {
  it("returns and logs the close code instead of polling forever", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    const session = fakeSession({
      order,
      call(channel) {
        if (channel === "terminal:snapshot") return { t: "res", v: { text: "", end: 0 } };
        return { t: "res", v: {} };
      },
      pushes: {}, // no terminal:exit ever arrives
      closed: Promise.resolve(4410),
    });

    await runTerminalProbe(session, "pane-1", (line) => lines.push(line));

    expect(lines).toContain("closed: 4410");
  });
});

describe("runTerminalProbe: consumes terminal:data by seq, staying correct past a retained window's eviction", () => {
  it("rendered bytes keep increasing across polls even once a channel's retained pushes have long since evicted " +
    "past 1,000 total [bite-proof: restore the absolute index]", async () => {
    const order: string[] = [];
    const lines: string[] = [];
    // A synthetic window much smaller than the real PROBE_PUSH_WINDOW —
    // the fix is seq-based, not size-based, so any window that evicts at
    // all reproduces the review's finding in far fewer iterations than
    // the real 1,000 would take.
    const WINDOW = 100;
    const TOTAL = 1_500;
    let emitted = 0;

    function terminalDataWindow(): Record<string, unknown>[] {
      // Simulates a live session past PROBE_PUSH_WINDOW eviction: each
      // poll, a further batch has "arrived" server-side (seq keeps
      // climbing), and only the most recent WINDOW pushes are ever
      // retained — exactly what connectDevice's real eviction does once
      // a channel's pushLog exceeds its cap.
      emitted = Math.min(TOTAL, emitted + 150);
      const start = Math.max(1, emitted - WINDOW + 1);
      const pushes: Record<string, unknown>[] = [];
      for (let seq = start; seq <= emitted; seq++) {
        pushes.push({ t: "psh", ch: "terminal:data", seq, p: { chunk: "x", offset: seq - 1 } });
      }
      return pushes;
    }

    let exitAfter = false;
    const session = fakeSession({
      order,
      call(channel) {
        if (channel === "terminal:snapshot") return { t: "res", v: { text: "", end: 0 } };
        return { t: "res", v: {} };
      },
      pushes: (channel) => {
        if (channel === "terminal:data") return terminalDataWindow();
        if (channel === "terminal:exit") return exitAfter ? [{ p: { code: 0 } }] : [];
        return [];
      },
    });

    const renderedSamples: number[] = [];
    await runTerminalProbe(session, "pane-1", (line) => {
      lines.push(line);
      const match = /rendered=(\d+)/.exec(line);
      if (match) renderedSamples.push(Number(match[1]));
      if (emitted >= TOTAL) exitAfter = true;
    });

    // At least two samples, spanning many poll cycles' worth of
    // continued eviction, each one strictly greater than the last — the
    // old absolute-index bug froze the first sample forever the moment
    // the retained window first got smaller than `dataSeen`.
    expect(renderedSamples.length).toBeGreaterThan(1);
    for (let i = 1; i < renderedSamples.length; i++) {
      expect(renderedSamples[i]).toBeGreaterThan(renderedSamples[i - 1] as number);
    }
    expect(emitted).toBe(TOTAL);
  }, 10_000);
});

describe("runTerminalProbe: an err terminal:snapshot reply throws instead of hanging", () => {
  it("throws with the error code instead of treating it as an empty snapshot", async () => {
    const order: string[] = [];
    const session = fakeSession({
      order,
      call(channel) {
        if (channel === "terminal:snapshot") return { t: "err", code: "forbidden", text: "no" };
        return { t: "res", v: {} };
      },
    });

    await expect(runTerminalProbe(session, "pane-1", () => {})).rejects.toThrow(/forbidden/);
  });
});

// A minimal in-memory stand-in for `ws.WebSocket` — an event emitter typed
// for exactly the five events and five methods openPinned/connectDevice use
// (upgrade/open/error/close/message; send/close/terminate/pause/resume) —
// never a real socket. `vi.hoisted` is required because `vi.mock` factories
// below run before this file's own top-level statements.
const wsDouble = vi.hoisted(() => {
  type FakeUpgradeRequest = { socket: { getPeerCertificate: () => { raw?: Buffer } } };
  type EventMap = {
    upgrade: [request: FakeUpgradeRequest];
    open: [];
    error: [error: Error];
    close: [code: number];
    message: [data: Buffer];
  };
  type EventName = keyof EventMap;
  // biome-ignore lint/suspicious/noExplicitAny: the one place this double erases each event's own tuple to store every listener in one map; every public on/once/emit overload below stays fully typed per event.
  type AnyListener = (...args: any[]) => void;

  class FakeWebSocket {
    #listeners = new Map<EventName, AnyListener[]>();
    sent: unknown[] = [];
    closeCalls: Array<{ code?: number; reason?: string }> = [];
    terminated = false;

    on<E extends EventName>(event: E, listener: (...args: EventMap[E]) => void): this {
      const list = this.#listeners.get(event) ?? [];
      list.push(listener as AnyListener);
      this.#listeners.set(event, list);
      return this;
    }

    once<E extends EventName>(event: E, listener: (...args: EventMap[E]) => void): this {
      const wrapped: AnyListener = (...args) => {
        this.#off(event, wrapped);
        (listener as AnyListener)(...args);
      };
      return this.on(event, wrapped as (...args: EventMap[E]) => void);
    }

    #off(event: EventName, listener: AnyListener): void {
      const list = this.#listeners.get(event);
      if (list === undefined) return;
      const index = list.indexOf(listener);
      if (index !== -1) list.splice(index, 1);
    }

    emit<E extends EventName>(event: E, ...args: EventMap[E]): void {
      for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(...args);
    }

    send(text: unknown): void {
      this.sent.push(text);
    }
    close(code?: number, reason?: string): void {
      this.closeCalls.push({ code, reason });
    }
    terminate(): void {
      this.terminated = true;
    }
    pause(): void {}
    resume(): void {}
  }

  const instances: FakeWebSocket[] = [];
  return { FakeWebSocket, instances };
});

vi.mock("ws", () => ({
  // `function`, not an arrow: `new WebSocket(...)` in openPinned requires a
  // constructor, and vi.fn() only produces one when given a function/class
  // expression to wrap.
  WebSocket: vi.fn(function FakeWebSocketCtor() {
    const ws = new wsDouble.FakeWebSocket();
    wsDouble.instances.push(ws);
    return ws;
  }),
}));

describe("connectDevice: reject pending push waiters on close (fake ws.WebSocket double)", () => {
  const RAW_CERT = Buffer.from("probe-client-test-cert");
  const FINGERPRINT = createHash("sha256").update(RAW_CERT).digest("hex");
  const LINK: PairingLink = {
    host: "127.0.0.1",
    port: 4433,
    secret: "a".repeat(43),
    fingerprint: FINGERPRINT,
  };
  const CREDENTIAL: Credential = { deviceId: "device-1", token: "token-1" };

  async function connectedSession(): Promise<DeviceSession> {
    const sessionPromise = connectDevice(LINK, CREDENTIAL);
    const ws = wsDouble.instances.at(-1);
    if (ws === undefined) throw new Error("test bug: no FakeWebSocket was constructed");

    // Pin the fingerprint, then open — mirrors openPinned's own sequence.
    ws.emit("upgrade", { socket: { getPeerCertificate: () => ({ raw: RAW_CERT }) } });
    ws.emit("open");
    // Flush the microtask hop between openPinned's promise resolving and
    // connectDevice's `.then` registering its own message/close listeners.
    await new Promise((resolve) => setImmediate(resolve));

    ws.emit(
      "message",
      Buffer.from(encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: [] })),
    );
    return sessionPromise;
  }

  it(
    "fails a pending nextPush with ProbeClosedError('closed <code>') instead of its own timeout " +
      "[bite-proof: revert the push-waiter reject in the close handler]",
    async () => {
      const session = await connectedSession();
      const ws = wsDouble.instances.at(-1);
      if (ws === undefined) throw new Error("test bug: no FakeWebSocket was constructed");

      const pushPromise = session.nextPush("metrics:update");
      ws.emit("close", 4404);

      await expect(pushPromise).rejects.toBeInstanceOf(ProbeClosedError);
      await expect(pushPromise).rejects.toMatchObject({
        code: 4404,
        message: "the socket closed with code 4404",
      });
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 262_145])(
    "rejects invalid upload chunkBytes %j before creating a pending upload or sending a frame",
    async (chunkBytes) => {
      const session = await connectedSession();
      const ws = wsDouble.instances.at(-1);
      if (ws === undefined) throw new Error("test bug: no FakeWebSocket was constructed");
      ws.sent = [];

      await expect(
        session.upload("test:blob", [], new Uint8Array([1]), chunkBytes),
      ).rejects.toThrow(/chunkBytes/);
      expect(ws.sent).toEqual([]);
    },
    100,
  );

  it(
    "retains at most PROBE_PUSH_WINDOW pushes per channel, oldest evicted " +
      "[bite-proof: remove the eviction; pushes() keeps all 1500]",
    async () => {
      const session = await connectedSession();
      const ws = wsDouble.instances.at(-1);
      if (ws === undefined) throw new Error("test bug: no FakeWebSocket was constructed");

      for (let i = 0; i < 1_500; i++) {
        ws.emit(
          "message",
          Buffer.from(encodeMessage({ t: "psh", ch: "metrics:update", p: { n: i }, seq: i + 1 })),
        );
      }

      const pushes = session.pushes("metrics:update");
      expect(pushes).toHaveLength(PROBE_PUSH_WINDOW);
      expect((pushes[0] as { p: { n: number } }).p.n).toBe(500); // the oldest 500 (n=0..499) are gone
      expect((pushes.at(-1) as { p: { n: number } }).p.n).toBe(1_499);
    },
  );

  it(
    "also caps pushQueues (the nextPush() backlog) at PROBE_PUSH_WINDOW when nothing ever drains it " +
      "[bite-proof: remove the eviction on the pushQueues push in the message handler]",
    async () => {
      const session = await connectedSession();
      const ws = wsDouble.instances.at(-1);
      if (ws === undefined) throw new Error("test bug: no FakeWebSocket was constructed");

      // Nothing calls nextPush("metrics:update") while these arrive — every
      // one of them piles into pushQueues, exactly the shape a --terminal
      // session's untouched channels are in (it reads through pushes(),
      // never nextPush()).
      for (let i = 0; i < 1_500; i++) {
        ws.emit(
          "message",
          Buffer.from(encodeMessage({ t: "psh", ch: "metrics:update", p: { n: i }, seq: i + 1 })),
        );
      }

      // The first nextPush() call after the flood drains pushQueues' head —
      // if it were left uncapped, that head would still be n=0. Capped to
      // PROBE_PUSH_WINDOW (oldest evicted), it's n=500 instead, the same
      // cutoff pushLog's own window landed on above.
      const first = await session.nextPush("metrics:update");
      expect((first.p as { n: number }).n).toBe(500);
    },
  );
});
