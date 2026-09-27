import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  Bridge,
  BridgeDeps,
  Listen,
  ListenOptions,
  ListenWeb,
  WebListenOptions,
  RemoteStatus,
} from "./bridge.js";
import { createBridge, IDLE_DISABLE_MAX_MINUTES } from "./bridge.js";
import type { CertificateMaterial } from "./certificate.js";
import { fakeClock } from "./clock-double.js";
import type { AuditPolicy, AuthorizeKey, RequestHandler, RequestOutcome } from "./connection.js";
import { webPairingUrl } from "@jarvis/wire";
import { createDeviceStore } from "./devices.js";
import { memoryFs } from "./fs-double.js";
import { MAX_PENDING } from "./hub.js";
import type { DesktopNoticeKind } from "./owner-auth.js";
import {
  OWNER_TEST_HASH_PARAMS,
  OWNER_TEST_PASSWORD,
  ownerFileWithPassword,
} from "./owner-double.js";
import type { RandomBytes, SessionHandlers } from "./io.js";
import { CLOSE, parsePairingUri, PROTOCOL_VERSION } from "./protocol.js";
import type { SidecarProxy } from "./proxy.js";
import { ACCESS_TTL_MS } from "./sessions.js";
import type { SidecarRegistry, SidecarTarget } from "./sidecar-registry.js";
import { FakeSocket } from "./socket-double.js";
import { softAuthenticator } from "./webauthn-double.js";
import type { WebManifest } from "./web-server.js";

const DIR = "/remote";
// createBridge builds both paths with `join(deps.dir, …)` (bridge.ts), which
// is platform-correct — backslash-joined on win32. memoryFs (fs-double.ts)
// keys its Map on the exact path string, so these must be built the same
// way rather than hardcoded with a literal "/", or every lookup misses on
// Windows and the bridge treats devices.json as unreadable.
const DEVICES_PATH = join(DIR, "devices.json");
const AUDIT_PATH = join(DIR, "audit.log");
const OWNER_PATH = join(DIR, "owner.json");
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
  web: { enabled: false, port: port + 1 },
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

const LOGIN_ID = 9_000;

/**
 * Phase 0: logs an open /rpc connection in with the owner password and
 * waits for the answer (a real scrypt check, at the test cost), then
 * forgets every frame sent so far.
 */
async function login(
  handlers: SessionHandlers | undefined,
  socket: FakeSocket,
  password: string = OWNER_TEST_PASSWORD,
): Promise<Record<string, unknown>> {
  handlers?.onText(reqFrame(LOGIN_ID, "auth:login", [{ password }]));
  for (let i = 0; i < 200; i++) {
    const answer = socket.sent.find((frame) => frame.id === LOGIN_ID);
    if (answer !== undefined) {
      socket.sent = [];
      return answer;
    }
    await flush();
  }
  throw new Error("auth:login never answered");
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

const WEB_MANIFEST: WebManifest = new Map([
  ["/index.html", { bytes: Buffer.from("<!doctype html>"), type: "text/html", etag: '"e"' }],
]);

function makeListenWeb(opts: { fail?: boolean } = {}): {
  listenWeb: ListenWeb;
  calls: WebListenOptions[];
  listeners: FakeListener[];
} {
  const calls: WebListenOptions[] = [];
  const listeners: FakeListener[] = [];
  const listenWeb: ListenWeb = vi.fn(async (options: WebListenOptions) => {
    calls.push(options);
    if (opts.fail) throw new Error("EADDRINUSE");
    const entry: FakeListener = { port: options.port, closed: false };
    listeners.push(entry);
    return {
      port: entry.port,
      async close() {
        entry.closed = true;
      },
    };
  });
  return { listenWeb, calls, listeners };
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
    webListenFails?: boolean;
    /** What `loadWebManifest` answers; "throws" makes it reject. Defaults to a built one. */
    webManifest?: WebManifest | undefined | "throws";
    auditPolicy?: (channel: string) => AuditPolicy;
    /** Phase 0: every harness starts with an owner password already set
     *  (the bridge never listens without one) unless this is false. */
    ownerPassword?: boolean;
  } = {},
) {
  const notifyDesktop = vi.fn<(kind: DesktopNoticeKind, deviceName?: string) => void>();
  const fs = opts.fs ?? memoryFs();
  if ((opts.ownerPassword ?? true) && !fs.files.has(OWNER_PATH)) {
    fs.files.set(OWNER_PATH, { data: ownerFileWithPassword(), mode: 0o600 });
  }
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
  const {
    listenWeb,
    calls: webListenCalls,
    listeners: webListeners,
  } = makeListenWeb({ fail: opts.webListenFails });
  const webManifest = "webManifest" in opts ? opts.webManifest : WEB_MANIFEST;
  const loadWebManifest = vi.fn(async () => {
    if (webManifest === "throws") throw new Error("manifest unreadable");
    return webManifest;
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
    listenWeb,
    loadWebManifest,
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
    ownerHashParams: OWNER_TEST_HASH_PARAMS,
    log,
    onStatus,
    onDeviceDisconnected,
    notifyDesktop,
  };

  return {
    notifyDesktop,
    fs,
    clock,
    random,
    listenCalls,
    listeners,
    webListenCalls,
    webListeners,
    loadWebManifest,
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

/** Opens an /rpc connection for `device` on the current listener and logs it in. */
async function connectLoggedIn(
  h: ReturnType<typeof makeHarness>,
  device: { deviceId: string; token: string } | undefined,
  source = "10.0.0.5:1",
): Promise<{ socket: FakeSocket; handlers: SessionHandlers | undefined }> {
  const socket = new FakeSocket();
  const handlers = h.listenCalls.at(-1)?.onSocket("rpc", socket, source);
  handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));
  socket.sent = [];
  expect(await login(handlers, socket)).toMatchObject({ t: "res" });
  return { socket, handlers };
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
      web: { enabled: false, port: 7718 },
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
      web: { enabled: false, port: 7718 },
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
      web: { enabled: false, port: 7718 },
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
      web: { enabled: false, port: 7718 },
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
        web: { enabled: false, port: 7718 },
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
    await login(rpcHandlers, rpcSocket);

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
    await login(rpcHandlers, rpcSocket);
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
    await login(handlers, socket);

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
    await login(handlers, socket);
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
    await login(handlers, socket);
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
    await login(rpcHandlers, rpcSocket);
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
    await connectLoggedIn(h, device);

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
    await connectLoggedIn(h, device);
    await connectLoggedIn(h, other, "10.0.0.6:1");

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
    await connectLoggedIn(h, device);

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
    await connectLoggedIn(h, device);

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
    web: { enabled: false, port: 7718 },
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

describe("createBridge: owner password gate (Phase 0)", () => {
  const NEW_PASSWORD = "a brand new owner password";

  it("[bite-proof: no owner password] enabled with a paired device never listens without an owner password", async () => {
    const h = makeHarness({ ownerPassword: false });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127());

    expect(h.listenCalls).toEqual([]);
    expect(bridge.status().listening).toBeUndefined();
    expect(bridge.status().problem).toBe("no-owner-password");
  });

  it("openPairing without an owner password is unavailable and never listens", async () => {
    const h = makeHarness({ ownerPassword: false });
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());

    expect(await bridge.openPairing()).toBe("unavailable");
    expect(h.listenCalls).toEqual([]);
  });

  it("disabled without an owner password reports no problem", async () => {
    const h = makeHarness({ ownerPassword: false });
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), enabled: false });

    expect(bridge.status().problem).toBeUndefined();
  });

  it("upgrade path: enabled in config with no password stays off with the problem shown, keeps enabled, and comes up once a password is set", async () => {
    const h = makeHarness({ ownerPassword: false });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127());

    const before = bridge.status();
    expect(before.enabled).toBe(true);
    expect(before.problem).toBe("no-owner-password");
    expect(before.listening).toBeUndefined();
    expect(h.onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ problem: "no-owner-password" }),
    );
    expect(h.fs.files.has(OWNER_PATH)).toBe(false);

    expect(await bridge.setOwnerPassword(undefined, NEW_PASSWORD)).toEqual({ ok: true });

    expect(h.listenCalls).toHaveLength(1);
    expect(bridge.status().problem).toBeUndefined();
    expect(bridge.status().listening).toBeDefined();
    expect(h.fs.files.get(OWNER_PATH)?.mode).toBe(0o600);
  });

  it("rejects an 11-character password and writes nothing", async () => {
    const h = makeHarness({ ownerPassword: false });
    const bridge = await createBridge(h.deps);

    expect(await bridge.setOwnerPassword(undefined, "a".repeat(11))).toEqual({
      ok: false,
      code: "too-short",
    });
    expect(bridge.ownerStatus().hasPassword).toBe(false);
    expect(h.fs.files.has(OWNER_PATH)).toBe(false);
  });

  it("a change needs the current password: missing is current-required, wrong is current-wrong, right changes it", async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);

    expect(await bridge.setOwnerPassword(undefined, NEW_PASSWORD)).toEqual({
      ok: false,
      code: "current-required",
    });
    expect(await bridge.setOwnerPassword("", NEW_PASSWORD)).toEqual({
      ok: false,
      code: "current-required",
    });
    expect(await bridge.setOwnerPassword("not the password", NEW_PASSWORD)).toEqual({
      ok: false,
      code: "current-wrong",
    });
    expect(await bridge.setOwnerPassword(OWNER_TEST_PASSWORD, NEW_PASSWORD)).toEqual({ ok: true });
    expect(await bridge.setOwnerPassword(OWNER_TEST_PASSWORD, "yet another password")).toEqual({
      ok: false,
      code: "current-wrong",
    });

    const lines = (await auditLines(h.fs)).join("\n");
    expect(lines).toContain("owner-password-changed");
    expect(lines).not.toContain("owner-password-set");
  });

  it("a first password is audited as owner-password-set", async () => {
    const h = makeHarness({ ownerPassword: false });
    const bridge = await createBridge(h.deps);

    await bridge.setOwnerPassword(undefined, NEW_PASSWORD);

    expect((await auditLines(h.fs)).join("\n")).toContain("owner-password-set");
  });

  it("[bite-proof: password leak] no password ever reaches the audit log, the log double, or any file as plaintext", async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);
    const wrong = "a wrong guess at the password";

    await bridge.setOwnerPassword(wrong, NEW_PASSWORD);
    await bridge.setOwnerPassword(OWNER_TEST_PASSWORD, NEW_PASSWORD);
    await bridge.setOwnerPassword(NEW_PASSWORD, "short");
    h.fs.rename = async () => {
      throw new Error(`rename failed: ${NEW_PASSWORD}`);
    };
    expect(await bridge.setOwnerPassword(NEW_PASSWORD, "the password that fails")).toEqual({
      ok: false,
      code: "write-failed",
    });
    await flush();

    const logged = h.log.mock.calls.map((call) => String(call[0])).join("\n");
    const files = [...h.fs.files.values()].map((entry) => entry.data).join("\n");
    for (const secret of [OWNER_TEST_PASSWORD, NEW_PASSWORD, wrong, "the password that fails"]) {
      expect(logged).not.toContain(secret);
      expect(files).not.toContain(secret);
    }
  });

  it("ownerStatus lists passkeys by id, label and createdAt only; deletePasskey removes one and audits only its tail", async () => {
    const h = makeHarness({ ownerPassword: false });
    const owner = JSON.parse(ownerFileWithPassword());
    owner.passkeys = [
      {
        credentialId: "Y3JlZGVudGlhbC1vbmU",
        publicKey: "cHVibGljLWtleQ",
        alg: -7,
        signCount: 3,
        label: "Laptop",
        createdAt: 42,
      },
    ];
    h.fs.files.set(OWNER_PATH, { data: JSON.stringify(owner), mode: 0o600 });
    const bridge = await createBridge(h.deps);

    expect(bridge.ownerStatus()).toEqual({
      hasPassword: true,
      passkeys: [{ id: "Y3JlZGVudGlhbC1vbmU", label: "Laptop", createdAt: 42 }],
    });

    expect(await bridge.deletePasskey("unknown")).toBe(false);
    expect(await bridge.deletePasskey("Y3JlZGVudGlhbC1vbmU")).toBe(true);
    expect(bridge.ownerStatus().passkeys).toEqual([]);

    const lines = (await auditLines(h.fs)).join("\n");
    expect(lines).toContain(`passkey-deleted credentialTail="vbmU"`);
    expect(lines).not.toContain("Y3JlZGVudGlhbC1vbmU");
    expect(lines).not.toContain("cHVibGljLWtleQ");
  });

  it("signOutEverywhere is audited", async () => {
    const h = makeHarness();
    const bridge = await createBridge(h.deps);

    await bridge.signOutEverywhere();

    const lines = (await auditLines(h.fs)).join("\n");
    expect(lines).toContain("signed-out-everywhere");
    expect(lines).toContain('signed-out-all reason="signed-out-everywhere"');
  });

  it("an unreadable owner.json is sticky owner-unreadable: never listens, never overwritten", async () => {
    const h = makeHarness({ ownerPassword: false });
    h.fs.files.set(OWNER_PATH, { data: "{", mode: 0o600 });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);

    await bridge.apply(ON_127());

    expect(h.listenCalls).toEqual([]);
    expect(bridge.status().problem).toBe("owner-unreadable");
    expect(await bridge.setOwnerPassword(undefined, NEW_PASSWORD)).toEqual({
      ok: false,
      code: "unavailable",
    });
    expect(h.fs.files.get(OWNER_PATH)?.data).toBe("{");
  });
});

describe("createBridge: owner login (Phase 0)", () => {
  const SESSIONS_PATH = join(DIR, "sessions.json");
  const TARGET: SidecarTarget = { kind: "editor", port: 4001 };

  function lockedErr(id: number) {
    return { t: "err", id, code: "locked", text: "err:locked", language: "en" };
  }

  /** Two paired devices, sidecar proxy on (a spy `closeDevice`), both connected but not logged in. */
  async function twoDevices() {
    const closeDevice = vi.fn((_deviceId: string) => 0);
    const h = makeHarness({
      cert: certWith("configured", ["laptop.tailnet.ts.net"]),
      createProxy: () => ({ handleRequest: vi.fn(), handleUpgrade: vi.fn(), closeDevice }),
    });
    const [one, two] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone", "Laptop"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), sidecarProxy: true });
    const connect = (device: { deviceId: string; token: string } | undefined, source: string) => {
      const socket = new FakeSocket();
      const handlers = h.listenCalls[0]?.onSocket("rpc", socket, source);
      handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));
      socket.sent = [];
      return { socket, handlers, id: device?.deviceId ?? "" };
    };
    return { h, bridge, closeDevice, a: connect(one, "10.0.0.5:1"), b: connect(two, "10.0.0.6:1") };
  }

  it("a paired device opens locked: a req is refused locked, auth:status is answered", async () => {
    const { a } = await twoDevices();
    a.handlers?.onText(reqFrame(1, "projects:list"));
    a.handlers?.onText(reqFrame(2, "auth:status"));
    await flush();
    expect(a.socket.sent).toEqual([
      lockedErr(1),
      { t: "res", id: 2, v: { locked: true, hasPasskeys: false } },
    ]);
  });

  it("a wrong password is forbidden and audited login-failed, never with the password", async () => {
    const { h, a } = await twoDevices();
    const wrong = "definitely not the owner password";
    expect(await login(a.handlers, a.socket, wrong)).toMatchObject({ t: "err", code: "forbidden" });
    const lines = (await auditLines(h.fs)).join("\n");
    expect(lines).toContain(`login-failed deviceId="${a.id}"`);
    expect(lines).not.toContain(wrong);
  });

  it("after login a req passes and auth:status reports the access expiry", async () => {
    const { a } = await twoDevices();
    const answer = await login(a.handlers, a.socket);
    const tokens = answer.v as { accessExpiresAt: number };
    a.handlers?.onText(reqFrame(1, "projects:list"));
    a.handlers?.onText(reqFrame(2, "auth:status"));
    await flush();
    expect(a.socket.sent).toEqual([
      { t: "res", id: 1, v: null },
      {
        t: "res",
        id: 2,
        v: { locked: false, hasPasskeys: false, accessExpiresAt: tokens.accessExpiresAt },
      },
    ]);
  });

  it("signOutEverywhere locks every connection within 1s, keeps the sockets, drops subscriptions, tears down all sidecars and kills refresh tokens", async () => {
    const { h, bridge, closeDevice, a, b } = await twoDevices();
    const answer = await login(a.handlers, a.socket);
    await login(b.handlers, b.socket);
    a.handlers?.onText(subFrame(["metrics:update"]));
    b.handlers?.onText(subFrame(["metrics:update"]));
    expect(bridge.publishSidecar(a.id, TARGET)).toHaveProperty("url");

    const signedOut = bridge.signOutEverywhere();
    h.clock.advance(1_000);

    for (const conn of [a, b]) {
      expect(conn.socket.sent).toEqual([
        { t: "psh", ch: "auth:state", p: { locked: true, reason: "signed-out" }, seq: 1 },
      ]);
      expect(conn.socket.closed).toBeUndefined();
    }
    expect(bridge.hasSubscriber("metrics:update")).toBe(false);
    expect(new Set(closeDevice.mock.calls.map(([id]) => id))).toEqual(new Set([a.id, b.id]));
    await signedOut;

    a.socket.sent = [];
    a.handlers?.onText(reqFrame(3, "projects:list"));
    expect(a.socket.sent).toEqual([lockedErr(3)]);
    const { refreshToken } = answer.v as { refreshToken: string };
    expect(await login(a.handlers, a.socket, OWNER_TEST_PASSWORD)).toMatchObject({ t: "res" });
    a.handlers?.onText(reqFrame(4, "auth:refresh", [{ refreshToken }]));
    for (let i = 0; i < 20; i++) await flush();
    expect(a.socket.sent).toContainEqual({
      t: "err",
      id: 4,
      code: "forbidden",
      text: "err:forbidden",
      language: "en",
    });
    const lines = (await auditLines(h.fs)).join("\n");
    expect(lines).toContain("sidecars-cleared count=1");
  });

  it("a password change locks every open connection at once", async () => {
    const { bridge, a } = await twoDevices();
    await login(a.handlers, a.socket);
    await bridge.setOwnerPassword(OWNER_TEST_PASSWORD, "a brand new owner password");
    a.handlers?.onText(reqFrame(5, "projects:list"));
    expect(a.socket.sent).toEqual([
      { t: "psh", ch: "auth:state", p: { locked: true, reason: "signed-out" }, seq: 1 },
      lockedErr(5),
    ]);
  });

  it("logout locks only that connection and closes its device's sidecar sockets (proxy double)", async () => {
    const { bridge, closeDevice, a, b } = await twoDevices();
    await login(a.handlers, a.socket);
    await login(b.handlers, b.socket);
    expect(bridge.publishSidecar(a.id, TARGET)).toHaveProperty("url");

    a.handlers?.onText(reqFrame(6, "auth:logout"));
    for (let i = 0; i < 5; i++) await flush();

    expect(a.socket.sent).toEqual([
      { t: "psh", ch: "auth:state", p: { locked: true, reason: "logout" }, seq: 1 },
      { t: "res", id: 6, v: null },
    ]);
    expect(closeDevice).toHaveBeenCalledWith(a.id);
    expect(closeDevice).not.toHaveBeenCalledWith(b.id);
    b.handlers?.onText(reqFrame(7, "projects:list"));
    await flush();
    expect(b.socket.sent).toEqual([{ t: "res", id: 7, v: null }]);
  });

  it("access expiry locks the connection and tears its sidecars down", async () => {
    const { h, closeDevice, a } = await twoDevices();
    await login(a.handlers, a.socket);
    h.clock.advance(ACCESS_TTL_MS);
    expect(a.socket.sent).toContainEqual({
      t: "psh",
      ch: "auth:state",
      p: { locked: true, reason: "expired" },
      seq: 1,
    });
    expect(closeDevice).toHaveBeenCalledWith(a.id);
  });

  it("publishSidecar refuses locked for a device with no logged-in connection", async () => {
    const { bridge, a } = await twoDevices();
    expect(bridge.publishSidecar(a.id, TARGET)).toEqual({ unavailable: "locked" });
    await login(a.handlers, a.socket);
    expect(bridge.publishSidecar(a.id, TARGET)).toHaveProperty("url");
    a.handlers?.onText(reqFrame(10, "auth:logout"));
    for (let i = 0; i < 5; i++) await flush();
    expect(bridge.publishSidecar(a.id, TARGET)).toEqual({ unavailable: "locked" });
  });

  it("a refresh straddling Sign out everywhere ends locked with its family revoked", async () => {
    const { h, bridge, a } = await twoDevices();
    const answer = await login(a.handlers, a.socket);
    const { refreshToken } = answer.v as { refreshToken: string };
    const rename = h.fs.rename.bind(h.fs);
    let held = false;
    let release: () => void = () => {};
    h.fs.rename = async (from, to) => {
      if (!held && to === SESSIONS_PATH) {
        held = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return rename(from, to);
    };
    a.handlers?.onText(reqFrame(11, "auth:refresh", [{ refreshToken }]));
    for (let i = 0; i < 10; i++) await flush();
    expect(held).toBe(true);

    await bridge.signOutEverywhere();
    release();
    for (let i = 0; i < 20; i++) await flush();

    expect(a.socket.sent).toContainEqual({
      t: "err",
      id: 11,
      code: "forbidden",
      text: "err:forbidden",
      language: "en",
    });
    a.socket.sent = [];
    a.handlers?.onText(reqFrame(12, "projects:list"));
    expect(a.socket.sent).toEqual([lockedErr(12)]);
    expect(JSON.parse(h.fs.files.get(SESSIONS_PATH)?.data ?? "{}")).toEqual({
      version: 1,
      sessions: [],
    });
  });

  it("5 wrong passwords lock the device out: the 6th attempt is rate-limited and locked-out is audited", async () => {
    const { h, a } = await twoDevices();
    const wrong = "definitely not the owner password";
    for (let i = 0; i < 5; i++) {
      expect(await login(a.handlers, a.socket, wrong)).toMatchObject({ code: "forbidden" });
    }
    expect(await login(a.handlers, a.socket)).toMatchObject({ t: "err", code: "rate-limited" });
    const lines = (await auditLines(h.fs)).join("\n");
    expect(lines).toContain(`locked-out deviceId="${a.id}" scope="device" source="10.0.0.5:1"`);
    expect(h.notifyDesktop).toHaveBeenCalledExactlyOnceWith("locked-out-device", "Phone");
    expect(lines).not.toContain(wrong);
    expect(lines).not.toContain(OWNER_TEST_PASSWORD);
  });

  it("a replayed refresh token notifies the desktop and audits refresh-reuse", async () => {
    const { h, a } = await twoDevices();
    const answer = await login(a.handlers, a.socket);
    const { refreshToken } = answer.v as { refreshToken: string };
    a.handlers?.onText(reqFrame(13, "auth:refresh", [{ refreshToken }]));
    for (let i = 0; i < 10; i++) await flush();
    const rotated = a.socket.sent.find((frame) => frame.id === 13)?.v as { refreshToken: string };
    // The successor is used, so the first token is no longer a retry.
    a.handlers?.onText(reqFrame(14, "auth:refresh", [{ refreshToken: rotated.refreshToken }]));
    for (let i = 0; i < 10; i++) await flush();
    a.handlers?.onText(reqFrame(15, "auth:refresh", [{ refreshToken }]));
    for (let i = 0; i < 10; i++) await flush();
    expect(h.notifyDesktop).toHaveBeenCalledExactlyOnceWith("refresh-reuse");
    const lines = (await auditLines(h.fs)).join("\n");
    expect(lines).toContain(`refresh-reuse deviceId="${a.id}"`);
    expect(lines).not.toContain(refreshToken);
  });

  it("revoke deletes the device's refresh tokens", async () => {
    const { h, bridge, a } = await twoDevices();
    await login(a.handlers, a.socket);
    expect(h.fs.files.get(SESSIONS_PATH)?.data).toContain(a.id);
    await bridge.revoke(a.id);
    expect(h.fs.files.get(SESSIONS_PATH)?.data).not.toContain(a.id);
  });

  it("an unreadable sessions.json is sticky sessions-unreadable: never listens, never overwritten", async () => {
    const h = makeHarness();
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const read = h.fs.readFile.bind(h.fs);
    h.fs.readFile = async (path) => {
      if (path === SESSIONS_PATH) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return read(path);
    };
    const bridge = await createBridge(h.deps);
    await bridge.apply(ON_127());
    expect(h.listenCalls).toEqual([]);
    expect(bridge.status().problem).toBe("sessions-unreadable");
  });
});

describe("createBridge: passkeys (Phase 0)", () => {
  const NAME = "laptop.tailnet.ts.net";
  const ORIGIN = `https://${NAME}:8443`;

  /** Sends one request and waits for its answer, then forgets every frame sent so far. */
  async function ask(
    conn: { handlers: SessionHandlers | undefined; socket: FakeSocket },
    id: number,
    ch: string,
    args: unknown[] = [],
  ): Promise<Record<string, unknown>> {
    conn.handlers?.onText(reqFrame(id, ch, args));
    for (let i = 0; i < 200; i++) {
      const answer = conn.socket.sent.find((frame) => frame.id === id);
      if (answer !== undefined) {
        conn.socket.sent = [];
        return answer;
      }
      await flush();
    }
    throw new Error(`${ch} never answered`);
  }

  /** `web: true` turns the web listener on at port 8443 — the passkeys'
   *  origin comes only from it, never from a dependency of its own. */
  async function setup(options: { cert?: CertificateMaterial; web?: boolean } = {}) {
    const h = makeHarness({ cert: options.cert ?? certWith("configured", [NAME]) });
    const [one, two] = await seedDevices(h.fs, h.random, h.clock.now, ["Phone", "Laptop"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply({ ...ON_127(), web: { enabled: options.web ?? false, port: 8443 } });
    const connect = (device: { deviceId: string; token: string } | undefined, source: string) => {
      const socket = new FakeSocket();
      const handlers = h.listenCalls[0]?.onSocket("rpc", socket, source);
      handlers?.onText(helloFrame(device?.deviceId ?? "", device?.token ?? ""));
      socket.sent = [];
      return { socket, handlers, id: device?.deviceId ?? "" };
    };
    return { h, bridge, a: connect(one, "10.0.0.5:1"), b: connect(two, "10.0.0.6:1") };
  }

  it("answers unsupported while the web listener is off, or with a self-signed certificate", async () => {
    for (const options of [{}, { cert: certWith("self-signed", []), web: true }]) {
      const { a } = await setup(options);
      await login(a.handlers, a.socket);
      expect(await ask(a, 1, "auth:passkeyBegin")).toMatchObject({ code: "unsupported" });
      expect(
        await ask(a, 2, "auth:passkeyRegisterBegin", [{ password: OWNER_TEST_PASSWORD }]),
      ).toMatchObject({ code: "unsupported" });
    }
  });

  it("passkey ceremonies become supported once the web listener turns on", async () => {
    const { bridge, a } = await setup();
    await login(a.handlers, a.socket);
    const args = [{ password: OWNER_TEST_PASSWORD }];
    expect(await ask(a, 1, "auth:passkeyRegisterBegin", args)).toMatchObject({
      code: "unsupported",
    });
    await bridge.apply({ ...ON_127(), web: { enabled: true, port: 8443 } });
    expect(await ask(a, 2, "auth:passkeyRegisterBegin", args)).toMatchObject({
      t: "res",
      v: { challenge: expect.any(String) },
    });
  });

  it("a passkey stored across a sign-out is taken back through the full invalidation: a login made with it meanwhile dies too", async () => {
    const { h, bridge, a, b } = await setup({ web: true });
    const authenticator = softAuthenticator({ rpId: NAME, origin: ORIGIN });
    await login(a.handlers, a.socket);
    const begin = await ask(a, 1, "auth:passkeyRegisterBegin", [{ password: OWNER_TEST_PASSWORD }]);
    const { challenge } = begin.v as { challenge: string };

    // Hold the next owner.json write: the passkey sits in memory meanwhile.
    const rename = h.fs.rename;
    let release: (() => void) | undefined;
    h.fs.rename = async (from, to) => {
      if (to === OWNER_PATH && release === undefined) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return rename(from, to);
    };
    a.handlers?.onText(
      reqFrame(2, "auth:passkeyRegisterFinish", [
        { ...authenticator.register(challenge), label: "Raced" },
      ]),
    );
    for (let i = 0; i < 50 && release === undefined; i++) await flush();
    expect(release).toBeDefined();

    await bridge.signOutEverywhere();
    // Another connection logs in with the not-yet-rolled-back credential.
    const loginBegin = await ask(b, 1, "auth:passkeyBegin");
    b.handlers?.onText(
      reqFrame(2, "auth:passkeyFinish", [
        authenticator.assert((loginBegin.v as { challenge: string }).challenge),
      ]),
    );
    await flush();
    release?.();
    for (let i = 0; i < 50; i++) await flush();

    expect(a.socket.sent).toContainEqual(expect.objectContaining({ id: 2, code: "forbidden" }));
    expect(bridge.ownerStatus().passkeys).toEqual([]);
    b.socket.sent = [];
    expect(await ask(b, 3, "projects:list")).toMatchObject({ t: "err", id: 3, code: "locked" });
    const lines = (await auditLines(h.fs)).join("\n");
    expect(lines).toContain('signed-out-all reason="passkey-deleted"');
    expect(lines).not.toContain("passkey-added");
  });

  it("registers over one connection, refreshes desktop Settings, logs in with it over another, and a deleted passkey stops working", async () => {
    const { h, bridge, a, b } = await setup({ web: true });
    expect(bridge.status().web).toEqual({ kind: "on", port: 8443, origin: ORIGIN });
    const authenticator = softAuthenticator({ rpId: NAME, origin: ORIGIN });
    await login(a.handlers, a.socket);
    const versionBefore = bridge.status().ownerVersion;

    const begin = await ask(a, 1, "auth:passkeyRegisterBegin", [{ password: OWNER_TEST_PASSWORD }]);
    const { challenge } = begin.v as { challenge: string };
    expect(
      await ask(a, 2, "auth:passkeyRegisterFinish", [
        { ...authenticator.register(challenge), label: "Phone" },
      ]),
    ).toEqual({ t: "res", id: 2, v: null });

    expect(bridge.ownerStatus().passkeys).toEqual([
      { id: authenticator.credentialId, label: "Phone", createdAt: h.clock.now() },
    ]);
    expect(bridge.status().ownerVersion).toBe((versionBefore ?? 0) + 1);
    expect(h.onStatus.mock.calls.at(-1)?.[0].ownerVersion).toBe((versionBefore ?? 0) + 1);
    const lines = (await auditLines(h.fs)).join("\n");
    expect(lines).toContain(
      `passkey-added credentialPrefix="${authenticator.credentialId.slice(0, 8)}"`,
    );

    // A second, locked connection unlocks with the passkey alone.
    const loginBegin = await ask(b, 1, "auth:passkeyBegin");
    const options = loginBegin.v as { challenge: string; allowCredentials: string[] };
    expect(options.allowCredentials).toEqual([authenticator.credentialId]);
    const finish = await ask(b, 2, "auth:passkeyFinish", [authenticator.assert(options.challenge)]);
    expect(finish).toMatchObject({ t: "res", id: 2, v: { accessToken: expect.any(String) } });
    expect(await ask(b, 3, "projects:list")).toEqual({ t: "res", id: 3, v: null });

    // Deleting it locks every connection, and it can no longer log in.
    expect(await bridge.deletePasskey(authenticator.credentialId)).toBe(true);
    await flush();
    expect(b.socket.sent).toContainEqual({
      t: "psh",
      ch: "auth:state",
      p: { locked: true, reason: "signed-out" },
      seq: 1,
    });
    b.socket.sent = [];
    const retry = await ask(b, 4, "auth:passkeyBegin");
    expect(
      await ask(b, 5, "auth:passkeyFinish", [
        authenticator.assert((retry.v as { challenge: string }).challenge),
      ]),
    ).toMatchObject({ t: "err", id: 5, code: "forbidden" });
  });
});

describe("createBridge: web listener (Phase 1)", () => {
  const NAME = "laptop.tailnet.ts.net";
  const CONFIGURED = certWith("configured", [NAME]);
  const WEB_ON = (port = 7717): Parameters<Bridge["apply"]>[0] => ({
    ...ON_127(port),
    web: { enabled: true, port: port + 1 },
  });

  async function start(
    options: Parameters<typeof makeHarness>[0] = {},
    config: Parameters<Bridge["apply"]>[0] = WEB_ON(),
  ) {
    const h = makeHarness({ cert: CONFIGURED, ...options });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const bridge = await createBridge(h.deps);
    await bridge.apply(config);
    return { h, bridge };
  }

  it("with every condition met, listens beside the bridge and feeds the Origin check its origin", async () => {
    const { h, bridge } = await start();

    expect(h.webListenCalls).toEqual([
      {
        host: "127.0.0.1",
        port: 7718,
        cert: "CERT",
        key: "KEY",
        name: NAME,
        manifest: WEB_MANIFEST,
        bridgePort: 7717,
      },
    ]);
    expect(bridge.status().web).toEqual({
      kind: "on",
      port: 7718,
      origin: `https://${NAME}:7718`,
    });
    expect(h.listenCalls[0]?.webOrigin()).toBe(`https://${NAME}:7718`);
    expect(h.onStatus.mock.calls.at(-1)?.[0].web).toEqual(bridge.status().web);
  });

  it('audits a "web-listening" line with the bound port once the web listener is up', async () => {
    const { h } = await start();
    const lines = (await auditLines(h.fs)).filter((line) => line.includes("web-listening"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("web-listening port=7718");
  });

  it("an open pairing window carries the browser's pairing URL while web is on", async () => {
    const { bridge } = await start();
    await bridge.openPairing();
    const pairing = bridge.status().pairing;
    if (pairing.kind !== "open") throw new Error("expected an open window");
    const link = parsePairingUri(pairing.uri);
    if (link === undefined) throw new Error("expected a valid pairing uri");
    expect(pairing.webUri).toBe(webPairingUrl(link, 7718));
    expect(pairing.webUri).toMatch(
      new RegExp(`^https://${NAME.replaceAll(".", "\\.")}:7718/pair#v=`),
    );
  });

  it("status().devices labels a browser-paired device client web, and leaves an app's unset", async () => {
    const h = makeHarness({ cert: CONFIGURED });
    const store = createDeviceStore({
      fs: h.fs,
      path: DEVICES_PATH,
      random: h.random,
      now: h.clock.now,
      enforceFileModes: true,
    });
    await store.load();
    await store.add("Phone");
    await store.add("Chrome", "web");
    const bridge = await createBridge(h.deps);
    await bridge.apply(WEB_ON());
    const byName = new Map(bridge.status().devices.map((device) => [device.name, device]));
    expect(byName.get("Chrome")?.client).toBe("web");
    expect(byName.get("Phone")).not.toHaveProperty("client");
  });

  it("an open pairing window has no browser URL while web is off", async () => {
    const { bridge } = await start({}, ON_127());
    await bridge.openPairing();
    const pairing = bridge.status().pairing;
    if (pairing.kind !== "open") throw new Error("expected an open window");
    expect(pairing.webUri).toBeUndefined();
  });

  it("port 443 gives the origin without a port, as a browser sends it", async () => {
    const { h, bridge } = await start({}, { ...ON_127(), web: { enabled: true, port: 443 } });
    expect(bridge.status().web).toEqual({ kind: "on", port: 443, origin: `https://${NAME}` });
    expect(h.listenCalls[0]?.webOrigin()).toBe(`https://${NAME}`);
  });

  it.each<[string, Parameters<typeof makeHarness>[0], Parameters<Bridge["apply"]>[0], unknown]>([
    ["web disabled", {}, ON_127(), { kind: "off" }],
    ["bridge disabled", {}, { ...WEB_ON(), enabled: false }, { kind: "off" }],
    [
      "a self-signed certificate",
      { cert: certWith("self-signed", []) },
      WEB_ON(),
      { kind: "needs-certificate" },
    ],
    [
      "a configured certificate with no DNS name",
      { cert: certWith("configured", []) },
      WEB_ON(),
      { kind: "needs-certificate" },
    ],
    [
      "a configured certificate whose only name is a wildcard",
      { cert: certWith("configured", ["*.tailnet.ts.net"]) },
      WEB_ON(),
      { kind: "needs-certificate" },
    ],
    ["no web export", { webManifest: undefined }, WEB_ON(), { kind: "not-built" }],
    ["an unreadable web export", { webManifest: "throws" }, WEB_ON(), { kind: "not-built" }],
    [
      "the bridge's own port",
      {},
      { ...ON_127(), web: { enabled: true, port: 7717 } },
      { kind: "off", reason: "port-conflict" },
    ],
  ])("%s: no web listener, the matching web status", async (_name, options, config, expected) => {
    const { h, bridge } = await start(options, config);
    expect(h.webListenCalls).toEqual([]);
    expect(bridge.status().web).toEqual(expected);
    expect(h.listenCalls[0]?.webOrigin()).toBeUndefined();
  });

  it("no owner password: neither listener runs, web status needs-owner-password", async () => {
    const { h, bridge } = await start({ ownerPassword: false });
    expect(h.listenCalls).toEqual([]);
    expect(h.webListenCalls).toEqual([]);
    expect(bridge.status().web).toEqual({ kind: "needs-owner-password" });
  });

  it("bridge not listening (no device, no pairing window): web status off, no listener", async () => {
    const h = makeHarness({ cert: CONFIGURED });
    const bridge = await createBridge(h.deps);
    await bridge.apply(WEB_ON());
    expect(h.listenCalls).toEqual([]);
    expect(h.webListenCalls).toEqual([]);
    expect(bridge.status().web).toEqual({ kind: "off" });
  });

  it("a missing loadWebManifest or listenWeb dependency reads as not-built", async () => {
    for (const missing of ["loadWebManifest", "listenWeb"] as const) {
      const h = makeHarness({ cert: CONFIGURED });
      delete h.deps[missing];
      await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
      const bridge = await createBridge(h.deps);
      await bridge.apply(WEB_ON());
      expect(bridge.status().web).toEqual({ kind: "not-built" });
      expect(bridge.status().listening).toBeDefined();
    }
  });

  it("apply(OFF) closes the web listener before the bridge's, and the origin goes with it", async () => {
    const h = makeHarness({ cert: CONFIGURED });
    await seedDevices(h.fs, h.random, h.clock.now, ["Phone"]);
    const closeOrder: string[] = [];
    const recordClose =
      <O>(name: string, start: (options: O) => Promise<{ port: number; close(): Promise<void> }>) =>
      async (options: O) => {
        const started = await start(options);
        return {
          port: started.port,
          async close() {
            closeOrder.push(name);
            await started.close();
          },
        };
      };
    h.deps.listen = recordClose("bridge", h.deps.listen);
    h.deps.listenWeb = recordClose("web", h.deps.listenWeb as ListenWeb);
    const bridge = await createBridge(h.deps);
    await bridge.apply(WEB_ON());
    const getter = h.listenCalls[0]?.webOrigin;
    expect(getter?.()).toBe(`https://${NAME}:7718`);

    await bridge.apply({ ...WEB_ON(), enabled: false });
    expect(closeOrder).toEqual(["web", "bridge"]);
    expect(h.webListeners[0]?.closed).toBe(true);
    expect(h.listeners[0]?.closed).toBe(true);
    expect(getter?.()).toBeUndefined();
    expect(bridge.status().web).toEqual({ kind: "off" });
  });

  it("turning web off alone closes only the web listener", async () => {
    const { h, bridge } = await start();
    await bridge.apply(ON_127());
    expect(h.webListeners[0]?.closed).toBe(true);
    expect(h.listeners[0]?.closed).toBe(false);
    expect(h.listenCalls[0]?.webOrigin()).toBeUndefined();
  });

  it("re-applying the same config keeps the one web listener", async () => {
    const { h, bridge } = await start();
    await bridge.apply(WEB_ON());
    expect(h.webListenCalls).toHaveLength(1);
    expect(h.webListeners[0]?.closed).toBe(false);
  });

  it("a bridge restart on a new port restarts the web listener with the new bridgePort", async () => {
    const { h, bridge } = await start();
    await bridge.apply({ ...ON_127(9000), web: { enabled: true, port: 7718 } });
    expect(h.webListeners[0]?.closed).toBe(true);
    expect(h.webListenCalls[1]).toMatchObject({ port: 7718, bridgePort: 9000 });
    expect(bridge.status().web).toMatchObject({ kind: "on", port: 7718 });
  });

  it("stop() closes the web listener", async () => {
    const { h, bridge } = await start();
    await bridge.stop();
    expect(h.webListeners[0]?.closed).toBe(true);
    expect(bridge.status().web).toEqual({ kind: "off" });
  });

  it("idle auto-disable closes the web listener", async () => {
    const { h, bridge } = await start({}, { ...WEB_ON(), idleDisableMinutes: 1 });
    expect(bridge.status().web).toMatchObject({ kind: "on" });
    h.clock.advance(60_000);
    await flush();
    expect(h.listeners[0]?.closed).toBe(true);
    expect(h.webListeners[0]?.closed).toBe(true);
    expect(bridge.status().web).toEqual({ kind: "off" });
    expect(h.listenCalls[0]?.webOrigin()).toBeUndefined();
  });

  it("a web port bind failure leaves the bridge up, reads off/listen-failed, audits, and is retried on the next apply", async () => {
    const { h, bridge } = await start({ webListenFails: true });
    expect(bridge.status().listening).toBeDefined();
    expect(bridge.status().problem).toBeUndefined();
    expect(bridge.status().web).toEqual({ kind: "off", reason: "listen-failed" });
    expect(h.listenCalls[0]?.webOrigin()).toBeUndefined();
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("web listen failed"));
    expect((await auditLines(h.fs)).join("\n")).toContain(" error ");

    // Not retried on every unrelated reconcile...
    await bridge.openPairing();
    expect(h.webListenCalls).toHaveLength(1);
    // ...but a fresh apply tries again.
    await bridge.apply(WEB_ON());
    expect(h.webListenCalls).toHaveLength(2);
    expect(h.listeners[0]?.closed).toBe(false);
  });

  it("a web export built after the first attempt is picked up by the next apply", async () => {
    const { h, bridge } = await start({ webManifest: undefined });
    expect(bridge.status().web).toEqual({ kind: "not-built" });
    h.loadWebManifest.mockResolvedValue(WEB_MANIFEST);
    await bridge.apply(WEB_ON());
    expect(bridge.status().web).toMatchObject({ kind: "on" });
  });
});
