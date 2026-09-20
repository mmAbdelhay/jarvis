import type { AuthenticatedDevice, Bridge, BridgeDeps, RemoteStatus } from "@jarvis/remote";
import { VOICE_UPLOAD_CHANNEL, type PushRegistration } from "@jarvis/wire";
import { describe, expect, it, vi } from "vitest";
import { createBroadcaster } from "./broadcast.js";
import { createDispatchTable, type DispatchTable } from "./dispatch.js";
import { fakeDeps } from "./dispatch.test.js";
import {
  createRemoteAccess,
  remoteRequestHandler,
  type RemoteAccessDeps,
} from "./remote-access.js";
import { createBlobTable, type BlobHandler, type BlobTable } from "./remote-blob.js";
import { remotePushPolicies, type StreamOwners } from "./remote-push-policy.js";

const DEVICE: AuthenticatedDevice = { id: "d1", name: "Phone" };

const NO_BLOBS: () => BlobTable = () => ({}) as BlobTable;

const CLOSED_STATUS: RemoteStatus = {
  enabled: false,
  listening: undefined,
  pairing: { kind: "closed" },
  devices: [],
  problem: undefined,
  // M11 Task 2 minimal compile fix (Task 4 owns the real desktop wiring).
  sidecarProxy: "off",
};

describe("remoteRequestHandler", () => {
  // [bite-proof: denied policy channel refused] Dropping the isRemoteAllowed
  // check (e.g. calling table() unconditionally) fails this: the spied
  // handlers below would be invoked instead of the request being refused
  // before the table is ever touched.
  it("refuses a policy-denied channel before the table is ever touched", async () => {
    const spied = {
      "settings:restart": vi.fn(),
      "dialog:readJson": vi.fn(),
      "remote:pair": vi.fn(),
      "remote:revoke": vi.fn(),
      "remote:tailscaleCert": vi.fn(),
    };
    const table = vi.fn(() => spied as unknown as DispatchTable);
    const handler = remoteRequestHandler(table, NO_BLOBS);

    for (const channel of Object.keys(spied)) {
      expect(await handler(channel, [], DEVICE)).toEqual({ kind: "forbidden" });
    }
    expect(table).not.toHaveBeenCalled();
    for (const fn of Object.values(spied)) expect(fn).not.toHaveBeenCalled();
  });

  it("reports unknown-channel for an undeclared or prototype-shaped name", async () => {
    const handler = remoteRequestHandler(() => ({}) as unknown as DispatchTable, NO_BLOBS);
    for (const channel of ["nope:nope", "constructor", "__proto__", "toString"]) {
      expect(await handler(channel, [], DEVICE)).toEqual({ kind: "unknown-channel" });
    }
  });

  // A policy-allowed channel that somehow has no table entry must never
  // throw — Object.hasOwn on the table itself is what this proves.
  it("reports unknown-channel, not a throw, for a remote-allowed channel missing from the table", async () => {
    const handler = remoteRequestHandler(() => ({}) as unknown as DispatchTable, NO_BLOBS);
    await expect(handler("projects:list", [], DEVICE)).resolves.toEqual({
      kind: "unknown-channel",
    });
  });

  it("dispatches an allowed channel and hands the wrapped handler a remote origin", async () => {
    const deps = fakeDeps({ projects: { app: {} } });
    const table = createDispatchTable(deps);
    const handler = remoteRequestHandler(() => table, NO_BLOBS);

    const outcome = await handler("projects:list", [], DEVICE);
    expect(outcome).toEqual({ kind: "value", value: ["app"] });
  });

  // Controller note: origin is built only from the bridge's authenticated
  // `device` argument — nothing in `args` can influence it, even a payload
  // shaped like a desktop origin.
  it("builds the origin only from the authenticated device, never from args", async () => {
    let seenOrigin: unknown;
    const spyTable = {
      "projects:list": (args: readonly unknown[], origin: unknown) => {
        seenOrigin = origin;
        return args;
      },
    } as unknown as DispatchTable;
    const handler = remoteRequestHandler(() => spyTable, NO_BLOBS);

    await handler("projects:list", [{ kind: "desktop" }], DEVICE);
    expect(seenOrigin).toEqual({ kind: "remote", deviceId: "d1", deviceName: "Phone" });
  });

  it("propagates a throwing handler's rejection rather than swallowing it", async () => {
    const spyTable = {
      "projects:list": () => {
        throw new Error("boom: /secret/path");
      },
    } as unknown as DispatchTable;
    const handler = remoteRequestHandler(() => spyTable, NO_BLOBS);

    await expect(handler("projects:list", [], DEVICE)).rejects.toThrow();
  });
});

describe("remoteRequestHandler: blob gate", () => {
  it("a blob on remote:uploadAudio reaches the handler with a remote origin built from device", async () => {
    let seenArgs: readonly unknown[] | undefined;
    let seenBytes: Uint8Array | undefined;
    let seenOrigin: unknown;
    const uploadAudio: BlobHandler = vi.fn(async (args, bytes, origin) => {
      seenArgs = args;
      seenBytes = bytes;
      seenOrigin = origin;
      return { kind: "invalid", text: "x", language: "en" };
    });
    const blobs = () => createBlobTable({ uploadAudio, uploadFile: vi.fn(async () => undefined) });
    const handler = remoteRequestHandler(() => ({}) as DispatchTable, blobs);
    const bytes = new Uint8Array([1, 2, 3]);

    const outcome = await handler(VOICE_UPLOAD_CHANNEL, ["meta"], DEVICE, bytes);

    expect(outcome).toEqual({
      kind: "value",
      value: { kind: "invalid", text: "x", language: "en" },
    });
    expect(seenArgs).toEqual(["meta"]);
    expect(seenBytes).toBe(bytes);
    expect(seenOrigin).toEqual({ kind: "remote", deviceId: "d1", deviceName: "Phone" });
  });

  it("a blob on session:input is forbidden", async () => {
    const uploadAudio: BlobHandler = vi.fn(async () => undefined);
    const blobs = () => createBlobTable({ uploadAudio, uploadFile: vi.fn(async () => undefined) });
    const handler = remoteRequestHandler(() => ({}) as DispatchTable, blobs);

    const outcome = await handler("session:input", [], DEVICE, new Uint8Array([1]));

    expect(outcome).toEqual({ kind: "forbidden" });
    expect(uploadAudio).not.toHaveBeenCalled();
  });

  it("a blob on an unknown channel is unknown-channel", async () => {
    const uploadAudio: BlobHandler = vi.fn(async () => undefined);
    const blobs = () => createBlobTable({ uploadAudio, uploadFile: vi.fn(async () => undefined) });
    const handler = remoteRequestHandler(() => ({}) as DispatchTable, blobs);

    const outcome = await handler("nope", [], DEVICE, new Uint8Array([1]));

    expect(outcome).toEqual({ kind: "unknown-channel" });
  });

  // [bite-proof: drop the no-blob check (the `Object.hasOwn(blobTable,
  // channel)` branch when `blob === undefined`) and a plain `req` on
  // remote:uploadAudio falls through to the M4 path instead, where the
  // channel is absent from CHANNEL_POLICY — answering unknown-channel
  // rather than forbidden.]
  it("a req (no blob) on remote:uploadAudio is forbidden, not unknown-channel", async () => {
    const uploadAudio: BlobHandler = vi.fn(async () => undefined);
    const blobs = () => createBlobTable({ uploadAudio, uploadFile: vi.fn(async () => undefined) });
    const handler = remoteRequestHandler(() => ({}) as DispatchTable, blobs);

    const outcome = await handler(VOICE_UPLOAD_CHANNEL, [], DEVICE);

    expect(outcome).toEqual({ kind: "forbidden" });
    expect(uploadAudio).not.toHaveBeenCalled();
  });

  it("a blob one byte over maxBytes is forbidden and the handler is never called", async () => {
    const uploadAudio: BlobHandler = vi.fn(async () => undefined);
    const blobs = () => createBlobTable({ uploadAudio, uploadFile: vi.fn(async () => undefined) });
    const handler = remoteRequestHandler(() => ({}) as DispatchTable, blobs);
    const overLimit = new Uint8Array(4_194_305);

    const outcome = await handler(VOICE_UPLOAD_CHANNEL, [], DEVICE, overLimit);

    expect(outcome).toEqual({ kind: "forbidden" });
    expect(uploadAudio).not.toHaveBeenCalled();
  });
});

function fakeBridge(): { bridge: Bridge; push: ReturnType<typeof vi.fn> } {
  const push = vi.fn();
  const bridge: Bridge = {
    apply: vi.fn(async () => {}),
    openPairing: vi.fn(async () => "opened" as const),
    cancelPairing: vi.fn(),
    decidePairing: vi.fn(() => true),
    revoke: vi.fn(async () => true),
    publishSidecar: vi.fn(() => ({ unavailable: "off" as const })),
    setPushToken: vi.fn(async () => "ok" as const),
    clearPushToken: vi.fn(async () => false),
    pushTargets: vi.fn(() => []),
    recordPushQueued: vi.fn(),
    watchingDevices: vi.fn(() => new Set<string>()),
    push,
    hasSubscriber: vi.fn(() => false),
    status: vi.fn(() => CLOSED_STATUS),
    stop: vi.fn(async () => {}),
  };
  return { bridge, push };
}

function harness(overrides: Partial<RemoteAccessDeps> = {}) {
  const toRenderer = vi.fn();
  const broadcast = createBroadcaster({ toRenderer });
  const { bridge, push } = fakeBridge();
  let capturedOnStatus: ((status: RemoteStatus) => void) | undefined;
  const createBridge = vi.fn(async (deps: BridgeDeps) => {
    capturedOnStatus = deps.onStatus;
    return bridge;
  });
  const deps: RemoteAccessDeps = {
    table: () => ({}) as DispatchTable,
    blobs: NO_BLOBS,
    broadcast,
    language: "en",
    createBridge,
    io: {
      dir: "/tmp/remote",
      fs: {} as never,
      random: (() => Buffer.alloc(0)) as never,
      now: () => 0,
      timers: {} as never,
      listen: (async () => ({ port: 0, close: async () => {} })) as never,
      loadCertificate: async () => ({
        cert: "",
        key: "",
        fingerprint: "",
        source: "self-signed" as const,
        dnsNames: [],
      }),
      // M11 Task 2 minimal compile fix (Task 4 owns the real desktop wiring).
      createProxy: () => undefined,
      enforceFileModes: false,
      log: vi.fn(),
    },
    streams: {
      hasPane: () => false,
      hasSession: () => false,
      followerOwner: () => undefined,
    },
    onDeviceDisconnected: vi.fn(),
    onDeviceRevoked: vi.fn(),
    onIdleDisabled: vi.fn(),
    fetch: vi.fn(async () => ({ status: 200, json: async () => ({ data: [] }) })),
    ...overrides,
  };
  const remoteAccess = createRemoteAccess(deps);
  return {
    remoteAccess,
    toRenderer,
    broadcast,
    bridge,
    push,
    createBridge,
    emit: (status: RemoteStatus) => capturedOnStatus?.(status),
  };
}

describe("createRemoteAccess: before start", () => {
  it("returns the closed defaults without ever creating a bridge", async () => {
    const { remoteAccess, createBridge } = harness();
    expect(remoteAccess.status()).toEqual(CLOSED_STATUS);
    expect(await remoteAccess.openPairing()).toBe("unavailable");
    expect(await remoteAccess.revoke("d1")).toBe(false);
    expect(remoteAccess.decidePairing("r1", true)).toBe(false);
    remoteAccess.cancelPairing();
    expect(createBridge).not.toHaveBeenCalled();
  });

  it("stop() before start() is safe", async () => {
    const { remoteAccess } = harness();
    await expect(remoteAccess.stop()).resolves.toBeUndefined();
  });
});

const REMOTE_CONFIG = {
  enabled: true,
  bindAddress: "127.0.0.1",
  port: 0,
  sidecarProxy: false,
  tls: {},
  push: { enabled: false, includeProjectNames: false },
  idleDisableMinutes: 0,
};

describe("createRemoteAccess: bridge creation", () => {
  it("start() creates the bridge once, then applies the config", async () => {
    const { remoteAccess, createBridge, bridge } = harness();
    await remoteAccess.start(REMOTE_CONFIG);
    expect(createBridge).toHaveBeenCalledTimes(1);
    expect(bridge.apply).toHaveBeenCalledWith({
      enabled: true,
      bindAddress: "127.0.0.1",
      port: 0,
      sidecarProxy: false,
      idleDisableMinutes: 0,
      tls: {},
    });
  });

  it("concurrent start calls create the bridge exactly once", async () => {
    const { remoteAccess, createBridge } = harness();
    await Promise.all([remoteAccess.start(REMOTE_CONFIG), remoteAccess.start(REMOTE_CONFIG)]);
    expect(createBridge).toHaveBeenCalledTimes(1);
  });

  it("apply before start shares the same bridge rather than creating a second one", async () => {
    const { remoteAccess, createBridge } = harness();
    await Promise.all([remoteAccess.apply(REMOTE_CONFIG), remoteAccess.start(REMOTE_CONFIG)]);
    expect(createBridge).toHaveBeenCalledTimes(1);
  });

  // Rule 6: apply() waits for start(), rather than merely sharing its
  // bridge — so apply(B) called before start(A) still lands *after*
  // start(A)'s own initial apply, and B is what the bridge ends up
  // configured with.
  it("apply(B) called before start(A) waits for start, then applies B last", async () => {
    const { remoteAccess, createBridge, bridge } = harness();
    const configB = { ...REMOTE_CONFIG, port: 4200 };

    const applying = remoteAccess.apply(configB);
    const starting = remoteAccess.start(REMOTE_CONFIG);
    await Promise.all([applying, starting]);

    expect(createBridge).toHaveBeenCalledTimes(1);
    const applyMock = bridge.apply as ReturnType<typeof vi.fn>;
    const lastCall = applyMock.mock.calls[applyMock.mock.calls.length - 1];
    expect(lastCall?.[0]).toEqual({
      enabled: true,
      bindAddress: "127.0.0.1",
      port: 4200,
      sidecarProxy: false,
      idleDisableMinutes: 0,
      tls: {},
    });
  });
});

describe("createRemoteAccess: start() rejection unblocks apply()", () => {
  // [bite-proof] I6: reverting start()'s try/finally to a trailing
  // `resolveStarted?.()` after the awaits (so a rejection skips it
  // entirely) makes this hang instead of settling; the test's own timeout
  // is the failure signal, not a thrown assertion.
  it("a later apply() settles (rather than hanging) after createBridge rejects on start", async () => {
    const createBridge = vi.fn(async () => {
      throw new Error("bind failed");
    });
    const { remoteAccess } = harness({ createBridge });

    await expect(remoteAccess.start(REMOTE_CONFIG)).rejects.toThrow("bind failed");

    // ensureBridge() caches the rejected `creating` promise, so a later
    // apply() unblocks immediately (it no longer hangs on `started`) but
    // still surfaces the same rejection rather than silently no-op'ing —
    // callers (main.ts's writeConfig) already .catch() this.
    await expect(remoteAccess.apply(REMOTE_CONFIG)).rejects.toThrow("bind failed");
  });
});

describe("createRemoteAccess: stop during creation", () => {
  // [bite-proof] Reverting stop() to skip awaiting `creating` (or dropping
  // its `stopped` checks in start()/apply()) fails this: bridge.apply would
  // be called after stop(), and bridge.stop would never run at all since
  // `bridge` was still undefined when the old stop() ran.
  it("stop() called while the bridge is still being created stops it once ready, and start() never applies", async () => {
    const { bridge } = fakeBridge();
    let resolveCreate: ((bridge: Bridge) => void) | undefined;
    const createBridge = vi.fn(
      () =>
        new Promise<Bridge>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { remoteAccess } = harness({ createBridge });

    const starting = remoteAccess.start(REMOTE_CONFIG);
    const stopping = remoteAccess.stop();

    // createBridge only resolves now — after stop() has already run.
    resolveCreate?.(bridge);
    await Promise.all([starting, stopping]);

    expect(bridge.stop).toHaveBeenCalledTimes(1);
    expect(bridge.apply).not.toHaveBeenCalled();
  });
});

describe("createRemoteAccess: push sink lifecycle", () => {
  // [bite-proof: sink lifecycle] Deleting the `removeSink()` call in the
  // "no longer listening" branch fails this: the sink stays attached, and
  // the third `broadcast.send` would push twice instead of once.
  it("pushes once per send while listening, none while not, and still once after listening again", async () => {
    const { remoteAccess, broadcast, emit, push } = harness();
    await remoteAccess.start(REMOTE_CONFIG);

    emit({
      ...CLOSED_STATUS,
      enabled: true,
      listening: {
        host: "127.0.0.1",
        port: 4100,
        fingerprint: "ab",
        certificate: { source: "self-signed", hostname: undefined },
      },
    });
    broadcast.send("metrics:update", {} as never);
    expect(push).toHaveBeenCalledTimes(1);

    emit({ ...CLOSED_STATUS, listening: undefined });
    broadcast.send("metrics:update", {} as never);
    expect(push).toHaveBeenCalledTimes(1);

    emit({
      ...CLOSED_STATUS,
      enabled: true,
      listening: {
        host: "127.0.0.1",
        port: 4100,
        fingerprint: "ab",
        certificate: { source: "self-signed", hostname: undefined },
      },
    });
    // Idempotent: a second "still listening" status must not add a second sink.
    emit({
      ...CLOSED_STATUS,
      enabled: true,
      listening: {
        host: "127.0.0.1",
        port: 4100,
        fingerprint: "ab",
        certificate: { source: "self-signed", hostname: undefined },
      },
    });
    broadcast.send("metrics:update", {} as never);
    expect(push).toHaveBeenCalledTimes(2);
  });

  it("always broadcasts remote:update locally, to the renderer alone", async () => {
    const { remoteAccess, toRenderer, broadcast, emit } = harness();
    await remoteAccess.start(REMOTE_CONFIG);
    const sink = vi.fn();
    broadcast.addSink(sink);

    emit({ ...CLOSED_STATUS, enabled: true });

    expect(toRenderer).toHaveBeenCalledWith("remote:update", expect.anything());
    expect(sink).not.toHaveBeenCalled();
  });

  it("stop() removes the sink", async () => {
    const { remoteAccess, broadcast, emit, push } = harness();
    await remoteAccess.start(REMOTE_CONFIG);
    emit({
      ...CLOSED_STATUS,
      enabled: true,
      listening: {
        host: "127.0.0.1",
        port: 4100,
        fingerprint: "ab",
        certificate: { source: "self-signed", hostname: undefined },
      },
    });

    await remoteAccess.stop();
    broadcast.send("metrics:update", {} as never);
    expect(push).not.toHaveBeenCalled();
  });
});

describe("createRemoteAccess: bridge deps", () => {
  it("passes remotePushPolicies() and the streams authoriser, and forwards onDeviceDisconnected", async () => {
    let captured: BridgeDeps | undefined;
    const { bridge } = fakeBridge();
    const createBridge = vi.fn(async (bridgeDeps: BridgeDeps) => {
      captured = bridgeDeps;
      return bridge;
    });
    const streams: StreamOwners = {
      hasPane: (k) => k === "known-pane",
      hasSession: () => false,
      followerOwner: () => undefined,
    };
    const onDeviceDisconnected = vi.fn();
    const { remoteAccess } = harness({ createBridge, streams, onDeviceDisconnected });

    await remoteAccess.start(REMOTE_CONFIG);

    expect(captured).toBeDefined();
    expect([...(captured?.policies ?? new Map())]).toEqual([...remotePushPolicies()]);
    expect(captured?.authorizeKey("terminal:data", "known-pane", DEVICE)).toBe(true);
    expect(captured?.authorizeKey("terminal:data", "unknown-pane", DEVICE)).toBe(false);

    captured?.onDeviceDisconnected("d1");
    expect(onDeviceDisconnected).toHaveBeenCalledWith("d1");
  });

  it("the bridge's blobLimit returns 4194304 for remote:uploadAudio and undefined otherwise", async () => {
    let captured: BridgeDeps | undefined;
    const { bridge } = fakeBridge();
    const createBridge = vi.fn(async (bridgeDeps: BridgeDeps) => {
      captured = bridgeDeps;
      return bridge;
    });
    const blobs = () =>
      createBlobTable({
        uploadAudio: vi.fn(async () => undefined),
        uploadFile: vi.fn(async () => undefined),
      });
    const { remoteAccess } = harness({ createBridge, blobs });

    await remoteAccess.start(REMOTE_CONFIG);

    expect(captured?.blobLimit(VOICE_UPLOAD_CHANNEL)).toBe(4_194_304);
    expect(captured?.blobLimit("session:input")).toBeUndefined();
    expect(captured?.blobLimit("__proto__")).toBeUndefined();
  });

  // M12 Task 3, rule 9.
  it("the bridge's auditPolicy classifies a mutate channel, an input channel, a read channel, and a blob channel over the current blob table", async () => {
    let captured: BridgeDeps | undefined;
    const { bridge } = fakeBridge();
    const createBridge = vi.fn(async (bridgeDeps: BridgeDeps) => {
      captured = bridgeDeps;
      return bridge;
    });
    const blobs = () =>
      createBlobTable({
        uploadAudio: vi.fn(async () => undefined),
        uploadFile: vi.fn(async () => undefined),
      });
    const { remoteAccess } = harness({ createBridge, blobs });

    await remoteAccess.start(REMOTE_CONFIG);

    expect(captured?.auditPolicy("git:commit")).toBe("always");
    expect(captured?.auditPolicy("session:input")).toBe("first-per-key");
    expect(captured?.auditPolicy("projects:list")).toBe("never");
    expect(captured?.auditPolicy(VOICE_UPLOAD_CHANNEL)).toBe("always");
    expect(captured?.auditPolicy("__proto__")).toBe("never");
  });
});

describe("createRemoteAccess: recordPushQueued", () => {
  it("is a no-op before the bridge exists", () => {
    const { remoteAccess } = harness();
    expect(() => remoteAccess.recordPushQueued("d1", "session-done")).not.toThrow();
  });

  it("delegates to the bridge once it exists", async () => {
    const { remoteAccess, bridge } = harness();
    await remoteAccess.start(REMOTE_CONFIG);

    remoteAccess.recordPushQueued("d1", "session-done");

    expect(bridge.recordPushQueued).toHaveBeenCalledWith("d1", "session-done");
  });
});

describe("createRemoteAccess: hasSubscriber", () => {
  it("is false before start", () => {
    const { remoteAccess } = harness();
    expect(remoteAccess.hasSubscriber("metrics:update")).toBe(false);
  });

  it("delegates to the bridge once started", async () => {
    const { remoteAccess, bridge } = harness();
    await remoteAccess.start(REMOTE_CONFIG);
    (bridge.hasSubscriber as ReturnType<typeof vi.fn>).mockReturnValue(true);

    expect(remoteAccess.hasSubscriber("metrics:update")).toBe(true);
  });
});

describe("createRemoteAccess: revoke", () => {
  it("calls onDeviceRevoked only once the bridge itself reports the revoke ok", async () => {
    const onDeviceRevoked = vi.fn();
    const { remoteAccess, bridge } = harness({ onDeviceRevoked });
    await remoteAccess.start(REMOTE_CONFIG);
    (bridge.revoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(true);

    const ok = await remoteAccess.revoke("d1");

    expect(ok).toBe(true);
    expect(onDeviceRevoked).toHaveBeenCalledWith("d1");
    expect(onDeviceRevoked).toHaveBeenCalledTimes(1);
  });

  // [bite-proof: calling onDeviceRevoked unconditionally rather than only
  // when the bridge reports `ok` — this fails if that guard is dropped.]
  it("never calls onDeviceRevoked when the bridge reports the revoke failed", async () => {
    const onDeviceRevoked = vi.fn();
    const { remoteAccess, bridge } = harness({ onDeviceRevoked });
    await remoteAccess.start(REMOTE_CONFIG);
    (bridge.revoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);

    const ok = await remoteAccess.revoke("d1");

    expect(ok).toBe(false);
    expect(onDeviceRevoked).not.toHaveBeenCalled();
  });
});

describe("createRemoteAccess: publishSidecar", () => {
  const LISTENING_WITH_HOSTNAME = {
    host: "127.0.0.1",
    port: 7717,
    fingerprint: "ab",
    certificate: { source: "configured" as const, hostname: "mac.tail.ts.net" },
  };

  it("is not-listening before any bridge exists", () => {
    const { remoteAccess } = harness();
    expect(
      remoteAccess.publishSidecar("d1", { kind: "editor", url: "http://127.0.0.1:4321/" }),
    ).toEqual({ ok: false, reason: "not-listening" });
  });

  // [bite-proof: accept any hostname; the 10.0.0.1 row fails]
  it.each([
    ["http://10.0.0.1:1/", "not 127.0.0.1"],
    ["https://127.0.0.1:1/", "not http:"],
    ["http://localhost:1/", "not the 127.0.0.1 literal"],
  ] as const)("rejects %s as bad-target (%s)", async (url, _why) => {
    const { remoteAccess } = harness();
    await remoteAccess.start(REMOTE_CONFIG);
    expect(remoteAccess.publishSidecar("d1", { kind: "editor", url })).toEqual({
      ok: false,
      reason: "bad-target",
    });
  });

  it("composes the editor URL: the sidecar's own path+query after /s/<handle>, k appended to the query", async () => {
    const { remoteAccess, bridge } = harness();
    (bridge.publishSidecar as ReturnType<typeof vi.fn>).mockReturnValue({ url: "/s/h/?k=k" });
    (bridge.status as ReturnType<typeof vi.fn>).mockReturnValue({
      ...CLOSED_STATUS,
      listening: LISTENING_WITH_HOSTNAME,
    });
    await remoteAccess.start(REMOTE_CONFIG);

    const result = remoteAccess.publishSidecar("d1", {
      kind: "editor",
      url: "http://127.0.0.1:4321/?folder=%2Fp",
    });

    expect(bridge.publishSidecar).toHaveBeenCalledWith("d1", { kind: "editor", port: 4321 });
    expect(result).toEqual({
      ok: true,
      url: "https://mac.tail.ts.net:7717/s/h/?folder=%2Fp&k=k",
    });
  });

  it("composes the Headlamp URL: no query on the sidecar side, the fragment kept verbatim and last", async () => {
    const { remoteAccess, bridge } = harness();
    (bridge.publishSidecar as ReturnType<typeof vi.fn>).mockReturnValue({ url: "/s/h/?k=k" });
    (bridge.status as ReturnType<typeof vi.fn>).mockReturnValue({
      ...CLOSED_STATUS,
      listening: LISTENING_WITH_HOSTNAME,
    });
    await remoteAccess.start(REMOTE_CONFIG);

    const result = remoteAccess.publishSidecar("d1", {
      kind: "cluster",
      url: "http://127.0.0.1:5000/#/c/x",
    });

    expect(result).toEqual({ ok: true, url: "https://mac.tail.ts.net:7717/s/h/?k=k#/c/x" });
  });

  it("composes the DbGate URL and forwards basicAuth to the bridge, never in the URL", async () => {
    const { remoteAccess, bridge } = harness();
    (bridge.publishSidecar as ReturnType<typeof vi.fn>).mockReturnValue({ url: "/s/h/?k=k" });
    (bridge.status as ReturnType<typeof vi.fn>).mockReturnValue({
      ...CLOSED_STATUS,
      listening: LISTENING_WITH_HOSTNAME,
    });
    await remoteAccess.start(REMOTE_CONFIG);

    const result = remoteAccess.publishSidecar("d1", {
      kind: "database",
      url: "http://127.0.0.1:3000/",
      basicAuth: { login: "u", password: "p" },
    });

    expect(bridge.publishSidecar).toHaveBeenCalledWith("d1", {
      kind: "database",
      port: 3000,
      basicAuth: { login: "u", password: "p" },
    });
    expect(result).toEqual({ ok: true, url: "https://mac.tail.ts.net:7717/s/h/?k=k" });
  });

  // Review round 1, M1: an empty handle or key from the registry's own
  // answer must refuse the publish, never silently compose
  // `https://host:port/s//…?k=`.
  it.each([
    ["empty handle", "/s//?k=k"],
    ["empty key", "/s/h/?k="],
  ] as const)("refuses a publish whose registry URL has %s", async (_why, registryUrl) => {
    const { remoteAccess, bridge } = harness();
    (bridge.publishSidecar as ReturnType<typeof vi.fn>).mockReturnValue({ url: registryUrl });
    (bridge.status as ReturnType<typeof vi.fn>).mockReturnValue({
      ...CLOSED_STATUS,
      listening: LISTENING_WITH_HOSTNAME,
    });
    await remoteAccess.start(REMOTE_CONFIG);

    expect(
      remoteAccess.publishSidecar("d1", { kind: "editor", url: "http://127.0.0.1:1000/" }),
    ).toEqual({ ok: false, reason: "not-listening" });
  });

  it.each(["off", "not-listening", "unknown-device"] as const)(
    "maps the bridge's %s 1:1",
    async (reason) => {
      const { remoteAccess, bridge } = harness();
      (bridge.publishSidecar as ReturnType<typeof vi.fn>).mockReturnValue({ unavailable: reason });
      await remoteAccess.start(REMOTE_CONFIG);

      expect(
        remoteAccess.publishSidecar("d1", { kind: "editor", url: "http://127.0.0.1:1000/" }),
      ).toEqual({ ok: false, reason });
    },
  );

  // Defence-in-depth (review round 1, M2): distinct from the `it.each`
  // above, which covers the bridge's own 1:1 `unavailable` mapping. Here
  // the bridge itself answers a *success* — `{ url }`, never `unavailable`
  // — but `status().listening.certificate.hostname` is undefined anyway
  // (self-signed, or a certificate with no DNS SAN). This should never
  // happen on a correctly wired bridge (bridge.ts's own gate guarantees a
  // successful `{ url }` only when the served certificate is configured
  // with a hostname) — this test exists to pin remote-access.ts's own
  // fallback for exactly that "should never happen" case.
  it("is needs-certificate when the bridge answers a URL but its own listening record has no hostname", async () => {
    const { remoteAccess, bridge } = harness();
    (bridge.publishSidecar as ReturnType<typeof vi.fn>).mockReturnValue({ url: "/s/h/?k=k" });
    (bridge.status as ReturnType<typeof vi.fn>).mockReturnValue({
      ...CLOSED_STATUS,
      listening: {
        host: "127.0.0.1",
        port: 7717,
        fingerprint: "ab",
        certificate: { source: "self-signed" as const, hostname: undefined },
      },
    });
    await remoteAccess.start(REMOTE_CONFIG);

    expect(
      remoteAccess.publishSidecar("d1", { kind: "editor", url: "http://127.0.0.1:1000/" }),
    ).toEqual({ ok: false, reason: "needs-certificate" });
  });
});

describe("createRemoteAccess: sidecarProxy reaches the bridge config", () => {
  it("forwards config.sidecarProxy through toBridgeConfig's apply()", async () => {
    const { remoteAccess, bridge } = harness();
    await remoteAccess.start({ ...REMOTE_CONFIG, sidecarProxy: true });
    expect(bridge.apply).toHaveBeenCalledWith(expect.objectContaining({ sidecarProxy: true }));
  });
});

describe("createRemoteAccess: idleDisableMinutes reaches the bridge config", () => {
  it.each([0, 30])(
    "forwards config.idleDisableMinutes=%d through toBridgeConfig's apply()",
    async (idleDisableMinutes) => {
      const { remoteAccess, bridge } = harness();
      await remoteAccess.start({ ...REMOTE_CONFIG, idleDisableMinutes });
      expect(bridge.apply).toHaveBeenCalledWith(expect.objectContaining({ idleDisableMinutes }));
    },
  );
});

describe("createRemoteAccess: onIdleDisabled", () => {
  it("passes deps.onIdleDisabled to the bridge factory, and calling it invokes the dep exactly once", async () => {
    let captured: BridgeDeps | undefined;
    const { bridge } = fakeBridge();
    const createBridge = vi.fn(async (bridgeDeps: BridgeDeps) => {
      captured = bridgeDeps;
      return bridge;
    });
    const onIdleDisabled = vi.fn();
    const { remoteAccess } = harness({ createBridge, onIdleDisabled });

    await remoteAccess.start(REMOTE_CONFIG);

    expect(captured?.onIdleDisabled).toBeDefined();
    captured?.onIdleDisabled?.();
    expect(onIdleDisabled).toHaveBeenCalledTimes(1);
  });
});

// M10 Task 4: the sender's home in remote-access.ts.
type ScheduledTimer = { id: number; at: number; fn: () => void };

function fakePushTimers(start = 0) {
  let time = start;
  let nextId = 1;
  const scheduled = new Map<number, ScheduledTimer>();
  const timers = {
    setTimeout(fn: () => void, ms: number): unknown {
      const id = nextId++;
      scheduled.set(id, { id, at: time + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown): void {
      scheduled.delete(handle as number);
    },
  };
  function advance(ms: number): void {
    const target = time + ms;
    for (;;) {
      let due: ScheduledTimer | undefined;
      for (const candidate of scheduled.values()) {
        if (candidate.at > target) continue;
        if (
          due === undefined ||
          candidate.at < due.at ||
          (candidate.at === due.at && candidate.id < due.id)
        ) {
          due = candidate;
        }
      }
      if (due === undefined) break;
      scheduled.delete(due.id);
      time = due.at;
      due.fn();
    }
    time = target;
  }
  return { timers, now: () => time, advance };
}

/** Lets whatever microtask chain a fake timer's callback kicked off
 *  (fetch -> json -> processing) actually settle before assertions run. */
async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

const REGISTRATION: PushRegistration = {
  token: "ExponentPushToken[abcdefgh12345678]",
  platform: "ios",
  language: "en",
};

function pushMessage(to: string): {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: "default";
  priority: "high";
  channelId: string;
  ttl: number;
} {
  return {
    to,
    title: "Jarvis",
    body: "test",
    data: { kind: "reply" },
    sound: "default",
    priority: "high",
    channelId: "jarvis",
    ttl: 1800,
  };
}

describe("createRemoteAccess: pushSettings/registerPush/unregisterPush", () => {
  it("registerPush before the bridge exists answers the same failure shape, without touching a store", async () => {
    const { remoteAccess } = harness();

    const result = await remoteAccess.registerPush("d1", REGISTRATION);

    expect(result).toEqual({
      registered: false,
      text: expect.any(String),
      language: "en",
    });
  });

  it("unregisterPush before the bridge exists is a no-op", async () => {
    const { remoteAccess } = harness();
    await expect(remoteAccess.unregisterPush("d1")).resolves.toBeUndefined();
  });

  it("pushSettings defaults to disabled before any apply, then tracks the last applied config", async () => {
    const { remoteAccess } = harness();
    expect(remoteAccess.pushSettings()).toEqual({ enabled: false, includeProjectNames: false });

    await remoteAccess.start(REMOTE_CONFIG);
    expect(remoteAccess.pushSettings()).toEqual({ enabled: false, includeProjectNames: false });

    await remoteAccess.apply({
      ...REMOTE_CONFIG,
      push: { enabled: true, includeProjectNames: true },
    });
    expect(remoteAccess.pushSettings()).toEqual({ enabled: true, includeProjectNames: true });
  });

  it("registerPush's laptopEnabled reflects pushSettings().enabled: false before apply, true after", async () => {
    const { remoteAccess, bridge } = harness();
    (bridge.setPushToken as ReturnType<typeof vi.fn>).mockResolvedValue("ok" as const);
    await remoteAccess.start(REMOTE_CONFIG);

    expect(await remoteAccess.registerPush("d1", REGISTRATION)).toEqual({
      registered: true,
      laptopEnabled: false,
    });

    await remoteAccess.apply({
      ...REMOTE_CONFIG,
      push: { enabled: true, includeProjectNames: false },
    });

    expect(await remoteAccess.registerPush("d1", REGISTRATION)).toEqual({
      registered: true,
      laptopEnabled: true,
    });
  });

  it.each(["unknown-device", "write-failed"] as const)(
    "registerPush maps the bridge's %s to the same registered:false failure shape",
    async (outcome) => {
      const { remoteAccess, bridge } = harness();
      (bridge.setPushToken as ReturnType<typeof vi.fn>).mockResolvedValue(outcome);
      await remoteAccess.start(REMOTE_CONFIG);

      const result = await remoteAccess.registerPush("d1", REGISTRATION);
      expect(result).toEqual({ registered: false, text: expect.any(String), language: "en" });
    },
  );

  it("unregisterPush forwards to bridge.clearPushToken(deviceId, 'unregistered') and ignores the result", async () => {
    const { remoteAccess, bridge } = harness();
    await remoteAccess.start(REMOTE_CONFIG);

    await remoteAccess.unregisterPush("d1");

    expect(bridge.clearPushToken).toHaveBeenCalledWith("d1", "unregistered");
  });

  it("pushTargets/watchingDevices are empty before the bridge exists, and forward once it does", async () => {
    const { remoteAccess, bridge } = harness();
    expect(remoteAccess.pushTargets()).toEqual([]);
    expect(remoteAccess.watchingDevices("terminal:data", "p1")).toEqual(new Set());

    await remoteAccess.start(REMOTE_CONFIG);
    const targets = [
      { deviceId: "d1", token: "t1", platform: "ios" as const, language: "en" as const },
    ];
    (bridge.pushTargets as ReturnType<typeof vi.fn>).mockReturnValue(targets);
    (bridge.watchingDevices as ReturnType<typeof vi.fn>).mockReturnValue(new Set(["d1"]));

    expect(remoteAccess.pushTargets()).toBe(targets);
    expect(remoteAccess.watchingDevices("terminal:data", "p1")).toEqual(new Set(["d1"]));
    expect(bridge.watchingDevices).toHaveBeenCalledWith("terminal:data", "p1");
  });
});

describe("createRemoteAccess: sendPush", () => {
  // [bite-proof: enqueue regardless of pushSettings().enabled; this fails]
  it("never calls fetch while push is disabled", async () => {
    const { timers, now, advance } = fakePushTimers();
    const fetchFn = vi.fn(async () => ({ status: 200, json: async () => ({ data: [] }) }));
    const { remoteAccess } = harness({
      fetch: fetchFn,
      io: {
        dir: "/tmp/remote",
        fs: {} as never,
        random: (() => Buffer.alloc(0)) as never,
        now,
        timers: timers as never,
        listen: (async () => ({ port: 0, close: async () => {} })) as never,
        loadCertificate: async () => ({
          cert: "",
          key: "",
          fingerprint: "",
          source: "self-signed" as const,
          dnsNames: [],
        }),
        createProxy: () => undefined,
        enforceFileModes: false,
        log: vi.fn(),
      },
    });
    await remoteAccess.start(REMOTE_CONFIG);

    remoteAccess.sendPush([pushMessage("t1")]);
    advance(1000);
    await flushMicrotasks();

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends one fetch after the flush once push is enabled", async () => {
    const { timers, now, advance } = fakePushTimers();
    const fetchFn = vi.fn(async () => ({
      status: 200,
      json: async () => ({ data: [{ status: "ok", id: "r1" }] }),
    }));
    const { remoteAccess } = harness({
      fetch: fetchFn,
      io: {
        dir: "/tmp/remote",
        fs: {} as never,
        random: (() => Buffer.alloc(0)) as never,
        now,
        timers: timers as never,
        listen: (async () => ({ port: 0, close: async () => {} })) as never,
        loadCertificate: async () => ({
          cert: "",
          key: "",
          fingerprint: "",
          source: "self-signed" as const,
          dnsNames: [],
        }),
        createProxy: () => undefined,
        enforceFileModes: false,
        log: vi.fn(),
      },
    });
    await remoteAccess.start({
      ...REMOTE_CONFIG,
      push: { enabled: true, includeProjectNames: false },
    });

    remoteAccess.sendPush([pushMessage("t1")]);
    advance(1000);
    await flushMicrotasks();

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  // [bite-proof: onUnregistered clearing every device rather than the one
  // that owns the token; this fails]
  it("a DeviceNotRegistered ticket clears only the device that owns that token", async () => {
    const { timers, now, advance } = fakePushTimers();
    const fetchFn = vi.fn(async () => ({
      status: 200,
      json: async () => ({
        data: [{ status: "error", details: { error: "DeviceNotRegistered" } }],
      }),
    }));
    const log = vi.fn();
    const { remoteAccess, bridge } = harness({
      fetch: fetchFn,
      io: {
        dir: "/tmp/remote",
        fs: {} as never,
        random: (() => Buffer.alloc(0)) as never,
        now,
        timers: timers as never,
        listen: (async () => ({ port: 0, close: async () => {} })) as never,
        loadCertificate: async () => ({
          cert: "",
          key: "",
          fingerprint: "",
          source: "self-signed" as const,
          dnsNames: [],
        }),
        createProxy: () => undefined,
        enforceFileModes: false,
        log,
      },
    });
    (bridge.pushTargets as ReturnType<typeof vi.fn>).mockReturnValue([
      { deviceId: "d1", token: "dead-token", platform: "ios", language: "en" },
      { deviceId: "d2", token: "other-token", platform: "android", language: "ar" },
    ]);
    await remoteAccess.start({
      ...REMOTE_CONFIG,
      push: { enabled: true, includeProjectNames: false },
    });

    remoteAccess.sendPush([pushMessage("dead-token")]);
    advance(1000);
    await flushMicrotasks();

    expect(bridge.clearPushToken).toHaveBeenCalledWith("d1", "not-registered");
    expect(bridge.clearPushToken).not.toHaveBeenCalledWith("d2", "not-registered");
    for (const call of log.mock.calls) {
      expect(String(call[0])).not.toContain("dead-token");
    }
  });

  it("stop() calls sender.stop() before bridge.stop(), and a queued message never sends after", async () => {
    const { timers, now, advance } = fakePushTimers();
    const fetchFn = vi.fn(async () => ({ status: 200, json: async () => ({ data: [] }) }));
    const { remoteAccess, bridge } = harness({
      fetch: fetchFn,
      io: {
        dir: "/tmp/remote",
        fs: {} as never,
        random: (() => Buffer.alloc(0)) as never,
        now,
        timers: timers as never,
        listen: (async () => ({ port: 0, close: async () => {} })) as never,
        loadCertificate: async () => ({
          cert: "",
          key: "",
          fingerprint: "",
          source: "self-signed" as const,
          dnsNames: [],
        }),
        createProxy: () => undefined,
        enforceFileModes: false,
        log: vi.fn(),
      },
    });
    await remoteAccess.start({
      ...REMOTE_CONFIG,
      push: { enabled: true, includeProjectNames: false },
    });

    remoteAccess.sendPush([pushMessage("t1")]);
    await remoteAccess.stop();

    advance(1000);
    await flushMicrotasks();

    expect(fetchFn).not.toHaveBeenCalled();
    expect(bridge.stop).toHaveBeenCalledTimes(1);
  });
});
