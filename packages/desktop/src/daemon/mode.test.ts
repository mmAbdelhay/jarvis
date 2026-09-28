import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../core/socket-core-client.js";
import {
  createDaemonMode,
  type DaemonLink,
  daemonSettingWriter,
  type DaemonModeDeps,
  IN_APP_FLAG,
  relaunchArgs,
  SOCKET_WAIT_MS,
  STARTED_STOP_WAIT_MS,
  STOP_WAIT_MS,
} from "./mode.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../messages.js";
import type { ServiceStatus } from "./service.js";

type FakeLink = DaemonLink & { state: ConnectionState; name: string };

function fakeLink(events: string[], name = "link"): FakeLink {
  const link: FakeLink = {
    name,
    state: { kind: "connected" },
    info: async () => ({ pid: 4242, startedAt: 1_000 }),
    reapplyRemote: async () => {
      events.push("reapplyRemote");
    },
    setDaemonEnabled: async (enabled) => {
      if (link.state.kind !== "connected") throw new Error("The Jarvis daemon is not connected");
      events.push(`daemon writes ${enabled}`);
    },
    connection: () => link.state,
    stop: () => {
      events.push("link.stop");
      link.state = { kind: "stopped" };
    },
  };
  return link;
}

type Options = {
  enabled?: boolean;
  installStarts?: boolean;
  serviceStatus?: ServiceStatus;
  /** One answer per connect() call, in order: a link, or an error. */
  connects?: Array<"ok" | Error>;
  controlSocket?: boolean;
  confirm?: boolean;
  fallback?: "in-app" | "quit";
  /** How many polls the daemon keeps answering after a stop. */
  answersFor?: number;
  uninstallFails?: boolean;
  useInProcessFails?: boolean;
  /** Writes go through daemonSettingWriter to the last link, as main.ts's. */
  routeWrites?: boolean;
  /** The installed service names another binary (a moved app). */
  stale?: boolean | Error;
};

function harness(options: Options = {}) {
  const events: string[] = [];
  let time = 10_000;
  let enabled = options.enabled ?? false;
  let answers = options.answersFor ?? 0;
  const connects = [...(options.connects ?? ["ok"])];
  const links: FakeLink[] = [];
  const controlSocket = options.controlSocket ?? false;
  const record = (name: string) => async (): Promise<undefined> => {
    events.push(name);
    return undefined;
  };
  const socketOrNothing = (name: string) => async () => {
    events.push(name);
    return controlSocket ? ({ ok: false, reason: "use-control-socket" } as const) : undefined;
  };
  const deps: DaemonModeDeps<FakeLink> = {
    service: {
      install: record("install"),
      uninstall: options.uninstallFails
        ? async () => {
            throw new Error("launchctl exited with code 5");
          }
        : record("uninstall"),
      start: record("start"),
      stop: socketOrNothing("stop"),
      restart: socketOrNothing("restart"),
      status: async () => options.serviceStatus ?? "stopped",
      isStale: async () => {
        if (options.stale instanceof Error) throw options.stale;
        return options.stale ?? false;
      },
    },
    installStarts: options.installStarts ?? true,
    async connect(timeoutMs) {
      events.push(`connect(${timeoutMs})`);
      const next = connects.shift() ?? new Error("no daemon");
      if (next instanceof Error) throw next;
      const link = fakeLink(events, `link${links.length + 1}`);
      links.push(link);
      return link;
    },
    async daemonAnswers() {
      if (answers <= 0) return false;
      answers -= 1;
      return true;
    },
    requestDaemonStop: record("daemon:stop"),
    config: {
      read: async () => enabled,
      write: options.routeWrites
        ? daemonSettingWriter(
            () => ({ attached: links.at(-1) }),
            async (next) => {
              events.push(`config ${next}`);
              enabled = next;
            },
          )
        : async (next) => {
            events.push(`config ${next}`);
            enabled = next;
          },
    },
    async confirm(change) {
      events.push(`confirm ${change}`);
      return options.confirm ?? true;
    },
    async chooseFallback(failure) {
      events.push(`fallback? ${failure.reason} | ${failure.lastLogLine}`);
      return options.fallback ?? "in-app";
    },
    stopInProcess: record("stopInProcess"),
    useDaemon: (link) => events.push(`useDaemon ${link.name}`),
    useInProcess: async () => {
      events.push("useInProcess");
      if (options.useInProcessFails) throw new Error("createCore failed");
    },
    showError: async (title) => {
      events.push(`error ${title}`);
    },
    relaunch: ({ inApp }) => events.push(`relaunch inApp=${inApp}`),
    lastLogLine: async () => "error: the core failed to start: EACCES",
    now: () => time,
    sleep: async (ms) => {
      time += ms;
    },
    log: (line) => events.push(`log ${line}`),
  };
  const mode = createDaemonMode(deps);
  return {
    mode,
    events,
    links,
    advance: (ms: number) => {
      time += ms;
    },
    enabled: () => enabled,
  };
}

const noLogs = (events: string[]) => events.filter((event) => !event.startsWith("log "));

describe("daemon mode: app launch", () => {
  it("off: runs the core in the app and never touches the daemon", async () => {
    const h = harness({ enabled: false });
    expect(await h.mode.launch({ inAppThisSession: false })).toEqual({ kind: "in-process" });
    expect(h.events).toEqual([]);
    expect(await h.mode.status()).toEqual({
      enabled: false,
      inApp: true,
      state: { kind: "off" },
    });
  });

  it("on: connects to a running daemon with one attempt, no service call", async () => {
    const h = harness({ enabled: true });
    const result = await h.mode.launch({ inAppThisSession: false });
    expect(result).toEqual({ kind: "daemon", link: h.links[0] });
    expect(h.events).toEqual(["connect(0)"]);
    expect(await h.mode.status()).toEqual({
      enabled: true,
      inApp: false,
      state: { kind: "running", pid: 4242, uptimeMs: 9_000 },
    });
  });

  it("on, not answering: starts the installed service and waits up to 10 s", async () => {
    const h = harness({ enabled: true, connects: [new Error("ENOENT"), "ok"] });
    const result = await h.mode.launch({ inAppThisSession: false });
    expect(result.kind).toBe("daemon");
    expect(noLogs(h.events)).toEqual(["connect(0)", "start", `connect(${SOCKET_WAIT_MS})`]);
    expect(SOCKET_WAIT_MS).toBe(10_000);
  });

  it("on, service gone: installs it again (and starts it where install does not)", async () => {
    const mac = harness({
      enabled: true,
      serviceStatus: "not-installed",
      connects: [new Error("ENOENT"), "ok"],
    });
    await mac.mode.launch({ inAppThisSession: false });
    expect(noLogs(mac.events)).toEqual(["connect(0)", "install", "connect(10000)"]);

    const windows = harness({
      enabled: true,
      installStarts: false,
      serviceStatus: "not-installed",
      connects: [new Error("ENOENT"), "ok"],
    });
    await windows.mode.launch({ inAppThisSession: false });
    expect(noLogs(windows.events)).toEqual(["connect(0)", "install", "start", "connect(10000)"]);
  });

  it("on, still nothing after 10 s: offers to run inside the app this time, with the log's last line", async () => {
    const h = harness({
      enabled: true,
      connects: [new Error("ENOENT"), new Error("timed out")],
      fallback: "in-app",
    });
    expect(await h.mode.launch({ inAppThisSession: false })).toEqual({ kind: "in-process" });
    expect(noLogs(h.events)).toEqual([
      "connect(0)",
      "start",
      "connect(10000)",
      "fallback? timed out | error: the core failed to start: EACCES",
      // Whatever the start set going is stopped before the app runs a core.
      "stop",
    ]);
    // In-process for this session only: the setting stays on.
    expect(h.enabled()).toBe(true);
    expect(await h.mode.status()).toEqual({
      enabled: true,
      inApp: true,
      state: {
        kind: "failed",
        reason: "timed out",
        lastLogLine: "error: the core failed to start: EACCES",
      },
    });
  });

  it("on, in the app this time, but what it started won't stop: an error, and no second core", async () => {
    const h = harness({
      enabled: true,
      connects: [new Error("ENOENT"), new Error("timed out")],
      fallback: "in-app",
      // It answers throughout: never goes.
      answersFor: 10_000,
      controlSocket: true,
    });
    expect(await h.mode.launch({ inAppThisSession: false })).toEqual({ kind: "quit" });
    const events = noLogs(h.events);
    expect(events.slice(-3)).toEqual([
      "stop",
      "daemon:stop",
      "error Jarvis's background service won't stop",
    ]);
    expect(events).not.toContain("useInProcess");
    expect(STARTED_STOP_WAIT_MS).toBe(5_000);
  });

  it("on, in the app this time, and a late daemon answers: daemon:stop, then in-process once it is gone", async () => {
    const h = harness({
      enabled: true,
      connects: [new Error("ENOENT"), new Error("timed out")],
      fallback: "in-app",
      answersFor: 3,
      controlSocket: true,
    });
    expect(await h.mode.launch({ inAppThisSession: false })).toEqual({ kind: "in-process" });
    expect(noLogs(h.events).slice(-2)).toEqual(["stop", "daemon:stop"]);
  });

  it("on, still nothing, and the user quits", async () => {
    const h = harness({
      enabled: true,
      connects: [new Error("x"), new Error("y")],
      fallback: "quit",
    });
    expect(await h.mode.launch({ inAppThisSession: false })).toEqual({ kind: "quit" });
  });

  it("on, but relaunched to run inside the app this session: no connect", async () => {
    const h = harness({ enabled: true });
    expect(await h.mode.launch({ inAppThisSession: true })).toEqual({ kind: "in-process" });
    expect(h.events).toEqual([]);
    expect((await h.mode.status()).inApp).toBe(true);
  });
});

describe("daemon mode: setting off, but a daemon already runs (review I1)", () => {
  it("attaches to it for this session instead of starting a second core", async () => {
    const h = harness({ enabled: false, answersFor: 1 });
    const result = await h.mode.launch({ inAppThisSession: false });
    expect(result).toEqual({ kind: "daemon", link: h.links[0] });
    // No service call, and the setting is left as it is.
    expect(noLogs(h.events)).toEqual(["connect(0)"]);
    expect(h.enabled()).toBe(false);
    expect(await h.mode.status()).toEqual({
      enabled: false,
      inApp: false,
      state: { kind: "running", pid: 4242, uptimeMs: 9_000 },
    });
  });

  it("one it can't attach to (another build): stops it over the socket before running in the app", async () => {
    const h = harness({
      enabled: false,
      answersFor: 2,
      connects: [new Error("runs a different build")],
      fallback: "in-app",
    });
    expect(await h.mode.launch({ inAppThisSession: false })).toEqual({ kind: "in-process" });
    expect(noLogs(h.events)).toEqual([
      "connect(0)",
      "fallback? runs a different build | error: the core failed to start: EACCES",
      "daemon:stop",
    ]);
  });

  it("one it can't attach to and that won't stop: an error and a quit, never a second core", async () => {
    const h = harness({
      enabled: false,
      answersFor: 10_000,
      connects: [new Error("runs a different build")],
      fallback: "in-app",
    });
    expect(await h.mode.launch({ inAppThisSession: false })).toEqual({ kind: "quit" });
    expect(noLogs(h.events).slice(-2)).toEqual([
      "daemon:stop",
      "error Jarvis's background service won't stop",
    ]);

    const quits = harness({
      enabled: false,
      answersFor: 1,
      connects: [new Error("x")],
      fallback: "quit",
    });
    expect(await quits.mode.launch({ inAppThisSession: false })).toEqual({ kind: "quit" });
  });

  it("turning the setting on while attached writes it and installs the service, and nothing else", async () => {
    const h = harness({ enabled: false, answersFor: 1 });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.setEnabled(true)).toEqual({ ok: true });
    expect(noLogs(h.events)).toEqual(["connect(0)", "config true", "install"]);
    expect((await h.mode.status()).enabled).toBe(true);

    // Windows: the Run value only; the daemon already runs.
    const windows = harness({ enabled: false, answersFor: 1, installStarts: false });
    await windows.mode.launch({ inAppThisSession: false });
    expect(await windows.mode.setEnabled(true)).toEqual({ ok: true });
    expect(noLogs(windows.events)).toEqual(["connect(0)", "config true", "install"]);
  });

  it("restart is refused: the service did not start this daemon, so it can't restart it", async () => {
    const h = harness({ enabled: false, answersFor: 1 });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.restart()).toEqual({
      ok: false,
      reason: "failed",
      detail: MESSAGES.daemonNotService(PRIMARY_LANGUAGE),
    });
    // Nor does the adapter's answer to restart-required touch a service.
    await expect(h.mode.restartDaemon()).rejects.toThrow(MESSAGES.daemonNotService("en"));
    expect(noLogs(h.events)).toEqual(["connect(0)"]);
  });

  it("turning it off is a no-op (it is off), and stop now stops the daemon and relaunches in the app", async () => {
    const h = harness({ enabled: false, answersFor: 1 });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.setEnabled(false)).toEqual({ ok: true });
    expect(await h.mode.stopNow()).toEqual({ ok: true });
    expect(noLogs(h.events)).toEqual([
      "connect(0)",
      "daemon:stop",
      "link.stop",
      "relaunch inApp=true",
    ]);
  });
});

describe("daemon mode: a moved app's stale service (fix wave)", () => {
  it("reinstalls a service that names another binary before connecting", async () => {
    const h = harness({ enabled: true, stale: true });
    expect((await h.mode.launch({ inAppThisSession: false })).kind).toBe("daemon");
    expect(noLogs(h.events)).toEqual(["install", "connect(0)"]);
  });

  it("leaves a current service alone, never checks when the setting is off, and goes on if the check fails", async () => {
    const current = harness({ enabled: true, stale: false });
    await current.mode.launch({ inAppThisSession: false });
    expect(noLogs(current.events)).toEqual(["connect(0)"]);

    const off = harness({ enabled: false, stale: true });
    await off.mode.launch({ inAppThisSession: false });
    expect(off.events).toEqual([]);

    const failing = harness({ enabled: true, stale: new Error("EACCES") });
    expect((await failing.mode.launch({ inAppThisSession: false })).kind).toBe("daemon");
    expect(noLogs(failing.events)).toEqual(["connect(0)"]);
    expect(failing.events).toContain("log checking the installed service failed: EACCES");
  });
});

describe("daemon mode: turning it on", () => {
  it("confirms, installs and starts, waits for the socket, switches, then stops the in-process core", async () => {
    const h = harness({ enabled: false });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.setEnabled(true)).toEqual({ ok: true });
    expect(noLogs(h.events)).toEqual([
      "confirm enable",
      "config true",
      "install",
      "connect(10000)",
      // The window leaves the in-process core before that core tears down.
      "useDaemon link1",
      "stopInProcess",
      "reapplyRemote",
    ]);
    expect(await h.mode.status()).toMatchObject({
      enabled: true,
      inApp: false,
      state: { kind: "running", pid: 4242 },
    });
  });

  it("starts the service itself where installing does not (Windows)", async () => {
    const h = harness({ installStarts: false });
    await h.mode.launch({ inAppThisSession: false });
    await h.mode.setEnabled(true);
    expect(noLogs(h.events).slice(0, 5)).toEqual([
      "confirm enable",
      "config true",
      "install",
      "start",
      "connect(10000)",
    ]);
  });

  it("does nothing when the user cancels the confirm", async () => {
    const h = harness({ confirm: false });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.setEnabled(true)).toEqual({ ok: false, reason: "cancelled" });
    expect(h.events).toEqual(["confirm enable"]);
    expect(h.enabled()).toBe(false);
  });

  it("on a socket timeout: undoes the service and the setting, keeps the in-process core, reports the log line", async () => {
    const h = harness({ connects: [new Error("timed out")] });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.setEnabled(true)).toEqual({
      ok: false,
      reason: "failed",
      detail: "timed out",
    });
    expect(noLogs(h.events)).toEqual([
      "confirm enable",
      "config true",
      "install",
      "connect(10000)",
      "stop",
      "uninstall",
      "config false",
    ]);
    expect(h.enabled()).toBe(false);
    expect(await h.mode.status()).toEqual({
      enabled: false,
      inApp: true,
      state: {
        kind: "failed",
        reason: "timed out",
        lastLogLine: "error: the core failed to start: EACCES",
      },
    });
  });

  it("on a Windows timeout: a daemon the spawn brought up late gets daemon:stop before the uninstall", async () => {
    const h = harness({
      installStarts: false,
      controlSocket: true,
      connects: [new Error("timed out")],
      answersFor: 2,
    });
    // In-process from the start, without the launch's probe, so the two
    // answers belong to the daemon the start brings up late.
    await h.mode.launch({ inAppThisSession: true });
    expect((await h.mode.setEnabled(true)).ok).toBe(false);
    expect(noLogs(h.events)).toEqual([
      "confirm enable",
      "config true",
      "install",
      "start",
      "connect(10000)",
      "stop",
      "daemon:stop",
      "uninstall",
      "config false",
    ]);
  });

  it("on a timeout whose daemon won't stop: says so, and leaves the service for the user to stop", async () => {
    const h = harness({
      connects: [new Error("timed out")],
      answersFor: 10_000,
      controlSocket: true,
    });
    await h.mode.launch({ inAppThisSession: false });
    const result = await h.mode.setEnabled(true);
    expect(result).toEqual({
      ok: false,
      reason: "failed",
      detail: MESSAGES.daemonStuck(PRIMARY_LANGUAGE),
    });
    expect(noLogs(h.events)).not.toContain("uninstall");
    expect(noLogs(h.events)).not.toContain("useDaemon link1");
  });

  it("refuses a second change while one is running, and reports starting meanwhile", async () => {
    const h = harness();
    await h.mode.launch({ inAppThisSession: false });
    const first = h.mode.setEnabled(true);
    expect(await h.mode.setEnabled(false)).toEqual({ ok: false, reason: "busy" });
    expect((await h.mode.status()).state).toEqual({ kind: "starting" });
    expect(await first).toEqual({ ok: true });
  });
});

describe("daemon mode: turning it off", () => {
  it("confirms, stops and uninstalls the service, waits for it to go, writes the setting, relaunches in-process", async () => {
    const h = harness({ enabled: true, answersFor: 2 });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.setEnabled(false)).toEqual({ ok: true });
    expect(noLogs(h.events)).toEqual([
      "connect(0)",
      "confirm disable",
      // Through the daemon's own config writer, while it still runs.
      "config false",
      "stop",
      "uninstall",
      "link.stop",
      "relaunch inApp=false",
    ]);
    expect(h.enabled()).toBe(false);
  });

  it("stops the daemon over the control socket where the service manager can't (Windows)", async () => {
    const h = harness({ enabled: true, controlSocket: true, answersFor: 3 });
    await h.mode.launch({ inAppThisSession: false });
    await h.mode.setEnabled(false);
    expect(noLogs(h.events)).toEqual([
      "connect(0)",
      "confirm disable",
      "config false",
      "stop",
      "daemon:stop",
      "uninstall",
      "link.stop",
      "relaunch inApp=false",
    ]);
  });

  it("in a run-inside-the-app session: no confirm, no relaunch", async () => {
    const h = harness({ enabled: true });
    await h.mode.launch({ inAppThisSession: true });
    expect(await h.mode.setEnabled(false)).toEqual({ ok: true });
    expect(noLogs(h.events)).toEqual(["config false", "stop", "uninstall"]);
    expect(await h.mode.status()).toEqual({
      enabled: false,
      inApp: true,
      state: { kind: "off" },
    });
  });

  it("keeps the setting on, and the app as it is, when the uninstall fails", async () => {
    const h = harness({ enabled: true, uninstallFails: true, answersFor: 1 });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.setEnabled(false)).toEqual({
      ok: false,
      reason: "failed",
      detail: "launchctl exited with code 5",
    });
    // The daemon still answers: the app stays attached, the setting on.
    expect(noLogs(h.events)).toEqual([
      "connect(0)",
      "confirm disable",
      "config false",
      "stop",
      "config true",
    ]);
    expect(h.enabled()).toBe(true);
  });

  it("fails after the daemon has stopped: starts a core in the app, keeps the setting, says why", async () => {
    const h = harness({ enabled: true, uninstallFails: true, answersFor: 0 });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.setEnabled(false)).toEqual({
      ok: false,
      reason: "failed",
      detail: "launchctl exited with code 5",
    });
    expect(noLogs(h.events)).toEqual([
      "connect(0)",
      "confirm disable",
      "config false",
      "stop",
      "link.stop",
      "useInProcess",
      "config true",
    ]);
    expect(await h.mode.status()).toMatchObject({ enabled: true, inApp: true });
  });

  it("with the attached daemon down: writes the file itself, and still stops, uninstalls and relaunches", async () => {
    const h = harness({ enabled: true, routeWrites: true });
    await h.mode.launch({ inAppThisSession: false });
    h.links[0]!.state = { kind: "reconnecting", attempt: 3, inMs: 2_000 };
    expect(await h.mode.setEnabled(false)).toEqual({ ok: true });
    expect(noLogs(h.events)).toEqual([
      "connect(0)",
      "confirm disable",
      "config false",
      "stop",
      "uninstall",
      "link.stop",
      "relaunch inApp=false",
    ]);
    expect(h.enabled()).toBe(false);
  });

  it("with the attached daemon up: the daemon writes the setting", async () => {
    const h = harness({ enabled: true, routeWrites: true });
    await h.mode.launch({ inAppThisSession: false });
    await h.mode.setEnabled(false);
    expect(noLogs(h.events)).toContain("daemon writes false");
    expect(noLogs(h.events)).not.toContain("config false");
  });

  it("restores the setting before the relaunch when no core will start in the app", async () => {
    const h = harness({ enabled: true, uninstallFails: true, useInProcessFails: true });
    await h.mode.launch({ inAppThisSession: false });
    expect((await h.mode.setEnabled(false)).ok).toBe(false);
    expect(noLogs(h.events).slice(-3)).toEqual([
      "useInProcess",
      "config true",
      "relaunch inApp=true",
    ]);
    expect(h.enabled()).toBe(true);
  });

  it("gives up waiting after 10 s and goes on", async () => {
    const h = harness({ enabled: true, answersFor: 1_000 });
    await h.mode.launch({ inAppThisSession: false });
    await h.mode.setEnabled(false);
    expect(h.events).toContain("log the Jarvis daemon is still answering after the stop");
    expect(h.events).toContain("relaunch inApp=false");
    expect(STOP_WAIT_MS).toBe(10_000);
  });
});

describe("daemon mode: restart and stop now", () => {
  it("restarts through the service manager", async () => {
    const h = harness({ enabled: true });
    await h.mode.launch({ inAppThisSession: false });
    await h.mode.restartDaemon();
    expect(noLogs(h.events)).toEqual(["connect(0)", "restart"]);
  });

  it("restarts on Windows with daemon:stop, a wait for it to go, then a start", async () => {
    const h = harness({ enabled: true, controlSocket: true, answersFor: 3 });
    await h.mode.launch({ inAppThisSession: false });
    await h.mode.restartDaemon();
    expect(noLogs(h.events)).toEqual(["connect(0)", "restart", "daemon:stop", "start"]);
  });

  it("stop now: daemon:stop, then relaunch inside the app — the service and the setting stay", async () => {
    const h = harness({ enabled: true, answersFor: 2 });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.stopNow()).toEqual({ ok: true });
    expect(noLogs(h.events)).toEqual([
      "connect(0)",
      "daemon:stop",
      "link.stop",
      "relaunch inApp=true",
    ]);
    expect(h.enabled()).toBe(true);
  });

  it("Settings' restart is refused when the core runs in the app: no daemon beside it", async () => {
    const h = harness({ enabled: true });
    await h.mode.launch({ inAppThisSession: true });
    expect(await h.mode.restart()).toEqual({
      ok: false,
      reason: "failed",
      detail: MESSAGES.daemonNotAttached(PRIMARY_LANGUAGE),
    });
    expect(h.events).toEqual([]);

    const attached = harness({ enabled: true });
    await attached.mode.launch({ inAppThisSession: false });
    expect(await attached.mode.restart()).toEqual({ ok: true });
    expect(noLogs(attached.events)).toEqual(["connect(0)", "restart"]);
  });

  it("stop now does nothing when the core already runs in the app", async () => {
    const h = harness({ enabled: false });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.stopNow()).toEqual({ ok: true });
    expect(h.events).toEqual([]);
  });
});

describe("daemon mode: status while connected", () => {
  it.each([
    [{ kind: "reconnecting", attempt: 1, inMs: 250 }, { kind: "starting" }],
    [{ kind: "restarting" }, { kind: "starting" }],
    [{ kind: "connecting" }, { kind: "starting" }],
    [{ kind: "stopped" }, { kind: "off" }],
    [
      { kind: "failed", error: "not restarted again" },
      {
        kind: "failed",
        reason: "not restarted again",
        lastLogLine: "error: the core failed to start: EACCES",
      },
    ],
  ] as const)("maps %j to %j", async (connection, state) => {
    const h = harness({ enabled: true });
    await h.mode.launch({ inAppThisSession: false });
    h.links[0]!.state = connection as ConnectionState;
    expect((await h.mode.status()).state).toEqual(state);
  });

  it("reads starting while daemon:info does not answer", async () => {
    const h = harness({ enabled: true });
    await h.mode.launch({ inAppThisSession: false });
    h.links[0]!.info = async () => {
      throw new Error("not connected");
    };
    expect((await h.mode.status()).state).toEqual({ kind: "starting" });
  });
});

describe("who writes daemon.enabled", () => {
  it("the in-process core first, then a connected daemon, else the file", async () => {
    const calls: string[] = [];
    const inProcess = {
      setDaemonEnabled: async (enabled: boolean) => {
        calls.push(`core ${enabled}`);
      },
    };
    const link = fakeLink(calls);
    const file = async (enabled: boolean) => {
      calls.push(`file ${enabled}`);
    };
    await daemonSettingWriter(() => ({ inProcess, attached: link }), file)(true);
    await daemonSettingWriter(() => ({ attached: link }), file)(true);
    link.state = { kind: "restarting" };
    await daemonSettingWriter(() => ({ attached: link }), file)(false);
    await daemonSettingWriter(() => ({}), file)(false);
    expect(calls).toEqual(["core true", "daemon writes true", "file false", "file false"]);
  });

  it("the stuck message tells the user to quit", () => {
    expect(MESSAGES.daemonStuck("en")).toContain("Quit Jarvis");
    expect(MESSAGES.daemonStuck("ar")).toContain("أغلق جارفيس");
  });
});

describe("relaunch arguments", () => {
  it("adds the in-app flag once, and removes it", () => {
    expect(relaunchArgs([".", "--user-data-dir=/x"], true)).toEqual([
      ".",
      "--user-data-dir=/x",
      IN_APP_FLAG,
    ]);
    expect(relaunchArgs([".", IN_APP_FLAG], true)).toEqual([".", IN_APP_FLAG]);
    expect(relaunchArgs([".", IN_APP_FLAG, "--user-data-dir=/x"], false)).toEqual([
      ".",
      "--user-data-dir=/x",
    ]);
    expect(IN_APP_FLAG).toBe("--jarvis-in-app");
  });
});
