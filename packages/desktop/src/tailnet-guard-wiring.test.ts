// The guard and the bridge together, over a real `createBridge` and a real
// `createRemoteAccess`, with only the sockets, certificate and `tailscale`
// faked: the two hold separate switches and a latch, which a guard test with a
// fake `setTailnetBlock` cannot see disagreeing.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge } from "@jarvis/remote";
import { nodeFs, nodeTimers } from "@jarvis/remote/listen";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBroadcaster } from "./broadcast.js";
import { DEFAULT_REMOTE, type RemoteConfig } from "./config.js";
import type { DispatchTable } from "./dispatch.js";
import type { BlobTable } from "./remote-blob.js";
import { createRemoteAccess } from "./remote-access.js";
import { applyRemoteThenCheck, createRemoteTailnetGuard } from "./tailnet-guard-wiring.js";

const HOST = "machine.tailnet.ts.net";
const FUNNEL = {
  AllowFunnel: { [`${HOST}:443`]: true },
  Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:7717" } } } },
};

const ON: RemoteConfig = {
  ...DEFAULT_REMOTE,
  enabled: true,
  bindAddress: "100.79.83.16",
  port: 7717,
  tls: { certPath: "/tls/a.crt", keyPath: "/tls/a.key" },
  tailnet: { enabled: true, relay: false },
};
const REMOTE_OFF: RemoteConfig = { ...ON, enabled: false };
const TAILNET_OFF: RemoteConfig = { ...ON, tailnet: { enabled: false, relay: false } };

const dirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(initial: RemoteConfig) {
  const dir = await mkdtemp(join(tmpdir(), "tailnet-wiring-"));
  dirs.push(dir);
  const state = { config: initial, serve: FUNNEL as unknown, serveReads: 0 };
  const listeners: { closed: boolean }[] = [];
  const access = createRemoteAccess({
    table: () => ({}) as DispatchTable,
    blobs: () => ({}) as BlobTable,
    broadcast: createBroadcaster({ toRenderer: vi.fn() }),
    language: "en",
    createBridge,
    io: {
      dir,
      fs: nodeFs,
      random: randomBytes,
      now: Date.now,
      timers: nodeTimers,
      listen: async (options) => {
        const listener = { closed: false };
        listeners.push(listener);
        return {
          port: options.port,
          close: async () => {
            listener.closed = true;
          },
        };
      },
      loadCertificate: async () => ({
        cert: "CERT",
        key: "KEY",
        fingerprint: "ab".repeat(32),
        source: "configured" as const,
        dnsNames: [HOST],
      }),
      createProxy: () => undefined,
      enforceFileModes: false,
      ownerHashParams: { N: 2 ** 4, r: 8, p: 1 },
      hostname: () => "test-host",
      log: vi.fn(),
    },
    streams: { hasPane: () => false, hasSession: () => false, followerOwner: () => undefined },
    onDeviceDisconnected: vi.fn(),
    onDeviceRevoked: vi.fn(),
    onIdleDisabled: vi.fn(),
    showNotification: vi.fn(),
    onDeviceJoined: vi.fn(),
    fetch: vi.fn(),
  });

  const armed: (() => void)[] = [];
  const guard = createRemoteTailnetGuard({
    remote: () => state.config,
    access,
    tailscale: {
      exec: async (_command, args) => {
        if (args[0] !== "serve") return { code: 0, stdout: "", stderr: "" };
        state.serveReads += 1;
        return { code: 0, stdout: JSON.stringify(state.serve), stderr: "" };
      },
      fs: {
        access: async () => undefined,
        mkdir: async () => undefined,
        chmod: async () => undefined,
      },
      homedir: () => "/Users/x",
      platform: "linux",
    },
    certificateExpiry: async () => Date.now() + 60 * 24 * 60 * 60 * 1000,
    timers: {
      setTimeout: (callback) => {
        armed.push(callback);
        return callback;
      },
      clearTimeout: () => {},
    },
    now: Date.now,
    log: vi.fn(),
  });
  cleanups.push(async () => {
    guard.stop();
    await access.stop();
  });

  // What a settings save does: the live config first, the bridge's apply after.
  const save = async (next: RemoteConfig) => {
    state.config = next;
    await applyRemoteThenCheck(access, guard, next);
  };
  // Lets the armed poll and everything it awaits finish.
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  };

  await access.start(initial);
  await access.setOwnerPassword(undefined, "a long new password");
  return {
    state,
    access,
    guard,
    save,
    settle,
    listeners,
    tailnet: () => access.status().tailnet,
    poll: async () => {
      armed.shift()?.();
      await settle();
    },
    openListeners: () => listeners.filter((listener) => !listener.closed).length,
  };
}

describe("the guard and the bridge", () => {
  it("toggling remote.enabled with Funnel on puts the latch back", async () => {
    const h = await setup(ON);
    h.guard.start();
    await h.settle();
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "funnel" });
    expect(h.openListeners()).toBe(0);

    await h.save(REMOTE_OFF);
    expect(h.tailnet()).toEqual({ kind: "off" });

    await h.save(ON);
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "funnel" });
    expect(h.openListeners()).toBe(0);

    // And the polls after it keep agreeing.
    await h.poll();
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "funnel" });
  });

  it("toggling remote.enabled between two polls puts it back too", async () => {
    const h = await setup(ON);
    h.guard.start();
    await h.settle();

    await h.save(REMOTE_OFF);
    await h.save(ON);
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "funnel" });
  });

  it("toggling tailnet.enabled between two polls puts it back too", async () => {
    const h = await setup(ON);
    h.guard.start();
    await h.settle();

    await h.save(TAILNET_OFF);
    expect(h.tailnet()).toEqual({ kind: "off" });
    await h.save(ON);
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "funnel" });
  });

  it("remote off at startup: Funnel latches as soon as remote comes on", async () => {
    const h = await setup(REMOTE_OFF);
    h.guard.start();
    await h.settle();
    await h.poll();
    expect(h.tailnet()).toEqual({ kind: "off" });
    // The bridge's switch is the guard's: with it off, Tailscale is not asked.
    expect(h.state.serveReads).toBe(0);

    await h.save(ON);
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "funnel" });
    expect(h.openListeners()).toBe(0);
  });

  it("a poll in the gap between the save and the apply is not lost", async () => {
    const h = await setup(REMOTE_OFF);
    h.guard.start();
    await h.settle();

    // The live config says on; the bridge has not heard yet, and drops it.
    h.state.config = ON;
    await h.poll();
    expect(h.tailnet()).toEqual({ kind: "off" });

    await h.access.apply(ON);
    await h.poll();
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "funnel" });
  });

  it("with Funnel gone, re-enabling stays on", async () => {
    const h = await setup(ON);
    h.state.serve = {};
    h.guard.start();
    await h.settle();
    expect(h.tailnet()).toEqual({ kind: "on" });
    expect(h.openListeners()).toBe(1);
  });

  it("compose.ts applies through the same helper, with the guard it starts", () => {
    const compose = readFileSync(new URL("./core/compose.ts", import.meta.url), "utf8");
    expect(compose).toContain(
      "await applyRemoteThenCheck(remoteAccess, tailnetGuard, next.remote)",
    );
    expect(compose).toContain("createRemoteTailnetGuard({");
  });
});
