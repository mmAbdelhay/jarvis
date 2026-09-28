import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBroadcaster } from "../broadcast.js";
import { INVOKE_CHANNELS } from "../channels.js";
import { createDaemonBinding } from "../daemon/binding.js";
import { connectControl } from "../daemon/control/client.js";
import { nodeControlDeps } from "../daemon/control/deps.js";
import { createControlServer, type ControlServer } from "../daemon/control/server.js";
import { ELECTRON_BOUND_CHANNELS } from "../desktop-only.js";
import { DESKTOP_ORIGIN, type DispatchTable, type Handler, type Origin } from "../dispatch.js";
import type { Core } from "./compose.js";
import type { DesktopHost } from "./core-client.js";
import { faviconIntake } from "./favicon-intake.js";
import { createHostLink } from "./host-link.js";
import {
  type ConnectionState,
  connectSocketCoreClient,
  type SocketCoreClientDeps,
} from "./socket-core-client.js";
import { TabHost } from "./tab-host.js";

// The socket adapter against a real control server in a temporary run
// directory, with jarvisd's real binding in front of an in-process fake
// core: the same frames, framing and handshake main.ts will use.

const WINDOWS = process.platform === "win32";
const PLATFORM = process.platform;
const BUILD = "test-build";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Call = { channel: string; args: readonly unknown[]; origin: Origin };

function fakeCore() {
  const calls: Call[] = [];
  const answers = new Map<string, Handler>();
  const table: Record<string, Handler> = {};
  const bound: ReadonlySet<string> = new Set(ELECTRON_BOUND_CHANNELS);
  for (const channel of Object.values(INVOKE_CHANNELS)) {
    if (bound.has(channel)) continue;
    table[channel] = (args, origin) => {
      calls.push({ channel, args, origin });
      return answers.get(channel)?.(args, origin);
    };
  }
  const link = createHostLink();
  const broadcast = createBroadcaster({ toRenderer: link.toClients });
  const tabs = new TabHost();
  const config = { allowPopups: true, suspendTabsAfterMs: 60_000 };
  const lifecycle: string[] = [];
  const core: Core = {
    firstRun: true,
    hostConfig: () => ({ ...config }),
    dispatch: table as DispatchTable,
    broadcast,
    tabs,
    favicons: faviconIntake({
      put: async () => ({ ok: true, value: undefined }),
      putMiss: async () => ({ ok: true, value: undefined }),
    }),
    attachHost: (desktop) => link.attach(desktop),
    onPush: (listener) => link.onPush(listener),
    voiceControl: {
      start: () => lifecycle.push("voice:start"),
      stop: () => lifecycle.push("voice:stop"),
    },
    dbgateCredentialFor: (port) =>
      port === 5000 ? { login: "jarvis", password: "pw" } : undefined,
    startRemote: () => lifecycle.push("startRemote"),
    announceStartup: async () => {
      lifecycle.push("announceStartup");
    },
    stop: () => lifecycle.push("stop"),
    shutdown: async () => {},
  };
  return { core, calls, answers, link, tabs, config, lifecycle };
}

async function runDirectory(): Promise<string> {
  // Unix socket paths are capped near 104 bytes; macOS's tmpdir is long.
  const dir = await mkdtemp(join(WINDOWS ? tmpdir() : "/tmp", "jsc-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, "run");
}

type Daemon = {
  server: ControlServer;
  binding: ReturnType<typeof createDaemonBinding>;
  stop(): Promise<void>;
};

async function startDaemon(run: string, core: Core, build = BUILD): Promise<Daemon> {
  const binding = createDaemonBinding({
    requestStop: () => {},
    log: () => {},
    now: Date.now,
    timers: {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
      defer: (callback) => setImmediate(callback),
    },
  });
  const started = await createControlServer({
    platform: PLATFORM,
    runDirectory: run,
    build,
    handlers: binding.handlers,
    deps: nodeControlDeps(),
  });
  if (started.kind !== "started") throw new Error("control server busy");
  const unbind = binding.bind(core, started.server);
  let stopped = false;
  const daemon: Daemon = {
    server: started.server,
    binding,
    async stop() {
      if (stopped) return;
      stopped = true;
      unbind();
      await started.server.close();
    },
  };
  cleanups.push(() => daemon.stop());
  return daemon;
}

function adapterDeps(
  run: string,
  overrides: Partial<SocketCoreClientDeps> = {},
): SocketCoreClientDeps {
  return {
    connect: () =>
      connectControl({
        platform: PLATFORM,
        runDirectory: run,
        build: BUILD,
        deps: nodeControlDeps(),
      }),
    now: Date.now,
    timers: {
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
    },
    log: () => {},
    initialTimeoutMs: 0,
    hostPollMs: 20,
    ...overrides,
  };
}

async function connect(run: string, overrides: Partial<SocketCoreClientDeps> = {}) {
  const client = await connectSocketCoreClient(adapterDeps(run, overrides));
  cleanups.push(() => client.stop());
  return client;
}

function until(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() > deadline) return reject(new Error(`timed out waiting for ${what}`));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function recordingHost() {
  const seen: unknown[][] = [];
  const state = { focused: false, awake: true };
  const host: DesktopHost = {
    isFocused: () => state.focused,
    isAwake: () => state.awake,
    requestFavicon: (...args) => seen.push(["requestFavicon", ...args]),
    sweepIdleViews: () => seen.push(["sweepIdleViews"]),
    destroyViews: () => seen.push(["destroyViews"]),
    showNotification: (...args) => seen.push(["showNotification", ...args]),
    openExternal: async (url) => {
      seen.push(["openExternal", url]);
    },
    restart: () => seen.push(["restart"]),
  };
  return { host, seen, state };
}

describe("socket CoreClient: requests", () => {
  it("round-trips an invoke to the daemon's table, with the desktop origin", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    fake.answers.set("settings:read", (args) => ({ echoed: args }));
    await startDaemon(run, fake.core);
    const client = await connect(run);

    await expect(client.invoke("settings:read", ["a", { n: 1 }])).resolves.toEqual({
      echoed: ["a", { n: 1 }],
    });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.origin).toEqual(DESKTOP_ORIGIN);
    expect(fake.calls[0]?.origin).toBe(DESKTOP_ORIGIN);
    expect(client.connection()).toEqual({ kind: "connected" });
  });

  it("rejects a handler's failure with its message", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    fake.answers.set("settings:read", () => {
      throw new Error("no config");
    });
    await startDaemon(run, fake.core);
    const client = await connect(run);
    await expect(client.invoke("settings:read", [])).rejects.toThrow("no config");
  });

  it("delivers a push the core emits while handling a request before that request settles", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    fake.answers.set("settings:read", (args) => {
      const notice = (text: string) =>
        fake.core.broadcast.send("voice:notice", { text, language: "en" });
      notice(`during ${String(args[0])}`);
      setTimeout(() => notice(`after ${String(args[0])}`), 0);
      return `reply ${String(args[0])}`;
    });
    await startDaemon(run, fake.core);
    const client = await connect(run);
    const events: string[] = [];
    client.onPush((channel, payload) => {
      if (channel === "voice:notice") events.push((payload as { text: string }).text);
    });

    for (let i = 0; i < 25; i++) {
      events.push(String(await client.invoke("settings:read", [i])));
    }
    await until(() => events.filter((e) => e.startsWith("after")).length === 25, "late pushes");

    for (let i = 0; i < 25; i++) {
      // Always before its own reply; a push made after the reply, after it.
      expect(events.indexOf(`during ${i}`)).toBeLessThan(events.indexOf(`reply ${i}`));
      expect(events.indexOf(`reply ${i}`)).toBeLessThan(events.indexOf(`after ${i}`));
    }
  });

  it("forwards the lifecycle and voice calls, and answers DbGate's credential", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    await startDaemon(run, fake.core);
    const client = await connect(run);

    await expect(client.dbgateCredentialFor(5000)).resolves.toEqual({
      login: "jarvis",
      password: "pw",
    });
    await expect(client.dbgateCredentialFor(1)).resolves.toBeUndefined();
    await client.announceStartup();
    client.voice.start();
    client.voice.stop();
    client.startRemote(); // the daemon's own: nothing to forward
    await until(() => fake.lifecycle.includes("voice:stop"), "voice stop");
    expect(fake.lifecycle).toEqual(["announceStartup", "voice:start", "voice:stop"]);
    await expect(client.favicons.put("https://x.test/", "AAAA", "image/png")).resolves.toEqual({
      ok: true,
    });
  });
});

describe("socket CoreClient: synchronous reads from the cache", () => {
  it("answers firstRun, hostConfig and the tab state without a round trip, kept current by pushes", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    fake.tabs.openTerminal("acme");
    await startDaemon(run, fake.core);
    const client = await connect(run);

    expect(client.firstRun).toBe(true);
    expect(client.hostConfig()).toEqual({ allowPopups: true, suspendTabsAfterMs: 60_000 });
    expect(client.workspace.state()).toEqual(fake.tabs.state());

    const seen: unknown[] = [];
    client.workspace.onChange((state) => seen.push(state));
    const requests: unknown[] = [];
    client.workspace.onViewRequest((request) => requests.push(request));
    fake.tabs.openTerminal("beta");
    await until(() => requests.length > 0, "the view request");
    // Synchronous, and already the new state when its view request arrives.
    expect(client.workspace.state()).toEqual(fake.tabs.state());
    expect(seen.at(-1)).toEqual(fake.tabs.state());

    fake.config.allowPopups = false;
    await client.invoke("settings:save", [{}]);
    expect(client.hostConfig().allowPopups).toBe(false);
  });

  it("reports page facts, suspensions and popups back to the core's tabs", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    await startDaemon(run, fake.core);
    const client = await connect(run);
    client.workspace.open("acme", "https://example.com", "web");
    await until(() => fake.tabs.state().tabs.length === 1, "the popup tab");
    const id = fake.tabs.state().tabs[0]?.id as string;
    client.workspace.reportPage(id, { kind: "title", title: "Example" });
    await until(() => fake.tabs.state().tabs[0]?.title === "Example", "the title");
    await until(() => client.workspace.state().tabs[0]?.title === "Example", "the mirrored title");
  });
});

describe("socket CoreClient: the desktop host", () => {
  it("attaches the window, reports its focus changes, and runs the core's hooks against it", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    const daemon = await startDaemon(run, fake.core);
    const client = await connect(run);
    const { host, seen, state } = recordingHost();
    const detach = client.attachHost(host);

    await until(() => daemon.binding.daemonHost.attachedCount === 1, "the attach");
    expect(fake.link.host.isAwake()).toBe(true);
    expect(fake.link.host.isFocused()).toBe(false);
    state.focused = true;
    await until(() => fake.link.host.isFocused(), "the focus report");

    fake.link.host.requestFavicon("acme", "https://x.test");
    fake.link.host.sweepIdleViews();
    await fake.link.host.openExternal("https://web.test");
    fake.link.host.showNotification("Locked out", "body");
    await until(() => seen.length === 4, "the host hooks");
    expect(seen).toEqual([
      ["requestFavicon", "acme", "https://x.test"],
      ["sweepIdleViews"],
      ["openExternal", "https://web.test"],
      ["showNotification", "Locked out", "body"],
    ]);

    detach();
    await until(() => daemon.binding.daemonHost.attachedCount === 0, "the detach");
  });

  it("gets the alerts queued while no app was attached once it attaches", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    await startDaemon(run, fake.core);
    fake.link.host.showNotification("Reused refresh token", "b1");
    fake.link.host.showNotification("Locked out", "b2");

    const client = await connect(run);
    const { host, seen } = recordingHost();
    client.attachHost(host);
    await until(() => seen.length === 2, "the flushed alerts");
    expect(seen).toEqual([
      ["showNotification", "Reused refresh token", "b1"],
      ["showNotification", "Locked out", "b2"],
    ]);
  });
});

describe("socket CoreClient: reconnect", () => {
  it("rejects calls while disconnected, reconnects, and resyncs everything on connect", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    fake.answers.set("settings:read", () => "ok");
    const first = await startDaemon(run, fake.core);
    const client = await connect(run);
    const states: ConnectionState["kind"][] = [];
    client.onConnectionChange((state) => states.push(state.kind));
    const changes: unknown[] = [];
    client.workspace.onChange((state) => changes.push(state));
    const { host } = recordingHost();
    client.attachHost(host);
    await until(() => first.binding.daemonHost.attachedCount === 1, "the first attach");

    await first.stop();
    await until(() => client.connection().kind !== "connected", "the drop");
    await expect(client.invoke("settings:read", [])).rejects.toThrow(/not connected/);

    // What changed while the app was away arrives in the resync, not as
    // replayed pushes.
    fake.tabs.openTerminal("while-away");
    fake.config.allowPopups = false;
    const second = await startDaemon(run, fake.core);

    await until(() => client.connection().kind === "connected", "the reconnect", 8_000);
    expect(client.workspace.state()).toEqual(fake.tabs.state());
    expect(changes.at(-1)).toEqual(fake.tabs.state());
    expect(client.hostConfig().allowPopups).toBe(false);
    await expect(client.invoke("settings:read", [])).resolves.toBe("ok");
    await until(() => second.binding.daemonHost.attachedCount === 1, "the host re-attached");
    expect(states).toContain("reconnecting");
    expect(states.at(-1)).toBe("connected");
  });

  it("stop() closes this connection only and never reconnects", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    const daemon = await startDaemon(run, fake.core);
    const client = await connect(run);
    client.stop();
    expect(client.connection()).toEqual({ kind: "stopped" });
    await until(() => daemon.server.connectionCount === 0, "the close");
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(daemon.server.connectionCount).toBe(0);
    expect(fake.lifecycle).not.toContain("stop");
  });
});

describe("socket CoreClient: a daemon of another build", () => {
  it("restarts the daemon through the service manager, then connects to the new one", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    let daemon: Daemon = await startDaemon(run, fake.core, "old-build");
    let restarts = 0;
    const client = await connect(run, {
      initialTimeoutMs: 5_000,
      restartDaemon: async () => {
        restarts += 1;
        await daemon.stop();
        daemon = await startDaemon(run, fake.core, BUILD);
      },
    });
    expect(restarts).toBe(1);
    expect(client.connection()).toEqual({ kind: "connected" });
  });

  it("stops restarting after 3 in 10 minutes and says why", async () => {
    const run = await runDirectory();
    const fake = fakeCore();
    let daemon: Daemon = await startDaemon(run, fake.core, "old-build");
    let restarts = 0;
    let failed: ConnectionState | undefined;
    const attempt = connectSocketCoreClient(
      adapterDeps(run, {
        initialTimeoutMs: 20_000,
        restartDaemon: async () => {
          restarts += 1;
          // The service manager brings back the same stale build each time.
          await daemon.stop();
          daemon = await startDaemon(run, fake.core, "old-build");
        },
        log: (line) => {
          if (line.includes("not restarted again")) failed = { kind: "failed", error: line };
        },
      }),
    );
    await expect(attempt).rejects.toThrow(/not restarted again/);
    expect(restarts).toBe(3);
    expect(failed?.kind).toBe("failed");
  }, 20_000);

  it("fails at once without a way to restart the daemon", async () => {
    const run = await runDirectory();
    await startDaemon(run, fakeCore().core, "old-build");
    await expect(connectSocketCoreClient(adapterDeps(run))).rejects.toThrow(/different build/);
  });
});
