import {
  BLOB_IDLE_TIMEOUT_MS,
  CLOSE,
  MAX_BLOB_BYTES,
  PROTOCOL_VERSION,
  encodeMessage,
} from "@jarvis/wire";
import { describe, expect, it } from "vitest";
import type { Clock } from "./clock";
import { createFakeClock } from "./clock";
import type { FakeSocket } from "./fake-transport";
import { createFakeTransport } from "./fake-transport";
import type { Credential, Endpoint, RpcResult } from "./rpc-client";
import { createRpcClient } from "./rpc-client";

const ENDPOINT: Endpoint = { host: "192.168.1.5", port: 4317, fingerprint: "a".repeat(64) };
const CREDENTIAL: Credential = { deviceId: "d".repeat(32), token: "T".repeat(43) };
const CLIENT_STRING = "jarvis-mobile/1.0.0/ios";

function createClientForTest<C extends Clock = ReturnType<typeof createFakeClock>>(
  randomValue = 0.5,
  clock: C = createFakeClock() as unknown as C,
) {
  const transport = createFakeTransport();
  const logs: string[] = [];
  const client = createRpcClient({
    transport,
    clock,
    random: () => randomValue,
    client: CLIENT_STRING,
    log: (line) => logs.push(line),
  });
  return { client, transport, clock, logs };
}

/**
 * A clock whose `setTimeout` never fires on its own — a test calls
 * `runNext()` to fire exactly one pending callback: whichever was scheduled
 * with the smallest `ms`, ties broken by scheduling order. Unlike
 * `createFakeClock`'s `advance(ms)` (which drains every timer due by a
 * target instant, including ones a firing callback reschedules for that
 * same instant — see rpc-client.ts's own upload() pacing, all 0ms turns),
 * this can never fire more than one callback per call, so it can't collapse
 * a whole chain of rescheduled-at-0ms turns into one call either. Also
 * never fires an unrelated long-delay timer (the watchdog, the backoff
 * reset) ahead of a due-sooner one, so it is safe to drive a client all the
 * way through connect+handshake and into an upload with nothing but
 * `runNext()` calls — fix round 1 (I1)'s "pacing yields between chunks"
 * test does exactly that, proving the client genuinely waits for a fresh
 * scheduled turn before sending the next chunk.
 */
function createStepClock(): Clock & { runNext(): boolean } {
  let nextHandle = 1;
  let nextSeq = 0;
  let now = 0;
  const pending = new Map<number, { fn: () => void; ms: number; seq: number }>();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const handle = nextHandle++;
      pending.set(handle, { fn, ms, seq: nextSeq++ });
      return handle;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
    runNext(): boolean {
      let dueHandle: number | undefined;
      let due: { fn: () => void; ms: number; seq: number } | undefined;
      for (const [handle, entry] of pending) {
        if (
          due === undefined ||
          entry.ms < due.ms ||
          (entry.ms === due.ms && entry.seq < due.seq)
        ) {
          due = entry;
          dueHandle = handle;
        }
      }
      if (due === undefined || dueHandle === undefined) return false;
      pending.delete(dueHandle);
      now += Math.max(0, due.ms);
      due.fn();
      return true;
    },
  };
}

function latestSocket(transport: ReturnType<typeof createFakeTransport>): FakeSocket {
  const socket = transport.sockets[transport.sockets.length - 1];
  if (!socket) throw new Error("no socket opened");
  return socket;
}

/** Drives the latest socket through open + welcome, returning that socket. */
function completeHandshake(
  transport: ReturnType<typeof createFakeTransport>,
  capabilities: string[] = [],
): FakeSocket {
  const socket = latestSocket(transport);
  socket.emit({ kind: "open" });
  socket.emit({
    kind: "message",
    text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities }),
  });
  return socket;
}

function frameType(text: string): string {
  return (JSON.parse(text) as { t: string }).t;
}

/**
 * A synthetic base64 string that decodes to exactly `byteLength` bytes —
 * built directly from base64's own arithmetic (no real byte encoding),
 * since these tests exercise framing, not audio content. All-`A` characters
 * decode to all-zero bytes; only the shape (length, padding) matters here.
 */
function base64ForByteLength(byteLength: number): string {
  const remainder = byteLength % 3;
  const padding = remainder === 0 ? 0 : remainder === 1 ? 2 : 1;
  const chars = Math.ceil(byteLength / 3) * 4;
  return "A".repeat(chars - padding) + "=".repeat(padding);
}

describe("createRpcClient: handshake", () => {
  it("sends exactly one hello before welcome; state goes connecting -> authenticating -> open", () => {
    const { client, transport } = createClientForTest();
    const states: string[] = [];
    client.onState((s) => states.push(s));

    client.connect(ENDPOINT, CREDENTIAL);
    expect(states).toEqual(["connecting"]);

    const socket = latestSocket(transport);
    expect(socket.sent).toEqual([]);

    socket.emit({ kind: "open" });
    expect(states).toEqual(["connecting", "authenticating"]);
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({
      t: "hello",
      v: PROTOCOL_VERSION,
      deviceId: CREDENTIAL.deviceId,
      token: CREDENTIAL.token,
      client: CLIENT_STRING,
    });

    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: [] }),
    });
    expect(states).toEqual(["connecting", "authenticating", "open"]);
    expect(client.state()).toBe("open");
    // Still just the one hello frame — no subscriptions were made.
    expect(socket.sent).toHaveLength(1);
  });

  it("closes 1000 and reconnects when no welcome arrives within the 5000ms handshake timeout", () => {
    // Bite-proof: remove the handshake timer in rpc-client.ts (the
    // `deps.clock.setTimeout(..., HANDSHAKE_TIMEOUT_MS)` in handleOpen) and
    // this test fails — state stays "authenticating" forever and
    // `transport.sockets` never gains a second entry.
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    expect(client.state()).toBe("authenticating");

    clock.advance(4_999);
    expect(socket.closedWith).toBeUndefined();
    expect(client.state()).toBe("authenticating");

    clock.advance(1);
    expect(socket.closedWith).toEqual({ code: 1000, reason: "handshake timeout" });
    expect(client.state()).toBe("reconnecting");
    expect(transport.sockets).toHaveLength(1);

    clock.advance(1_000); // first backoff delay at random()=0.5
    expect(transport.sockets).toHaveLength(2);
  });
});

describe("createRpcClient: system-trust endpoint (M11)", () => {
  it("dials wss://<name>:<port>/rpc with system trust when the endpoint carries a `name`", () => {
    const { client, transport } = createClientForTest();
    client.connect({ ...ENDPOINT, name: "mac.tail.ts.net" }, CREDENTIAL);

    const socket = latestSocket(transport);
    expect(socket.url).toBe(`wss://mac.tail.ts.net:${ENDPOINT.port}/rpc`);
    expect(socket.trust).toEqual({ kind: "system" });
  });

  it(
    "dials wss://<host>:<port>/rpc with pin trust when the endpoint has no `name` " +
      "[bite-proof: FakeTransport.sockets[i].trust catches a switch to always-system]",
    () => {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);

      const socket = latestSocket(transport);
      expect(socket.url).toBe(`wss://${ENDPOINT.host}:${ENDPOINT.port}/rpc`);
      expect(socket.trust).toEqual({ kind: "pin", fingerprint: ENDPOINT.fingerprint });
    },
  );
});

describe("createRpcClient: requests", () => {
  it("sends req with a monotonic id; res resolves ok; err resolves a remote error; an unknown id is a logged, ignored stray reply", async () => {
    const { client, transport, logs } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);

    const first = client.call("metrics:update", []);
    const reqFrames = socket.sent.filter((s) => frameType(s) === "req");
    expect(reqFrames).toHaveLength(1);
    expect(JSON.parse(reqFrames[0])).toEqual({ t: "req", id: 1, ch: "metrics:update", a: [] });

    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: 1, v: { cpu: 5 } }) });
    await expect(first).resolves.toEqual({ ok: true, value: { cpu: 5 } });

    const second = client.call("metrics:update", []);
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "err", id: 2, code: "forbidden", text: "no", language: "en" }),
    });
    await expect(second).resolves.toEqual({
      ok: false,
      error: { kind: "remote", code: "forbidden", text: "no", language: "en" },
    });

    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: 999, v: "ignored" }) });
    expect(logs.some((l) => l.includes("stray reply") && l.includes("999"))).toBe(true);
  });

  it("times out an in-flight call after 30000ms", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    completeHandshake(transport, []);

    const result = client.call("metrics:update", []);
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    clock.advance(29_999);
    await Promise.resolve();
    expect(settled).toBe(false);

    clock.advance(1);
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "timeout" } });
  });
});

describe("createRpcClient: request queue", () => {
  it("queues calls made before open and sends them in order once welcome arrives", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);

    void client.call("a", [1]);
    void client.call("b", [2]);
    void client.call("c", [3]);

    const socket = completeHandshake(transport, []);
    const reqFrames = socket.sent.filter((s) => frameType(s) === "req").map((s) => JSON.parse(s));
    expect(reqFrames.map((f) => f.ch)).toEqual(["a", "b", "c"]);
    expect(reqFrames.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it("caps the offline queue at 64: the 65th call resolves offline at once, the first 64 send after connect", async () => {
    const { client, transport } = createClientForTest();
    const results: Promise<RpcResult>[] = [];
    for (let i = 0; i < 65; i++) {
      results.push(client.call(`ch${i}`, [i]));
    }

    await expect(results[64]).resolves.toEqual({ ok: false, error: { kind: "offline" } });

    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);
    const reqFrames = socket.sent.filter((s) => frameType(s) === "req");
    expect(reqFrames).toHaveLength(64);
  });
});

describe("createRpcClient: drop semantics", () => {
  it("rejects an in-flight call offline on a 1006 drop; a queued (never-sent) call survives and sends after the reconnect's welcome", async () => {
    // Bite-proof: add a call to reject the queue (e.g. `rejectQueued()`)
    // inside handleClose alongside rejectInFlight(), and this test fails —
    // `queued` resolves `{ok:false, offline}` at the second drop instead of
    // surviving to be sent, and the final `resolves.toEqual({ok:true,...})`
    // assertion fails.
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(transport, ["metrics:update"]);

    const inFlight = client.call("metrics:update", []);
    expect(socket1.sent.filter((s) => frameType(s) === "req")).toHaveLength(1);

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    await expect(inFlight).resolves.toEqual({ ok: false, error: { kind: "offline" } });
    expect(client.state()).toBe("reconnecting");

    // Second attempt: queue a call while merely authenticating (never
    // sent), then drop again before any welcome — the queued call must
    // still be sitting in the queue, untouched by this second close.
    clock.advance(1_000);
    const socket2 = latestSocket(transport);
    socket2.emit({ kind: "open" });
    const queued = client.call("metrics:update", ["never sent on socket2"]);
    expect(socket2.sent.filter((s) => frameType(s) === "req")).toHaveLength(0);

    socket2.emit({ kind: "close", code: 1006, reason: "dropped again" });
    expect(client.state()).toBe("reconnecting");

    clock.advance(2_000);
    const socket3 = completeHandshake(transport, ["metrics:update"]);
    const reqFrames = socket3.sent.filter((s) => frameType(s) === "req");
    expect(reqFrames).toHaveLength(1);
    const req = JSON.parse(reqFrames[0]);
    expect(req.ch).toBe("metrics:update");

    socket3.emit({ kind: "message", text: encodeMessage({ t: "res", id: req.id, v: "ok" }) });
    await expect(queued).resolves.toEqual({ ok: true, value: "ok" });
  });

  it("disconnect() rejects both an in-flight and a queued call with offline, and clears subscriptions", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);
    client.subscribe("metrics:update");

    const inFlight = client.call("metrics:update", []);
    expect(socket.sent.filter((s) => frameType(s) === "req")).toHaveLength(1);

    // A second socket, still authenticating, holds a genuinely queued call.
    socket.emit({ kind: "close", code: 1006, reason: "dropped" });
    await expect(inFlight).resolves.toEqual({ ok: false, error: { kind: "offline" } });
    clock.advance(1_000); // first backoff delay at random()=0.5
    const socket2 = latestSocket(transport);
    socket2.emit({ kind: "open" });
    const queued = client.call("metrics:update", []);
    expect(socket2.sent.filter((s) => frameType(s) === "req")).toHaveLength(0);

    client.disconnect();

    await expect(queued).resolves.toEqual({ ok: false, error: { kind: "offline" } });
    expect(client.subscriptions()).toEqual([]);
    expect(client.state()).toBe("closed");
  });
});

describe("createRpcClient: subscriptions", () => {
  it("re-sends every subscription as one sub frame after reconnect, before any queued req", () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(transport, ["metrics:update", "terminal:data"]);

    expect(client.subscribe("metrics:update")).toEqual({ ok: true, value: undefined });
    expect(client.subscribe({ ch: "terminal:data", key: "tab-1" })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(client.subscriptions()).toEqual([
      "metrics:update",
      { ch: "terminal:data", key: "tab-1" },
    ]);

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    clock.advance(1_000);

    const socket2 = latestSocket(transport);
    socket2.emit({ kind: "open" });
    void client.call("metrics:update", []); // queued while authenticating
    socket2.emit({
      kind: "message",
      text: encodeMessage({
        t: "welcome",
        v: PROTOCOL_VERSION,
        capabilities: ["metrics:update", "terminal:data"],
      }),
    });

    const subIndex = socket2.sent.findIndex((s) => frameType(s) === "sub");
    const reqIndex = socket2.sent.findIndex((s) => frameType(s) === "req");
    expect(subIndex).toBeGreaterThanOrEqual(0);
    expect(reqIndex).toBeGreaterThan(subIndex);

    const subFrame = JSON.parse(socket2.sent[subIndex]);
    expect(subFrame.add).toHaveLength(2);
    expect(subFrame.add).toEqual(
      expect.arrayContaining(["metrics:update", { ch: "terminal:data", key: "tab-1" }]),
    );
  });

  it("refuses a subscribe for a channel outside capabilities, sending nothing", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);

    const result = client.subscribe("git:counts");
    expect(result).toEqual({ ok: false, error: { kind: "unsupported" } });
    expect(socket.sent.some((s) => frameType(s) === "sub")).toBe(false);
    expect(client.subscriptions()).toEqual([]);
  });

  it("unsubscribe removes the target and sends sub{drop} while open", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);

    expect(client.subscribe("metrics:update")).toEqual({ ok: true, value: undefined });
    client.unsubscribe("metrics:update");

    expect(client.subscriptions()).toEqual([]);
    const dropFrames = socket.sent.filter((s) => frameType(s) === "sub").map((s) => JSON.parse(s));
    expect(dropFrames.at(-1)).toEqual({ t: "sub", drop: ["metrics:update"] });
  });

  it("a duplicate subscribe increments the ref count: one add frame, one entry in subscriptions()", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);

    expect(client.subscribe("metrics:update")).toEqual({ ok: true, value: undefined });
    expect(client.subscribe("metrics:update")).toEqual({ ok: true, value: undefined });

    const addFrames = socket.sent.filter((s) => frameType(s) === "sub");
    expect(addFrames).toHaveLength(1);
    expect(client.subscriptions()).toEqual(["metrics:update"]);
  });

  it("defers the capability check to the next welcome while not open, and drops any now-unsupported target", () => {
    const { client, transport, logs } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);

    // Not open yet ("connecting"): the capability check is deferred, so
    // this succeeds locally and sends nothing.
    expect(client.subscribe("git:counts")).toEqual({ ok: true, value: undefined });
    expect(client.subscriptions()).toEqual(["git:counts"]);

    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: ["metrics:update"] }),
    });

    expect(client.subscriptions()).toEqual([]);
    expect(
      logs.some((l) => l.includes("unsupported subscription") && l.includes("git:counts")),
    ).toBe(true);
  });
});

describe("createRpcClient: call() whenNotOpen option (Task 3)", () => {
  it(
    "whenNotOpen:'reject' while connecting resolves offline at once; the call is never queued " +
      "[bite-proof: ignore the option; the call is queued and a req appears after welcome]",
    async () => {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      expect(client.state()).toBe("connecting");

      const result = client.call("session:input", ["s1", "x"], { whenNotOpen: "reject" });
      await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });

      const socket = completeHandshake(transport, ["session:input"]);
      const reqFrames = socket.sent.filter((s) => frameType(s) === "req");
      expect(reqFrames.some((s) => JSON.parse(s).ch === "session:input")).toBe(false);
    },
  );

  it("whenNotOpen:'reject' while open sends req; a 1006 drop before the reply resolves offline, and the reconnect's welcome never re-sends it", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(transport, ["session:input"]);

    const result = client.call("session:input", ["s1", "x"], { whenNotOpen: "reject" });
    const reqFrames1 = socket1.sent.filter((s) => frameType(s) === "req");
    expect(reqFrames1).toHaveLength(1);
    expect(JSON.parse(reqFrames1[0]).ch).toBe("session:input");

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });

    clock.advance(1_000);
    const socket2 = completeHandshake(transport, ["session:input"]);
    const reqFrames2 = socket2.sent.filter((s) => frameType(s) === "req");
    expect(reqFrames2.some((s) => JSON.parse(s).ch === "session:input")).toBe(false);
  });

  it("whenNotOpen:'reject' resolves offline at once while authenticating; the call is never queued", async () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    expect(client.state()).toBe("authenticating");

    const result = client.call("session:input", ["s1", "x"], { whenNotOpen: "reject" });
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });
  });

  it("whenNotOpen:'reject' resolves offline at once while reconnecting (the realistic keystroke-in-a-tunnel state); nothing is sent on the next socket either", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(transport, ["session:input"]);
    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    expect(client.state()).toBe("reconnecting");

    const result = client.call("session:input", ["s1", "x"], { whenNotOpen: "reject" });
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });

    clock.advance(1_000);
    const socket2 = completeHandshake(transport, ["session:input"]);
    const reqFrames = socket2.sent.filter((s) => frameType(s) === "req");
    expect(reqFrames.some((s) => JSON.parse(s).ch === "session:input")).toBe(false);
  });

  it("whenNotOpen:'reject' resolves offline immediately in unpaired/incompatible/closed, queuing nothing", async () => {
    // unpaired
    {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, []);
      socket.emit({ kind: "close", code: CLOSE.revoked, reason: "revoked" });
      expect(client.state()).toBe("unpaired");
      await expect(client.call("session:input", [], { whenNotOpen: "reject" })).resolves.toEqual({
        ok: false,
        error: { kind: "offline" },
      });
    }
    // incompatible
    {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, []);
      socket.emit({ kind: "close", code: CLOSE.versionMismatch, reason: "mismatch" });
      expect(client.state()).toBe("incompatible");
      await expect(client.call("session:input", [], { whenNotOpen: "reject" })).resolves.toEqual({
        ok: false,
        error: { kind: "offline" },
      });
    }
    // closed
    {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      completeHandshake(transport, []);
      client.disconnect();
      expect(client.state()).toBe("closed");
      await expect(client.call("session:input", [], { whenNotOpen: "reject" })).resolves.toEqual({
        ok: false,
        error: { kind: "offline" },
      });
    }
  });

  it("a default (no options) call made while connecting still queues (M6 behaviour unchanged)", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);

    void client.call("metrics:update", [1]);

    const socket = completeHandshake(transport, []);
    const reqFrames = socket.sent.filter((s) => frameType(s) === "req");
    expect(reqFrames).toHaveLength(1);
  });
});

describe("createRpcClient: ref-counted subscriptions (Task 3)", () => {
  it(
    "subscribe twice sends one add frame; one unsubscribe sends nothing and a push still reaches " +
      "onPush; the second unsubscribe sends one drop frame " +
      "[bite-proof: drop on every unsubscribe; the middle assertion fails]",
    () => {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, ["sessions:update"]);

      expect(client.subscribe("sessions:update")).toEqual({ ok: true, value: undefined });
      expect(client.subscribe("sessions:update")).toEqual({ ok: true, value: undefined });
      const addFrames = socket.sent.filter((s) => frameType(s) === "sub");
      expect(addFrames).toHaveLength(1);

      client.unsubscribe("sessions:update");
      expect(socket.sent.filter((s) => frameType(s) === "sub")).toHaveLength(1); // still just add

      let pushed = false;
      client.onPush("sessions:update", () => {
        pushed = true;
      });
      socket.emit({
        kind: "message",
        text: encodeMessage({ t: "psh", ch: "sessions:update", p: {}, seq: 1 }),
      });
      expect(pushed).toBe(true);

      client.unsubscribe("sessions:update");
      const subFrames = socket.sent.filter((s) => frameType(s) === "sub").map((s) => JSON.parse(s));
      expect(subFrames).toHaveLength(2);
      expect(subFrames[1]).toEqual({ t: "sub", drop: ["sessions:update"] });
      expect(client.subscriptions()).toEqual([]);
    },
  );

  it(
    "ref-count across reconnect: a target subscribed twice and unsubscribed once before the " +
      "drop is re-sent once after welcome; a target subscribed/unsubscribed entirely while " +
      "offline (reconnecting) sends no frame on the dead socket and is reflected correctly, " +
      "including down to 0, by the next welcome's resend",
    () => {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket1 = completeHandshake(transport, ["sessions:update"]);

      // A ("sessions:update"): subscribed twice, unsubscribed once, before the drop —
      // ref count 1 when the socket dies, must be re-sent once after welcome.
      client.subscribe("sessions:update");
      client.subscribe("sessions:update");
      client.unsubscribe("sessions:update");
      // A's first subscribe (0->1, while still open) sent one add frame —
      // that's the only frame this socket should ever carry.
      const sentBeforeClose = socket1.sent.filter((s) => frameType(s) === "sub").length;
      expect(sentBeforeClose).toBe(1);

      socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
      expect(client.state()).toBe("reconnecting");

      // Everything below happens while "reconnecting" — no live socket — so
      // none of it may ever produce a *new* frame on the now-dead socket1.
      // B ("metrics:update"): subscribed then unsubscribed to 0 entirely
      // offline — must not be re-sent.
      client.subscribe("metrics:update");
      client.unsubscribe("metrics:update");
      // C ("terminal:data"): subscribed twice and unsubscribed once entirely
      // offline — ref count 1, must be re-sent once, exactly like A.
      client.subscribe("terminal:data");
      client.subscribe("terminal:data");
      client.unsubscribe("terminal:data");

      expect(socket1.sent.filter((s) => frameType(s) === "sub")).toHaveLength(sentBeforeClose);

      clock.advance(1_000);
      const socket2 = latestSocket(transport);
      socket2.emit({ kind: "open" });
      // Still reconnecting/authenticating: no frame before welcome either.
      expect(socket2.sent.filter((s) => frameType(s) === "sub")).toHaveLength(0);

      socket2.emit({
        kind: "message",
        text: encodeMessage({
          t: "welcome",
          v: PROTOCOL_VERSION,
          capabilities: ["sessions:update", "metrics:update", "terminal:data"],
        }),
      });

      const subFrame = socket2.sent
        .filter((s) => frameType(s) === "sub")
        .map((s) => JSON.parse(s))
        .find((f) => f.add !== undefined);
      expect(subFrame.add).toEqual(["sessions:update", "terminal:data"]);
      expect(client.subscriptions()).toEqual(["sessions:update", "terminal:data"]);
    },
  );

  it("keyed targets ref-count by {ch,key} independently of the bare channel, each holding a count above 1", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["terminal:data"]);

    client.subscribe("terminal:data");
    client.subscribe("terminal:data"); // bare channel: ref count 2
    client.subscribe({ ch: "terminal:data", key: "tab-1" });
    client.subscribe({ ch: "terminal:data", key: "tab-1" }); // keyed target: ref count 2
    expect(client.subscriptions()).toEqual([
      "terminal:data",
      { ch: "terminal:data", key: "tab-1" },
    ]);
    expect(socket.sent.filter((s) => frameType(s) === "sub")).toHaveLength(2); // one add per distinct target

    // Bringing the keyed target down to 1 sends no frame and leaves the
    // bare channel (still at count 2) untouched.
    client.unsubscribe({ ch: "terminal:data", key: "tab-1" });
    expect(socket.sent.filter((s) => frameType(s) === "sub")).toHaveLength(2);
    expect(client.subscriptions()).toEqual([
      "terminal:data",
      { ch: "terminal:data", key: "tab-1" },
    ]);

    // The keyed target's drop to 0 does not touch the bare channel.
    client.unsubscribe({ ch: "terminal:data", key: "tab-1" });
    let dropFrames = socket.sent.filter((s) => frameType(s) === "sub").map((s) => JSON.parse(s));
    expect(dropFrames.at(-1)).toEqual({ t: "sub", drop: [{ ch: "terminal:data", key: "tab-1" }] });
    expect(client.subscriptions()).toEqual(["terminal:data"]);

    // The bare channel independently drops from its own count of 2. Three
    // frames exist so far (2 adds + the keyed drop above); this decrement
    // (2->1) adds none.
    client.unsubscribe("terminal:data");
    expect(socket.sent.filter((s) => frameType(s) === "sub")).toHaveLength(3); // still no bare drop
    client.unsubscribe("terminal:data");
    dropFrames = socket.sent.filter((s) => frameType(s) === "sub").map((s) => JSON.parse(s));
    expect(dropFrames.at(-1)).toEqual({ t: "sub", drop: ["terminal:data"] });
    expect(client.subscriptions()).toEqual([]);
  });

  it("unsubscribe of a never-subscribed target is a no-op: no frame, no throw, and a later subscribe still sends add", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);

    expect(() => client.unsubscribe("metrics:update")).not.toThrow();
    expect(socket.sent.filter((s) => frameType(s) === "sub")).toHaveLength(0);

    expect(client.subscribe("metrics:update")).toEqual({ ok: true, value: undefined });
    const addFrames = socket.sent.filter((s) => frameType(s) === "sub").map((s) => JSON.parse(s));
    expect(addFrames).toEqual([{ t: "sub", add: ["metrics:update"] }]);
  });

  it("an unsupported subscribe on the 0->1 transition stays at count 0; a later unsubscribe sends nothing", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);

    expect(client.subscribe("git:counts")).toEqual({ ok: false, error: { kind: "unsupported" } });
    expect(client.subscriptions()).toEqual([]);

    client.unsubscribe("git:counts");
    expect(socket.sent.filter((s) => frameType(s) === "sub")).toHaveLength(0);
  });

  it("disconnect() then connect() re-sends no stale subscriptions", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    completeHandshake(transport, ["metrics:update"]);
    client.subscribe("metrics:update");
    client.subscribe("metrics:update");

    client.disconnect();
    expect(client.subscriptions()).toEqual([]);

    client.connect(ENDPOINT, CREDENTIAL);
    const socket2 = completeHandshake(transport, ["metrics:update"]);
    expect(socket2.sent.filter((s) => frameType(s) === "sub")).toHaveLength(0);
  });
});

describe("createRpcClient: pushes", () => {
  it("delivers psh to every handler on a channel; a throwing handler does not stop the other; lastFrameAt updates on psh and ping", () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);

    const received: Array<[unknown, number | undefined]> = [];
    client.onPush("metrics:update", () => {
      throw new Error("boom");
    });
    client.onPush("metrics:update", (p, dropped) => received.push([p, dropped]));

    const afterWelcome = client.lastFrameAt();
    expect(afterWelcome).toBeDefined();

    clock.advance(1);
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "psh", ch: "metrics:update", p: { cpu: 10 }, seq: 1, dropped: 3 }),
    });
    expect(received).toEqual([[{ cpu: 10 }, 3]]);
    const afterPush = client.lastFrameAt();
    expect(afterPush).toBeGreaterThan(afterWelcome as number);

    clock.advance(1);
    socket.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 7 }) });
    expect(client.lastFrameAt()).toBeGreaterThan(afterPush as number);
  });
});

describe("createRpcClient: heartbeat", () => {
  it("answers ping with pong immediately; 45000ms of silence closes 1000 locally and reconnects", () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);

    socket.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 7 }) });
    const pongFrames = socket.sent.filter((s) => frameType(s) === "pong");
    expect(pongFrames).toHaveLength(1);
    expect(JSON.parse(pongFrames[0])).toEqual({ t: "pong", seq: 7 });

    clock.advance(44_999);
    expect(socket.closedWith).toBeUndefined();
    expect(client.state()).toBe("open");

    clock.advance(1);
    expect(socket.closedWith).toEqual({ code: 1000, reason: "watchdog" });
    expect(client.state()).toBe("reconnecting");
  });

  it("arms the watchdog on open, while still authenticating (the 5000ms handshake timer is the tighter deadline and fires first)", () => {
    // The watchdog (45000ms) is armed as soon as `open` fires (handleOpen),
    // before any frame arrives — this is what protects a socket that opens
    // but then goes silent forever with no `welcome` and no error/close
    // event at all. The handshake timer (5000ms) is strictly tighter, so in
    // every reachable scenario it fires first; this test pins that both
    // timers are live in "authenticating" and that the tighter one wins.
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    expect(client.state()).toBe("authenticating");

    clock.advance(5_000);
    expect(socket.closedWith).toEqual({ code: 1000, reason: "handshake timeout" });
    expect(client.state()).toBe("reconnecting");
  });
});

describe("createRpcClient: backoff", () => {
  it("backs off 1000,2000,4000,8000,16000ms across five consecutive drops (random()=0.5); resets to 1000ms after 10000ms open", () => {
    const { client, transport, clock } = createClientForTest(0.5);
    client.connect(ENDPOINT, CREDENTIAL);

    const expectedDelays = [1_000, 2_000, 4_000, 8_000, 16_000];
    for (const delay of expectedDelays) {
      const socket = latestSocket(transport);
      socket.emit({ kind: "open" });
      socket.emit({ kind: "close", code: 1006, reason: "drop" });
      expect(client.state()).toBe("reconnecting");

      const before = transport.sockets.length;
      clock.advance(delay - 1);
      expect(transport.sockets.length).toBe(before);
      clock.advance(1);
      expect(transport.sockets.length).toBe(before + 1);
    }

    const openedSocket = completeHandshake(transport, []);
    clock.advance(10_000); // backoff resets here

    openedSocket.emit({ kind: "close", code: 1006, reason: "drop" });
    const before = transport.sockets.length;
    clock.advance(999);
    expect(transport.sockets.length).toBe(before);
    clock.advance(1);
    expect(transport.sockets.length).toBe(before + 1); // back to the 1000ms delay
  });
});

describe("createRpcClient: close-code routing", () => {
  it("4410 moves to unpaired and does not reconnect", () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);
    socket.emit({ kind: "close", code: CLOSE.revoked, reason: "revoked" });
    expect(client.state()).toBe("unpaired");
    clock.advance(60_000);
    expect(transport.sockets).toHaveLength(1);
  });

  it("4426 moves to incompatible and does not reconnect", () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);
    socket.emit({ kind: "close", code: CLOSE.versionMismatch, reason: "mismatch" });
    expect(client.state()).toBe("incompatible");
    clock.advance(60_000);
    expect(transport.sockets).toHaveLength(1);
  });

  it("4413 reconnects with backoff", () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);
    socket.emit({ kind: "close", code: CLOSE.congested, reason: "congested" });
    expect(client.state()).toBe("reconnecting");
    clock.advance(1_000);
    expect(transport.sockets).toHaveLength(2);
  });

  it("disconnect() sends bye then closes 1000, moving to closed with no reconnect", () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);

    client.disconnect();

    expect(socket.sent.filter((s) => frameType(s) === "bye")).toHaveLength(1);
    expect(socket.closedWith).toEqual({ code: 1000, reason: "bye" });
    expect(client.state()).toBe("closed");
    clock.advance(60_000);
    expect(transport.sockets).toHaveLength(1);
  });

  it("disconnect() while merely connecting sends no bye (never authenticated)", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);

    client.disconnect();

    expect(socket.sent.filter((s) => frameType(s) === "bye")).toHaveLength(0);
    expect(socket.closedWith).toEqual({ code: 1000, reason: "bye" });
    expect(client.state()).toBe("closed");
  });

  it("4401 (unauthorized) moves to unpaired, before or after a welcome, and does not reconnect", () => {
    // Before any welcome (bad token).
    {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = latestSocket(transport);
      socket.emit({ kind: "open" });
      socket.emit({ kind: "close", code: CLOSE.unauthorized, reason: "unauthorized" });
      expect(client.state()).toBe("unpaired");
      clock.advance(60_000);
      expect(transport.sockets).toHaveLength(1);
    }
    // After a previous welcome in this connect (revoked mid-session).
    {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, []);
      socket.emit({ kind: "close", code: CLOSE.unauthorized, reason: "unauthorized" });
      expect(client.state()).toBe("unpaired");
      clock.advance(60_000);
      expect(transport.sockets).toHaveLength(1);
    }
  });

  it("a transport error alone does not itself transition state; the close event that follows drives reconnect", () => {
    const { client, transport, clock, logs } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);

    socket.emit({ kind: "error", message: "send failed" });
    expect(client.state()).toBe("open");
    expect(logs.some((l) => l.includes("transport error"))).toBe(true);

    socket.emit({ kind: "close", code: 1006, reason: "transport" });
    expect(client.state()).toBe("reconnecting");
    clock.advance(1_000);
    expect(transport.sockets).toHaveLength(2);
  });

  it("onState detail carries the closeCode for a routed close", () => {
    const { client, transport } = createClientForTest();
    const details: Array<{ closeCode?: number }> = [];
    client.onState((_s, detail) => details.push(detail));
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);

    socket.emit({ kind: "close", code: CLOSE.revoked, reason: "revoked" });

    const last = details.at(-1);
    expect(last?.closeCode).toBe(CLOSE.revoked);
  });
});

describe("createRpcClient: rule 8 (connect no-op unless idle/closed/unpaired)", () => {
  it("a second connect() while connecting is a no-op: no second socket, logged", () => {
    const { client, transport, logs } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    client.connect(ENDPOINT, CREDENTIAL);
    expect(transport.sockets).toHaveLength(1);
    expect(logs.some((l) => l.includes("connect ignored"))).toBe(true);
  });

  it("connect() is allowed again from unpaired", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);
    socket.emit({ kind: "close", code: CLOSE.revoked, reason: "revoked" });
    expect(client.state()).toBe("unpaired");

    client.connect(ENDPOINT, CREDENTIAL);
    expect(transport.sockets).toHaveLength(2);
  });
});

describe("createRpcClient: onState handler safety", () => {
  it("a throwing onState handler does not wedge reconnect, socket open or the welcome flow", () => {
    const { client, transport, clock, logs } = createClientForTest();
    client.onState(() => {
      throw new Error("boom");
    });

    client.connect(ENDPOINT, CREDENTIAL);
    expect(transport.sockets).toHaveLength(1); // openSocket ran despite the throw on "connecting"

    const socket1 = completeHandshake(transport, ["metrics:update"]);
    expect(client.state()).toBe("open"); // handleWelcome's resend/flush + state both ran
    client.subscribe("metrics:update");

    socket1.emit({ kind: "close", code: 1006, reason: "drop" });
    expect(client.state()).toBe("reconnecting"); // scheduleReconnect's timer still armed
    clock.advance(1_000);
    expect(transport.sockets).toHaveLength(2);

    const socket2 = latestSocket(transport);
    socket2.emit({ kind: "open" });
    socket2.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: ["metrics:update"] }),
    });
    expect(client.state()).toBe("open");
    expect(socket2.sent.some((s) => frameType(s) === "sub")).toBe(true);
    expect(logs.some((l) => l.includes("state handler threw"))).toBe(true);
  });

  it("disconnect() called from an onState handler during 'connecting' opens no socket", () => {
    const { client, transport } = createClientForTest();
    client.onState((state) => {
      if (state === "connecting") client.disconnect();
    });

    client.connect(ENDPOINT, CREDENTIAL);

    expect(transport.sockets).toHaveLength(0);
    expect(client.state()).toBe("closed");
  });

  it("disconnect() called from an onState handler during 'authenticating' does not throw, moves to closed, and leaves no timer running (N1)", () => {
    const { client, transport, clock } = createClientForTest();
    client.onState((state) => {
      if (state === "authenticating") client.disconnect();
    });

    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);

    // Before the fix, reading session.credential after an already-nulled
    // session threw a TypeError out of this very call (the transport
    // event callback).
    expect(() => socket.emit({ kind: "open" })).not.toThrow();

    expect(client.state()).toBe("closed");
    expect(socket.sent.filter((s) => frameType(s) === "bye")).toHaveLength(1);

    // No handshake/watchdog timer left armed: advancing well past both
    // deadlines opens no further socket and leaves the state alone.
    clock.advance(60_000);
    expect(transport.sockets).toHaveLength(1);
    expect(client.state()).toBe("closed");
  });

  it("a later observer's last-seen state always equals client.state(), even across a re-entrant disconnect() (N1)", () => {
    for (const triggerState of ["reconnecting", "open"] as const) {
      const { client, transport, clock } = createClientForTest();
      const secondObserverSeen: string[] = [];

      client.onState((state) => {
        if (state === triggerState) client.disconnect();
      });
      client.onState((state) => {
        secondObserverSeen.push(state);
      });

      client.connect(ENDPOINT, CREDENTIAL);
      if (triggerState === "open") {
        completeHandshake(transport, []);
      } else {
        // Drive to "reconnecting": open, then drop.
        const socket = latestSocket(transport);
        socket.emit({ kind: "open" });
        socket.emit({ kind: "close", code: 1006, reason: "drop" });
      }

      expect(client.state()).toBe("closed");
      expect(secondObserverSeen.at(-1)).toBe("closed");
      // The trigger state itself must never have reached the second
      // observer as the *final* thing it saw — it was superseded before
      // this client settled.
      expect(secondObserverSeen.at(-1)).not.toBe(triggerState);

      clock.advance(60_000);
      expect(transport.sockets).toHaveLength(1); // no reconnect leaked through
    }
  });

  it(
    "T4 R2-1 (final review): a later observer still sees 'unpaired' even " +
      "when an earlier observer reacts to it by calling disconnect() " +
      "synchronously [bite-proof: revert the ordered notification queue to " +
      'the old "stop once superseded" loop and the second observer\'s list ' +
      'never contains "unpaired" — only "closed"]',
    () => {
      const { client, transport } = createClientForTest();
      const secondObserverSeen: string[] = [];

      client.onState((state) => {
        if (state === "unpaired") client.disconnect();
      });
      client.onState((state) => {
        secondObserverSeen.push(state);
      });

      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, []);
      socket.emit({ kind: "close", code: CLOSE.revoked, reason: "revoked" });

      expect(client.state()).toBe("closed");
      // The second observer must have been told "unpaired" itself, not
      // just the "closed" the first observer's re-entrant disconnect()
      // forced next.
      expect(secondObserverSeen).toContain("unpaired");
      expect(secondObserverSeen.at(-1)).toBe("closed");
    },
  );
});

describe("createRpcClient: call() while already in a terminal state (N3)", () => {
  it("resolves offline immediately for a call made while already unpaired, instead of queuing", async () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);
    socket.emit({ kind: "close", code: CLOSE.revoked, reason: "revoked" });
    expect(client.state()).toBe("unpaired");

    const result = client.call("metrics:update", []);
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });

    // It must not have been queued for the next connect() either.
    client.connect(ENDPOINT, CREDENTIAL);
    const socket2 = completeHandshake(transport, []);
    expect(socket2.sent.filter((s) => frameType(s) === "req")).toHaveLength(0);
  });

  it("resolves offline immediately for a call made while already incompatible, instead of hanging forever", async () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);
    socket.emit({ kind: "close", code: CLOSE.versionMismatch, reason: "mismatch" });
    expect(client.state()).toBe("incompatible");

    const result = client.call("metrics:update", []);
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });
  });
});

describe("createRpcClient: rule 1 (first frame must be welcome)", () => {
  it("closes 1000 and reconnects when a non-welcome frame arrives before welcome; no push, no pong", () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });

    let pushed = false;
    client.onPush("metrics:update", () => {
      pushed = true;
    });
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "psh", ch: "metrics:update", p: {}, seq: 1 }),
    });

    expect(pushed).toBe(false);
    expect(socket.closedWith).toEqual({ code: 1000, reason: "protocol violation" });
    expect(client.state()).toBe("reconnecting");
    clock.advance(1_000);
    expect(transport.sockets).toHaveLength(2);
  });

  it("a ping before welcome is not answered with a pong, and closes/reconnects", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });

    socket.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 1 }) });

    expect(socket.sent.some((s) => frameType(s) === "pong")).toBe(false);
    expect(socket.closedWith).toEqual({ code: 1000, reason: "protocol violation" });
    expect(client.state()).toBe("reconnecting");
  });

  it("a second welcome while open is ignored: no re-subscribe, no resend, state stays open", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);
    client.subscribe("metrics:update");
    const sentBefore = socket.sent.length;

    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION, capabilities: ["metrics:update"] }),
    });

    expect(socket.sent).toHaveLength(sentBefore);
    expect(client.state()).toBe("open");
    expect(client.subscriptions()).toEqual(["metrics:update"]);
  });

  it("moves to incompatible, no reconnect, when welcome.v does not match PROTOCOL_VERSION", () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "welcome", v: PROTOCOL_VERSION + 1, capabilities: [] }),
    });

    expect(client.state()).toBe("incompatible");
    expect(socket.closedWith?.code).toBe(1000);
    clock.advance(60_000);
    expect(transport.sockets).toHaveLength(1);
  });
});

describe("createRpcClient: queued calls in terminal states (ruling I5)", () => {
  it("rejects every queued call with offline immediately on entering unpaired", async () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" }); // authenticating: calls queue, nothing sent yet

    const queued = client.call("metrics:update", []);
    socket.emit({ kind: "close", code: CLOSE.unauthorized, reason: "unauthorized" });

    await expect(queued).resolves.toEqual({ ok: false, error: { kind: "offline" } });
    expect(client.state()).toBe("unpaired");
  });

  it("rejects every queued call with offline immediately on entering incompatible", async () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = latestSocket(transport);
    socket.emit({ kind: "open" });

    const queued = client.call("metrics:update", []);
    socket.emit({ kind: "close", code: CLOSE.versionMismatch, reason: "mismatch" });

    await expect(queued).resolves.toEqual({ ok: false, error: { kind: "offline" } });
    expect(client.state()).toBe("incompatible");
  });
});

describe("createRpcClient: pin mismatch (ruling I6)", () => {
  it("surfaces pinMismatch in onState detail without unpairing, and keeps reconnecting", () => {
    const { client, transport, clock } = createClientForTest();
    const details: Array<{ pinMismatch?: true }> = [];
    client.onState((_s, detail) => details.push(detail));

    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);

    socket.emit({ kind: "error", message: "fingerprint mismatch" });
    socket.emit({ kind: "close", code: 1006, reason: "fingerprint" });

    expect(client.state()).toBe("reconnecting"); // not unpaired: no auto-unpair on a pin failure
    expect(details.at(-1)?.pinMismatch).toBe(true);

    clock.advance(1_000);
    expect(transport.sockets).toHaveLength(2); // keeps the reconnect-with-backoff path
  });

  it("does not set pinMismatch for an ordinary drop", () => {
    const { client, transport } = createClientForTest();
    const details: Array<{ pinMismatch?: true }> = [];
    client.onState((_s, detail) => details.push(detail));

    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);
    socket.emit({ kind: "close", code: 1006, reason: "dropped" });

    expect(details.at(-1)?.pinMismatch).toBeUndefined();
  });
});

describe("createRpcClient: capabilities and malformed frames (minor findings)", () => {
  it("clears capabilities() after a close", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);
    expect(client.capabilities()).toEqual(["metrics:update"]);

    socket.emit({ kind: "close", code: 1006, reason: "dropped" });
    expect(client.capabilities()).toEqual([]);
  });

  it("clears capabilities() after disconnect", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    completeHandshake(transport, ["metrics:update"]);
    expect(client.capabilities()).toEqual(["metrics:update"]);

    client.disconnect();
    expect(client.capabilities()).toEqual([]);
  });

  it("logs a too-long malformed frame kind as unknown rather than truncating it (N5)", () => {
    const { client, transport, logs } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);

    const longKind = "x".repeat(200);
    socket.emit({ kind: "message", text: JSON.stringify({ t: longKind }) });

    const line = logs.find((l) => l.includes("malformed frame"));
    expect(line).toBeDefined();
    expect(line?.length).toBeLessThan(60);
    expect(line).toContain("kind=unknown");
  });

  it("never echoes a control-character or non-ASCII frame kind into the log (N5, log-injection)", () => {
    const { client, transport, logs } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, []);

    socket.emit({ kind: "message", text: JSON.stringify({ t: "evil\nrpc: state open" }) });

    const line = logs.find((l) => l.includes("malformed frame"));
    expect(line).toBe("rpc: malformed frame kind=unknown");
  });

  it("transport.open throwing synchronously is treated as a close: state moves to reconnecting, not stuck", () => {
    const clock = createFakeClock();
    const logs: string[] = [];
    const transport = {
      open() {
        throw new Error("native module missing");
      },
    };
    const client = createRpcClient({
      transport,
      clock,
      random: () => 0.5,
      client: CLIENT_STRING,
      log: (line) => logs.push(line),
    });

    client.connect(ENDPOINT, CREDENTIAL);

    expect(client.state()).toBe("reconnecting");
    expect(logs.some((l) => l.includes("transport open threw"))).toBe(true);
  });
});

describe("createRpcClient: upload (Task 5)", () => {
  it("open: sends one blob header frame followed by exactly its binary frames, nothing interleaved; res resolves ok", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["remote:uploadAudio"]);

    const b64 = base64ForByteLength(600_000);
    const result = client.upload("remote:uploadAudio", [{ turnId: "x" }], b64);

    // Task 5 pacing: the header is sent synchronously, but every chunk is
    // deferred to its own scheduled turn — nothing binary is on the wire
    // until the clock is advanced.
    expect(socket.sentBinary).toEqual([]);
    clock.advance(0);

    // The blob header frame is immediately followed by exactly its binary
    // frames — nothing else interleaved (the hello frame from the
    // handshake above may precede it, but nothing comes between the header
    // and its own binary frames, and nothing follows them).
    const headerFrameIndex = socket.frames.findIndex(
      (f) => f.kind === "text" && frameType(f.text) === "blob",
    );
    expect(socket.frames.slice(headerFrameIndex).map((f) => f.kind)).toEqual([
      "text",
      "binary",
      "binary",
      "binary",
    ]);
    const header = JSON.parse(socket.sent.at(-1) ?? "{}");
    expect(header).toEqual({
      t: "blob",
      id: header.id,
      ch: "remote:uploadAudio",
      a: [{ turnId: "x" }],
      bytes: 600_000,
      chunks: 3,
    });
    expect(socket.sentBinary).toHaveLength(3);
    expect(socket.sentBinary.join("")).toBe(b64);

    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "res", id: header.id, v: { ok: true } }),
    });
    await expect(result).resolves.toEqual({ ok: true, value: { ok: true } });
  });

  it(
    "connecting: resolves offline at once; no blob or binary frame is ever sent, not even after the " +
      "following welcome [bite-proof: route upload through the queue; a blob frame appears after welcome]",
    async () => {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      expect(client.state()).toBe("connecting");

      const b64 = base64ForByteLength(1_000);
      const result = client.upload("remote:uploadAudio", [], b64);
      await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });

      const socket = completeHandshake(transport, ["remote:uploadAudio"]);
      expect(socket.sent.some((s) => frameType(s) === "blob")).toBe(false);
      expect(socket.sentBinary).toEqual([]);
    },
  );

  it("resolves offline immediately in reconnecting/unpaired/incompatible/closed, sending no blob or binary frame", async () => {
    const b64 = base64ForByteLength(1_000);

    // reconnecting
    {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, []);
      socket.emit({ kind: "close", code: 1006, reason: "dropped" });
      expect(client.state()).toBe("reconnecting");
      await expect(client.upload("remote:uploadAudio", [], b64)).resolves.toEqual({
        ok: false,
        error: { kind: "offline" },
      });
      expect(socket.sentBinary).toEqual([]);
      expect(socket.sent.some((s) => frameType(s) === "blob")).toBe(false);
    }
    // unpaired
    {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, []);
      socket.emit({ kind: "close", code: CLOSE.revoked, reason: "revoked" });
      expect(client.state()).toBe("unpaired");
      await expect(client.upload("remote:uploadAudio", [], b64)).resolves.toEqual({
        ok: false,
        error: { kind: "offline" },
      });
      expect(socket.sentBinary).toEqual([]);
    }
    // incompatible
    {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, []);
      socket.emit({ kind: "close", code: CLOSE.versionMismatch, reason: "mismatch" });
      expect(client.state()).toBe("incompatible");
      await expect(client.upload("remote:uploadAudio", [], b64)).resolves.toEqual({
        ok: false,
        error: { kind: "offline" },
      });
      expect(socket.sentBinary).toEqual([]);
    }
    // closed
    {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, []);
      client.disconnect();
      expect(client.state()).toBe("closed");
      await expect(client.upload("remote:uploadAudio", [], b64)).resolves.toEqual({
        ok: false,
        error: { kind: "offline" },
      });
      expect(socket.sentBinary).toEqual([]);
    }
  });

  it("an in-flight upload resolves offline on a 1006 drop; nothing is re-sent on the next socket", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket1 = completeHandshake(transport, ["remote:uploadAudio"]);

    const b64 = base64ForByteLength(1_000);
    const result = client.upload("remote:uploadAudio", [], b64);
    expect(socket1.sent.some((s) => frameType(s) === "blob")).toBe(true);

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });

    clock.advance(1_000);
    const socket2 = completeHandshake(transport, ["remote:uploadAudio"]);
    expect(socket2.sent.some((s) => frameType(s) === "blob")).toBe(false);
    expect(socket2.sentBinary).toEqual([]);
  });

  it(
    "timeoutMs replaces the default request timeout for an upload " +
      "[bite-proof: ignore timeoutMs; it times out at 30s]",
    async () => {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, ["remote:uploadAudio"]);

      const b64 = base64ForByteLength(1_000);
      const result = client.upload("remote:uploadAudio", [], b64, { timeoutMs: 100_000 });
      let settled = false;
      void result.then(() => {
        settled = true;
      });

      clock.advance(30_001);
      await Promise.resolve();
      expect(settled).toBe(false);

      // The 45s watchdog (DEAD_SOCKET_MS) would otherwise close the socket
      // before 100_000ms and resolve this offline instead of timeout — feed
      // it two pings (real server heartbeat traffic) to survive the full
      // window, exactly as a live connection would.
      socket.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 1 }) });
      clock.advance(40_000); // total 70_001ms
      socket.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 2 }) });
      clock.advance(29_999); // total 100_000ms
      await expect(result).resolves.toEqual({ ok: false, error: { kind: "timeout" } });
    },
  );

  it("an out-of-range timeoutMs (5 or 700000) falls back to the 30s default", async () => {
    for (const timeoutMs of [5, 700_000]) {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      completeHandshake(transport, ["remote:uploadAudio"]);
      const b64 = base64ForByteLength(1_000);
      const result = client.upload("remote:uploadAudio", [], b64, { timeoutMs });

      let settled = false;
      void result.then(() => {
        settled = true;
      });
      clock.advance(29_999);
      await Promise.resolve();
      expect(settled).toBe(false);
      clock.advance(1);
      await expect(result).resolves.toEqual({ ok: false, error: { kind: "timeout" } });
    }
  });

  it("err resolves remote with the code, text and language verbatim", async () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["remote:uploadAudio"]);
    const b64 = base64ForByteLength(1_000);
    const result = client.upload("remote:uploadAudio", [], b64);
    const header = JSON.parse(socket.sent.find((s) => frameType(s) === "blob") ?? "{}");

    socket.emit({
      kind: "message",
      text: encodeMessage({
        t: "err",
        id: header.id,
        code: "bad-request",
        text: "bad",
        language: "en",
      }),
    });
    await expect(result).resolves.toEqual({
      ok: false,
      error: { kind: "remote", code: "bad-request", text: "bad", language: "en" },
    });
  });

  it("invalid base64, empty, and an over-ceiling length all resolve unsupported, sending nothing", async () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["remote:uploadAudio"]);

    await expect(client.upload("remote:uploadAudio", [], "not-valid-base64!!")).resolves.toEqual({
      ok: false,
      error: { kind: "unsupported" },
    });
    await expect(client.upload("remote:uploadAudio", [], "")).resolves.toEqual({
      ok: false,
      error: { kind: "unsupported" },
    });
    await expect(
      client.upload("remote:uploadAudio", [], base64ForByteLength(MAX_BLOB_BYTES + 1)),
    ).resolves.toEqual({ ok: false, error: { kind: "unsupported" } });

    expect(socket.sent.some((s) => frameType(s) === "blob")).toBe(false);
    expect(socket.sentBinary).toEqual([]);
  });

  it("a sendBinary that throws resolves offline; a later res for that id is ignored as a stray reply", async () => {
    const { client, transport, clock, logs } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["remote:uploadAudio"]);
    socket.sendBinary = () => {
      throw new Error("native module missing");
    };

    const b64 = base64ForByteLength(1_000);
    const result = client.upload("remote:uploadAudio", [], b64);
    clock.advance(0); // Task 5: the (throwing) chunk send is a scheduled turn
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });

    const header = JSON.parse(socket.sent.find((s) => frameType(s) === "blob") ?? "{}");
    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: header.id, v: "late" }) });
    expect(logs.some((l) => l.includes("stray reply") && l.includes(String(header.id)))).toBe(true);
  });

  it("call() also honours a per-call timeoutMs", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    completeHandshake(transport, []);

    // 40_000, not 45_000: DEAD_SOCKET_MS (the watchdog) is exactly 45_000ms
    // of silence, which would otherwise close the socket and resolve this
    // offline before its own timer fires.
    const result = client.call("metrics:update", [], { timeoutMs: 40_000 });
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    clock.advance(39_999);
    await Promise.resolve();
    expect(settled).toBe(false);
    clock.advance(1);
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "timeout" } });
  });

  it("a second upload while one is in flight resolves busy at once, sending no second header or binary frame; the first still completes", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["remote:uploadAudio", "remote:uploadFile"]);

    const b64a = base64ForByteLength(1_000);
    const resultA = client.upload("remote:uploadAudio", [], b64a);
    expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(1);

    // The second call — a different channel (voice vs. file), same socket —
    // is refused synchronously, before it ever reaches the transport.
    const b64b = base64ForByteLength(1_000);
    const resultB = client.upload("remote:uploadFile", [], b64b);
    await expect(resultB).resolves.toEqual({ ok: false, error: { kind: "busy" } });
    expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(1);
    expect(socket.sentBinary).toEqual([]);

    // The first upload is unaffected by the refused second one and still
    // completes normally once its own paced chunk is sent.
    clock.advance(0);
    expect(socket.sentBinary).toHaveLength(1);
    const header = JSON.parse(socket.sent.find((s) => frameType(s) === "blob") ?? "{}");
    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: header.id, v: null }) });
    await expect(resultA).resolves.toEqual({ ok: true, value: null });

    // Busy is cleared once the first finishes: a third upload now succeeds.
    const resultC = client.upload("remote:uploadFile", [], base64ForByteLength(1_000));
    expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(2);
    clock.advance(0);
    const headerC = JSON.parse(socket.sent.filter((s) => frameType(s) === "blob").at(-1) ?? "{}");
    socket.emit({ kind: "message", text: encodeMessage({ t: "res", id: headerC.id, v: null }) });
    await expect(resultC).resolves.toEqual({ ok: true, value: null });
  });

  it("onProgress fires once per chunk with cumulative sent bytes; cancelled() checked before each chunk stops further sends mid-transfer", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["remote:uploadAudio"]);

    // 600_000 bytes -> 3 chunks (262_143, 262_143, 75_714).
    const b64 = base64ForByteLength(600_000);
    const progress: Array<[number, number]> = [];
    // Cancels itself once the first chunk's onProgress has fired — proves
    // cancelled() is re-checked *between* chunks, not just once up front.
    let sentChunks = 0;
    const result = client.upload("remote:uploadAudio", [], b64, {
      onProgress: (sent, total) => {
        progress.push([sent, total]);
        sentChunks += 1;
      },
      cancelled: () => sentChunks >= 1,
    });

    clock.advance(0);

    expect(progress).toEqual([[262_143, 600_000]]);
    expect(socket.sentBinary).toHaveLength(1);
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "cancelled" } });
  });

  it("cancelled() true before the first scheduled turn sends the header but no binary chunk at all", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["remote:uploadAudio"]);

    const b64 = base64ForByteLength(1_000);
    const result = client.upload("remote:uploadAudio", [], b64, { cancelled: () => true });
    expect(socket.sent.some((s) => frameType(s) === "blob")).toBe(true);

    clock.advance(0);
    expect(socket.sentBinary).toEqual([]);
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "cancelled" } });
  });

  it("a disconnect between two paced chunks stops the remaining chunks and resolves offline", async () => {
    const { client, transport, clock } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["remote:uploadAudio"]);

    const b64 = base64ForByteLength(600_000); // 3 chunks
    const result = client.upload("remote:uploadAudio", [], b64, {
      onProgress: () => {
        // Mid-transfer drop, simulated from inside the paced loop itself —
        // the next scheduled chunk must see the upload is no longer in
        // flight and stop rather than send onto a torn-down socket.
        socket.emit({ kind: "close", code: 1006, reason: "dropped" });
      },
    });

    clock.advance(0);
    expect(socket.sentBinary).toHaveLength(1);
    await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });
  });

  describe("fix round 1 (I1): blob draining latch", () => {
    it(
      "a laptop refusal mid-pacing stops the remaining chunks and busies a retry until the laptop's own idle " +
        "window (plus margin) has elapsed, then allows it " +
        "[bite-proof: drop the busy-on-draining check; a retry inside the window sends a second header instead]",
      async () => {
        const { client, transport, clock } = createClientForTest();
        client.connect(ENDPOINT, CREDENTIAL);
        const socket = completeHandshake(transport, ["remote:uploadAudio"]);

        const b64 = base64ForByteLength(600_000); // 3 chunks
        let header: { id: number } | undefined;
        const result = client.upload("remote:uploadAudio", [], b64, {
          onProgress: () => {
            if (header !== undefined) return;
            const parsedHeader = JSON.parse(
              socket.sent.find((s) => frameType(s) === "blob") ?? "{}",
            ) as { id: number };
            header = parsedHeader;
            // The laptop refuses this blob at header time (over a channel's
            // own byte cap, rate-limited, ...) and replies err immediately —
            // while this client is still mid-pacing the rest of its
            // declared chunks (connection.ts's discardAfterRefusal).
            socket.emit({
              kind: "message",
              text: encodeMessage({
                t: "err",
                id: parsedHeader.id,
                code: "bad-request",
                text: "no",
                language: "en",
              }),
            });
          },
        });

        clock.advance(0);
        // Stopped after the one chunk already in flight when the err
        // arrived — never drains the remaining declared chunks itself.
        expect(socket.sentBinary).toHaveLength(1);
        await expect(result).resolves.toEqual({
          ok: false,
          error: { kind: "remote", code: "bad-request", text: "no", language: "en" },
        });

        // Still inside the laptop's own BLOB_IDLE_TIMEOUT_MS(+margin)
        // window: a retry — or any other upload, the voice lane included —
        // is refused locally, never reaching the socket.
        await expect(
          client.upload("remote:uploadAudio", [], base64ForByteLength(1_000)),
        ).resolves.toEqual({ ok: false, error: { kind: "busy" } });
        expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(1);

        // Past the window since the last chunk this client actually sent:
        // the laptop's own idle timer would long since have returned its
        // blobPhase to "none".
        clock.advance(BLOB_IDLE_TIMEOUT_MS + 1_000);
        const allowed = client.upload("remote:uploadAudio", [], base64ForByteLength(1_000));
        expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(2);
        clock.advance(0);
        const headerAllowed = JSON.parse(
          socket.sent.filter((s) => frameType(s) === "blob").at(-1) ?? "{}",
        );
        socket.emit({
          kind: "message",
          text: encodeMessage({ t: "res", id: headerAllowed.id, v: null }),
        });
        await expect(allowed).resolves.toEqual({ ok: true, value: null });
      },
    );

    it("a client-side cancel mid-pacing starts the same drain latch: busy inside the window, allowed after it", async () => {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, ["remote:uploadAudio"]);

      const b64 = base64ForByteLength(600_000); // 3 chunks
      let sentChunks = 0;
      const result = client.upload("remote:uploadAudio", [], b64, {
        onProgress: () => {
          sentChunks += 1;
        },
        cancelled: () => sentChunks >= 1,
      });
      clock.advance(0);
      expect(socket.sentBinary).toHaveLength(1);
      await expect(result).resolves.toEqual({ ok: false, error: { kind: "cancelled" } });

      await expect(
        client.upload("remote:uploadAudio", [], base64ForByteLength(1_000)),
      ).resolves.toEqual({ ok: false, error: { kind: "busy" } });
      expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(1);

      clock.advance(BLOB_IDLE_TIMEOUT_MS + 1_000);
      client.upload("remote:uploadAudio", [], base64ForByteLength(1_000));
      expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(2);
    });

    it("a late err for the id being drained clears the latch immediately, without waiting out the rest of the margin", async () => {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, ["remote:uploadAudio"]);

      const b64 = base64ForByteLength(600_000);
      let sentChunks = 0;
      const result = client.upload("remote:uploadAudio", [], b64, {
        onProgress: () => {
          sentChunks += 1;
        },
        cancelled: () => sentChunks >= 1,
      });
      clock.advance(0);
      await result;
      const header = JSON.parse(socket.sent.find((s) => frameType(s) === "blob") ?? "{}");

      await expect(
        client.upload("remote:uploadAudio", [], base64ForByteLength(1_000)),
      ).resolves.toEqual({ ok: false, error: { kind: "busy" } });

      // Well within the margin, the laptop's own idle timer fires first and
      // sends its (now unsolicited — this client already settled the
      // cancelled upload's promise locally) err for that id.
      clock.advance(5_000);
      socket.emit({
        kind: "message",
        text: encodeMessage({
          t: "err",
          id: header.id,
          code: "bad-request",
          text: "x",
          language: "en",
        }),
      });

      // The latch clears immediately: a third upload sends right away,
      // long before BLOB_IDLE_TIMEOUT_MS would otherwise have elapsed.
      client.upload("remote:uploadAudio", [], base64ForByteLength(1_000));
      expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(2);
    });

    it("an err/res that arrives after every declared chunk was already sent needs no drain latch", async () => {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, ["remote:uploadAudio"]);

      const b64 = base64ForByteLength(1_000); // 1 chunk
      const result = client.upload("remote:uploadAudio", [], b64);
      clock.advance(0);
      expect(socket.sentBinary).toHaveLength(1);
      const header = JSON.parse(socket.sent.find((s) => frameType(s) === "blob") ?? "{}");
      socket.emit({
        kind: "message",
        text: encodeMessage({
          t: "err",
          id: header.id,
          code: "bad-request",
          text: "x",
          language: "en",
        }),
      });
      await result;

      // Not draining — every declared byte was already handed to the
      // transport, so the laptop's blobPhase already returned to "none"
      // independently of this err.
      client.upload("remote:uploadAudio", [], base64ForByteLength(1_000));
      expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(2);
    });

    it("a socket close clears the drain latch — a fresh connection is never stuck busy [bite-proof: drop clearBlobDrain() from rejectInFlight; the post-reconnect upload stays busy]", async () => {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      let socket = completeHandshake(transport, ["remote:uploadAudio"]);

      const b64 = base64ForByteLength(600_000);
      let sentChunks = 0;
      const result = client.upload("remote:uploadAudio", [], b64, {
        onProgress: () => {
          sentChunks += 1;
        },
        cancelled: () => sentChunks >= 1,
      });
      clock.advance(0);
      await result;

      await expect(
        client.upload("remote:uploadAudio", [], base64ForByteLength(1_000)),
      ).resolves.toEqual({ ok: false, error: { kind: "busy" } });

      socket.emit({ kind: "close", code: 1006, reason: "dropped" });
      clock.advance(1_000);
      socket = completeHandshake(transport, ["remote:uploadAudio"]);

      client.upload("remote:uploadAudio", [], base64ForByteLength(1_000));
      expect(socket.sent.some((s) => frameType(s) === "blob")).toBe(true);
    });

    it(
      "pacing genuinely yields between chunks: each chunk needs its own scheduled turn, never all at once from a " +
        "single advance " +
        "[bite-proof: schedule every chunk from the same deps.clock.setTimeout(fn, 0) call up front instead of " +
        "recursively; runNext() then sends every chunk on its very first call]",
      async () => {
        const clock = createStepClock();
        const { client, transport } = createClientForTest(0.5, clock);
        client.connect(ENDPOINT, CREDENTIAL);
        const socket = latestSocket(transport);
        socket.emit({ kind: "open" });
        socket.emit({
          kind: "message",
          text: encodeMessage({
            t: "welcome",
            v: PROTOCOL_VERSION,
            capabilities: ["remote:uploadAudio"],
          }),
        });

        const b64 = base64ForByteLength(600_000); // 3 chunks
        client.upload("remote:uploadAudio", [], b64);

        // The header is synchronous; no chunk is sent until a turn runs.
        expect(socket.sentBinary).toEqual([]);

        expect(clock.runNext()).toBe(true);
        expect(socket.sentBinary).toHaveLength(1);
        // Nothing further fires on its own — genuinely paced, not a
        // recursive synchronous loop hiding behind one scheduled call.
        expect(socket.sentBinary).toHaveLength(1);

        expect(clock.runNext()).toBe(true);
        expect(socket.sentBinary).toHaveLength(2);

        expect(clock.runNext()).toBe(true);
        expect(socket.sentBinary).toHaveLength(3);
      },
    );

    it(
      "allSent flips the instant the last chunk reaches sendBinary, not a whole scheduled turn later — a " +
        "res arriving in that same turn sees it already true and starts no drain " +
        "[bite-proof: set allSent on the trailing scheduled turn again instead of at the last sendBinary; " +
        "the immediate res-in-the-same-turn case now arms the drain latch and the second upload below is busy]",
      async () => {
        const { client, transport, clock } = createClientForTest();
        client.connect(ENDPOINT, CREDENTIAL);
        const socket = completeHandshake(transport, ["remote:uploadAudio"]);

        const b64 = base64ForByteLength(1_000); // 1 chunk
        let header: { id: number } | undefined;
        const result = client.upload("remote:uploadAudio", [], b64, {
          onProgress: () => {
            // Fires synchronously right after the one (and last) chunk is
            // handed to sendBinary — allSent must already be true here,
            // *before* the trailing scheduled turn (index >= parts.length)
            // ever runs, so answering immediately must not start a drain.
            const parsedHeader = JSON.parse(
              socket.sent.find((s) => frameType(s) === "blob") ?? "{}",
            ) as { id: number };
            header = parsedHeader;
            socket.emit({
              kind: "message",
              text: encodeMessage({ t: "res", id: parsedHeader.id, v: null }),
            });
          },
        });

        clock.advance(0);
        await expect(result).resolves.toEqual({ ok: true, value: null });
        expect(header).toBeDefined();

        // Not draining: a second upload sends immediately.
        const second = client.upload("remote:uploadAudio", [], base64ForByteLength(1_000));
        expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(2);
        clock.advance(0);
        const secondHeader = JSON.parse(
          socket.sent.filter((s) => frameType(s) === "blob").at(-1) ?? "{}",
        );
        socket.emit({
          kind: "message",
          text: encodeMessage({ t: "res", id: secondHeader.id, v: null }),
        });
        await expect(second).resolves.toEqual({ ok: true, value: null });
      },
    );

    it(
      "a header send() that throws never arms the drain latch — a retry sends immediately, not busy " +
        "[bite-proof: drop the headerSent guard in finalize(); the retry below is busy instead of sent]",
      async () => {
        const { client, transport, clock } = createClientForTest();
        client.connect(ENDPOINT, CREDENTIAL);
        const socket = completeHandshake(transport, ["remote:uploadAudio"]);
        const realSend = socket.send.bind(socket);
        let throwOnce = true;
        socket.send = (text: string) => {
          if (throwOnce && (JSON.parse(text) as { t: string }).t === "blob") {
            throwOnce = false;
            throw new Error("native module missing");
          }
          realSend(text);
        };

        const b64 = base64ForByteLength(1_000);
        const result = client.upload("remote:uploadAudio", [], b64);
        await expect(result).resolves.toEqual({ ok: false, error: { kind: "offline" } });
        expect(socket.sentBinary).toEqual([]);

        // Never reached the wire at all — nothing for the laptop to
        // drain, so a retry sends immediately rather than being refused
        // busy.
        const retry = client.upload("remote:uploadAudio", [], b64);
        clock.advance(0);
        expect(socket.sent.some((s) => frameType(s) === "blob")).toBe(true);
        expect(socket.sentBinary).toHaveLength(1);
        void retry;
      },
    );

    it("consecutive early-stop uploads each get their own fresh drain window — an earlier, already-cleared drain's timer never cuts the newer one short", async () => {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, ["remote:uploadAudio"]);

      const b64 = base64ForByteLength(600_000); // 3 chunks
      let firstSent = 0;
      const first = client.upload("remote:uploadAudio", [], b64, {
        onProgress: () => {
          firstSent += 1;
        },
        cancelled: () => firstSent >= 1,
      });
      clock.advance(0);
      await first;
      const firstHeader = JSON.parse(socket.sent.find((s) => frameType(s) === "blob") ?? "{}");

      // A late err clears the first drain early, well inside its window.
      clock.advance(5_000);
      socket.emit({
        kind: "message",
        text: encodeMessage({
          t: "err",
          id: firstHeader.id,
          code: "bad-request",
          text: "x",
          language: "en",
        }),
      });

      // A second upload starts immediately and also stops early — its own
      // drain must start fresh, not inherit anything from the first.
      let secondSent = 0;
      const second = client.upload("remote:uploadAudio", [], b64, {
        onProgress: () => {
          secondSent += 1;
        },
        cancelled: () => secondSent >= 1,
      });
      clock.advance(0);
      await second;

      await expect(
        client.upload("remote:uploadAudio", [], base64ForByteLength(1_000)),
      ).resolves.toEqual({ ok: false, error: { kind: "busy" } });

      // The full window from the *second* upload's own last chunk.
      clock.advance(BLOB_IDLE_TIMEOUT_MS + 1_000);
      client.upload("remote:uploadAudio", [], base64ForByteLength(1_000));
      expect(socket.sent.filter((s) => frameType(s) === "blob")).toHaveLength(3);
    });
  });
});

describe("createRpcClient: setAppActive (M12 Task 5, ruling d)", () => {
  it(
    "open with two subscriptions: setAppActive(false) sends exactly one sub drop " +
      "frame with both targets [bite-proof: send one frame per target; the frame-count assertion fails]",
    () => {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, ["metrics:update", "terminal:data"]);
      client.subscribe("metrics:update");
      client.subscribe({ ch: "terminal:data", key: "tab-1" });

      const before = socket.sent.length;
      client.setAppActive(false);

      const sent = socket.sent.slice(before);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0] as string)).toEqual({
        t: "sub",
        drop: ["metrics:update", { ch: "terminal:data", key: "tab-1" }],
      });
    },
  );

  it("while suspended, a new subscribe maintains the map with no frame; map size 3", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update", "terminal:data", "git:counts"]);
    client.subscribe("metrics:update");
    client.subscribe({ ch: "terminal:data", key: "tab-1" });
    client.setAppActive(false);

    const before = socket.sent.length;
    const result = client.subscribe("git:counts");

    expect(result).toEqual({ ok: true, value: undefined });
    expect(socket.sent.length).toBe(before); // no frame while suspended
    expect(client.subscriptions()).toHaveLength(3);
  });

  it(
    "setAppActive(true) resumes with one sub add carrying every target " +
      "[bite-proof: forget the map on suspend; the add carries only the third], " +
      "then delivers onState('open', {resumed:true}) with state() still 'open'",
    () => {
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, [
        "metrics:update",
        "terminal:data",
        "git:counts",
      ]);
      client.subscribe("metrics:update");
      client.subscribe({ ch: "terminal:data", key: "tab-1" });
      client.setAppActive(false);
      client.subscribe("git:counts"); // added to the map while suspended

      const states: { state: string; detail: Record<string, unknown> }[] = [];
      let stateDuringNotify: string | undefined;
      client.onState((state, detail) => {
        states.push({ state, detail });
        stateDuringNotify = client.state();
      });

      const before = socket.sent.length;
      client.setAppActive(true);

      const sent = socket.sent.slice(before);
      expect(sent).toHaveLength(1);
      expect(JSON.parse(sent[0] as string)).toEqual({
        t: "sub",
        add: ["metrics:update", { ch: "terminal:data", key: "tab-1" }, "git:counts"],
      });
      expect(states.at(-1)?.state).toBe("open");
      expect(states.at(-1)?.detail.resumed).toBe(true);
      expect(stateDuringNotify).toBe("open");
    },
  );

  it("setAppActive(true) twice sends exactly one sub add", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);
    client.subscribe("metrics:update");
    client.setAppActive(false);

    const before = socket.sent.length;
    client.setAppActive(true);
    client.setAppActive(true);

    const sent = socket.sent.slice(before).filter((s) => frameType(s) === "sub");
    expect(sent).toHaveLength(1);
  });

  it(
    "setAppActive(false) while reconnecting sends no frame, and the following welcome " +
      "sends no sub add [bite-proof: ignore `suspended` in the welcome path]",
    () => {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket1 = completeHandshake(transport, ["metrics:update"]);
      client.subscribe("metrics:update");
      socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
      expect(client.state()).toBe("reconnecting");

      const beforeSuspend = socket1.sent.length;
      client.setAppActive(false);
      expect(socket1.sent.length).toBe(beforeSuspend); // no frame: no live socket

      clock.advance(1_000);
      const socket2 = latestSocket(transport);
      socket2.emit({ kind: "open" });
      socket2.emit({
        kind: "message",
        text: encodeMessage({
          t: "welcome",
          v: PROTOCOL_VERSION,
          capabilities: ["metrics:update"],
        }),
      });

      expect(socket2.sent.some((s) => frameType(s) === "sub")).toBe(false);
      expect(client.state()).toBe("open");
    },
  );

  it(
    "setAppActive(true) while not open (still reconnecting), then a welcome: the welcome's " +
      "own sub add fires normally, with no resumed event",
    () => {
      const { client, transport, clock } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket1 = completeHandshake(transport, ["metrics:update"]);
      client.subscribe("metrics:update");
      socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
      client.setAppActive(false);
      expect(client.state()).toBe("reconnecting");

      client.setAppActive(true); // rule 4: "if not open: nothing more"

      const states: { state: string; detail: Record<string, unknown> }[] = [];
      client.onState((state, detail) => states.push({ state, detail }));

      clock.advance(1_000);
      const socket2 = latestSocket(transport);
      socket2.emit({ kind: "open" });
      socket2.emit({
        kind: "message",
        text: encodeMessage({
          t: "welcome",
          v: PROTOCOL_VERSION,
          capabilities: ["metrics:update"],
        }),
      });

      const subFrames = socket2.sent.filter((s) => frameType(s) === "sub");
      expect(subFrames).toHaveLength(1);
      expect(JSON.parse(subFrames[0] as string).add).toEqual(["metrics:update"]);
      expect(states.some((item) => item.detail.resumed === true)).toBe(false);
    },
  );

  it("an unsubscribe to ref 0 while suspended sends no sub drop, and the target is absent from the resume sub add", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update", "terminal:data"]);
    client.subscribe("metrics:update");
    client.subscribe({ ch: "terminal:data", key: "tab-1" });
    client.setAppActive(false);

    const before = socket.sent.length;
    client.unsubscribe({ ch: "terminal:data", key: "tab-1" });
    expect(socket.sent.length).toBe(before); // no sub drop while suspended
    expect(client.subscriptions()).toEqual(["metrics:update"]);

    const beforeResume = socket.sent.length;
    client.setAppActive(true);
    const sent = socket.sent.slice(beforeResume);
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0] as string)).toEqual({ t: "sub", add: ["metrics:update"] });
  });

  it("a push arriving while suspended still reaches its handler", () => {
    const { client, transport } = createClientForTest();
    client.connect(ENDPOINT, CREDENTIAL);
    const socket = completeHandshake(transport, ["metrics:update"]);
    client.subscribe("metrics:update");
    client.setAppActive(false);

    const received: unknown[] = [];
    client.onPush("metrics:update", (payload) => received.push(payload));
    socket.emit({
      kind: "message",
      text: encodeMessage({ t: "psh", ch: "metrics:update", seq: 1, p: { cpu: 42 } }),
    });

    expect(received).toEqual([{ cpu: 42 }]);
  });

  it("setAppActive never logs a token, across a suspend/resume/suspend sequence", () => {
    const { client, transport, logs } = createClientForTest();
    const credential: Credential = { deviceId: CREDENTIAL.deviceId, token: "T".repeat(43) };
    client.connect(ENDPOINT, credential);
    completeHandshake(transport, ["metrics:update"]);
    client.subscribe("metrics:update");

    client.setAppActive(false);
    client.setAppActive(true);
    client.setAppActive(false);

    for (const line of logs) {
      expect(line).not.toContain(credential.token);
    }
  });

  it(
    "fix round 1, Important 1: resume chunks a batch past MAX_SUB_TARGETS — 65 subscriptions " +
      "send two sub add frames, 64 targets then 1, in original order",
    () => {
      const targets = Array.from({ length: 65 }, (_, i) => `ch${i}`);
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, targets);
      for (const target of targets) {
        client.subscribe(target);
      }
      client.setAppActive(false);

      const before = socket.sent.length;
      client.setAppActive(true);

      const addFrames = socket.sent
        .slice(before)
        .map((s) => JSON.parse(s as string))
        .filter((frame) => frame.t === "sub");
      expect(addFrames).toHaveLength(2);
      expect(addFrames[0].add).toHaveLength(64);
      expect(addFrames[1].add).toHaveLength(1);
      expect([...addFrames[0].add, ...addFrames[1].add]).toEqual(targets);
    },
  );

  it(
    "fix round 2: suspend chunks a batch past MAX_SUB_TARGETS — 65 subscriptions " +
      "send two sub drop frames, 64 targets then 1, in original order",
    () => {
      const targets = Array.from({ length: 65 }, (_, i) => `ch${i}`);
      const { client, transport } = createClientForTest();
      client.connect(ENDPOINT, CREDENTIAL);
      const socket = completeHandshake(transport, targets);
      for (const target of targets) {
        client.subscribe(target);
      }

      const before = socket.sent.length;
      client.setAppActive(false);

      const dropFrames = socket.sent
        .slice(before)
        .map((s) => JSON.parse(s as string))
        .filter((frame) => frame.t === "sub");
      expect(dropFrames).toHaveLength(2);
      expect(dropFrames[0].drop).toHaveLength(64);
      expect(dropFrames[1].drop).toHaveLength(1);
      expect([...dropFrames[0].drop, ...dropFrames[1].drop]).toEqual(targets);
    },
  );
});

describe("createRpcClient: security", () => {
  it("never logs the token or a secret-shaped string across a full connect/subscribe/call/reconnect/disconnect/upload scenario", () => {
    // Bite-proof: add `deps.log(encodeMessage(hello))` right after building
    // `hello` in handleOpen, and this test fails.
    const { client, transport, clock, logs } = createClientForTest();
    const secretLookalike = "S".repeat(43); // shaped like SECRET_PATTERN
    const credential: Credential = { deviceId: CREDENTIAL.deviceId, token: "T".repeat(43) };

    client.connect(ENDPOINT, credential);
    const socket1 = completeHandshake(transport, ["metrics:update", "remote:uploadAudio"]);
    client.subscribe("metrics:update");
    void client.call("metrics:update", [credential.token, secretLookalike]);
    void client.call("session:input", ["s1", "secret-typing"], { whenNotOpen: "reject" });
    // A distinctive base64 payload (M8 rule: never logged, on either side —
    // audio bytes or base64 never appear in a log line).
    const distinctiveB64 = base64ForByteLength(9_000);
    void client.upload("remote:uploadAudio", [{ turnId: "d".repeat(32) }], distinctiveB64);

    socket1.emit({ kind: "close", code: 1006, reason: "dropped" });
    clock.advance(1_000);
    const socket2 = completeHandshake(transport, ["metrics:update"]);
    socket2.emit({ kind: "message", text: encodeMessage({ t: "ping", seq: 1 }) });

    client.disconnect();

    for (const line of logs) {
      expect(line).not.toContain(credential.token);
      expect(line).not.toContain(secretLookalike);
      expect(line).not.toContain("secret-typing");
      expect(line).not.toContain(distinctiveB64);
    }
  });
});
