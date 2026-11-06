// The guard and the bridge together, over a real `createBridge` and a real
// `createRemoteAccess`, with only the sockets, certificate and `tailscale`
// faked: the two hold separate switches and a latch, which a guard test with a
// fake `setTailnetBlock` cannot see disagreeing.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

type ExecResult = { code: number; stdout: string; stderr: string };

async function setup(
  initial: RemoteConfig,
  options: { startBridge?: boolean; devices?: string[] } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), "tailnet-wiring-"));
  dirs.push(dir);
  if (options.devices !== undefined) {
    const devices = options.devices.map((name, index) => ({
      id: String(index).padStart(32, "0"),
      name,
      salt: "0".repeat(32),
      hash: "0".repeat(128),
      pairedAt: 0,
    }));
    await writeFile(join(dir, "devices.json"), JSON.stringify({ version: 1, devices }));
  }
  const state = {
    config: initial,
    serve: FUNNEL as unknown,
    serveReads: 0,
    failListens: 0,
    selfIps: undefined as string[] | undefined,
  };
  let heldRead: Promise<ExecResult> | undefined;
  const listeners: { closed: boolean }[] = [];
  const makeAccess = () =>
    createRemoteAccess({
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
          if (state.failListens > 0) {
            state.failListens -= 1;
            throw new Error("EADDRNOTAVAIL");
          }
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

  // The owner password goes in first, over a bridge with the switch off, so
  // the apply a test watches is the machine's real first one.
  const prepare = makeAccess();
  await prepare.start(TAILNET_OFF);
  await prepare.setOwnerPassword(undefined, "a long new password");
  await prepare.stop();
  listeners.length = 0;

  const access = makeAccess();
  const armed: (() => void)[] = [];
  const guard = createRemoteTailnetGuard({
    remote: () => state.config,
    access,
    tailscale: {
      exec: async (_command, args) => {
        if (args[0] === "status" && state.selfIps !== undefined) {
          const Self = { TailscaleIPs: state.selfIps };
          return { code: 0, stdout: JSON.stringify({ Self }), stderr: "" };
        }
        if (args[0] !== "serve") return { code: 0, stdout: "", stderr: "" };
        state.serveReads += 1;
        if (heldRead !== undefined) {
          const held = heldRead;
          heldRead = undefined;
          return held;
        }
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

  if (options.startBridge !== false) await access.start(initial);
  return {
    state,
    holdServeRead: () => {
      let answer: (result: ExecResult) => void = () => {};
      heldRead = new Promise<ExecResult>((resolve) => {
        answer = resolve;
      });
      return { answer };
    },
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

  describe("booting with the switch on", () => {
    /** Starts a machine with a read of Tailscale that has not answered. */
    async function bootWithHeldRead(devices: string[]) {
      const h = await setup(ON, { startBridge: false, devices });
      const read = h.holdServeRead();
      const starting = h.access.start(ON);
      h.guard.start();
      await starting;
      await h.settle();
      return { h, read };
    }

    it("Funnel exposed: no join and no listener, before the read or after", async () => {
      const { h, read } = await bootWithHeldRead([]);
      expect(h.tailnet()).toEqual({ kind: "blocked", reason: "unverified" });
      expect(h.listeners).toHaveLength(0);

      read.answer({ code: 0, stdout: JSON.stringify(FUNNEL), stderr: "" });
      await h.settle();

      expect(h.tailnet()).toEqual({ kind: "blocked", reason: "funnel" });
      expect(h.listeners).toHaveLength(0);
    });

    it("a paired machine with Funnel exposed never opens either", async () => {
      const { h, read } = await bootWithHeldRead(["Phone"]);
      expect(h.listeners).toHaveLength(0);

      read.answer({ code: 0, stdout: JSON.stringify(FUNNEL), stderr: "" });
      await h.settle();

      expect(h.listeners).toHaveLength(0);
    });

    it("nothing exposed: the read's answer opens it", async () => {
      const { h, read } = await bootWithHeldRead([]);

      read.answer({ code: 0, stdout: "{}", stderr: "" });
      await h.settle();

      expect(h.tailnet()).toEqual({ kind: "on" });
      expect(h.openListeners()).toBe(1);
    });

    it("a failed read: no joins; a paired device connects, an unpaired machine stays shut", async () => {
      for (const [devices, open] of [
        [["Phone"], 1],
        [[], 0],
      ] as const) {
        const { h, read } = await bootWithHeldRead([...devices]);

        read.answer({ code: 1, stdout: "", stderr: "tailscaled is down" });
        await h.settle();

        expect(h.tailnet()).toEqual({ kind: "blocked", reason: "unverified" });
        expect(h.openListeners()).toBe(open);
      }
    });

    it("a later good read recovers, after failed ones", async () => {
      const { h, read } = await bootWithHeldRead([]);
      read.answer({ code: 1, stdout: "", stderr: "down" });
      await h.settle();

      h.state.serve = {};
      await h.poll();

      expect(h.tailnet()).toEqual({ kind: "on" });
      expect(h.openListeners()).toBe(1);
    });
  });

  it("the switch coming on by a hand edit waits for the read before anything opens", async () => {
    const h = await setup(TAILNET_OFF);
    h.state.serve = {};
    h.guard.start();
    await h.settle();

    const read = h.holdServeRead();
    const saving = h.save(ON);
    await h.settle();
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "unverified" });
    expect(h.openListeners()).toBe(0);

    read.answer({ code: 0, stdout: "{}", stderr: "" });
    await saving;
    expect(h.tailnet()).toEqual({ kind: "on" });
  });

  it("a boot before Tailscale has its address recovers on its own", async () => {
    const h = await setup(ON);
    h.state.serve = {};
    h.state.selfIps = [];
    h.guard.start();
    await h.settle();
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "bad-bind" });
    expect(h.openListeners()).toBe(0);

    h.state.selfIps = [ON.bindAddress];
    await h.poll();

    expect(h.tailnet()).toEqual({ kind: "on" });
    expect(h.openListeners()).toBe(1);
  });

  it("a listen that failed at boot comes up on a later poll", async () => {
    const h = await setup(ON);
    h.state.serve = {};
    h.state.failListens = 2; // The first poll's verdict and its own retry.
    h.guard.start();
    await h.settle();
    expect(h.access.status().problem).toBe("listen-failed");
    expect(h.openListeners()).toBe(0);

    await h.poll();

    expect(h.access.status().problem).toBeUndefined();
    expect(h.openListeners()).toBe(1);
  });

  it("with the switch off a failed listen is left for the usual events", async () => {
    const h = await setup(ON);
    h.state.serve = {};
    h.state.failListens = 2; // The first poll's verdict and its own retry.
    h.guard.start();
    await h.settle();
    expect(h.access.status().problem).toBe("listen-failed");

    h.state.failListens = 0;
    h.state.config = TAILNET_OFF;
    await h.poll();

    expect(h.access.status().problem).toBe("listen-failed");
    expect(h.openListeners()).toBe(0);
  });

  it("a transition the guard never saw cannot stay stuck, with the same verdict as last sent", async () => {
    const h = await setup(ON);
    h.state.serve = {};
    h.guard.start();
    await h.settle();
    expect(h.tailnet()).toEqual({ kind: "on" });

    // Off and on again straight to the bridge: no checkNow, and the guard's
    // last verdict is the one the next read gives.
    await h.access.apply(TAILNET_OFF);
    await h.access.apply(ON);
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "unverified" });

    await h.poll();
    expect(h.tailnet()).toEqual({ kind: "on" });
  });

  it("relay on: never reads on before the forwards are confirmed", async () => {
    const RELAY: RemoteConfig = {
      ...ON,
      bindAddress: "127.0.0.1",
      tailnet: { enabled: true, relay: true },
    };
    const h = await setup(RELAY);
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "unverified" });

    h.state.serve = {};
    h.guard.start();
    await h.settle();
    expect(h.tailnet()).toEqual({ kind: "blocked", reason: "relay-missing" });
    expect(h.openListeners()).toBe(0);
  });

  it("compose.ts applies through the same helper, with the guard it starts", () => {
    const compose = readFileSync(new URL("./core/compose.ts", import.meta.url), "utf8");
    expect(compose).toContain(
      "await applyRemoteThenCheck(remoteAccess, tailnetGuard, next.remote)",
    );
    expect(compose).toContain("createRemoteTailnetGuard({");
  });
});
