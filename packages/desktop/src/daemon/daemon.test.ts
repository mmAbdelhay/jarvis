import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createBroadcaster } from "../broadcast.js";
import { INVOKE_CHANNELS, PUSH_CHANNELS } from "../channels.js";
import type { Core } from "../core/compose.js";
import { faviconIntake } from "../core/favicon-intake.js";
import { createHostLink } from "../core/host-link.js";
import { TabHost } from "../core/tab-host.js";
import { ELECTRON_BOUND_CHANNELS } from "../desktop-only.js";
import { DESKTOP_ORIGIN, type DispatchTable, type Handler, type Origin } from "../dispatch.js";
import { DAEMON_EXIT, parseDaemonArgs } from "./args.js";
import { createDaemonBinding, HOST_CONFIG_POLL_MS } from "./binding.js";
import { formatBuildId, readBuildId } from "./build-id.js";
import type { ControlConnection } from "./control/server.js";
import { createDaemonHost, MAX_QUEUED_ALERTS } from "./daemon-host.js";
import { takeDaemonEnv } from "./env.js";
import { CORE_STOP_TIMEOUT_MS, createShutdown } from "./lifecycle.js";
import { createDaemonLog, type LogFs, scrubSecrets } from "./log-file.js";
import { DAEMON_PUSHES, DAEMON_REQUESTS } from "./protocol.js";
import { createRestartGuard } from "./restart-guard.js";
import { daemonScriptPath } from "./script-path.js";

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
    firstRun: false,
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
    voiceControl: { start: () => lifecycle.push("voice:start"), stop: () => {} },
    dbgateCredentialFor: () => undefined,
    startRemote: () => lifecycle.push("startRemote"),
    reapplyRemote: async () => {
      lifecycle.push("reapplyRemote");
    },
    setDaemonEnabled: async (enabled: boolean) => {
      lifecycle.push(`setDaemonEnabled ${enabled}`);
    },
    announceStartup: async () => {},
    stop: () => lifecycle.push("stop"),
    shutdown: async () => {
      lifecycle.push("shutdown");
    },
  };
  return { core, calls, answers, link, tabs, config, lifecycle };
}

function connectionDouble(id = 1) {
  const closers: Array<() => void> = [];
  const connection: ControlConnection = { id, onClose: (listener) => closers.push(listener) };
  return {
    connection,
    close: () => {
      for (const listener of closers.splice(0)) listener();
    },
  };
}

function bindingDouble(options: { supervised?: boolean } = {}) {
  const pushes: Array<[string, unknown]> = [];
  const direct: Array<[number, string, unknown]> = [];
  const deferred: Array<() => void> = [];
  const intervals: Array<() => void> = [];
  const requestStop = vi.fn();
  const requestRestart = vi.fn();
  const logs: string[] = [];
  const infos: string[] = [];
  const binding = createDaemonBinding({
    requestStop,
    ...(options.supervised === true ? { requestRestart } : {}),
    log: (line) => logs.push(line),
    info: (line) => infos.push(line),
    now: () => 1000,
    instance: "run-1",
    timers: {
      setInterval: (callback) => intervals.push(callback),
      clearInterval: () => {},
      defer: (callback) => deferred.push(callback),
    },
  });
  const fake = fakeCore();
  binding.bind(fake.core, {
    push: (channel, payload) => pushes.push([channel, payload]),
    pushTo: (id, channel, payload) => direct.push([id, channel, payload]),
  });
  // Settings' Restart, as dispatch.ts wires it: settings.restart → host.restart.
  fake.answers.set("settings:restart", () => fake.link.host.restart());
  return {
    binding,
    pushes,
    direct,
    deferred,
    intervals,
    requestStop,
    requestRestart,
    logs,
    infos,
    ...fake,
  };
}

describe("daemon channels", () => {
  it("never share a name with an invoke or push channel the app already uses", () => {
    const taken = new Set<string>([
      ...Object.values(INVOKE_CHANNELS),
      ...Object.values(PUSH_CHANNELS),
    ]);
    for (const channel of Object.values(INVOKE_CHANNELS)) {
      expect(channel.startsWith("daemon:")).toBe(false);
    }
    for (const channel of [...Object.values(DAEMON_REQUESTS), ...Object.values(DAEMON_PUSHES)]) {
      expect(taken.has(channel)).toBe(false);
    }
    for (const channel of Object.values(DAEMON_REQUESTS)) {
      expect(channel.startsWith("daemon:")).toBe(true);
    }
  });
});

describe("daemon binding: dispatch", () => {
  it("runs every dispatch-table request with DESKTOP_ORIGIN and the args as sent", async () => {
    const { binding, calls, answers } = bindingDouble();
    answers.set("settings:read", () => ({ theme: "dark" }));
    const { connection } = connectionDouble();

    const result = await binding.handlers.invoke("settings:read", ["a", { b: 1 }], connection);

    expect(result).toEqual({ theme: "dark" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.channel).toBe("settings:read");
    expect(calls[0]?.args).toEqual(["a", { b: 1 }]);
    expect(calls[0]?.origin).toBe(DESKTOP_ORIGIN);
  });

  it("refuses a channel the table doesn't own, prototype names included, and runs nothing", async () => {
    const { binding, calls } = bindingDouble();
    const { connection } = connectionDouble();
    for (const channel of ["nope:nope", "constructor", "__proto__", "workspace:showView"]) {
      await expect(binding.handlers.invoke(channel, [], connection)).rejects.toMatchObject({
        code: "unknown-channel",
      });
    }
    expect(calls).toEqual([]);
  });

  it("waits for the core rather than failing a request that arrives before bind", async () => {
    const binding = createDaemonBinding({
      requestStop: () => {},
      log: () => {},
      info: () => {},
      now: () => 0,
      timers: { setInterval: () => 0, clearInterval: () => {}, defer: () => {} },
    });
    const { core, answers } = fakeCore();
    answers.set("settings:read", () => "late");
    const early = binding.handlers.invoke("settings:read", [], connectionDouble().connection);
    binding.bind(core, { push: () => {}, pushTo: () => {} });
    await expect(early).resolves.toBe("late");
  });

  it("refuses uploads: no blob channel is served on the control socket", async () => {
    const { binding } = bindingDouble();
    await expect(
      binding.handlers.upload("x:y", [], new Uint8Array(1), connectionDouble().connection),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("pushes hostConfig when a request changed it, and on the poll", async () => {
    const { binding, pushes, config, intervals } = bindingDouble();
    const { connection } = connectionDouble();
    await binding.handlers.invoke("settings:read", [], connection);
    expect(pushes.filter(([channel]) => channel === DAEMON_PUSHES.hostConfig)).toEqual([]);

    config.allowPopups = false;
    await binding.handlers.invoke("settings:save", [{}], connection);
    expect(pushes.filter(([channel]) => channel === DAEMON_PUSHES.hostConfig)).toEqual([
      [DAEMON_PUSHES.hostConfig, { allowPopups: false, suspendTabsAfterMs: 60_000 }],
    ]);

    config.suspendTabsAfterMs = 0;
    expect(intervals).toHaveLength(1);
    intervals[0]?.();
    expect(pushes.filter(([channel]) => channel === DAEMON_PUSHES.hostConfig)).toHaveLength(2);
    expect(HOST_CONFIG_POLL_MS).toBe(2_000);
  });

  it("relays core pushes and versioned tab state to the control clients, in order", () => {
    const { pushes, core, tabs } = bindingDouble();
    core.broadcast.send("voice:speaking", true);
    tabs.openTerminal("acme");
    const channels = pushes.map(([channel]) => channel);
    expect(channels[0]).toBe("voice:speaking");
    expect(channels).toContain(DAEMON_PUSHES.tabs);
    expect(channels).toContain(DAEMON_PUSHES.viewRequest);
    const versions = pushes
      .filter(([channel]) => channel === DAEMON_PUSHES.tabs)
      .map(([, payload]) => (payload as { version: number; instance: string }).version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("answers daemon:stop first and starts the stop after the reply", async () => {
    const { binding, deferred, requestStop, logs, infos } = bindingDouble();
    await expect(
      binding.handlers.invoke(DAEMON_REQUESTS.stop, [], connectionDouble().connection),
    ).resolves.toEqual({ stopping: true });
    expect(requestStop).not.toHaveBeenCalled();
    for (const run of deferred) run();
    expect(requestStop).toHaveBeenCalledOnce();
    // A stop that was asked for is routine: info, not error (review minor 4).
    expect(infos).toEqual(["stop requested over the control socket"]);
    expect(logs).toEqual([]);
  });

  it("stops on a hello's intent stop, after the answer is queued, logged at info", () => {
    const { binding, deferred, requestStop, logs, infos } = bindingDouble();
    binding.handlers.stop();
    expect(requestStop).not.toHaveBeenCalled();
    for (const run of deferred) run();
    expect(requestStop).toHaveBeenCalledOnce();
    expect(infos).toEqual(["stop requested over the control socket"]);
    expect(logs).toEqual([]);
  });

  it("lets the app broadcast only the host's own notices", async () => {
    const { binding, pushes } = bindingDouble();
    const { connection } = connectionDouble();
    await binding.handlers.invoke(
      DAEMON_REQUESTS.broadcast,
      ["voice:hotkeys", { start: "x" }],
      connection,
    );
    expect(pushes).toContainEqual(["voice:hotkeys", { start: "x" }]);
    await expect(
      binding.handlers.invoke(DAEMON_REQUESTS.broadcast, ["remote:update", {}], connection),
    ).rejects.toMatchObject({ code: "bad-request" });
  });

  it("detaches an app's host when its connection closes", async () => {
    const { binding } = bindingDouble();
    const { connection, close } = connectionDouble(7);
    await binding.handlers.invoke(
      DAEMON_REQUESTS.attachHost,
      [{ focused: true, awake: true }],
      connection,
    );
    expect(binding.daemonHost.attachedCount).toBe(1);
    expect(binding.daemonHost.host.isFocused()).toBe(true);
    close();
    expect(binding.daemonHost.attachedCount).toBe(0);
    expect(binding.daemonHost.host.isFocused()).toBe(false);
  });
});

describe("daemon host: security alerts", () => {
  function hostDouble() {
    const pushes: Array<[string, unknown]> = [];
    const logs: string[] = [];
    let clock = 0;
    const daemonHost = createDaemonHost({
      push: (channel, payload) => pushes.push([channel, payload]),
      pushTo: () => {},
      initiator: () => undefined,
      log: (line) => logs.push(line),
      now: () => ++clock,
    });
    return { daemonHost, pushes, logs };
  }

  it("queues at most 20 alerts with no app attached, dropping the oldest, and logs titles only", () => {
    const { daemonHost, pushes, logs } = hostDouble();
    for (let i = 1; i <= 25; i++)
      daemonHost.host.showNotification(`title ${i}`, `secret body ${i}`);

    expect(pushes).toEqual([]);
    const queued = daemonHost.queuedAlerts();
    expect(queued).toHaveLength(MAX_QUEUED_ALERTS);
    expect(queued[0]?.title).toBe("title 6");
    expect(queued.at(-1)?.title).toBe("title 25");
    expect(logs).toHaveLength(25);
    expect(logs.join("\n")).not.toContain("body");
  });

  it("flushes the queue, in order, to the next app that attaches, then pushes live", () => {
    const { daemonHost, pushes } = hostDouble();
    daemonHost.host.showNotification("one", "b1");
    daemonHost.host.showNotification("two", "b2");
    daemonHost.attach(3, { focused: false, awake: true });

    expect(
      pushes.map(([channel, payload]) => [channel, (payload as { title: string }).title]),
    ).toEqual([
      [DAEMON_PUSHES.alert, "one"],
      [DAEMON_PUSHES.alert, "two"],
    ]);
    expect(daemonHost.queuedAlerts()).toEqual([]);

    daemonHost.host.showNotification("three", "b3");
    expect(pushes).toHaveLength(3);
    expect(pushes[2]?.[1]).toMatchObject({ title: "three", body: "b3" });

    // A second app attaching later gets nothing twice.
    daemonHost.attach(4, { focused: false, awake: false });
    expect(pushes).toHaveLength(3);
  });

  it("forwards host hooks to an attached app and refuses what needs one when none is", async () => {
    const { daemonHost, pushes, logs } = hostDouble();
    await expect(daemonHost.host.openExternal("https://x.test")).rejects.toThrow(/No desktop app/);
    daemonHost.host.requestFavicon("p", "https://x.test");
    daemonHost.host.sweepIdleViews();
    daemonHost.host.destroyViews();
    expect(pushes).toEqual([]);
    expect(logs).toEqual([]);

    daemonHost.attach(1, { focused: false, awake: false });
    await daemonHost.host.openExternal("https://x.test");
    daemonHost.host.requestFavicon("p", "https://x.test");
    daemonHost.host.sweepIdleViews();
    daemonHost.host.destroyViews();
    expect(pushes.map(([channel]) => channel)).toEqual([
      DAEMON_PUSHES.openExternal,
      DAEMON_PUSHES.requestFavicon,
      DAEMON_PUSHES.sweepIdleViews,
    ]);
  });

  it("answers focus and visibility from what the attached apps report", () => {
    const { daemonHost } = hostDouble();
    expect(daemonHost.host.isAwake()).toBe(false);
    daemonHost.attach(1, { focused: false, awake: true });
    expect(daemonHost.host.isAwake()).toBe(true);
    daemonHost.report(1, { focused: true, awake: false });
    expect(daemonHost.host.isFocused()).toBe(true);
    expect(daemonHost.host.isAwake()).toBe(false);
    daemonHost.report(2, { focused: true, awake: true }); // never attached: ignored
    expect(daemonHost.host.isAwake()).toBe(false);
  });
});

describe("graceful stop", () => {
  function steps(overrides: { stopCore?: () => Promise<void> } = {}) {
    const order: string[] = [];
    const timers: Array<() => void> = [];
    const shutdown = createShutdown({
      stopCore:
        overrides.stopCore ??
        (async () => {
          order.push("core");
        }),
      closeControl: async () => {
        order.push("control");
      },
      exit: (code) => order.push(`exit ${code}`),
      log: (line) => order.push(`log ${line}`),
      timers: {
        setTimeout: (callback) => timers.push(callback),
        clearTimeout: () => {},
      },
    });
    return { shutdown, order, timers };
  }

  it("stops the core, then the control socket (and its lock), then exits 0", async () => {
    const { shutdown, order } = steps();
    await shutdown.stop("SIGTERM");
    expect(order.filter((step) => !step.startsWith("log"))).toEqual(["core", "control", "exit 0"]);
  });

  it("exits with the restart code when the stop is a restart", async () => {
    const { shutdown, order } = steps();
    await shutdown.stop("restart", DAEMON_EXIT.restart);
    expect(order.filter((step) => !step.startsWith("log"))).toEqual(["core", "control", "exit 75"]);
  });

  it("is idempotent: a second signal changes nothing", async () => {
    const { shutdown, order } = steps();
    const first = shutdown.stop("SIGTERM");
    const second = shutdown.stop("SIGINT");
    await Promise.all([first, second]);
    expect(order.filter((step) => step === "exit 0")).toHaveLength(1);
    expect(order).not.toContain("log stopping (SIGINT)");
  });

  it("still releases the lock and exits 0 when the core's stop fails", async () => {
    const { shutdown, order } = steps({
      stopCore: async () => {
        throw new Error("boom");
      },
    });
    await shutdown.stop("daemon:stop");
    expect(order).toContain("log [shutdown] core failed: boom");
    expect(order.slice(-3).filter((step) => !step.startsWith("log"))).toEqual([
      "control",
      "exit 0",
    ]);
  });

  it("moves on when the core's stop hangs past its timeout", async () => {
    const { shutdown, order, timers } = steps({ stopCore: () => new Promise(() => {}) });
    const done = shutdown.stop("SIGTERM");
    await Promise.resolve();
    timers[0]?.();
    await done;
    expect(order).toContain(
      `log [shutdown] core did not finish in ${CORE_STOP_TIMEOUT_MS} ms; going on`,
    );
    expect(order.at(-1)).toBe("exit 0");
  });

  it("the core stops the bridge, awaited, then the sidecars, then the ptys", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../core/compose.ts", import.meta.url)),
      "utf8",
    );
    const release = source.slice(source.indexOf("const releaseChildren = (): void => {"));
    const at = (needle: string) => {
      const index = release.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const bridge = at(`safely("remote bridge"`);
    for (const sidecar of [`safely("code-server"`, `safely("dbgate"`, `safely("headlamp-server"`]) {
      expect(at(sidecar)).toBeGreaterThan(bridge);
      expect(at(sidecar)).toBeLessThan(at(`safely("shells"`));
    }
    const shutdown = source.slice(source.indexOf("async shutdown() {"));
    expect(shutdown.indexOf("await stopRemote();")).toBeGreaterThan(-1);
    expect(shutdown.indexOf("await stopRemote();")).toBeLessThan(
      shutdown.indexOf("releaseChildren();"),
    );
  });
});

describe("restart guard", () => {
  it("allows 3 restarts in 10 minutes, then refuses until the window moves on", () => {
    let now = 0;
    const guard = createRestartGuard({ now: () => now });
    expect([guard.allow(), guard.allow(), guard.allow()]).toEqual([true, true, true]);
    now = 9 * 60_000;
    expect(guard.allow()).toBe(false);
    now = 10 * 60_000; // all three have left the window
    expect([guard.allow(), guard.allow(), guard.allow(), guard.allow()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe("daemon command line", () => {
  it("runs in the foreground by default and refuses what it doesn't know", () => {
    expect(parseDaemonArgs([])).toEqual({ kind: "run" });
    expect(parseDaemonArgs(["run"])).toEqual({ kind: "run" });
    expect(parseDaemonArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseDaemonArgs(["status"])).toMatchObject({ kind: "error" });
    expect(parseDaemonArgs(["run", "extra"])).toMatchObject({ kind: "error" });
    expect(DAEMON_EXIT.busy).toBe(3);
  });
});

describe("build id", () => {
  it("is the version, the commit and the build time — or dev when there's no stamp", () => {
    expect(
      formatBuildId({ version: "0.1.4", commit: "abc123", builtAt: "2026-09-28T00:00:00Z" }),
    ).toBe("0.1.4+abc123.2026-09-28T00:00:00Z");
    expect(formatBuildId({ version: "0.1.4", builtAt: "t" })).toBe("0.1.4+nogit.t");
    expect(readBuildId("x", () => '{"version":"1.0.0","builtAt":"t"}')).toBe("1.0.0+nogit.t");
    expect(
      readBuildId("x", () => {
        throw new Error("ENOENT");
      }),
    ).toBe("dev");
    expect(readBuildId("x", () => '{"version":1}')).toBe("dev");
    expect(formatBuildId({ version: "v".repeat(300), builtAt: "t" })).toHaveLength(256);
  });
});

describe("daemon script path", () => {
  it("is inside app.asar when packaged and beside main.js in development", () => {
    expect(
      daemonScriptPath({
        platform: "darwin",
        packaged: true,
        resourcesPath: "/R",
        distSrcDir: "/ignored",
      }),
    ).toBe("/R/app.asar/dist/src/daemon-main.js");
    expect(
      daemonScriptPath({
        platform: "linux",
        packaged: false,
        resourcesPath: "",
        distSrcDir: "/repo/dist/src",
      }),
    ).toBe("/repo/dist/src/daemon-main.js");
  });

  it("joins with Windows separators on Windows, whatever the host", () => {
    expect(
      daemonScriptPath({
        platform: "win32",
        packaged: true,
        resourcesPath: "C:\\Program Files\\Jarvis\\resources",
        distSrcDir: "C:\\ignored",
      }),
    ).toBe("C:\\Program Files\\Jarvis\\resources\\app.asar\\dist\\src\\daemon-main.js");
    expect(
      daemonScriptPath({
        platform: "win32",
        packaged: false,
        resourcesPath: "",
        distSrcDir: "C:\\repo\\dist\\src",
      }),
    ).toBe("C:\\repo\\dist\\src\\daemon-main.js");
  });
});

describe("daemon log", () => {
  function memoryLogFs() {
    const files = new Map<string, string>();
    const fs: LogFs = {
      mkdir: () => {},
      append: (path, text) => files.set(path, (files.get(path) ?? "") + text),
      size: (path) => (files.has(path) ? Buffer.byteLength(files.get(path) ?? "") : undefined),
      rename: (from, to) => {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
      },
    };
    return { fs, files };
  }

  it("rotates to .1 once a line would pass the cap", () => {
    const { fs, files } = memoryLogFs();
    const log = createDaemonLog({ path: "/l/jarvisd.log", now: () => 0, fs, maxBytes: 100 });
    log.write("info", "x".repeat(40)); // each line is ~72 bytes with its prefix
    log.write("info", "y".repeat(40));
    expect(files.get("/l/jarvisd.log.1")).toContain("x".repeat(40));
    expect(files.get("/l/jarvisd.log")).toContain("y".repeat(40));
    expect(files.get("/l/jarvisd.log")).not.toContain("x".repeat(40));
  });

  it("keeps one line per write and no secrets", () => {
    const { fs, files } = memoryLogFs();
    const log = createDaemonLog({ path: "/l/jarvisd.log", now: () => 0, fs });
    const hex = "ab".repeat(32);
    log.write("error", `token=${hex}\nsecond line Bearer abc.def password: hunter2hunter2`);
    const written = files.get("/l/jarvisd.log") ?? "";
    expect(written.split("\n").filter(Boolean)).toHaveLength(1);
    expect(written).not.toContain(hex);
    expect(written).not.toContain("abc.def");
    expect(written).not.toContain("hunter2");
  });

  it("leaves ordinary lines alone", () => {
    const line = "remote bridge: listening on 127.0.0.1:7717 for project acme-web (tab-12)";
    expect(scrubSecrets(line)).toBe(line);
    expect(scrubSecrets("x".repeat(60))).toBe("x".repeat(60));
  });
});

describe("daemon restart (Settings' Restart in daemon mode)", () => {
  it("under a service manager: tells every client it is restarting, then exits for a restart", async () => {
    const { binding, pushes, direct, deferred, requestRestart, requestStop } = bindingDouble({
      supervised: true,
    });
    const asker = connectionDouble(5);
    await binding.handlers.invoke(
      DAEMON_REQUESTS.attachHost,
      [{ focused: true, awake: true }],
      asker.connection,
    );
    await binding.handlers.invoke(
      DAEMON_REQUESTS.attachHost,
      [{ focused: false, awake: true }],
      connectionDouble(6).connection,
    );

    await binding.handlers.invoke("settings:restart", [], asker.connection);

    expect(pushes.filter(([channel]) => channel === DAEMON_PUSHES.restarting)).toHaveLength(1);
    // Only the app that asked may relaunch; never a broadcast.
    expect(pushes.filter(([channel]) => channel === DAEMON_PUSHES.restart)).toEqual([]);
    expect(direct).toEqual([[5, DAEMON_PUSHES.restart, null]]);
    // After the reply: the restart is deferred.
    expect(requestRestart).not.toHaveBeenCalled();
    for (const run of deferred) run();
    expect(requestRestart).toHaveBeenCalledOnce();
    expect(requestStop).not.toHaveBeenCalled();
  });

  it("without one: asks the app that asked to have jarvisd restarted by hand, and doesn't exit", async () => {
    const { binding, pushes, direct, deferred, requestRestart, requestStop, logs } =
      bindingDouble();
    await binding.handlers.invoke("settings:restart", [], connectionDouble(9).connection);

    expect(pushes.filter(([channel]) => channel === DAEMON_PUSHES.restarting)).toEqual([]);
    expect(direct).toEqual([
      [9, DAEMON_PUSHES.restart, null],
      [9, DAEMON_PUSHES.restartManual, null],
    ]);
    for (const run of deferred) run();
    expect(requestRestart).not.toHaveBeenCalled();
    expect(requestStop).not.toHaveBeenCalled();
    expect(logs.some((line) => line.includes("restart jarvisd manually"))).toBe(true);
  });

  it("uses exit code 75", () => {
    expect(DAEMON_EXIT.restart).toBe(75);
  });
});

describe("daemon environment", () => {
  it("takes ELECTRON_RUN_AS_NODE and the supervisor marker out, so no child inherits them", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/bin",
      ELECTRON_RUN_AS_NODE: "1",
      JARVISD_SUPERVISOR: "launchd",
    };
    expect(takeDaemonEnv(env)).toEqual({ supervisor: "launchd" });
    expect(env).toEqual({ PATH: "/bin" });
    expect(takeDaemonEnv({ JARVISD_SUPERVISOR: "cron" })).toEqual({});
    expect(takeDaemonEnv({ JARVISD_SUPERVISOR: "systemd" })).toEqual({ supervisor: "systemd" });
  });
});
