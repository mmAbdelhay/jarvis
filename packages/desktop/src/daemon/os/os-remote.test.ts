import type { Bridge, BridgeConfig, BridgeDeps, RemoteStatus } from "@jarvis/remote";
import { describe, expect, it } from "vitest";
import type { OsRouter } from "./os-binding.js";
import { createOsRemote, type OsRemoteDeps } from "./os-remote.js";
import { DEFAULT_OS_REMOTE, type OsRemoteConfig } from "./remote-config.js";

const CLOSED: RemoteStatus = {
  enabled: false,
  listening: undefined,
  pairing: { kind: "closed" },
  devices: [],
  problem: undefined,
  sidecarProxy: "off",
};

function harness(config: OsRemoteConfig = DEFAULT_OS_REMOTE) {
  let status: RemoteStatus = CLOSED;
  let captured: BridgeDeps | undefined;
  const applied: BridgeConfig[] = [];
  const decided: [string, boolean][] = [];
  const forwarded: [string, unknown][] = [];
  const pushes: [string, unknown][] = [];
  const writes: unknown[] = [];
  let current = config;
  const bridge = {
    apply: async (c: BridgeConfig) => {
      applied.push(c);
    },
    openPairing: async () => {
      status = {
        ...status,
        pairing: { kind: "open", uri: "jarvis://pair?s=x", expiresAt: 120_000 },
      };
      return "opened" as const;
    },
    cancelPairing: () => {},
    decidePairing: (requestId: string, approve: boolean) => {
      decided.push([requestId, approve]);
      return true;
    },
    revoke: async () => true,
    push: (channel: string, payload: unknown) => forwarded.push([channel, payload]),
    status: () => status,
    ownerStatus: () => ({ hasPassword: true, passkeys: [] }),
    setOwnerPassword: async () => ({ ok: true as const }),
    stop: async () => {},
  } as unknown as Bridge;
  const router: OsRouter = {
    invoke: async () => ({ ok: true }),
    upload: async () => ({ ok: true }),
  };
  const deps: OsRemoteDeps = {
    language: () => "en" as const,
    createBridge: async (d) => {
      captured = d;
      return bridge;
    },
    io: {} as OsRemoteDeps["io"],
    router: () => router,
    readConfig: async () => current,
    writeConfig: async (patch) => {
      writes.push(patch);
      current = { ...current, ...patch };
    },
    push: (channel, payload) => pushes.push([channel, payload]),
    log: () => {},
  };
  const remote = createOsRemote(deps);
  const setStatus = (next: RemoteStatus) => {
    status = next;
    captured?.onStatus(next);
  };
  return {
    remote,
    applied,
    decided,
    forwarded,
    pushes,
    writes,
    setStatus,
    bridgeDeps: () => captured,
  };
}

const confirming = (requestId: string, deviceName = "Pixel 8"): RemoteStatus => ({
  ...CLOSED,
  enabled: true,
  pairing: {
    kind: "confirming",
    requestId,
    deviceName,
    address: "192.168.1.20",
    expiresAt: 60_000,
  },
});

describe("createOsRemote (design §3.3)", () => {
  it("starts the bridge with the phone policy, no sidecars and no web client", async () => {
    const h = harness({ ...DEFAULT_OS_REMOTE, enabled: true });
    await h.remote.start();
    const d = h.bridgeDeps();
    if (d === undefined) throw new Error("no bridge");
    await expect(d.handle("provider:save", [], { id: "a".repeat(32), name: "P" })).resolves.toEqual(
      { kind: "forbidden" },
    );
    expect(d.blobLimit("voice:utterance")).toBe(4_194_304);
    expect(d.blobLimit("remote:uploadFile")).toBeUndefined();
    expect([...d.policies.keys()].sort()).toEqual(["agent:events", "sys:snapshot"]);
    expect(d.authorizeKey("agent:events", "k", { id: "a".repeat(32), name: "P" })).toBe(false);
    expect(h.applied[0]).toMatchObject({
      enabled: true,
      sidecarProxy: false,
      web: { enabled: false },
    });
  });

  it("shows a pairing request once as pairing:pending, and answers the one waiting", async () => {
    const h = harness();
    await h.remote.start();
    h.setStatus(confirming("r1"));
    h.setStatus(confirming("r1"));
    expect(h.pushes.filter(([c]) => c === "pairing:pending")).toEqual([
      [
        "pairing:pending",
        { requestId: "r1", deviceName: "Pixel 8", address: "192.168.1.20", expiresAt: 60_000 },
      ],
    ]);
    expect(() => h.remote.answerPairing({ requestId: "r0", approve: true })).toThrow(
      /Another phone/,
    );
    expect(h.remote.answerPairing({ requestId: "r1", approve: true })).toBeNull();
    expect(h.decided).toEqual([["r1", true]]);
    h.setStatus(CLOSED);
    expect(() => h.remote.answerPairing({ requestId: "r1", approve: false })).toThrow(/No phone/);
  });

  it("cleans a hostile pairing device name for the card", async () => {
    const h = harness();
    await h.remote.start();
    h.setStatus(confirming("r2", "Evil\u0007\nPhone"));
    expect(h.pushes.find(([c]) => c === "pairing:pending")?.[1]).toMatchObject({
      deviceName: "Evil Phone",
    });
  });

  it("forwards only agent:events and sys:snapshot to phones", async () => {
    const h = harness();
    await h.remote.start();
    h.remote.forward("agent:events", { type: "text" });
    h.remote.forward("sys:snapshot", { online: true });
    h.remote.forward("pairing:pending", { deviceName: "x" });
    h.remote.forward("provider:status", { reachable: true });
    expect(h.forwarded.map(([c]) => c)).toEqual(["agent:events", "sys:snapshot"]);
  });

  it("turns phone access on through jarvis.yaml and re-applies it", async () => {
    const h = harness();
    await h.remote.start();
    await h.remote.configure({ enabled: true, bindAddress: "0.0.0.0" });
    expect(h.writes).toEqual([{ enabled: true, bindAddress: "0.0.0.0" }]);
    expect(h.applied.at(-1)).toMatchObject({ enabled: true, bindAddress: "0.0.0.0" });
  });

  it("writes enabled: false when the bridge turns itself off for idleness", async () => {
    const h = harness({ ...DEFAULT_OS_REMOTE, enabled: true });
    await h.remote.start();
    h.bridgeDeps()?.onIdleDisabled?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.writes).toEqual([{ enabled: false }]);
  });

  it("opens a pairing window and reports the status the shell shows", async () => {
    const h = harness({ ...DEFAULT_OS_REMOTE, enabled: true });
    await h.remote.start();
    await expect(h.remote.openPairing()).resolves.toEqual({
      uri: "jarvis://pair?s=x",
      expiresAt: 120_000,
    });
    expect(h.remote.status()).toMatchObject({
      pairing: "open",
      hasOwnerPassword: true,
      listening: null,
    });
  });
});
