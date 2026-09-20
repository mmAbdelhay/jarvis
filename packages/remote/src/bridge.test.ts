import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Bridge, BridgeDeps, Listen, ListenOptions, RemoteStatus } from "./bridge.js";
import { createBridge, IDLE_DISABLE_MAX_MINUTES } from "./bridge.js";
import type { CertificateMaterial } from "./certificate.js";
import { fakeClock } from "./clock-double.js";
import type { AuditPolicy, AuthorizeKey, RequestHandler, RequestOutcome } from "./connection.js";
import { createDeviceStore } from "./devices.js";
import { memoryFs } from "./fs-double.js";
import { MAX_PENDING } from "./hub.js";
import type { RandomBytes } from "./io.js";
import { CLOSE, parsePairingUri, PROTOCOL_VERSION } from "./protocol.js";
import type { SidecarProxy } from "./proxy.js";
import type { SidecarRegistry, SidecarTarget } from "./sidecar-registry.js";
import { FakeSocket } from "./socket-double.js";

const DIR = "/remote";
// createBridge builds both paths with `join(deps.dir, …)` (bridge.ts), which
// is platform-correct — backslash-joined on win32. memoryFs (fs-double.ts)
// keys its Map on the exact path string, so these must be built the same
// way rather than hardcoded with a literal "/", or every lookup misses on
// Windows and the bridge treats devices.json as unreadable.
const DEVICES_PATH = join(DIR, "devices.json");
const AUDIT_PATH = join(DIR, "audit.log");
const CERT = {
  cert: "CERT",
  key: "KEY",
  fingerprint: "ab".repeat(32),
  source: "self-signed" as const,
  dnsNames: [] as string[],
};
const ON_127: (port?: number) => Parameters<Bridge["apply"]>[0] = (port = 7717) => ({
  enabled: true,
  bindAddress: "127.0.0.1",
  port,
  sidecarProxy: false,
  tls: {},
});

/** `CERT` with a different `source`/`dnsNames` — the four combinations the sidecar gate depends on. */
function certWith(source: "self-signed" | "configured", dnsNames: string[]): CertificateMaterial {
  return { ...CERT, source, dnsNames };
}

/** A RandomBytes double that fills each call's buffer with an incrementing byte, so successive mints never collide. */
function countingRandom(): RandomBytes {
  let call = 0;
  return (size: number) => Buffer.alloc(size, ++call);
}

/** Waits for every already-queued microtask (the bridge's reconcile chain included) to drain, via a real macrotask tick. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function helloFrame(deviceId: string, token: string): string {
  return JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, deviceId, token, client: "test/1.0" });
}

function reqFrame(id: number, ch: string, a: unknown[] = []): string {
  return JSON.stringify({ t: "req", id, ch, a });
}

function subFrame(add: string[]): string {
  return JSON.stringify({ t: "sub", add });
}

function pairFrame(secret: string, deviceName: string): string {
  return JSON.stringify({ t: "pair", v: PROTOCOL_VERSION, secret, deviceName, client: "test/1.0" });
}

type FakeListener = { port: number; closed: boolean };

function makeListen(opts: { fail?: boolean; closeFails?: boolean } = {}): {
  listen: Listen;
  calls: ListenOptions[];
  listeners: FakeListener[];
} {
  const calls: ListenOptions[] = [];
  const listeners: FakeListener[] = [];
  const listen: Listen = vi.fn(async (options: ListenOptions) => {
    calls.push(options);
    if (opts.fail) throw new Error("listen failed");
    const entry: FakeListener = { port: options.port, closed: false };
    listeners.push(entry);
    return {
      port: entry.port,
      async close() {
        entry.closed = true;
        if (opts.closeFails) throw new Error("close failed");
      },
    };
  });
  return { listen, calls, listeners };
}

function makeHarness(
  opts: {
    fs?: ReturnType<typeof memoryFs>;
    cert?: CertificateMaterial;
    certFails?: boolean;
    listenFails?: boolean;
    closeFails?: boolean;
    handle?: RequestHandler;
    authorizeKey?: AuthorizeKey;
    createProxy?: (registry: SidecarRegistry) => SidecarProxy | undefined;
    auditPolicy?: (channel: string) => AuditPolicy;
  } = {},
) {
  const fs = opts.fs ?? memoryFs();
  const clock = fakeClock(0);
  const random = countingRandom();
  const {
    listen,
    calls: listenCalls,
    listeners,
  } = makeListen({
    fail: opts.listenFails,
    closeFails: opts.closeFails,
  });
  const loadCertificate = vi.fn(async () => {
    if (opts.certFails) throw new Error("certificate failed");
    return { ...(opts.cert ?? CERT) };
  });
  const onStatus = vi.fn<(status: RemoteStatus) => void>();
  const log = vi.fn();
  const handle: RequestHandler =
    opts.handle ?? (async () => ({ kind: "value", value: null }) as RequestOutcome);
  const onDeviceDisconnected = vi.fn();
  const authorizeKey: AuthorizeKey = opts.authorizeKey ?? (() => false);
  // Final review, M5: defaults to a real (stub) proxy, not `undefined`, so
  // every existing "gate is on" test still gets a `currentProxy` the way a
  // real `createProxy` (listen.ts) always would — a harness that wants the
  // M5 window (gate "on", no live proxy) passes its own `createProxy: () =>
  // undefined` explicitly.
  const createProxy = vi.fn(
    opts.createProxy ??
      ((): SidecarProxy => ({
        handleRequest: vi.fn(),
        handleUpgrade: vi.fn(),
        closeDevice: vi.fn(() => 0),
      })),
  );

  const deps: BridgeDeps = {
    dir: DIR,
    fs,
    random,
    now: clock.now,
    timers: clock.timers,
    listen,
    loadCertificate,
    createProxy,
    handle,
    policies: new Map([
      ["metrics:update", { kind: "latest" as const }],
      ["projects:list", { kind: "latest" as const }],
    ]),
    authorizeKey,
    blobLimit: () => undefined,
    errorText: (code) => ({ text: `err:${code}`, language: "en" }),
    auditPolicy: opts.auditPolicy ?? (() => "never"),
    enforceFileModes: true,
    log,
    onStatus,
    onDeviceDisconnected,
  };

  return {
    fs,
    clock,
    random,
    listenCalls,
    listeners,
    loadCertificate,
    createProxy,
    onStatus,
    log,
    handle,
    onDeviceDisconnected,
    deps,
  };
}

/** Seeds `names.length` devices directly onto `fs`, via a throwaway store, before the bridge under test ever loads it. */
async function seedDevices(
  fs: ReturnType<typeof memoryFs>,
  random: RandomBytes,
  now: () => number,
  names: string[],
): Promise<{ deviceId: string; token: string }[]> {
  const store = createDeviceStore({ fs, path: DEVICES_PATH, random, now, enforceFileModes: true });
  await store.load();
  const minted: { deviceId: string; token: string }[] = [];
  for (const name of names) minted.push(await store.add(name));
  return minted;
}

async function auditLines(fs: ReturnType<typeof memoryFs>): Promise<string[]> {
  await flush();
  return (fs.files.get(AUDIT_PATH)?.data ?? "").split("\n").filter((line) => line !== "");
}

describe("createBridge: off by default", () => {
  it("[bite-proof: no address before apply] before any apply, status is fully closed and openPairing is disabled", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    expect(bridge.status()).toMatchObject({
      enabled: false,
      listening: undefined,
      pairing: { kind: "closed" },
      problem: undefined,
    });

    const result = await bridge.openPairing();

    expect(result).toBe("disabled");
    expect(h.listenCalls).toEqual([]);
  });

  it("[bite-proof: off by default] disabled with a seeded device never listens", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply({
      enabled: false,
      bindAddress: "127.0.0.1",
      port: 7717,
      sidecarProxy: false,
      tls: {},
    });

    expect(h.listenCalls).toEqual([]);
    expect(bridge.status().enabled).toBe(false);
    expect(bridge.status().listening).toBeUndefined();
  });

  it("[bite-proof: off by default] enabled with zero devices never listens", async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127());

    expect(h.listenCalls).toEqual([]);
    expect(bridge.status().listening).toBeUndefined();
  });

  it("enabled with a paired device listens once, with the config's host/port/cert/key", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127());

    expect(h.listenCalls).toHaveLength(1);
    expect(h.listenCalls[0]).toMatchObject({
      host: "127.0.0.1",
      port: 7717,
      cert: "CERT",
      key: "KEY",
    });
    expect(bridge.status().listening).toEqual({
      host: "127.0.0.1",
      port: 7717,
      fingerprint: CERT.fingerprint,
      certificate: { source: "self-signed", hostname: undefined },
    });
  });

  it("the listen() call receives a log that forwards to deps.log", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127());

    h.listenCalls[0]?.log("test line");
    expect(h.log).toHaveBeenCalledWith("test line");
  });

  it("an IPv4-mapped bindAddress listens on plain IPv4", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply({
      enabled: true,
      bindAddress: "::ffff:127.0.0.1",
      port: 7717,
      sidecarProxy: false,
      tls: {},
    });

    expect(h.listenCalls[0]?.host).toBe("127.0.0.1");
  });

  it("a hostname bindAddress never listens and reports bad-address", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply({
      enabled: true,
      bindAddress: "localhost",
      port: 7717,
      sidecarProxy: false,
      tls: {},
    });

    expect(h.listenCalls).toEqual([]);
    expect(bridge.status().problem).toBe("bad-address");
  });
});

describe("createBridge: listener lifecycle", () => {
  it("apply(OFF) closes the listener and the phone's live socket with 1001", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const socket = new FakeSocket();
    const handlers = h.listenCalls[0]?.onSocket("rpc", socket, "10.0.0.5:1");
    handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));

    await bridge.apply({
      enabled: false,
      bindAddress: "127.0.0.1",
      port: 7717,
      sidecarProxy: false,
      tls: {},
    });

    expect(h.listeners[0]?.closed).toBe(true);
    expect(socket.closed).toEqual({ code: CLOSE.goingAway, reason: "" });
    expect((await auditLines(h.fs)).join("\n")).toContain(" stopped");
  });

  it("a rejecting listener close still resolves apply(OFF), records stopped, and logs", async () => {
    const h = makeHarness({ closeFails: true });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    await expect(
      bridge.apply({
        enabled: false,
        bindAddress: "127.0.0.1",
        port: 7717,
        sidecarProxy: false,
        tls: {},
      }),
    ).resolves.toBeUndefined();

    expect(h.listeners[0]?.closed).toBe(true);
    expect(h.log).toHaveBeenCalled();
    expect((await auditLines(h.fs)).join("\n")).toContain(" stopped");
  });

  it("an onStatus that throws once does not break a later apply", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    h.deps.onStatus = vi.fn(() => {
      throw new Error("boom");
    });
    const bridge = await createBridge(h.deps);

    await expect(bridge.apply(ON_127())).resolves.toBeUndefined();
    expect(h.log).toHaveBeenCalled();

    h.deps.onStatus = vi.fn();
    await expect(bridge.apply(ON_127(8443))).resolves.toBeUndefined();
    expect(bridge.status().listening?.port).toBe(8443);
  });

  it("a port change closes the old listener and opens a new one; an unchanged apply listens only once more", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127(7717));
    await bridge.apply(ON_127(8443));
    await bridge.apply(ON_127(8443));

    expect(h.listenCalls).toHaveLength(2);
    expect(h.listeners[0]?.closed).toBe(true);
    expect(h.listeners[1]?.closed).toBe(false);
    expect(bridge.status().listening?.port).toBe(8443);
  });

  it("a listen failure reports listen-failed and no listening status", async () => {
    const h = makeHarness({ listenFails: true });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127());

    expect(bridge.status().listening).toBeUndefined();
    expect(bridge.status().problem).toBe("listen-failed");
  });

  it("a certificate failure reports certificate-failed and never calls listen", async () => {
    const h = makeHarness({ certFails: true });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127());

    expect(h.listenCalls).toEqual([]);
    expect(bridge.status().problem).toBe("certificate-failed");
  });
});

describe("createBridge: unreadable devices file", () => {
  it("[bite-proof: fail closed on unreadable devices] openPairing is unavailable, never listens, and never touches the file", async () => {
    const h = makeHarness();
    h.fs.files.set(DEVICES_PATH, { data: "{", mode: 0o600 });
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127());
    const result = await bridge.openPairing();

    expect(result).toBe("unavailable");
    expect(h.listenCalls).toEqual([]);
    expect(bridge.status().problem).toBe("devices-unreadable");
    expect(h.fs.files.get(DEVICES_PATH)?.data).toBe("{");
    // openPairing must bail out before ever opening a pairing window: no
    // "pairing-opened" audit line, even though nothing ever listens either way.
    expect((await auditLines(h.fs)).join("\n")).not.toContain("pairing-opened");
  });
});

describe("createBridge: openPairing / cancelPairing", () => {
  it("disabled bridge: openPairing is disabled and never listens", async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);

    const result = await bridge.openPairing();

    expect(result).toBe("disabled");
    expect(h.listenCalls).toEqual([]);
  });

  it("zero devices: openPairing opens a listener whose link parses back, and expires after 120s", async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const result = await bridge.openPairing();

    expect(result).toBe("opened");
    const status = bridge.status();
    expect(status.pairing.kind).toBe("open");
    const uri = status.pairing.kind === "open" ? status.pairing.uri : "";
    const link = parsePairingUri(uri);
    expect(link).toMatchObject({ host: "127.0.0.1", port: 7717, fingerprint: CERT.fingerprint });

    h.clock.advance(120_000);
    await flush();

    expect(h.listeners[0]?.closed).toBe(true);
    expect(bridge.status().pairing.kind).toBe("closed");
  });

  it("cancelPairing closes the listener", async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    await bridge.openPairing();

    bridge.cancelPairing();
    await flush();

    expect(h.listeners[0]?.closed).toBe(true);
    expect(bridge.status().pairing.kind).toBe("closed");
  });

  it("a listen failure while pairing is unavailable, closes the pairing window, and the problem sticks until the next apply", async () => {
    const h = makeHarness({ listenFails: true });
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const result = await bridge.openPairing();

    expect(result).toBe("unavailable");
    expect(bridge.status().pairing.kind).toBe("closed");
    expect(bridge.status().problem).toBe("listen-failed");

    // Ruling P9: only the next apply() clears the sticky listen-failed problem.
    await bridge.apply(ON_127(8443));
    expect(bridge.status().problem).toBeUndefined();
  });
});

describe("createBridge: pairing a device end-to-end", () => {
  it("pairs, keeps the listener open, and a paired hello sees welcome then req/res, with the token never in status", async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    await bridge.openPairing();

    const openStatus = bridge.status();
    const uri = openStatus.pairing.kind === "open" ? openStatus.pairing.uri : "";
    const link = parsePairingUri(uri);
    expect(link).toBeDefined();

    const pairSocket = new FakeSocket();
    const pairHandlers = h.listenCalls[0]?.onSocket("pair", pairSocket, "::ffff:127.0.0.1");
    pairHandlers?.onText(pairFrame(link?.secret ?? "", "Paired phone"));

    const confirming = bridge.status();
    expect(confirming.pairing.kind).toBe("confirming");
    const requestId = confirming.pairing.kind === "confirming" ? confirming.pairing.requestId : "";

    const decided = bridge.decidePairing(requestId, true);
    expect(decided).toBe(true);
    await flush();

    // The listener stays open, now because a device is paired.
    expect(h.listeners[0]?.closed).toBe(false);
    expect(bridge.status().devices).toHaveLength(1);

    const pairedFrame = pairSocket.sent.find((frame) => frame.t === "paired");
    const deviceId = pairedFrame?.deviceId as string;
    const token = pairedFrame?.token as string;
    expect(deviceId).toBeTruthy();
    expect(token).toBeTruthy();

    const rpcSocket = new FakeSocket();
    const rpcHandlers = h.listenCalls[0]?.onSocket("rpc", rpcSocket, "10.0.0.9:1");
    rpcHandlers?.onText(helloFrame(deviceId, token));
    expect(rpcSocket.sent.some((frame) => frame.t === "welcome")).toBe(true);

    rpcHandlers?.onText(reqFrame(1, "projects:list"));
    await flush();
    expect(rpcSocket.sent.some((frame) => frame.t === "res" && frame.id === 1)).toBe(true);

    for (const call of h.onStatus.mock.calls) {
      expect(JSON.stringify(call[0])).not.toContain(token);
    }
  });

  it("handle is called with (channel, args, {id, name}) exactly — never the full device summary", async () => {
    const handle = vi.fn(async () => ({ kind: "value", value: ["alpha"] }) as RequestOutcome);
    const h = makeHarness({ handle });
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    await bridge.openPairing();
    const uri = (() => {
      const s = bridge.status();
      return s.pairing.kind === "open" ? s.pairing.uri : "";
    })();
    const secret = parsePairingUri(uri)?.secret ?? "";

    const pairSocket = new FakeSocket();
    const pairHandlers = h.listenCalls[0]?.onSocket("pair", pairSocket, "::ffff:127.0.0.1");
    pairHandlers?.onText(pairFrame(secret, "Paired phone"));
    const requestId = (() => {
      const s = bridge.status();
      return s.pairing.kind === "confirming" ? s.pairing.requestId : "";
    })();
    bridge.decidePairing(requestId, true);
    await flush();

    const pairedFrame = pairSocket.sent.find((frame) => frame.t === "paired");
    const deviceId = pairedFrame?.deviceId as string;
    const token = pairedFrame?.token as string;

    const rpcSocket = new FakeSocket();
    const rpcHandlers = h.listenCalls[0]?.onSocket("rpc", rpcSocket, "10.0.0.9:1");
    rpcHandlers?.onText(helloFrame(deviceId, token));
    rpcHandlers?.onText(reqFrame(1, "projects:list", []));
    await flush();

    expect(handle).toHaveBeenCalledWith("projects:list", [], {
      id: deviceId,
      name: "Paired phone",
    });
  });
});

describe("createBridge: push", () => {
  it("a push reaches a device only after its sub", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const socket = new FakeSocket();
    const handlers = h.listenCalls[0]?.onSocket("rpc", socket, "10.0.0.5:1");
    handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));
    socket.sent = [];

    bridge.push("metrics:update", { cpu: 1 });
    expect(socket.sent).toEqual([]);

    handlers?.onText(subFrame(["metrics:update"]));
    bridge.push("metrics:update", { cpu: 1 });
    expect(socket.sent).toEqual([{ t: "psh", ch: "metrics:update", p: { cpu: 1 }, seq: 1 }]);
  });
});

describe("createBridge: hasSubscriber", () => {
  it("is false while not listening, then reflects the hub once a device subscribes", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    expect(bridge.hasSubscriber("metrics:update")).toBe(false);

    await bridge.apply(ON_127());
    expect(bridge.hasSubscriber("metrics:update")).toBe(false);

    const socket = new FakeSocket();
    const handlers = h.listenCalls[0]?.onSocket("rpc", socket, "10.0.0.5:1");
    handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));
    expect(bridge.hasSubscriber("metrics:update")).toBe(false);

    handlers?.onText(subFrame(["metrics:update"]));
    expect(bridge.hasSubscriber("metrics:update")).toBe(true);
  });
});

describe("createBridge: revoke", () => {
  it("[bite-proof: revoked device refused] seeded + paired device, live rpc on the paired one, revoke(paired)", async () => {
    const h = makeHarness();
    // Two devices, per the brief: "Seeded + paired device, live rpc on the
    // paired one, revoke(paired)" — the listener stays open throughout
    // because `other` is still paired, so the second hello below is driven
    // on a live listener, not one that closed the moment the count hit zero.
    const [device, other] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone", "Tablet"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const socket = new FakeSocket();
    const handlers = h.listenCalls[0]?.onSocket("rpc", socket, "10.0.0.5:1");
    handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));

    const result = await bridge.revoke(device?.deviceId ?? "");

    expect(result).toBe(true);
    expect(socket.closed).toEqual({ code: CLOSE.revoked, reason: "" });
    const raw = h.fs.files.get(DEVICES_PATH)?.data ?? "";
    expect(raw).not.toContain(device?.deviceId ?? "");
    expect(h.listeners[0]?.closed).toBe(false);
    expect(bridge.status().devices.map((d) => d.id)).toEqual([other?.deviceId]);

    const socket2 = new FakeSocket();
    const handlers2 = h.listenCalls[0]?.onSocket("rpc", socket2, "10.0.0.6:1");
    handlers2?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));

    expect(socket2.closed).toEqual({ code: CLOSE.unauthorized, reason: "" });
  });

  it("revoke(id) of a connected device calls onDeviceDisconnected(id) once", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const socket = new FakeSocket();
    const handlers = h.listenCalls[0]?.onSocket("rpc", socket, "10.0.0.5:1");
    handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));

    await bridge.revoke(device?.deviceId ?? "");

    expect(h.onDeviceDisconnected).toHaveBeenCalledTimes(1);
    expect(h.onDeviceDisconnected).toHaveBeenCalledWith(device?.deviceId);
  });

  it("handle is never called for a request from the revoked device", async () => {
    const handle = vi.fn(async () => ({ kind: "value", value: null }) as RequestOutcome);
    const h = makeHarness({ handle });
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    await bridge.revoke(device?.deviceId ?? "");

    const socket = new FakeSocket();
    const handlers = h.listenCalls[0]?.onSocket("rpc", socket, "10.0.0.6:1");
    handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));
    handlers?.onText(reqFrame(1, "projects:list"));

    expect(handle).not.toHaveBeenCalled();
  });

  it("revoking the last device closes the listener and leaves devices empty", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    await bridge.revoke(device?.deviceId ?? "");

    expect(h.listeners[0]?.closed).toBe(true);
    expect(bridge.status().devices).toEqual([]);
  });

  it("a rename failure during revoke returns false and reports devices-write-failed, with the device already gone", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    h.fs.rename = vi.fn().mockRejectedValue(new Error("rename failed"));

    const result = await bridge.revoke(device?.deviceId ?? "");

    expect(result).toBe(false);
    expect(bridge.status()).toMatchObject({ devices: [], problem: "devices-write-failed" });
  });
});

describe("createBridge: push", () => {
  const TOKEN = "ExponentPushToken[cccccccccccc3333]";

  it("setPushToken on a paired device answers ok, audits push-registered, and never leaks the token into status()", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const result = await bridge.setPushToken(device?.deviceId ?? "", {
      token: TOKEN,
      platform: "ios",
      language: "en",
    });

    expect(result).toBe("ok");
    expect(bridge.status().devices[0]?.push).toBe("ios");
    expect(JSON.stringify(bridge.status())).not.toContain(TOKEN);
    expect((await auditLines(h.fs)).join("\n")).toContain("push-registered");
  });

  it("a re-registered token supersedes the old device and audits each push-cleared device", async () => {
    const h = makeHarness();
    const devices = await seedDevices(h.fs, h.random, h.clock.now, ["First", "Second"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    const push = { token: TOKEN, platform: "ios" as const, language: "en" as const };

    await bridge.setPushToken(devices[0]?.deviceId ?? "", push);
    await bridge.setPushToken(devices[1]?.deviceId ?? "", push);

    expect(bridge.pushTargets()).toEqual([
      expect.objectContaining({ deviceId: devices[1]?.deviceId }),
    ]);
    const lines = await auditLines(h.fs);
    expect(
      lines.filter((line) => line.includes("push-cleared") && line.includes('reason="superseded"')),
    ).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("a repeat setPushToken with the same token/platform/language audits nothing further", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    const push = { token: TOKEN, platform: "ios" as const, language: "en" as const };
    await bridge.setPushToken(device?.deviceId ?? "", push);
    const linesAfterFirst = await auditLines(h.fs);

    await bridge.setPushToken(device?.deviceId ?? "", push);
    const linesAfterSecond = await auditLines(h.fs);

    expect(linesAfterSecond.filter((line) => line.includes("push-registered"))).toEqual(
      linesAfterFirst.filter((line) => line.includes("push-registered")),
    );
  });

  it("clearPushToken clears a registered token once; a second call is a no-op with no second audit line", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    await bridge.setPushToken(device?.deviceId ?? "", {
      token: TOKEN,
      platform: "ios",
      language: "en",
    });

    const first = await bridge.clearPushToken(device?.deviceId ?? "", "not-registered");
    expect(first).toBe(true);
    const linesAfterFirst = await auditLines(h.fs);
    expect(linesAfterFirst.filter((line) => line.includes("push-cleared"))).toHaveLength(1);

    const second = await bridge.clearPushToken(device?.deviceId ?? "", "not-registered");
    expect(second).toBe(false);
    const linesAfterSecond = await auditLines(h.fs);
    expect(linesAfterSecond.filter((line) => line.includes("push-cleared"))).toHaveLength(1);
  });

  // Not a bite-proof: before `apply`, teardown/never-started state already
  // closes every connection, so `listening === undefined` and an empty hub
  // agree — the `listening` guard in `watchingDevices` is defensive, not
  // something this test alone can catch a regression in. Kept for the
  // documented pre/post-apply behaviour it still exercises.
  it("watchingDevices is empty before apply and delegates while listening", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    expect(bridge.watchingDevices("turn:new")).toEqual(new Set());

    await bridge.apply(ON_127());
    const socket = new FakeSocket();
    const handlers = h.listenCalls[0]?.onSocket("rpc", socket, "10.0.0.5:1");
    handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));
    handlers?.onText(subFrame(["metrics:update"]));

    expect(bridge.watchingDevices("metrics:update")).toEqual(new Set([device?.deviceId]));
  });

  it("a failing write answers write-failed and reports devices-write-failed", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    h.fs.rename = vi.fn().mockRejectedValue(new Error(TOKEN));

    const result = await bridge.setPushToken(device?.deviceId ?? "", {
      token: TOKEN,
      platform: "ios",
      language: "en",
    });

    expect(result).toBe("write-failed");
    expect(bridge.status().problem).toBe("devices-write-failed");
    expect(h.log.mock.calls.flat().join("\n")).not.toContain(TOKEN);
  });

  it("Task 6 fix round 1 (review I2): a failing write's fs error code reaches the log, and the token never does", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    h.fs.rename = vi.fn().mockImplementation(async () => {
      const error = new Error("rename failed") as Error & { code?: string };
      error.code = "EACCES";
      throw error;
    });

    const result = await bridge.setPushToken(device?.deviceId ?? "", {
      token: TOKEN,
      platform: "ios",
      language: "en",
    });

    expect(result).toBe("write-failed");
    // devices.ts's log dep (Task 6 rule 8) is only load-bearing in
    // production once the bridge actually wires it through — this is what
    // proves `log: deps.log` in createBridge's createDeviceStore call does
    // exactly that, rather than the line being dead.
    const logged = h.log.mock.calls.flat().join("\n");
    expect(logged).toContain("EACCES");
    expect(logged).not.toContain(TOKEN);
  });

  it("records registration only when a retry makes a failed token write durable", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    const originalRename = h.fs.rename.bind(h.fs);
    let failOnce = true;
    h.fs.rename = async (from, to) => {
      if (failOnce) {
        failOnce = false;
        throw new Error(TOKEN);
      }
      return originalRename(from, to);
    };
    const push = { token: TOKEN, platform: "ios" as const, language: "en" as const };

    await expect(bridge.setPushToken(device?.deviceId ?? "", push)).resolves.toBe("write-failed");
    await expect(bridge.setPushToken(device?.deviceId ?? "", push)).resolves.toBe("ok");

    expect(
      (await auditLines(h.fs)).filter((line) => line.includes("push-registered")),
    ).toHaveLength(1);
  });

  it("audits superseded records even when the replacement write fails and is retried", async () => {
    const h = makeHarness();
    const devices = await seedDevices(h.fs, h.random, h.clock.now, ["First", "Second"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    const push = { token: TOKEN, platform: "ios" as const, language: "en" as const };
    await bridge.setPushToken(devices[0]?.deviceId ?? "", push);
    const originalRename = h.fs.rename.bind(h.fs);
    let failOnce = true;
    h.fs.rename = async (from, to) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("write failed");
      }
      return originalRename(from, to);
    };

    await expect(bridge.setPushToken(devices[1]?.deviceId ?? "", push)).resolves.toBe(
      "write-failed",
    );
    await expect(bridge.setPushToken(devices[1]?.deviceId ?? "", push)).resolves.toBe("ok");

    expect(
      (await auditLines(h.fs)).filter(
        (line) => line.includes("push-cleared") && line.includes('reason="superseded"'),
      ),
    ).toHaveLength(1);
  });

  it("a failed registration's marker is cleared by a differing retry, so a later identical re-registration audits nothing further", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    const originalRename = h.fs.rename.bind(h.fs);
    let failOnce = true;
    h.fs.rename = async (from, to) => {
      if (failOnce) {
        failOnce = false;
        throw new Error(TOKEN);
      }
      return originalRename(from, to);
    };
    const firstToken = { token: TOKEN, platform: "ios" as const, language: "en" as const };
    const secondToken = {
      token: "ExponentPushToken[dddddddddddd4444]",
      platform: "ios" as const,
      language: "en" as const,
    };

    await expect(bridge.setPushToken(device?.deviceId ?? "", firstToken)).resolves.toBe(
      "write-failed",
    );
    // The retry uses a *different* token, so it counts as a real change and
    // must audit once — but it must also clear the failed-write marker, or a
    // later value-identical re-registration (the bug this guards) audits a
    // second, spurious `push-registered` line for a write that did nothing.
    await expect(bridge.setPushToken(device?.deviceId ?? "", secondToken)).resolves.toBe("ok");
    await expect(bridge.setPushToken(device?.deviceId ?? "", secondToken)).resolves.toBe("ok");

    expect(
      (await auditLines(h.fs)).filter((line) => line.includes("push-registered")),
    ).toHaveLength(1);
  });

  it("pushTargets() lists a registered device's token", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    await bridge.setPushToken(device?.deviceId ?? "", {
      token: TOKEN,
      platform: "android",
      language: "ar",
    });

    expect(bridge.pushTargets()).toEqual([
      { deviceId: device?.deviceId, token: TOKEN, platform: "android", language: "ar" },
    ]);
  });
});

describe("createBridge: stop", () => {
  it("stop closes the listener and disables; a later apply(ON) + openPairing stays disabled", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    await bridge.stop();

    expect(h.listeners[0]?.closed).toBe(true);
    expect(bridge.status().enabled).toBe(false);
    expect(bridge.status().pairing.kind).toBe("closed");

    await bridge.apply(ON_127());
    const result = await bridge.openPairing();

    expect(result).toBe("disabled");
    expect(h.listenCalls).toHaveLength(1);
  });

  it("stop() with a connected device calls onDeviceDisconnected once, once the transport reports the close", async () => {
    // Rule 7 (hub.ts): closeAll (unlike closeDevice) only closes the wire —
    // onDeviceDisconnected still fires from the real onClosed path, driven
    // here by the same `handlers.onClose` a real `ws` "close" event would
    // eventually call through server.ts.
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const socket = new FakeSocket();
    const handlers = h.listenCalls[0]?.onSocket("rpc", socket, "10.0.0.5:1");
    handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));

    await bridge.stop();
    expect(socket.closed).toEqual({ code: CLOSE.goingAway, reason: "" });
    handlers?.onClose(CLOSE.goingAway);

    expect(h.onDeviceDisconnected).toHaveBeenCalledTimes(1);
    expect(h.onDeviceDisconnected).toHaveBeenCalledWith(device?.deviceId);
  });

  // [bite-proof] Reverting stop() to `stopped = true; pairing.cancel(); await
  // reconcile();` (dropping the two `flushed()` awaits) fails this: `stop()`
  // would resolve while `fs.appendFile` is still gated, before its own
  // "stopped" audit line has actually landed — which is exactly the race
  // that let bridge.integration.test.ts's `afterAll` `rm` hit ENOTEMPTY.
  it("stop() resolves only once its own audit line is actually written", async () => {
    const fs = memoryFs();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const baseAppend = fs.appendFile.bind(fs);
    fs.appendFile = async (path, data, mode) => {
      await gate;
      return baseAppend(path, data, mode);
    };

    const h = makeHarness({ fs });
    await seedDevices(fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    let resolved = false;
    const stopping = bridge.stop().then(() => {
      resolved = true;
    });

    // Every microtask this side of the gate has had a chance to run (a real
    // macrotask tick, not a fixed count of `Promise.resolve()`s); stop()
    // must still be pending because its own "stopped" append is blocked.
    await flush();
    expect(resolved).toBe(false);
    expect(fs.files.get(AUDIT_PATH)?.data ?? "").not.toContain("stopped");

    release?.();
    await stopping;

    expect(resolved).toBe(true);
    expect(fs.files.get(AUDIT_PATH)?.data ?? "").toContain("stopped");
  });
});

describe("createBridge: audit log", () => {
  it("records listening with fingerprintTail and revoked, but never the full fingerprint or the token", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    await bridge.revoke(device?.deviceId ?? "");

    const lines = await auditLines(h.fs);
    const joined = lines.join("\n");

    expect(joined).toContain(' listening fingerprintTail="abab" host="127.0.0.1" port=7717');
    expect(joined).toContain(" revoked ");
    expect(joined).not.toContain(CERT.fingerprint);
    expect(joined).not.toContain(device?.token ?? "");
  });
});

// M12 Task 3, rule 6.
describe("createBridge: recordPushQueued", () => {
  it('records a push-queued line with deviceId and pushKind, e.g. recordPushQueued("d1","session-done")', async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    bridge.recordPushQueued("d1", "session-done");

    const lines = await auditLines(h.fs);
    expect(lines.join("\n")).toContain('push-queued deviceId="d1" pushKind="session-done"');
  });

  // Fix round 1 (review minor): the bridge is the audit log's last line of
  // defense, not a place that trusts its caller — an over-long pushKind is
  // refused, not truncated into the log.
  it("refuses a pushKind over 32 characters: nothing recorded, one log line", async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const tooLong = "k".repeat(33);
    bridge.recordPushQueued("d1", tooLong);

    const lines = await auditLines(h.fs);
    expect(lines.some((line) => line.includes("push-queued"))).toBe(false);
    expect(lines.some((line) => line.includes(tooLong))).toBe(false);
    expect(
      h.log.mock.calls.some((call) =>
        String(call[0]).includes("recordPushQueued pushKind too long"),
      ),
    ).toBe(true);
  });
});

// M12 Task 3: the auditPolicy dep reaches the connection through hub.ts's
// pass-through — a hub-level proof with a spy policy over the full
// bridge -> hub -> connection chain.
describe("createBridge: auditPolicy dep reaches the connection", () => {
  it("a spy policy's channel is audited when a paired device calls it", async () => {
    const auditPolicy: (channel: string) => AuditPolicy = (channel) =>
      channel === "spy:channel" ? "always" : "never";
    const h = makeHarness({ auditPolicy });
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    const rpcSocket = new FakeSocket();
    const rpcHandlers = h.listenCalls[0]?.onSocket("rpc", rpcSocket, "10.0.0.9:1");
    rpcHandlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));
    rpcHandlers?.onText(reqFrame(1, "spy:channel"));
    await flush();

    const lines = await auditLines(h.fs);
    const joined = lines.join("\n");
    expect(joined).toContain('remote-call channel="spy:channel"');
    expect(joined).toContain(`deviceId="${device?.deviceId}"`);
  });
});

describe("createBridge: sidecar proxy status (rule 4)", () => {
  /** Seeds one device, then applies with the given cert/toggle so the listener opens on the first `apply()` (no `openPairing()` needed). */
  async function listeningWith(cert: CertificateMaterial, sidecarProxy: boolean) {
    const h = makeHarness({ cert });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy });
    return { h, bridge };
  }

  it('"off" when config.sidecarProxy is false, regardless of the certificate', async () => {
    const { bridge } = await listeningWith(
      certWith("configured", ["laptop.tailnet.ts.net"]),
      false,
    );
    expect(bridge.status().sidecarProxy).toBe("off");
  });

  it('"needs-certificate" when on but the served certificate is self-signed', async () => {
    const { bridge } = await listeningWith(certWith("self-signed", []), true);
    expect(bridge.status().sidecarProxy).toBe("needs-certificate");
    expect(bridge.status().listening?.certificate).toEqual({
      source: "self-signed",
      hostname: undefined,
    });
  });

  it('"needs-certificate" when on and configured but the certificate carries no DNS SAN', async () => {
    const { bridge } = await listeningWith(certWith("configured", []), true);
    expect(bridge.status().sidecarProxy).toBe("needs-certificate");
    expect(bridge.status().listening?.certificate).toEqual({
      source: "configured",
      hostname: undefined,
    });
  });

  it('"on" when configured with a DNS SAN — and the pairing URI carries name only in this combination', async () => {
    const { bridge } = await listeningWith(certWith("configured", ["laptop.tailnet.ts.net"]), true);
    expect(bridge.status().sidecarProxy).toBe("on");
    expect(bridge.status().listening?.certificate).toEqual({
      source: "configured",
      hostname: "laptop.tailnet.ts.net",
    });

    await bridge.openPairing();
    const status = bridge.status();
    const uri = status.pairing.kind === "open" ? status.pairing.uri : "";
    expect(parsePairingUri(uri)?.name).toBe("laptop.tailnet.ts.net");
  });

  it("the other combinations (no DNS SAN either way) never carry name in the pairing URI", async () => {
    // Rule 7 keys `name` off `listening.certificate.hostname` alone
    // (`material.dnsNames[0]`) — both cases below leave it `undefined`
    // exactly because neither certificate carries a DNS SAN; a self-signed
    // certificate carrying one isn't a shape `loadCertificate` ever
    // produces (`mintSelfSigned` sets no SAN extension), so it isn't
    // exercised here.
    for (const cert of [certWith("self-signed", []), certWith("configured", [])]) {
      const { bridge } = await listeningWith(cert, true);
      await bridge.openPairing();
      const status = bridge.status();
      const uri = status.pairing.kind === "open" ? status.pairing.uri : "";
      expect(parsePairingUri(uri)?.name).toBeUndefined();
    }
  });

  // Final review, I2: the hostname is the first DNS SAN that is a plain
  // hostname (@jarvis/wire's `isHostname`) — not simply `dnsNames[0]` — so a
  // wildcard first entry is skipped rather than handed to `formatPairingUri`
  // as a `name` the phone's `parsePairingUri` would then reject outright.
  it('"on" with hostname the first plain-hostname SAN, skipping a leading wildcard', async () => {
    const { bridge } = await listeningWith(
      certWith("configured", ["*.example.com", "mac.tail.ts.net"]),
      true,
    );
    expect(bridge.status().sidecarProxy).toBe("on");
    expect(bridge.status().listening?.certificate).toEqual({
      source: "configured",
      hostname: "mac.tail.ts.net",
    });
  });

  it('"needs-certificate", with no name in the pairing link, when every SAN is a wildcard', async () => {
    const { bridge } = await listeningWith(certWith("configured", ["*.example.com"]), true);
    expect(bridge.status().sidecarProxy).toBe("needs-certificate");
    expect(bridge.status().listening?.certificate).toEqual({
      source: "configured",
      hostname: undefined,
    });

    await bridge.openPairing();
    const status = bridge.status();
    const uri = status.pairing.kind === "open" ? status.pairing.uri : "";
    expect(parsePairingUri(uri)?.name).toBeUndefined();
  });
});

describe("createBridge: sidecar proxy — createProxy wiring", () => {
  it('createProxy is called only when the gate would be "on" for the listen about to happen', async () => {
    const createProxy = vi.fn(() => undefined as SidecarProxy | undefined);
    const h = makeHarness({ createProxy, cert: certWith("self-signed", []) });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply({ ...ON_127(7717), sidecarProxy: true });
    expect(createProxy).not.toHaveBeenCalled();

    // A restart (different port -> different desiredKey) with a real
    // DNS-carrying configured certificate flips the gate to "on".
    h.loadCertificate.mockResolvedValueOnce(certWith("configured", ["laptop.tailnet.ts.net"]));
    await bridge.apply({ ...ON_127(8443), sidecarProxy: true });

    expect(createProxy).toHaveBeenCalledTimes(1);
    expect(createProxy).toHaveBeenCalledWith(
      expect.objectContaining({ publish: expect.any(Function) }),
    );
  });

  it("toggling sidecarProxy restarts the listener even with nothing else changed", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply({ ...ON_127(), sidecarProxy: false });
    await bridge.apply({ ...ON_127(), sidecarProxy: true });

    expect(h.listenCalls).toHaveLength(2);
    expect(h.listeners[0]?.closed).toBe(true);
    expect(h.listeners[1]?.closed).toBe(false);
  });
});

describe("createBridge: publishSidecar (rule 6)", () => {
  const TARGET: SidecarTarget = { kind: "editor", port: 4001 };
  const URL_PATTERN = /^\/s\/[0-9a-f]{32}\/\?k=[0-9a-f]{64}$/;

  it('"off" when sidecarProxy is disabled', async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: false });

    expect(bridge.publishSidecar(device?.deviceId ?? "", TARGET)).toEqual({ unavailable: "off" });
  });

  it('"not-listening" when sidecarProxy is on but nothing is listening (zero devices)', async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: true });

    expect(h.listenCalls).toEqual([]);
    expect(bridge.publishSidecar("anything", TARGET)).toEqual({ unavailable: "not-listening" });
  });

  it('"needs-certificate" when listening but the served certificate is self-signed', async () => {
    const h = makeHarness({ cert: certWith("self-signed", []) });
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: true });

    expect(bridge.publishSidecar(device?.deviceId ?? "", TARGET)).toEqual({
      unavailable: "needs-certificate",
    });
  });

  it('"unknown-device" when the id is not a paired device', async () => {
    const h = makeHarness({ cert: certWith("configured", ["laptop.tailnet.ts.net"]) });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: true });

    expect(bridge.publishSidecar("no-such-device", TARGET)).toEqual({
      unavailable: "unknown-device",
    });
  });

  // Final review, M5: the gate is "on" for the certificate/config the
  // listener was started with, but the listener has no *live* proxy —
  // `createProxy` returning `undefined` here stands in for the window
  // between `apply()` writing `sidecarProxy: true` and the restart that
  // would actually bind one (a caller cannot force that exact interleaving
  // through the injected fakes; this drives the same end state directly).
  // publishSidecar must refuse with "not-listening" rather than handing out
  // a URL a dead proxy can never serve, and status().sidecarProxy must not
  // read "on" for that same listener.
  it('"not-listening" when the gate is on but the current listener has no live proxy', async () => {
    const h = makeHarness({
      cert: certWith("configured", ["laptop.tailnet.ts.net"]),
      createProxy: () => undefined,
    });
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: true });

    expect(bridge.publishSidecar(device?.deviceId ?? "", TARGET)).toEqual({
      unavailable: "not-listening",
    });
    expect(bridge.status().sidecarProxy).toBe("needs-certificate");
  });

  it("publishes a URL shaped /s/<32hex>/?k=<64hex> and audits sidecar-published without the key or port", async () => {
    const h = makeHarness({ cert: certWith("configured", ["laptop.tailnet.ts.net"]) });
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: true });

    const result = bridge.publishSidecar(device?.deviceId ?? "", TARGET);
    expect(result).toMatchObject({ url: expect.stringMatching(URL_PATTERN) });
    const url = (result as { url: string }).url;
    const key = url.split("k=")[1] ?? "";

    const lines = await auditLines(h.fs);
    const line = lines.find((l) => l.includes(" sidecar-published "));
    expect(line).toBeDefined();
    expect(line).toContain(`deviceId="${device?.deviceId}"`);
    expect(line).toContain('sidecar="editor"');
    expect(line).not.toContain("4001");
    expect(line).not.toContain(key);
  });
});

describe("createBridge: sidecar handles cleared on revoke and listener restart (rule 5)", () => {
  const TARGET: SidecarTarget = { kind: "editor", port: 4001 };

  it("revoke clears only the revoked device's handles, and audits sidecars-cleared", async () => {
    const h = makeHarness({ cert: certWith("configured", ["laptop.tailnet.ts.net"]) });
    const [device, other] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone", "Tablet"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: true });

    const published1 = bridge.publishSidecar(device?.deviceId ?? "", TARGET);
    const published2 = bridge.publishSidecar(other?.deviceId ?? "", TARGET);
    expect(published1).toMatchObject({ url: expect.any(String) });
    expect(published2).toMatchObject({ url: expect.any(String) });

    await bridge.revoke(device?.deviceId ?? "");

    expect(bridge.publishSidecar(device?.deviceId ?? "", TARGET)).toEqual({
      unavailable: "unknown-device",
    });
    // The other device's own publish is untouched by the first device's revoke.
    expect(bridge.publishSidecar(other?.deviceId ?? "", TARGET)).toMatchObject({
      url: expect.any(String),
    });

    const lines = await auditLines(h.fs);
    expect(lines.join("\n")).toContain(" sidecars-cleared count=1");
  });

  // [bite-proof: remove the `registry.clear()` call (and its audit line) in
  // the teardown branch of step() — this test then fails, since the
  // "sidecars-cleared" line it looks for is never written]
  it("a listener restart clears all live sidecar handles", async () => {
    const h = makeHarness({ cert: certWith("configured", ["laptop.tailnet.ts.net"]) });
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(7717), sidecarProxy: true });

    const published = bridge.publishSidecar(device?.deviceId ?? "", TARGET);
    expect(published).toMatchObject({ url: expect.any(String) });

    // A port change forces a listener restart (a different desiredKey).
    await bridge.apply({ ...ON_127(8443), sidecarProxy: true });

    const lines = await auditLines(h.fs);
    expect(lines.join("\n")).toContain(" sidecars-cleared count=1");
  });
});

describe("createBridge: revoke closes live sidecar sockets (controller ruling, fix round 1)", () => {
  it("revoke calls the current proxy's closeDevice with the device id, and folds the count into the revoked audit line", async () => {
    const closeDevice = vi.fn(() => 3);
    const fakeProxy: SidecarProxy = {
      handleRequest: vi.fn(),
      handleUpgrade: vi.fn(),
      closeDevice,
    };
    const h = makeHarness({
      cert: certWith("configured", ["laptop.tailnet.ts.net"]),
      createProxy: () => fakeProxy,
    });
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: true });

    await bridge.revoke(device?.deviceId ?? "");

    expect(closeDevice).toHaveBeenCalledWith(device?.deviceId);
    expect(closeDevice).toHaveBeenCalledTimes(1);

    const lines = await auditLines(h.fs);
    const line = lines.find((l) => l.includes(" revoked "));
    expect(line).toContain("closedSidecarSockets=3");
  });

  it("revoke audits closedSidecarSockets=0 when no proxy is bound (gate off)", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    await expect(bridge.revoke(device?.deviceId ?? "")).resolves.toBe(true);

    const lines = await auditLines(h.fs);
    const line = lines.find((l) => l.includes(" revoked "));
    expect(line).toContain("closedSidecarSockets=0");
  });
});

describe("createBridge: stop() clears the sidecar registry directly (M4)", () => {
  it("stop() after a publish clears the registry and audits sidecars-cleared", async () => {
    const h = makeHarness({ cert: certWith("configured", ["laptop.tailnet.ts.net"]) });
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: true });

    const published = bridge.publishSidecar(device?.deviceId ?? "", {
      kind: "editor",
      port: 4001,
    });
    expect(published).toMatchObject({ url: expect.any(String) });

    await bridge.stop();

    const lines = await auditLines(h.fs);
    expect(lines.join("\n")).toContain(" sidecars-cleared count=1");
  });
});

describe("createBridge: idle auto-disable (M12 Task 1)", () => {
  const OFF_127: Parameters<Bridge["apply"]>[0] = {
    enabled: false,
    bindAddress: "127.0.0.1",
    port: 7717,
    sidecarProxy: false,
    tls: {},
  };

  it("IDLE_DISABLE_MAX_MINUTES is 10_080 — config.ts's validator uses the same ceiling ('...from 0 to 10080'); the two must never drift apart", () => {
    expect(IDLE_DISABLE_MAX_MINUTES).toBe(10_080);
  });

  // [bite-proof: skip the latch and only call onIdleDisabled; the listener
  // stays up and enabled stays true]
  it("a listener idle with no devices connected disables itself after idleDisableMinutes, in order after stopped", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const onIdleDisabled = vi.fn();
    h.deps.onIdleDisabled = onIdleDisabled;
    const bridge = await createBridge(h.deps);

    await bridge.apply({ ...ON_127(), idleDisableMinutes: 2 });

    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 120_000 });

    h.clock.advance(119_999);
    await flush();
    expect(h.listeners[0]?.closed).toBe(false);

    h.clock.advance(1);
    await flush();

    expect(h.listeners[0]?.closed).toBe(true);
    expect(bridge.status().enabled).toBe(false);
    expect(bridge.status().idle).toEqual({ kind: "disabled", at: 120_000, afterMinutes: 2 });

    const lines = await auditLines(h.fs);
    const stoppedIdx = lines.findIndex((line) => line.includes(" stopped"));
    const idleIdx = lines.findIndex((line) => line.includes(" idle-disabled afterMinutes=2"));
    expect(stoppedIdx).toBeGreaterThanOrEqual(0);
    expect(idleIdx).toBeGreaterThan(stoppedIdx);
    expect(onIdleDisabled).toHaveBeenCalledTimes(1);
  });

  // [bite-proof: treat 0 as 1 minute; a 60s advance closes the listener]
  it("idleDisableMinutes: 0 means never — no timer arms, and a 60s advance changes nothing", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply({ ...ON_127(), idleDisableMinutes: 0 });
    expect(bridge.status().idle).toBeUndefined();

    h.clock.advance(60_000);
    await flush();

    expect(h.listeners[0]?.closed).toBe(false);
    expect(bridge.status().idle).toBeUndefined();
  });

  // [bite-proof: never clear the timer on connect; the 10-minute advance
  // closes the listener while the device is connected]
  it("a device connecting clears the idle timer; disconnecting re-arms from that moment, not the original idleSince", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 5 });

    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 300_000 });

    h.clock.advance(30_000); // t = 30s: device authenticates
    const socket = new FakeSocket();
    const handlers = h.listenCalls[0]?.onSocket("rpc", socket, "10.0.0.5:1");
    handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));

    expect(bridge.status().idle).toBeUndefined();

    h.clock.advance(570_000); // t = 600_000 (10 min): still connected, still listening
    await flush();
    expect(h.listeners[0]?.closed).toBe(false);

    h.clock.advance(60_000); // t = 660_000 (11 min): disconnects
    handlers?.onClose(CLOSE.goingAway);

    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 960_000 });
  });

  // [bite-proof: reset idleSince in hub.accept; disableAt moves]
  it("an auth failure and a refused pending socket do not touch idle or disableAt", async () => {
    const h = makeHarness();
    const [device] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 5 });

    const before = bridge.status().idle;
    expect(before).toEqual({ kind: "armed", disableAt: 300_000 });

    // Advance first: if a socket accept ever reset `idleSince`, `disableAt`
    // would move forward from here — the bite-proof this test guards.
    h.clock.advance(10_000);

    const badSocket = new FakeSocket();
    const badHandlers = h.listenCalls[0]?.onSocket("rpc", badSocket, "10.0.0.9:1");
    badHandlers?.onText(helloFrame(device?.deviceId ?? "", "wrong-token"));
    expect(bridge.status().idle).toEqual(before);

    // Fill the pending queue so the next socket is refused for capacity —
    // none of these ever authenticate or become a "pair" session.
    for (let i = 0; i < MAX_PENDING; i++) {
      h.listenCalls[0]?.onSocket("rpc", new FakeSocket(), `10.0.1.${i}:1`);
    }
    const refused = new FakeSocket();
    h.listenCalls[0]?.onSocket("rpc", refused, "10.0.2.1:1");
    expect(refused.closed).toBeDefined();
    expect(bridge.status().idle).toEqual(before);
  });

  it("an open pairing window is not idle; cancelPairing re-arms idle from the cancel time", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 5 });
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 300_000 });

    await bridge.openPairing();
    expect(bridge.status().idle).toBeUndefined();

    h.clock.advance(45_000);
    bridge.cancelPairing();
    await flush();

    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 345_000 });
  });

  it("a pair socket landing while the pairing window is closed preserves the idle deadline", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 5 });
    const before = bridge.status().idle;
    expect(before).toEqual({ kind: "armed", disableAt: 300_000 });

    const pairSocket = new FakeSocket();
    h.listenCalls[0]?.onSocket("pair", pairSocket, "10.0.0.1:1");

    expect(bridge.status().idle).toEqual(before);
  });

  it("a pair session settling while the pairing window is closed preserves the idle deadline", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 5 });
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 300_000 });

    h.clock.advance(40_000); // t = 40s: a pair socket lands
    const pairSocket = new FakeSocket();
    const pairHandlers = h.listenCalls[0]?.onSocket("pair", pairSocket, "10.0.0.1:1");
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 300_000 });

    h.clock.advance(20_000); // t = 60s: a bad frame refuses and settles it, unpaired
    pairHandlers?.onBinary(new Uint8Array([1]));
    await flush();

    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 300_000 });
  });

  it("ten refused pair sockets over five minutes do not move the original idle deadline", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const onIdleDisabled = vi.fn();
    h.deps.onIdleDisabled = onIdleDisabled;
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 1 });
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 60_000 });

    for (let i = 0; i < 10; i++) {
      for (let pending = 0; pending < MAX_PENDING; pending++) {
        h.listenCalls[0]?.onSocket("pair", new FakeSocket(), `10.0.${i}.${pending}:1`);
      }
      const refused = new FakeSocket();
      h.listenCalls[0]?.onSocket("pair", refused, `10.1.0.${i}:1`);
      expect(refused.closed).toBeDefined();
      h.clock.advance(30_000);
      await flush();
    }

    expect(onIdleDisabled).toHaveBeenCalledTimes(1);
    expect(bridge.status().idle).toEqual({ kind: "disabled", at: 60_000, afterMinutes: 1 });
  });

  // Task 1 deferred minor (folded into Task 3): a config change that
  // restarts the listener (a new port, say) must not disturb `idleSince` —
  // `checkIdle()` only ever runs once, at the very end of `step()`, after
  // the new listener is already up.
  it("a listener restart re-arms idle from the same idleSince, not the restart time", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 5 });
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 300_000 });

    h.clock.advance(50_000); // t = 50s: still idle the whole time
    await bridge.apply({ ...ON_127(9999), idleDisableMinutes: 5 }); // a different port forces a restart

    expect(h.listeners.at(-1)?.closed).toBe(false);
    // Unchanged: still the original idleSince (t=0), not t=50s.
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 300_000 });
  });

  it("apply with a larger N recomputes disableAt from the same idleSince; enabled:false clears the timer", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 5 });
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 300_000 });

    await bridge.apply({ ...ON_127(), idleDisableMinutes: 10 });
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 600_000 });

    await bridge.apply({ ...OFF_127, idleDisableMinutes: 10 });
    expect(bridge.status().idle).toBeUndefined();
  });

  it("stop() while armed clears the timer and never calls onIdleDisabled", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const onIdleDisabled = vi.fn();
    h.deps.onIdleDisabled = onIdleDisabled;
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 2 });
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 120_000 });

    await bridge.stop();
    h.clock.advance(200_000);
    await flush();

    expect(onIdleDisabled).not.toHaveBeenCalled();
    expect(bridge.status().idle).toBeUndefined();
  });

  it("after firing, idle stays disabled across an enabled:false apply, and re-arms on an enabled:true apply", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 2 });
    h.clock.advance(120_000);
    await flush();
    expect(bridge.status().idle).toEqual({ kind: "disabled", at: 120_000, afterMinutes: 2 });

    await bridge.apply({ ...OFF_127, idleDisableMinutes: 2 });
    expect(bridge.status().idle).toEqual({ kind: "disabled", at: 120_000, afterMinutes: 2 });
    expect(bridge.status().enabled).toBe(false);

    await bridge.apply({ ...ON_127(), idleDisableMinutes: 2 });
    expect(h.listeners.at(-1)?.closed).toBe(false);
    expect(bridge.status().idle).toEqual({ kind: "armed", disableAt: 240_000 });
  });

  it("onIdleDisabled throwing still leaves the listener closed and the audit line written, and logs the failure", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    h.deps.onIdleDisabled = () => {
      throw new Error("boom");
    };
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), idleDisableMinutes: 2 });

    h.clock.advance(120_000);
    await flush();

    expect(h.listeners[0]?.closed).toBe(true);
    expect(bridge.status().idle).toEqual({ kind: "disabled", at: 120_000, afterMinutes: 2 });
    expect((await auditLines(h.fs)).join("\n")).toContain("idle-disabled afterMinutes=2");
    expect(h.log.mock.calls.flat().join("\n")).toContain("bridge: onIdleDisabled threw");
  });

  // [bite-proof: pass Infinity straight to setTimeout; the fake timer
  // records a non-finite delay and the "no timer" assertion below fails]
  it.each([1.5, -1, 10_081, Number.NaN, Number.POSITIVE_INFINITY])(
    "idleDisableMinutes %p is treated as 0 (never) and logged once",
    async (value) => {
      const h = makeHarness();
      await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
      const bridge = await createBridge(h.deps);

      await bridge.apply({ ...ON_127(), idleDisableMinutes: value });

      expect(bridge.status().idle).toBeUndefined();
      expect(h.clock.pending()).toBe(0);
      expect(
        h.log.mock.calls.filter((call) => call[0] === "bridge: idleDisableMinutes ignored"),
      ).toHaveLength(1);
    },
  );

  it("never more than one idle timer handle is live across arm/re-arm sequences", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply({ ...ON_127(), idleDisableMinutes: 5 });
    expect(h.clock.pending()).toBe(1);

    await bridge.apply({ ...ON_127(), idleDisableMinutes: 10 });
    expect(h.clock.pending()).toBe(1);

    await bridge.apply({ ...OFF_127, idleDisableMinutes: 10 });
    expect(h.clock.pending()).toBe(0);

    await bridge.apply({ ...ON_127(), idleDisableMinutes: 10 });
    expect(h.clock.pending()).toBe(1);
  });
});
