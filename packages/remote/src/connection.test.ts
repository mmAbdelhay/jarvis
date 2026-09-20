import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "./audit.js";
import { fakeClock } from "./clock-double.js";
import type {
  AuditPolicy,
  AuthenticatedDevice,
  AuthorizeKey,
  Connection,
  ConnectionDeps,
  RequestHandler,
  RequestOutcome,
} from "./connection.js";
import {
  AUDIT_INPUT_KEYS_PER_CONNECTION,
  AUDIT_KEY_MAX_CHARS,
  AUDIT_PROBE_LINES_PER_CONNECTION,
  CONGESTION_TERMINATE_MS,
  createConnection,
} from "./connection.js";
import type { Clock, Timers } from "./io.js";
import {
  CONGESTED_BYTES,
  CONGESTION_CLOSE_MS,
  MAX_QUEUED_BYTES,
  OUTBOX_TICK_MS,
} from "./outbox.js";
import type { ChannelPolicies, ChannelPolicy, StreamPolicy } from "./policy.js";
import { MAX_KEYED_SUBSCRIPTIONS, STREAM_MAX_BYTES } from "./policy.js";
import {
  BLOB_IDLE_TIMEOUT_MS,
  CLOSE,
  HANDSHAKE_TIMEOUT_MS,
  MAX_BLOB_BYTES,
  MAX_BLOB_CHUNK_BYTES,
  MAX_BLOB_CHUNKS,
  PROTOCOL_VERSION,
} from "./protocol.js";
import { FakeSocket } from "./socket-double.js";

const SOURCE = "127.0.0.1:5555";

type StreamPayload = { k?: string; c: string; o?: number };

const streamPolicy: StreamPolicy = {
  kind: "stream",
  maxBytes: STREAM_MAX_BYTES,
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

// "remote:update" is deliberately left out of POLICIES: it must never end
// up in a welcome frame's `capabilities` or in `subscribed` via `sub add`,
// so tests below use it as the one channel absent from policies entirely.
const POLICIES: ChannelPolicies = new Map<string, ChannelPolicy>([
  ["metrics:update", { kind: "latest" }],
  ["sessions:update", { kind: "latest" }],
  ["t:latest", { kind: "latest" }],
  ["t:stream", streamPolicy],
]);

const DEVICE: AuthenticatedDevice = { id: "d".repeat(32), name: "Phone" };
const RIGHT_TOKEN = "r".repeat(43);
const WRONG_TOKEN = "w".repeat(43);

const errorText = (code: string) => ({ text: `err:${code}`, language: "en" as const });

/** Waits for a queued microtask (a resolved handler's `.then`) to run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function helloFrame(overrides: Partial<{ deviceId: string; token: string; v: number }> = {}) {
  return JSON.stringify({
    t: "hello",
    v: overrides.v ?? PROTOCOL_VERSION,
    deviceId: overrides.deviceId ?? DEVICE.id,
    token: overrides.token ?? RIGHT_TOKEN,
    client: "test/1.0",
  });
}

function reqFrame(id: number, ch: string, a: unknown[] = []) {
  return JSON.stringify({ t: "req", id, ch, a });
}

function blobFrame(id: number, ch: string, bytes: number, chunks: number, a: unknown[] = []) {
  return JSON.stringify({ t: "blob", id, ch, a, bytes, chunks });
}

function subFrame(
  add?: Array<string | { ch: string; key: string }>,
  drop?: Array<string | { ch: string; key: string }>,
) {
  const msg: Record<string, unknown> = { t: "sub" };
  if (add !== undefined) msg.add = add;
  if (drop !== undefined) msg.drop = drop;
  return JSON.stringify(msg);
}

function makeHarness(
  overrides: Partial<{
    now: Clock;
    timers: Timers;
    authenticate: ConnectionDeps["authenticate"];
    handle: RequestHandler;
    policies: ChannelPolicies;
    authorizeKey: AuthorizeKey;
    blobLimit: ConnectionDeps["blobLimit"];
    onOpen: ConnectionDeps["onOpen"];
    audit: { record: ReturnType<typeof vi.fn<(event: AuditEvent) => void>> };
    auditPolicy: (channel: string) => AuditPolicy;
  }> = {},
) {
  const clock = fakeClock(0);
  const socket = new FakeSocket();
  const handle = overrides.handle ?? vi.fn<RequestHandler>();
  const authenticate =
    overrides.authenticate ??
    ((deviceId: string, token: string) =>
      deviceId === DEVICE.id && token === RIGHT_TOKEN ? DEVICE : undefined);
  const log = vi.fn();
  const onOpen = overrides.onOpen ?? vi.fn();
  const onAuthFailed = vi.fn();
  const onClosed = vi.fn();
  const authorizeKey: AuthorizeKey = overrides.authorizeKey ?? (() => true);
  const blobLimit: ConnectionDeps["blobLimit"] = overrides.blobLimit ?? (() => undefined);
  const audit = overrides.audit ?? { record: vi.fn<(event: AuditEvent) => void>() };
  const auditPolicy: (channel: string) => AuditPolicy = overrides.auditPolicy ?? (() => "never");
  const deps: ConnectionDeps = {
    source: SOURCE,
    now: overrides.now ?? clock.now,
    timers: overrides.timers ?? clock.timers,
    authenticate,
    handle,
    policies: overrides.policies ?? POLICIES,
    authorizeKey,
    blobLimit,
    errorText,
    log,
    onOpen,
    onAuthFailed,
    onClosed,
    audit,
    auditPolicy,
  };
  const connection = createConnection(socket, deps);
  return { clock, socket, connection, handle, log, onOpen, onAuthFailed, onClosed, audit, deps };
}

function openConnection(harness: ReturnType<typeof makeHarness>) {
  harness.connection.onText(helloFrame());
  harness.socket.sent = [];
  // Callers of this helper never pass an `onOpen` override — it's always
  // the harness's own default `vi.fn()` — so this is a mock at runtime;
  // `vi.mocked` only tells the type system that.
  vi.mocked(harness.onOpen).mockClear();
}

describe("createConnection: before hello", () => {
  it("writes nothing and stays open at 4999ms", () => {
    const { clock, socket } = makeHarness();
    clock.advance(HANDSHAKE_TIMEOUT_MS - 1);
    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBeUndefined();
  });

  it("closes 4408 auth-failed:timeout at 5000ms", () => {
    const { clock, socket, onAuthFailed } = makeHarness();
    clock.advance(HANDSHAKE_TIMEOUT_MS);
    expect(socket.closed).toEqual({ code: CLOSE.handshakeTimeout, reason: "" });
    expect(onAuthFailed).toHaveBeenCalledWith("timeout");
    expect(clock.pending()).toBe(0);
  });

  it("[bite-proof: no pre-auth frame dispatches] a req before hello, then hello, then a req: close 4400, handle never called, nothing sent", () => {
    const { clock, socket, connection, handle } = makeHarness();

    connection.onText(reqFrame(1, "projects:list"));
    expect(socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });

    connection.onText(helloFrame());
    connection.onText(reqFrame(2, "projects:list"));

    expect(socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
    expect(handle).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it("[bite-proof: wrong token dispatches nothing] a wrong token, then a req: close 4401, handle never called", () => {
    const { clock, socket, connection, handle } = makeHarness();

    connection.onText(helloFrame({ token: WRONG_TOKEN }));
    expect(socket.closed).toEqual({ code: CLOSE.unauthorized, reason: "" });

    connection.onText(reqFrame(1, "projects:list"));
    expect(handle).not.toHaveBeenCalled();
    expect(socket.sent).toEqual([]);
    expect(clock.pending()).toBe(0);
  });

  it("a binary frame first closes 4400", () => {
    const { clock, socket, connection, onAuthFailed } = makeHarness();
    connection.onBinary(new Uint8Array([1]));
    expect(socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
    expect(onAuthFailed).toHaveBeenCalledWith("bad-frame");
    expect(clock.pending()).toBe(0);
  });

  it("wrong token with v2 closes 4401 (credentials checked first)", () => {
    const { clock, socket, connection, onAuthFailed } = makeHarness();
    connection.onText(helloFrame({ token: WRONG_TOKEN, v: 2 }));
    expect(socket.closed).toEqual({ code: CLOSE.unauthorized, reason: "" });
    expect(onAuthFailed).toHaveBeenCalledWith("bad-credentials");
    expect(clock.pending()).toBe(0);
  });

  it("right token with v2 closes 4426 with no onAuthFailed", () => {
    const { clock, socket, connection, onAuthFailed } = makeHarness();
    connection.onText(helloFrame({ v: 2 }));
    expect(socket.closed).toEqual({ code: CLOSE.versionMismatch, reason: "" });
    expect(onAuthFailed).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });
});

describe("createConnection: open", () => {
  it("calls onOpen and sends welcome with sorted capabilities equal to the policy keys", () => {
    const { socket, connection, onOpen } = makeHarness();
    connection.onText(helloFrame());
    expect(onOpen).toHaveBeenCalledWith(connection);
    expect(socket.sent).toEqual([
      {
        t: "welcome",
        v: PROTOCOL_VERSION,
        capabilities: ["metrics:update", "sessions:update", "t:latest", "t:stream"],
      },
    ]);
  });

  it("[ruling P8] onOpen runs before welcome: a hub-style onOpen that closes synchronously (e.g. the 9th client) sends no welcome", () => {
    const onOpen = vi.fn((c: Connection) => c.close(CLOSE.overCapacity, ""));
    const harness = makeHarness({ onOpen });

    harness.connection.onText(helloFrame());

    expect(onOpen).toHaveBeenCalledWith(harness.connection);
    expect(harness.socket.sent).toEqual([]); // no welcome
    expect(harness.socket.closed).toEqual({ code: CLOSE.overCapacity, reason: "" });
    expect(harness.clock.pending()).toBe(0);
  });

  it("req dispatches to handle(ch, a, device) and replies res; undefined becomes null", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: ["alpha"] }),
    );
    const harness = makeHarness({ handle });
    openConnection(harness);

    harness.connection.onText(reqFrame(7, "projects:list"));
    await flush();

    expect(handle).toHaveBeenCalledWith("projects:list", [], DEVICE);
    expect(harness.socket.sent).toEqual([{ t: "res", id: 7, v: ["alpha"] }]);
  });

  it("a handler returning undefined replies res with v: null", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({
        kind: "value",
        value: undefined,
      }),
    );
    const harness = makeHarness({ handle });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "projects:list"));
    await flush();

    expect(harness.socket.sent).toEqual([{ t: "res", id: 1, v: null }]);
  });

  it("[bite-proof: encode-failure answers err internal] a value that fails to encode (a BigInt) still answers the request id", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: 1n }),
    );
    const harness = makeHarness({ handle });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "projects:list"));
    await flush();

    expect(harness.socket.sent).toEqual([
      { t: "err", id: 1, code: "internal", text: "err:internal", language: "en" },
    ]);
    expect(harness.log.mock.calls.some((call) => String(call[0]).includes("res 1"))).toBe(true);
  });

  it("[bite-proof: denied channel refused] forbidden -> err forbidden; unknown-channel -> err unknown-channel", async () => {
    const outcomes: RequestOutcome[] = [{ kind: "forbidden" }, { kind: "unknown-channel" }];
    let call = 0;
    const handle: RequestHandler = vi.fn(async () => outcomes[call++] as RequestOutcome);
    const harness = makeHarness({ handle });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "secret:x"));
    await flush();
    harness.connection.onText(reqFrame(2, "secret:y"));
    await flush();

    expect(harness.socket.sent).toEqual([
      { t: "err", id: 1, code: "forbidden", text: "err:forbidden", language: "en" },
      { t: "err", id: 2, code: "unknown-channel", text: "err:unknown-channel", language: "en" },
    ]);
  });

  it("a handler throwing logs the detail and sends only err internal, never the detail", async () => {
    const detail = "ENOENT: /Users/me/projects/secret/.env";
    const handle: RequestHandler = vi.fn(async () => {
      throw new Error(detail);
    });
    const harness = makeHarness({ handle });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "projects:list"));
    await flush();

    expect(harness.socket.sent).toEqual([
      { t: "err", id: 1, code: "internal", text: "err:internal", language: "en" },
    ]);
    for (const frame of harness.socket.sent) {
      expect(JSON.stringify(frame)).not.toContain("/Users/me");
    }
    expect(harness.log.mock.calls.some((call) => String(call[0]).includes(detail))).toBe(true);
  });

  it("a __proto__ channel with id 9 replies err bad-request; not json closes 4400", () => {
    const harness = makeHarness();
    openConnection(harness);

    harness.connection.onText(JSON.stringify({ t: "req", id: 9, ch: "__proto__", a: [] }));
    expect(harness.socket.sent).toEqual([
      { t: "err", id: 9, code: "bad-request", text: "err:bad-request", language: "en" },
    ]);

    harness.connection.onText("not json");
    expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
    expect(harness.clock.pending()).toBe(0);
  });

  it("201 requests: the handler runs 200 times, id 201 gets err rate-limited, and it recovers after +10s", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle });
    openConnection(harness);

    for (let id = 1; id <= 200; id++) harness.connection.onText(reqFrame(id, "projects:list"));
    harness.connection.onText(reqFrame(201, "projects:list"));
    await flush();

    expect(handle).toHaveBeenCalledTimes(200);
    expect(harness.socket.sent).toEqual(
      expect.arrayContaining([
        { t: "err", id: 201, code: "rate-limited", text: "err:rate-limited", language: "en" },
      ]),
    );

    harness.clock.advance(10_000);
    harness.connection.onText(reqFrame(202, "projects:list"));
    await flush();
    expect(handle).toHaveBeenCalledTimes(201);
  });

  it("200 req then a sub in the same window: the sub is ignored", () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle });
    openConnection(harness);

    for (let id = 1; id <= 200; id++) harness.connection.onText(reqFrame(id, "projects:list"));
    harness.connection.onText(subFrame(["t:latest"]));

    harness.connection.push("t:latest", { x: 1 }, undefined);
    expect(harness.socket.sent.some((frame) => frame.t === "psh")).toBe(false);
  });

  it("binary while open with no blob in flight closes 1003 (unchanged)", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onBinary(new Uint8Array([1]));
    expect(harness.socket.closed).toEqual({ code: CLOSE.unsupportedData, reason: "" });
    expect(harness.clock.pending()).toBe(0);
  });

  it("a second hello while open closes 4400", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onText(helloFrame());
    expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
    expect(harness.clock.pending()).toBe(0);
  });

  it("bye closes 1000", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onText(JSON.stringify({ t: "bye" }));
    expect(harness.socket.closed?.code).toBe(CLOSE.normal);
    expect(harness.clock.pending()).toBe(0);
  });

  it("two onSocketClosed calls yield one closed event", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onSocketClosed(1006);
    harness.connection.onSocketClosed(1006);
    expect(harness.onClosed).toHaveBeenCalledTimes(1);
    expect(harness.onClosed).toHaveBeenCalledWith(harness.connection, 1006);
    expect(harness.clock.pending()).toBe(0);
  });

  it("onSocketClosed on an unauthenticated connection never calls onClosed", () => {
    const { clock, socket, connection, onClosed } = makeHarness();
    connection.onText(helloFrame({ token: WRONG_TOKEN }));
    expect(socket.closed?.code).toBe(CLOSE.unauthorized);
    connection.onSocketClosed(1006);
    expect(onClosed).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });
});

describe("createConnection: push (unkeyed)", () => {
  it("no push before sub; sub add adds only channels with a policy; drop stops it", () => {
    const harness = makeHarness();
    openConnection(harness);

    harness.connection.push("metrics:update", { cpu: 1 }, undefined);
    expect(harness.socket.sent).toEqual([]);

    // "remote:update" is not in this harness's POLICIES map — asking to
    // add it must be silently dropped, not added, so a push to it never
    // reaches the wire.
    harness.connection.onText(subFrame(["metrics:update", "remote:update"]));
    harness.connection.push("metrics:update", { cpu: 1 }, undefined);
    harness.connection.push("sessions:update", { count: 1 }, undefined); // never subscribed
    harness.connection.push("remote:update", { any: true }, undefined); // never added: no policy
    expect(harness.socket.sent).toEqual([
      { t: "psh", ch: "metrics:update", p: { cpu: 1 }, seq: 1 },
    ]);

    harness.socket.sent = [];
    harness.connection.onText(subFrame(undefined, ["metrics:update"]));
    harness.connection.push("metrics:update", { cpu: 2 }, undefined);
    expect(harness.socket.sent).toEqual([]);
  });

  it("no push to an unauthenticated connection", () => {
    const { connection, socket } = makeHarness();
    connection.push("metrics:update", { cpu: 1 }, undefined);
    expect(socket.sent).toEqual([]);
  });

  it("[bite-proof: unkeyed target needs a policy] a channel absent from policies is ignored for both a bare and a keyed target", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onText(subFrame(["remote:update", { ch: "remote:update", key: "x" }]));
    harness.connection.push("remote:update", { any: true }, undefined);
    harness.connection.push("remote:update", { any: true }, "x");
    expect(harness.socket.sent).toEqual([]);
    // Not just "no push reaches the wire" — the bare target must never be
    // held as a subscription at all, since `subscribes()` feeds
    // `hub.hasSubscriber()` (Task 4 gates on it).
    expect(harness.connection.subscribes("remote:update")).toBe(false);
  });

  it("a keyed target for an unkeyed channel ({ch:'t:latest', key:'p1'}) is ignored", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onText(subFrame([{ ch: "t:latest", key: "p1" }]));
    harness.connection.push("t:latest", { x: 1 }, "p1");
    expect(harness.socket.sent).toEqual([]);
  });
});

describe("createConnection: push (keyed / stream)", () => {
  it("[bite-proof: accept bare names for keyed policies] sub add ['t:latest','t:stream']: a t:latest push is delivered; a t:stream push with any key is not", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onText(subFrame(["t:latest", "t:stream"]));

    harness.connection.push("t:latest", { x: 1 }, undefined);
    harness.connection.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");

    expect(harness.socket.sent).toEqual([{ t: "psh", ch: "t:latest", p: { x: 1 }, seq: 1 }]);
    // A bare `t:stream` target must never land in the unkeyed set either —
    // `subscribes("t:stream")` (and so `hub.hasSubscriber`) must read false.
    expect(harness.connection.subscribes("t:stream")).toBe(false);
  });

  it("sub add [{ch:'t:stream', key:'p1'}] with authorizeKey true: p1 is delivered, p2 is not", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onText(subFrame([{ ch: "t:stream", key: "p1" }]));

    harness.connection.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");
    harness.connection.push("t:stream", { k: "p2", c: "cd", o: 0 }, "p2");

    expect(harness.socket.sent).toEqual([
      { t: "psh", ch: "t:stream", p: { k: "p1", c: "ab", o: 0 }, seq: 1 },
    ]);
  });

  it("[bite-proof: authorisation] authorizeKey false for p1: no p1 push, and authorizeKey was called with the exact args", () => {
    const authorizeKey = vi.fn(() => false);
    const harness = makeHarness({ authorizeKey });
    openConnection(harness);

    harness.connection.onText(subFrame([{ ch: "t:stream", key: "p1" }]));
    harness.connection.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");

    expect(harness.socket.sent).toEqual([]);
    expect(authorizeKey).toHaveBeenCalledWith("t:stream", "p1", DEVICE);
  });

  it("authorizeKey throwing: no subscription, logged, connection stays open", () => {
    const authorizeKey = vi.fn(() => {
      throw new Error("boom");
    });
    const harness = makeHarness({ authorizeKey });
    openConnection(harness);

    harness.connection.onText(subFrame([{ ch: "t:stream", key: "p1" }]));
    harness.connection.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");

    expect(harness.socket.sent).toEqual([]);
    expect(harness.socket.closed).toBeUndefined();
    expect(harness.log.mock.calls.some((call) => String(call[0]).includes("boom"))).toBe(true);
  });

  // Fix round 1 (Important 1): authorizeKey must be re-run at delivery, not
  // only at subscribe time — ownership can move to a different device
  // (docker:unfollow + a same-id re-follow) after the subscription was
  // accepted, and a stale subscription must not outlive it.
  // [bite-proof: remove the delivery-time re-check in connection.ts's push()
  // — p1 is delivered after `allow` flips to false]
  it("[bite-proof: delivery-time re-check] authorizeKey refusing p1 after a successful subscribe stops further p1 pushes; p2 (still authorized) is unaffected", () => {
    let allowP1 = true;
    const authorizeKey = vi.fn((_ch: string, key: string) => (key === "p1" ? allowP1 : true));
    const harness = makeHarness({ authorizeKey });
    openConnection(harness);

    harness.connection.onText(
      subFrame([
        { ch: "t:stream", key: "p1" },
        { ch: "t:stream", key: "p2" },
      ]),
    );
    // Subscribed while still authorized: delivered normally.
    harness.connection.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");
    expect(harness.socket.sent).toEqual([
      { t: "psh", ch: "t:stream", p: { k: "p1", c: "ab", o: 0 }, seq: 1 },
    ]);

    // Ownership moved on (e.g. the device unfollowed and another device
    // re-followed the same tab id) — the subscription itself was never
    // dropped, but the authoriser now refuses this key.
    allowP1 = false;
    harness.socket.sent = [];
    harness.connection.push("t:stream", { k: "p1", c: "cd", o: 1 }, "p1");
    harness.connection.push("t:stream", { k: "p2", c: "ef", o: 0 }, "p2");

    expect(harness.socket.sent).toEqual([
      { t: "psh", ch: "t:stream", p: { k: "p2", c: "ef", o: 0 }, seq: 2 },
    ]);
  });

  it("17 distinct keyed targets: only 16 held [bite-proof: remove the cap]", () => {
    const harness = makeHarness();
    openConnection(harness);

    const targets = Array.from({ length: 17 }, (_, i) => ({ ch: "t:stream", key: `p${i}` }));
    harness.connection.onText(subFrame(targets));

    for (let i = 0; i < 17; i++) {
      harness.connection.push("t:stream", { k: `p${i}`, c: "x", o: 0 }, `p${i}`);
    }
    expect(harness.socket.sent).toHaveLength(MAX_KEYED_SUBSCRIPTIONS);
    expect(harness.socket.sent.some((frame) => (frame.p as StreamPayload).k === "p16")).toBe(false);

    // Re-adding a held key is a no-op, not a new slot.
    harness.connection.onText(subFrame([{ ch: "t:stream", key: "p0" }]));
    harness.socket.sent = [];
    harness.connection.push("t:stream", { k: "p16", c: "x", o: 0 }, "p16");
    expect(harness.socket.sent).toEqual([]);

    // After dropping one, a new key fits.
    harness.connection.onText(subFrame(undefined, [{ ch: "t:stream", key: "p0" }]));
    harness.connection.onText(subFrame([{ ch: "t:stream", key: "p16" }]));
    harness.socket.sent = [];
    harness.connection.push("t:stream", { k: "p16", c: "x", o: 0 }, "p16");
    expect(harness.socket.sent).toEqual([
      { t: "psh", ch: "t:stream", p: { k: "p16", c: "x", o: 0 }, seq: 17 },
    ]);
  });

  it("drop [{ch:'t:stream', key:'p1'}] while stalled: the queued p1 chunk is never sent", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.socket.bufferedAmount = 2 * 1024 * 1024;
    harness.connection.onText(subFrame([{ ch: "t:stream", key: "p1" }]));

    harness.connection.push("t:stream", { k: "p1", c: "ab", o: 0 }, "p1");
    harness.connection.onText(subFrame(undefined, [{ ch: "t:stream", key: "p1" }]));

    harness.socket.bufferedAmount = 0;
    harness.clock.advance(OUTBOX_TICK_MS);
    expect(harness.socket.sent).toEqual([]);
  });

  it("stream cap: bufferedAmount stalled, pushes beyond STREAM_MAX_BYTES report the dropped byte count", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.socket.bufferedAmount = 2 * 1024 * 1024;
    harness.connection.onText(subFrame([{ ch: "t:stream", key: "p1" }]));

    const totalBytes = 300 * 1024;
    const chunkSize = 4 * 1024;
    let sent = 0;
    let offset = 0;
    while (sent < totalBytes) {
      harness.connection.push("t:stream", { k: "p1", c: "a".repeat(chunkSize), o: offset }, "p1");
      offset += chunkSize;
      sent += chunkSize;
    }

    harness.socket.bufferedAmount = 0;
    harness.clock.advance(OUTBOX_TICK_MS);

    expect(harness.socket.sent).toHaveLength(1);
    const frame = harness.socket.sent[0] as { p: StreamPayload; dropped?: number };
    const dropped = frame.dropped ?? 0;
    expect(dropped + (frame.p.c as string).length).toBe(totalBytes);
  });

  it("a stalled socket over 4 MiB for 10s closes 4413, logged, onClosed fires once", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.socket.bufferedAmount = CONGESTED_BYTES + 1024;
    harness.connection.onText(subFrame(["t:latest"]));
    harness.connection.push("t:latest", { x: 1 }, undefined); // arms the outbox tick

    harness.clock.advance(OUTBOX_TICK_MS);
    harness.clock.advance(CONGESTION_CLOSE_MS);

    expect(harness.socket.closed?.code).toBe(CLOSE.congested);
    expect(harness.log.mock.calls.some((call) => String(call[0]).includes("congested"))).toBe(true);

    harness.connection.onSocketClosed(harness.socket.closed?.code ?? 1006);
    expect(harness.onClosed).toHaveBeenCalledTimes(1);
  });

  it(
    "congestion closes 4413, then terminates after CONGESTION_TERMINATE_MS if no close event ever arrives " +
      "[bite-proof: never arm the timer; terminate uncalled]",
    () => {
      const harness = makeHarness();
      openConnection(harness);
      harness.socket.bufferedAmount = CONGESTED_BYTES + 1024;
      harness.connection.onText(subFrame(["t:latest"]));
      harness.connection.push("t:latest", { x: 1 }, undefined); // arms the outbox tick

      harness.clock.advance(OUTBOX_TICK_MS);
      harness.clock.advance(CONGESTION_CLOSE_MS);
      expect(harness.socket.closed?.code).toBe(CLOSE.congested);
      expect(harness.socket.terminated).toBe(false);

      harness.clock.advance(CONGESTION_TERMINATE_MS);
      expect(harness.socket.terminated).toBe(true);
    },
  );

  it("a real close event before CONGESTION_TERMINATE_MS clears the terminate timer: no terminate, nothing pending", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.socket.bufferedAmount = CONGESTED_BYTES + 1024;
    harness.connection.onText(subFrame(["t:latest"]));
    harness.connection.push("t:latest", { x: 1 }, undefined);

    harness.clock.advance(OUTBOX_TICK_MS);
    harness.clock.advance(CONGESTION_CLOSE_MS);
    expect(harness.socket.closed?.code).toBe(CLOSE.congested);

    // The real close handshake completes partway through the terminate
    // window — the underlying transport finally reports the close it was
    // asked for above.
    harness.clock.advance(1_000);
    harness.connection.onSocketClosed(harness.socket.closed?.code ?? 1006);

    harness.clock.advance(CONGESTION_TERMINATE_MS);
    expect(harness.socket.terminated).toBe(false);
    expect(harness.clock.pending()).toBe(0);
  });

  it(
    "a redundant second close() within the terminate window never disarms the safety net " +
      "(Task 6 fix round 1, review minor)",
    () => {
      const harness = makeHarness();
      openConnection(harness);
      harness.socket.bufferedAmount = CONGESTED_BYTES + 1024;
      harness.connection.onText(subFrame(["t:latest"]));
      harness.connection.push("t:latest", { x: 1 }, undefined);

      harness.clock.advance(OUTBOX_TICK_MS);
      harness.clock.advance(CONGESTION_CLOSE_MS);
      expect(harness.socket.closed?.code).toBe(CLOSE.congested);

      // Something else — a hub-level cleanup, a duplicate signal, whatever
      // — calls close() again while this connection is already closed and
      // still waiting out the terminate window. It must be a total no-op:
      // in particular, it must never touch the pending terminate timer.
      harness.clock.advance(1_000);
      harness.connection.close(CLOSE.normal, "redundant");
      expect(harness.socket.terminated).toBe(false);

      harness.clock.advance(CONGESTION_TERMINATE_MS - 1_000);
      expect(harness.socket.terminated).toBe(true);
    },
  );
});

describe("createConnection: subscribes()", () => {
  it("reports only unkeyed subscriptions, never a keyed one", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onText(subFrame(["t:latest", { ch: "t:stream", key: "p1" }]));

    expect(harness.connection.subscribes("t:latest")).toBe(true);
    expect(harness.connection.subscribes("t:stream")).toBe(false);
  });
});

describe("createConnection: subscribes(channel, key)", () => {
  it("a key checks the keyed set; no key checks the unkeyed set, independently of each other", () => {
    const policies: ChannelPolicies = new Map<string, ChannelPolicy>([
      ["session:output", streamPolicy],
    ]);
    const harness = makeHarness({ policies });
    openConnection(harness);
    harness.connection.onText(subFrame([{ ch: "session:output", key: "s1" }]));

    expect(harness.connection.subscribes("session:output", "s1")).toBe(true);
    expect(harness.connection.subscribes("session:output", "s2")).toBe(false);
    expect(harness.connection.subscribes("session:output")).toBe(false);

    harness.connection.onText(subFrame(undefined, [{ ch: "session:output", key: "s1" }]));
    expect(harness.connection.subscribes("session:output", "s1")).toBe(false);
  });
});

describe("createConnection: heartbeat", () => {
  it("pings at 15s and 30s, terminates at 45s with no pong", () => {
    const harness = makeHarness();
    openConnection(harness);

    harness.clock.advance(15_000);
    expect(harness.socket.sent).toEqual([{ t: "ping", seq: 1 }]);
    expect(harness.socket.terminated).toBe(false);

    harness.clock.advance(15_000); // 30s
    expect(harness.socket.sent).toEqual([
      { t: "ping", seq: 1 },
      { t: "ping", seq: 2 },
    ]);
    expect(harness.socket.terminated).toBe(false);

    harness.clock.advance(15_000); // 45s
    expect(harness.socket.terminated).toBe(true);
    expect(harness.clock.pending()).toBe(0); // no re-armed timer behind the terminate
  });

  it("a pong every beat never terminates", () => {
    const harness = makeHarness();
    openConnection(harness);

    for (let i = 0; i < 5; i++) {
      harness.clock.advance(15_000);
      harness.connection.onText(JSON.stringify({ t: "pong", seq: i }));
    }
    expect(harness.socket.terminated).toBe(false);
  });

  it(
    "a blob in flight resets missed pongs on every binary frame, staying open through 60s with no pong ever sent " +
      "[bite-proof: do not reset on binary; closed at 45s]",
    () => {
      const harness = makeHarness({ blobLimit: () => 1_000_000 });
      openConnection(harness);
      harness.connection.onText(blobFrame(1, "test:blob", 1_000_000, 100));

      for (let i = 0; i < 6; i++) {
        harness.clock.advance(10_000); // 10s, 20s, ..., 60s
        harness.connection.onBinary(new Uint8Array([1]));
      }

      expect(harness.socket.terminated).toBe(false);
    },
  );

  it("no blob in flight: a binary frame still gets today's refusal, not heartbeat credit", () => {
    const harness = makeHarness();
    openConnection(harness);
    harness.connection.onBinary(new Uint8Array([1]));
    expect(harness.socket.closed).toEqual({ code: CLOSE.unsupportedData, reason: "" });
  });
});

describe("createConnection: blob upload", () => {
  it("[bite-proof: full concatenation] happy path — 600000 bytes/3 chunks: handle is called once with args by value, the device and the exact concatenation; a res for the id", async () => {
    const handle: RequestHandler = vi.fn(async () => ({ kind: "value" as const, value: "ok" }));
    const harness = makeHarness({ handle, blobLimit: () => 1_000_000 });
    openConnection(harness);

    const chunk1 = new Uint8Array(262_144).fill(1);
    const chunk2 = new Uint8Array(262_144).fill(2);
    const chunk3 = new Uint8Array(75_712).fill(3);
    harness.connection.onText(blobFrame(11, "test:blob", 600_000, 3, ["x"]));
    harness.connection.onBinary(chunk1);
    harness.connection.onBinary(chunk2);
    harness.connection.onBinary(chunk3);
    await flush();

    expect(handle).toHaveBeenCalledTimes(1);
    const call = vi.mocked(handle).mock.calls[0];
    expect(call?.[0]).toBe("test:blob");
    expect(call?.[1]).toEqual(["x"]);
    expect(call?.[2]).toEqual(DEVICE);
    const expected = new Uint8Array(600_000);
    expected.set(chunk1, 0);
    expected.set(chunk2, 262_144);
    expected.set(chunk3, 524_288);
    expect(call?.[3]).toEqual(expected);
    expect(harness.socket.sent).toEqual(expect.arrayContaining([{ t: "res", id: 11, v: "ok" }]));
  });

  it("[bite-proof: the received !== declared check] under-fill — the declared chunks arrive but sum to fewer bytes: closed 4400, handle never called", () => {
    const handle = vi.fn<RequestHandler>();
    const harness = makeHarness({ handle, blobLimit: () => 1_000_000 });
    openConnection(harness);

    harness.connection.onText(blobFrame(1, "test:blob", 600_000, 3));
    harness.connection.onBinary(new Uint8Array(262_144).fill(1));
    harness.connection.onBinary(new Uint8Array(262_144).fill(2));
    harness.connection.onBinary(new Uint8Array(75_000).fill(3)); // sums to 599_288, not 600_000

    expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
    expect(handle).not.toHaveBeenCalled();
  });

  it("an overflowing frame closes 4400", () => {
    const harness = makeHarness({ blobLimit: () => 1_000_000 });
    openConnection(harness);
    harness.connection.onText(blobFrame(1, "test:blob", 1_000, 1));
    harness.connection.onBinary(new Uint8Array(1_001));
    expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
  });

  it("an empty frame closes 4400", () => {
    const harness = makeHarness({ blobLimit: () => 1_000_000 });
    openConnection(harness);
    harness.connection.onText(blobFrame(1, "test:blob", 10, 1));
    harness.connection.onBinary(new Uint8Array(0));
    expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
  });

  it("a 262145-byte frame closes 4400", () => {
    const harness = makeHarness({ blobLimit: () => MAX_BLOB_BYTES });
    openConnection(harness);
    harness.connection.onText(blobFrame(1, "test:blob", 262_145, 2));
    harness.connection.onBinary(new Uint8Array(MAX_BLOB_CHUNK_BYTES + 1));
    expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
  });

  it("a second blob header mid-blob closes 4400", () => {
    const harness = makeHarness({ blobLimit: () => 1_000_000 });
    openConnection(harness);
    harness.connection.onText(blobFrame(1, "test:blob", 1_000, 1));
    harness.connection.onText(blobFrame(2, "test:blob", 1_000, 1));
    expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
  });

  it.each<[number, number]>([
    [0, 1],
    [1, 0],
    [200, MAX_BLOB_CHUNKS + 1],
    [MAX_BLOB_BYTES + 1, 101],
    [600_000, 2], // below the MAX_BLOB_CHUNK_BYTES ceiling
  ])(
    "[bite-proof: no err sent before the close] invalid shape bytes=%d chunks=%d closes 4400 with nothing sent first",
    (bytes, chunks) => {
      const harness = makeHarness({ blobLimit: () => 1_000_000 });
      openConnection(harness);
      harness.connection.onText(blobFrame(1, "test:blob", bytes, chunks));
      expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
      expect(harness.socket.sent).toEqual([]);
    },
  );

  it.each([
    { bytes: -1, chunks: 1 },
    { bytes: 1.5, chunks: 1 },
    { bytes: Number.MAX_SAFE_INTEGER + 1, chunks: 1 },
    { bytes: undefined, chunks: 1 },
    { bytes: 1, chunks: -1 },
    { bytes: 1, chunks: 1.5 },
    { bytes: 1, chunks: Number.MAX_SAFE_INTEGER + 1 },
    { bytes: 1, chunks: undefined },
  ])("malformed blob numeric fields close 4400 without an err frame", (shape) => {
    const harness = makeHarness({ blobLimit: () => 1_000_000 });
    openConnection(harness);

    harness.connection.onText(
      JSON.stringify({ t: "blob", id: 1, ch: "test:blob", a: [], ...shape }),
    );

    expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
    expect(harness.socket.sent).toEqual([]);
  });

  it("a malformed second blob header closes 4400 without preserving the first upload", () => {
    const harness = makeHarness({ blobLimit: () => 1_000_000 });
    openConnection(harness);

    harness.connection.onText(blobFrame(1, "test:blob", 10, 1));
    harness.connection.onText(
      JSON.stringify({ t: "blob", id: 2, ch: "test:blob", a: [], bytes: -1, chunks: 1 }),
    );

    expect(harness.socket.closed).toEqual({ code: CLOSE.badFrame, reason: "" });
    expect(harness.socket.sent).toEqual([]);
    expect(harness.clock.pending()).toBe(0);
  });

  it(
    "a refused blob cannot arm an idle timer after synchronous congestion close — only the " +
      "congestion-terminate timer (Task 6) is left pending",
    () => {
      const harness = makeHarness({ blobLimit: () => undefined });
      openConnection(harness);
      harness.socket.bufferedAmount = MAX_QUEUED_BYTES + 1;

      harness.connection.onText(blobFrame(1, "test:blob", 10, 1));

      expect(harness.socket.closed).toEqual({ code: CLOSE.congested, reason: "" });
      expect(harness.clock.pending()).toBe(1);

      harness.clock.advance(CONGESTION_TERMINATE_MS);
      expect(harness.socket.terminated).toBe(true);
      expect(harness.clock.pending()).toBe(0);
    },
  );

  it("[bite-proof: discard, don't close] blobLimit undefined — err unknown-channel before the first binary frame; the declared frames are consumed silently; the connection stays open; a following req is answered", async () => {
    const handle: RequestHandler = vi.fn(async () => ({ kind: "value" as const, value: "ok" }));
    const harness = makeHarness({ handle, blobLimit: () => undefined });
    openConnection(harness);

    harness.connection.onText(blobFrame(1, "nope:ch", 1_000, 1));
    expect(harness.socket.sent).toEqual([
      { t: "err", id: 1, code: "unknown-channel", text: "err:unknown-channel", language: "en" },
    ]);

    harness.socket.sent = [];
    harness.connection.onBinary(new Uint8Array(1_000));
    expect(harness.socket.sent).toEqual([]);
    expect(harness.socket.closed).toBeUndefined();

    harness.connection.onText(reqFrame(2, "projects:list"));
    await flush();
    expect(harness.socket.sent).toEqual([{ t: "res", id: 2, v: "ok" }]);
  });

  it("over the limit (blobLimit 4, bytes 5): err bad-request before any frame; handle never called; stays open", () => {
    const handle = vi.fn<RequestHandler>();
    const harness = makeHarness({ handle, blobLimit: () => 4 });
    openConnection(harness);

    harness.connection.onText(blobFrame(1, "test:blob", 5, 1));
    expect(harness.socket.sent).toEqual([
      { t: "err", id: 1, code: "bad-request", text: "err:bad-request", language: "en" },
    ]);
    expect(handle).not.toHaveBeenCalled();
    expect(harness.socket.closed).toBeUndefined();
  });

  it("a rate-limited header answers err rate-limited, then discards", () => {
    const handle: RequestHandler = vi.fn(async () => ({ kind: "value" as const, value: null }));
    const harness = makeHarness({ handle, blobLimit: () => 1_000_000 });
    openConnection(harness);

    for (let id = 1; id <= 200; id++) harness.connection.onText(reqFrame(id, "projects:list"));
    harness.socket.sent = [];

    harness.connection.onText(blobFrame(201, "test:blob", 10, 1));
    expect(harness.socket.sent).toEqual([
      { t: "err", id: 201, code: "rate-limited", text: "err:rate-limited", language: "en" },
    ]);

    harness.socket.sent = [];
    harness.connection.onBinary(new Uint8Array(10));
    expect(harness.socket.sent).toEqual([]);
    expect(harness.socket.closed).toBeUndefined();
  });

  it("blobLimit throwing is treated as unknown-channel and logs a line naming only the channel", () => {
    const blobLimit = () => {
      throw new Error("boom");
    };
    const harness = makeHarness({ blobLimit });
    openConnection(harness);

    harness.connection.onText(blobFrame(1, "test:blob", 10, 1));
    expect(harness.socket.sent).toEqual([
      { t: "err", id: 1, code: "unknown-channel", text: "err:unknown-channel", language: "en" },
    ]);
    expect(
      harness.log.mock.calls.some((call) => String(call[0]).includes("blobLimit(test:blob)")),
    ).toBe(true);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 0, 1.5])(
    "blobLimit returning the invalid value %j is treated as unknown-channel, not as no limit",
    (limit) => {
      const harness = makeHarness({ blobLimit: () => limit });
      openConnection(harness);

      harness.connection.onText(blobFrame(1, "test:blob", 10, 1));
      expect(harness.socket.sent).toEqual([
        { t: "err", id: 1, code: "unknown-channel", text: "err:unknown-channel", language: "en" },
      ]);
      expect(
        harness.log.mock.calls.some((call) => String(call[0]).includes("blobLimit(test:blob)")),
      ).toBe(true);
    },
  );

  it(
    "a pong between chunks resets missed pongs (the heartbeat does not close the socket " +
      "across a 45s upload) [bite-proof: drop the pong sends; MAX_MISSED_PONGS is reached " +
      "at ping 3 (45s) and the socket terminates]",
    () => {
      const handle: RequestHandler = vi.fn(async () => ({ kind: "value" as const, value: null }));
      const harness = makeHarness({ handle, blobLimit: () => 1_000_000 });
      openConnection(harness);

      harness.connection.onText(blobFrame(1, "test:blob", 600_000, 3));
      harness.clock.advance(15_000); // ping 1 (15s)
      harness.connection.onBinary(new Uint8Array(262_144).fill(1));
      harness.connection.onText(JSON.stringify({ t: "pong", seq: 1 }));

      harness.clock.advance(15_000); // ping 2 (30s)
      harness.connection.onBinary(new Uint8Array(262_144).fill(2));
      harness.connection.onText(JSON.stringify({ t: "pong", seq: 2 }));

      // MAX_MISSED_PONGS is 2: without the pong above, missedPongs would
      // already be 2 here, and this third ping (fireHeartbeat checks
      // *before* incrementing) is exactly where termination fires. Reaching
      // this tick is what makes the pong handling load-bearing for this
      // test — the old 40s version never got here.
      harness.clock.advance(15_000); // ping 3 (45s)
      harness.connection.onBinary(new Uint8Array(75_712).fill(3));
      harness.connection.onText(JSON.stringify({ t: "pong", seq: 3 }));

      expect(harness.socket.terminated).toBe(false);
      expect(handle).toHaveBeenCalledTimes(1);
    },
  );

  it("[bite-proof: never arm the timer; no err arrives] idle 30000ms after the second of three chunks answers err bad-request; a later binary frame then closes 1003", () => {
    const harness = makeHarness({ blobLimit: () => 1_000_000 });
    openConnection(harness);

    harness.connection.onText(blobFrame(5, "test:blob", 600_000, 3));
    harness.connection.onBinary(new Uint8Array(262_144).fill(1));
    harness.connection.onBinary(new Uint8Array(262_144).fill(2));
    harness.socket.sent = [];

    harness.clock.advance(BLOB_IDLE_TIMEOUT_MS);
    const errs = harness.socket.sent.filter((frame) => frame.t === "err");
    expect(errs).toEqual([
      { t: "err", id: 5, code: "bad-request", text: "err:bad-request", language: "en" },
    ]);

    harness.connection.onBinary(new Uint8Array(75_712).fill(3));
    expect(harness.socket.closed).toEqual({ code: CLOSE.unsupportedData, reason: "" });
  });

  it("a handler throwing on a finished blob answers err internal", () => {
    const handle: RequestHandler = vi.fn(() => {
      throw new Error("boom");
    });
    const harness = makeHarness({ handle, blobLimit: () => 10 });
    openConnection(harness);

    harness.connection.onText(blobFrame(9, "test:blob", 4, 1));
    harness.connection.onBinary(new Uint8Array([1, 2, 3, 4]));

    expect(harness.socket.sent).toEqual(
      expect.arrayContaining([
        { t: "err", id: 9, code: "internal", text: "err:internal", language: "en" },
      ]),
    );
  });

  it("a handler rejecting on a finished blob answers err internal", async () => {
    const handle: RequestHandler = vi.fn(async () => {
      throw new Error("boom");
    });
    const harness = makeHarness({ handle, blobLimit: () => 10 });
    openConnection(harness);

    harness.connection.onText(blobFrame(9, "test:blob", 4, 1));
    harness.connection.onBinary(new Uint8Array([1, 2, 3, 4]));
    await flush();

    expect(harness.socket.sent).toEqual(
      expect.arrayContaining([
        { t: "err", id: 9, code: "internal", text: "err:internal", language: "en" },
      ]),
    );
  });

  it("closing mid-blob never calls handle, and the fake timers report no pending timer", () => {
    const handle = vi.fn<RequestHandler>();
    const harness = makeHarness({ handle, blobLimit: () => 1_000_000 });
    openConnection(harness);

    harness.connection.onText(blobFrame(3, "test:blob", 600_000, 3));
    harness.connection.onBinary(new Uint8Array(262_144).fill(1));
    harness.connection.close(CLOSE.normal, "bye");

    expect(handle).not.toHaveBeenCalled();
    expect(harness.clock.pending()).toBe(0);
  });

  it("[bite-proof: no byte reaches a log] a distinctive 16-byte pattern never appears in any log line, in hex or latin1", () => {
    const pattern = new Uint8Array([
      0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b,
      0x0c,
    ]);
    const handle: RequestHandler = vi.fn(async () => ({ kind: "value" as const, value: null }));
    const harness = makeHarness({ handle, blobLimit: () => 1_000_000 });
    openConnection(harness);

    harness.connection.onText(blobFrame(1, "test:blob", pattern.length, 1));
    harness.connection.onBinary(pattern);

    const hex = Buffer.from(pattern).toString("hex");
    const latin1 = Buffer.from(pattern).toString("latin1");
    for (const call of harness.log.mock.calls) {
      const line = String(call[0]);
      expect(line).not.toContain(hex);
      expect(line).not.toContain(latin1);
    }
  });
});

describe("createConnection: audit (M12 Task 3)", () => {
  function alwaysFor(channel: string): (c: string) => AuditPolicy {
    return (c) => (c === channel ? "always" : "never");
  }
  function firstPerKeyFor(channel: string): (c: string) => AuditPolicy {
    return (c) => (c === channel ? "first-per-key" : "never");
  }

  it("a git:commit req records one remote-call outcome=ok line with channel and deviceId and no key [bite-proof: spread args[0] into the line; the test's exact-line assertion fails]", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle, auditPolicy: alwaysFor("git:commit") });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "git:commit", ["some commit message"]));
    await flush();

    expect(harness.audit.record).toHaveBeenCalledTimes(1);
    expect(harness.audit.record).toHaveBeenCalledWith({
      kind: "remote-call",
      deviceId: DEVICE.id,
      channel: "git:commit",
      outcome: "ok",
    });
  });

  it("a throwing handler records outcome=error", async () => {
    const handle: RequestHandler = vi.fn(async () => {
      throw new Error("boom");
    });
    const harness = makeHarness({ handle, auditPolicy: alwaysFor("git:commit") });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "git:commit"));
    await flush();

    expect(harness.audit.record).toHaveBeenCalledWith({
      kind: "remote-call",
      deviceId: DEVICE.id,
      channel: "git:commit",
      outcome: "error",
    });
  });

  it("sessions:list under policy never records no line", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle, auditPolicy: () => "never" });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "sessions:list"));
    await flush();

    expect(harness.audit.record).not.toHaveBeenCalled();
  });

  it("three session:input calls with the same key record one line with key=s1; a fourth with key s2 records a second", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle, auditPolicy: firstPerKeyFor("session:input") });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "session:input", ["s1", "a"]));
    harness.connection.onText(reqFrame(2, "session:input", ["s1", "b"]));
    harness.connection.onText(reqFrame(3, "session:input", ["s1", "c"]));
    await flush();

    expect(harness.audit.record).toHaveBeenCalledTimes(1);
    expect(harness.audit.record).toHaveBeenCalledWith({
      kind: "remote-call",
      deviceId: DEVICE.id,
      channel: "session:input",
      outcome: "ok",
      key: "s1",
    });

    harness.connection.onText(reqFrame(4, "session:input", ["s2", "d"]));
    await flush();

    expect(harness.audit.record).toHaveBeenCalledTimes(2);
    expect(harness.audit.record).toHaveBeenLastCalledWith({
      kind: "remote-call",
      deviceId: DEVICE.id,
      channel: "session:input",
      outcome: "ok",
      key: "s2",
    });
  });

  it("a 65-character key records the line without key", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle, auditPolicy: firstPerKeyFor("session:input") });
    openConnection(harness);

    const longKey = "k".repeat(AUDIT_KEY_MAX_CHARS + 1);
    harness.connection.onText(reqFrame(1, "session:input", [longKey, "x"]));
    await flush();

    expect(harness.audit.record).toHaveBeenCalledWith({
      kind: "remote-call",
      deviceId: DEVICE.id,
      channel: "session:input",
      outcome: "ok",
    });
  });

  // Fix round 1 (review I1): a key-less call dedupes under a per-channel
  // sentinel, same as a real key — a phone that can't (or won't) supply a
  // usable key must not get one audit line per call.
  it("[bite-proof: drop the sentinel] two session:input calls with a 65-character key record only one remote-call line", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle, auditPolicy: firstPerKeyFor("session:input") });
    openConnection(harness);

    const longKey = "k".repeat(AUDIT_KEY_MAX_CHARS + 1);
    harness.connection.onText(reqFrame(1, "session:input", [longKey, "x"]));
    harness.connection.onText(reqFrame(2, "session:input", [longKey, "y"]));
    await flush();

    expect(harness.audit.record).toHaveBeenCalledTimes(1);
    expect(harness.audit.record).toHaveBeenCalledWith({
      kind: "remote-call",
      deviceId: DEVICE.id,
      channel: "session:input",
      outcome: "ok",
    });
  });

  it("a non-string first arg records the line without key", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle, auditPolicy: firstPerKeyFor("session:input") });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "session:input", [42, "x"]));
    await flush();

    expect(harness.audit.record).toHaveBeenCalledWith({
      kind: "remote-call",
      deviceId: DEVICE.id,
      channel: "session:input",
      outcome: "ok",
    });
  });

  // Fix round 1 (review I1): the dedupe set's own per-connection cap.
  it("[bite-proof: drop the cap] 257 distinct session:input keys record 256 lines, then one cap log line and no 257th", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle, auditPolicy: firstPerKeyFor("session:input") });
    openConnection(harness);

    // The rate limiter (200 requests / 10s) would otherwise refuse past
    // #200 — two batches, with the clock advanced a full window between
    // them, so all 257 actually reach `handle`.
    for (let id = 1; id <= 200; id++) {
      harness.connection.onText(reqFrame(id, "session:input", [`s${id}`, "x"]));
    }
    harness.clock.advance(10_000);
    for (let id = 201; id <= 257; id++) {
      harness.connection.onText(reqFrame(id, "session:input", [`s${id}`, "x"]));
    }
    await flush();

    expect(harness.audit.record).toHaveBeenCalledTimes(AUDIT_INPUT_KEYS_PER_CONNECTION);
    expect(
      harness.log.mock.calls.some((call) =>
        String(call[0]).includes(
          `further first-per-key audits from device=${DEVICE.id} not recorded`,
        ),
      ),
    ).toBe(true);
  });

  it("[bite-proof: drop the counter; 25 lines] 25 forbidden calls record 20 lines then one log line, and no 21st audit line", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "forbidden" }),
    );
    const harness = makeHarness({ handle, auditPolicy: () => "never" });
    openConnection(harness);

    for (let id = 1; id <= 25; id++) {
      harness.connection.onText(reqFrame(id, "secret:x"));
    }
    await flush();

    const refusedCalls = harness.audit.record.mock.calls.filter(
      (call) => (call[0] as AuditEvent).kind === "remote-call",
    );
    expect(refusedCalls).toHaveLength(AUDIT_PROBE_LINES_PER_CONNECTION);
    expect(
      harness.log.mock.calls.some((call) =>
        String(call[0]).includes(`further refused calls from device=${DEVICE.id} not audited`),
      ),
    ).toBe(true);
  });

  it("after reconnect the per-key set and the probe counter start fresh", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: null }),
    );
    const harness = makeHarness({ handle, auditPolicy: firstPerKeyFor("session:input") });
    openConnection(harness);

    harness.connection.onText(reqFrame(1, "session:input", ["s1", "a"]));
    await flush();
    expect(harness.audit.record).toHaveBeenCalledTimes(1);

    // A reconnect is a brand-new socket, so the hub creates a brand-new
    // `Connection` (a fresh `createConnection` call) — nothing from the
    // first one's per-key set or probe counter is shared with it.
    const second = makeHarness({ handle, auditPolicy: firstPerKeyFor("session:input") });
    openConnection(second);
    second.connection.onText(reqFrame(1, "session:input", ["s1", "a"]));
    await flush();
    expect(second.audit.record).toHaveBeenCalledTimes(1);
  });

  it("the audit record throwing still delivers res to the phone", async () => {
    const handle: RequestHandler = vi.fn(
      async (): Promise<RequestOutcome> => ({ kind: "value", value: 42 }),
    );
    const audit = {
      record: vi.fn<(event: AuditEvent) => void>(() => {
        throw new Error("audit boom");
      }),
    };
    const harness = makeHarness({ handle, audit, auditPolicy: alwaysFor("git:commit") });
    openConnection(harness);

    harness.connection.onText(reqFrame(7, "git:commit"));
    await flush();

    expect(harness.socket.sent).toEqual([{ t: "res", id: 7, v: 42 }]);
  });
});
