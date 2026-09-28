import { describe, expect, it } from "vitest";
import type { ConnectionState } from "../core/socket-core-client.js";
import {
  createDaemonMode,
  type DaemonLink,
  type DaemonModeDeps,
  IN_APP_FLAG,
  relaunchArgs,
  SOCKET_WAIT_MS,
  STOP_WAIT_MS,
} from "./mode.js";
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
      async write(next) {
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
      "stop",
      "uninstall",
      "config false",
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
      "stop",
      "daemon:stop",
      "uninstall",
      "config false",
      "link.stop",
      "relaunch inApp=false",
    ]);
  });

  it("in a run-inside-the-app session: no confirm, no relaunch", async () => {
    const h = harness({ enabled: true });
    await h.mode.launch({ inAppThisSession: true });
    expect(await h.mode.setEnabled(false)).toEqual({ ok: true });
    expect(noLogs(h.events)).toEqual(["stop", "uninstall", "config false"]);
    expect(await h.mode.status()).toEqual({
      enabled: false,
      inApp: true,
      state: { kind: "off" },
    });
  });

  it("keeps the setting on, and the app as it is, when the uninstall fails", async () => {
    const h = harness({ enabled: true, uninstallFails: true });
    await h.mode.launch({ inAppThisSession: false });
    expect(await h.mode.setEnabled(false)).toEqual({
      ok: false,
      reason: "failed",
      detail: "launchctl exited with code 5",
    });
    expect(noLogs(h.events)).toEqual(["connect(0)", "confirm disable", "stop"]);
    expect(h.enabled()).toBe(true);
  });

  it("gives up waiting after 10 s and goes on", async () => {
    const h = harness({ enabled: true, answersFor: 1_000 });
    await h.mode.launch({ inAppThisSession: false });
    await h.mode.setEnabled(false);
    expect(h.events).toContain("log the Jarvis daemon is still answering after the stop; going on");
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
