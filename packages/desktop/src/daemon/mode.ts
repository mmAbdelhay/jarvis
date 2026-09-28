// Where the core runs — in the app, or in jarvisd — and every move between
// the two (Task 23, "Keep Jarvis running in the background").
//
// Pure: the service manager (service.ts), the control connection, the
// config file, the dialogs, the in-process core and the app's relaunch are
// all injected, so the whole table of transitions runs against doubles
// (mode.test.ts). main.ts wires the real ones, with process.platform read
// there.
//
//   launch, daemon off ............ in-process.
//   launch, daemon on ............. connect; else start the service (install
//                                   it first if it is gone), wait up to
//                                   SOCKET_WAIT_MS; else ask: run inside the
//                                   app this time (in-process, this session
//                                   only, the setting stays on) or quit.
//   turn on ....................... confirm (open terminals close) → write
//                                   the setting → install + start → wait for
//                                   the socket → switch the app's CoreClient
//                                   to it → stop the in-process core. Any
//                                   failure undoes the setting and the
//                                   service and leaves the app as it was.
//   turn off ...................... confirm → stop and uninstall the
//                                   service → write the setting → relaunch
//                                   the app in-process.
//   restart ....................... the service manager's restart; where
//                                   there is none (Windows): daemon:stop,
//                                   wait for it to go, start.
//   stop now ...................... daemon:stop (a clean exit, which no
//                                   service manager restarts), then relaunch
//                                   in-process for this session; the service
//                                   stays installed and starts at next login.
//
// No electron here (core/no-electron.test.ts).
import type { ConnectionState } from "../core/socket-core-client.js";
import { MESSAGES, PRIMARY_LANGUAGE } from "../messages.js";
import type { DaemonInfo } from "./protocol.js";
import type { ServiceManager } from "./service.js";

/** How long a start waits for the daemon's socket. */
export const SOCKET_WAIT_MS = 10_000;
/** How long a stop waits for the daemon to let go of its socket. */
export const STOP_WAIT_MS = 10_000;
export const STOP_POLL_MS = 200;
/** How long a failure path waits for a daemon it started to go, before it
 *  refuses to run a second core in the app. */
export const STARTED_STOP_WAIT_MS = 5_000;

export type DaemonState =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "running"; pid: number; uptimeMs: number }
  | { kind: "failed"; reason: string; lastLogLine?: string };

export type DaemonStatus = {
  /** The setting: daemon.enabled in jarvis.yaml. */
  enabled: boolean;
  /** The core runs inside this app. With `enabled`, that is "for this
   *  session only". */
  inApp: boolean;
  state: DaemonState;
};

/** What this machine needs of the socket CoreClient. */
export interface DaemonLink {
  info(): Promise<DaemonInfo>;
  reapplyRemote(): Promise<void>;
  connection(): ConnectionState;
  stop(): void;
}

export type Failure = { reason: string; lastLogLine?: string };

export type DaemonModeDeps<L extends DaemonLink> = {
  service: ServiceManager;
  /** Whether install() also starts the service: launchd's RunAtLoad and
   *  systemd's enable --now do; Windows' Run value only runs at login. */
  installStarts: boolean;
  /** A connected socket CoreClient, trying for at most `timeoutMs` (0: one
   *  attempt). */
  connect(timeoutMs: number): Promise<L>;
  /** Whether a daemon answers on the control endpoint now. */
  daemonAnswers(): Promise<boolean>;
  /** daemon:stop over a control connection of its own. */
  requestDaemonStop(): Promise<void>;
  config: { read(): Promise<boolean>; write(enabled: boolean): Promise<void> };
  /** The confirm dialog. False: the user said no. */
  confirm(change: "enable" | "disable"): Promise<boolean>;
  /** The launch's error dialog: run inside the app this time, or quit. */
  chooseFallback(failure: Failure): Promise<"in-app" | "quit">;
  /** Stops the in-process core, awaited — its bridge's ports included. */
  stopInProcess(): Promise<void>;
  /** Switches the app's CoreClient to the daemon. */
  useDaemon(link: L): void;
  /** Starts a core in the app and switches the CoreClient to it — for a
   *  window whose daemon is gone (a turn-off that failed half way). */
  useInProcess(): Promise<void>;
  /** A native error box: title and body, already in the app's language. */
  showError(title: string, body: string): Promise<void>;
  /** Relaunches the app; `inApp` runs the core inside it for that session. */
  relaunch(options: { inApp: boolean }): void;
  /** jarvisd.log's last line, already scrubbed of secrets when written. */
  lastLogLine(): Promise<string | undefined>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
};

export type LaunchResult<L> =
  | { kind: "in-process" }
  | { kind: "daemon"; link: L }
  | { kind: "quit" };

export type ChangeResult =
  | { ok: true }
  | { ok: false; reason: "cancelled" | "busy" }
  | { ok: false; reason: "failed"; detail: string };

export type DaemonMode<L extends DaemonLink> = {
  launch(options: { inAppThisSession: boolean }): Promise<LaunchResult<L>>;
  setEnabled(enabled: boolean): Promise<ChangeResult>;
  /** Restarts the daemon through its service manager — the socket
   *  adapter's answer to restart-required. */
  restartDaemon(): Promise<void>;
  /** Settings' Restart daemon: refused unless the app is attached to it,
   *  so it can never start a daemon beside the in-process core. */
  restart(): Promise<ChangeResult>;
  /** Stops the daemon for this session and relaunches the app in-process. */
  stopNow(): Promise<ChangeResult>;
  status(): Promise<DaemonStatus>;
};

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createDaemonMode<L extends DaemonLink>(deps: DaemonModeDeps<L>): DaemonMode<L> {
  let enabled = false;
  let link: L | undefined;
  let failure: Failure | undefined;
  let busy = false;

  async function failed(error: unknown): Promise<Failure> {
    const lastLogLine = await deps.lastLogLine().catch(() => undefined);
    return { reason: describe(error), ...(lastLogLine === undefined ? {} : { lastLogLine }) };
  }

  async function startService(): Promise<void> {
    if ((await deps.service.status()) === "not-installed") {
      await deps.service.install();
      if (!deps.installStarts) await deps.service.start();
    } else {
      await deps.service.start();
    }
  }

  /** Until the daemon no longer answers (true), or `limitMs` (false). */
  async function waitGone(limitMs = STOP_WAIT_MS): Promise<boolean> {
    const deadline = deps.now() + limitMs;
    while (await deps.daemonAnswers()) {
      if (deps.now() >= deadline) {
        deps.log("the Jarvis daemon is still answering after the stop");
        return false;
      }
      await deps.sleep(STOP_POLL_MS);
    }
    return true;
  }

  /**
   * A failure path's undo of a start: whatever came up must go before the
   * app runs a core of its own, or two cores share the ptys, jarvis.yaml
   * and the bridge ports. The service manager's stop where there is one,
   * then daemon:stop to whatever still answers (Windows, or a daemon that
   * came up late), then up to STARTED_STOP_WAIT_MS for its endpoint to go.
   * True when nothing answers any more.
   */
  async function stopStarted(): Promise<boolean> {
    await deps.service.stop().catch((error: unknown) => {
      deps.log(`stopping the service failed: ${describe(error)}`);
    });
    try {
      if (await deps.daemonAnswers()) await deps.requestDaemonStop();
    } catch (error) {
      deps.log(`daemon:stop failed: ${describe(error)}`);
    }
    return waitGone(STARTED_STOP_WAIT_MS);
  }

  async function restartDaemon(): Promise<void> {
    const outcome = await deps.service.restart();
    if (outcome?.reason !== "use-control-socket") return;
    if (await deps.daemonAnswers()) await deps.requestDaemonStop();
    await waitGone();
    await deps.service.start();
  }

  const stuck = (): string => MESSAGES.daemonStuck(PRIMARY_LANGUAGE);

  async function stopDaemonProcess(): Promise<void> {
    const outcome = await deps.service.stop();
    if (outcome?.reason === "use-control-socket" && (await deps.daemonAnswers())) {
      await deps.requestDaemonStop();
    }
  }

  /** One change at a time: a second click while one runs is refused. */
  async function exclusive(run: () => Promise<ChangeResult>): Promise<ChangeResult> {
    if (busy) return { ok: false, reason: "busy" };
    busy = true;
    try {
      return await run();
    } finally {
      busy = false;
    }
  }

  async function turnOn(): Promise<ChangeResult> {
    if (link !== undefined) return { ok: true };
    if (!(await deps.confirm("enable"))) return { ok: false, reason: "cancelled" };
    failure = undefined;
    const wasEnabled = enabled;
    let installed = false;
    let connected: L | undefined;
    try {
      await deps.config.write(true);
      enabled = true;
      await deps.service.install();
      installed = true;
      if (!deps.installStarts) await deps.service.start();
      connected = await deps.connect(SOCKET_WAIT_MS);
    } catch (error) {
      failure = await failed(error);
      deps.log(`turning the background service on failed: ${failure.reason}`);
      // A daemon that came up after the wait (or, on Windows, one the
      // uninstall below would leave running) goes first.
      if (installed && !(await stopStarted())) {
        failure = { ...failure, reason: stuck() };
        return { ok: false, reason: "failed", detail: stuck() };
      }
      if (installed && !wasEnabled) {
        await deps.service.uninstall().catch((undo: unknown) => {
          deps.log(`undoing the service install failed: ${describe(undo)}`);
        });
      }
      if (!wasEnabled && enabled) {
        await deps.config.write(false).catch((undo: unknown) => {
          deps.log(`undoing daemon.enabled failed: ${describe(undo)}`);
        });
        enabled = false;
      }
      return { ok: false, reason: "failed", detail: failure.reason };
    }
    // The daemon is up. The app's CoreClient moves to it first — which
    // takes the window (its pages, its pushes) off the in-process core, so
    // that core's teardown can't reach into it (the same order the window's
    // own "closed" handler keeps) — and only then does the in-process core
    // go, and its bridge's ports with it. jarvisd's bridge could not take
    // those at its boot, so the daemon applies its remote settings again
    // once they are free.
    link = connected;
    deps.useDaemon(connected);
    await deps.stopInProcess().catch((error: unknown) => {
      deps.log(`stopping the in-process core failed: ${describe(error)}`);
    });
    await connected.reapplyRemote().catch((error: unknown) => {
      deps.log(`the daemon's remote bridge did not restart: ${describe(error)}`);
    });
    return { ok: true };
  }

  async function turnOff(): Promise<ChangeResult> {
    if (!enabled && link === undefined) return { ok: true };
    if (link !== undefined && !(await deps.confirm("disable"))) {
      return { ok: false, reason: "cancelled" };
    }
    // Written first, through the live core's own config writer (the
    // daemon's, when attached): after the stop there may be no core left.
    try {
      await deps.config.write(false);
    } catch (error) {
      failure = await failed(error);
      return { ok: false, reason: "failed", detail: failure.reason };
    }
    enabled = false;
    try {
      await stopDaemonProcess();
      await deps.service.uninstall();
      await waitGone();
    } catch (error) {
      failure = await failed(error);
      deps.log(`turning the background service off failed: ${failure.reason}`);
      // The service may still be installed: the setting says so again.
      if (link !== undefined && (await deps.daemonAnswers().catch(() => false))) {
        // Still attached to a live daemon: the app stays as it is.
        await restoreEnabled();
        return { ok: false, reason: "failed", detail: failure.reason };
      }
      if (link !== undefined) {
        // The daemon is gone and the window has no core: one in the app,
        // for this session.
        link.stop();
        link = undefined;
        try {
          await deps.useInProcess();
        } catch (start) {
          deps.log(`starting the core in the app failed: ${describe(start)}`);
          deps.relaunch({ inApp: true });
        }
      }
      await restoreEnabled();
      return { ok: false, reason: "failed", detail: failure.reason };
    }
    failure = undefined;
    if (link !== undefined) {
      link.stop();
      link = undefined;
      deps.relaunch({ inApp: false });
    }
    return { ok: true };
  }

  async function restoreEnabled(): Promise<void> {
    await deps.config.write(true).catch((undo: unknown) => {
      deps.log(`restoring daemon.enabled failed: ${describe(undo)}`);
    });
    enabled = true;
  }

  return {
    async launch({ inAppThisSession }) {
      enabled = await deps.config.read();
      if (!enabled || inAppThisSession) return { kind: "in-process" };
      try {
        link = await deps.connect(0);
        return { kind: "daemon", link };
      } catch (error) {
        deps.log(`the Jarvis daemon did not answer (${describe(error)}); starting it`);
      }
      try {
        await startService();
        link = await deps.connect(SOCKET_WAIT_MS);
        return { kind: "daemon", link };
      } catch (error) {
        failure = await failed(error);
        deps.log(`the Jarvis daemon did not start: ${failure.reason}`);
      }
      const choice = await deps.chooseFallback(failure);
      if (choice === "quit") return { kind: "quit" };
      // In the app this time — once nothing started above still runs.
      if (await stopStarted()) return { kind: "in-process" };
      failure = { ...failure, reason: stuck() };
      await deps.showError(MESSAGES.daemonStuckTitle(PRIMARY_LANGUAGE), stuck());
      return { kind: "quit" };
    },

    setEnabled: (next) => exclusive(() => (next ? turnOn() : turnOff())),

    restartDaemon,

    restart: () =>
      exclusive(async () => {
        if (link === undefined) {
          return {
            ok: false,
            reason: "failed",
            detail: MESSAGES.daemonNotAttached(PRIMARY_LANGUAGE),
          };
        }
        try {
          await restartDaemon();
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: "failed", detail: describe(error) };
        }
      }),

    stopNow: () =>
      exclusive(async () => {
        if (link === undefined) return { ok: true };
        try {
          await deps.requestDaemonStop();
          await waitGone();
        } catch (error) {
          failure = await failed(error);
          return { ok: false, reason: "failed", detail: failure.reason };
        }
        link.stop();
        link = undefined;
        deps.relaunch({ inApp: true });
        return { ok: true };
      }),

    async status() {
      const base = { enabled, inApp: link === undefined };
      if (busy) return { ...base, state: { kind: "starting" } };
      if (link !== undefined) {
        const connection = link.connection();
        switch (connection.kind) {
          case "connected":
            try {
              const info = await link.info();
              return {
                ...base,
                state: {
                  kind: "running",
                  pid: info.pid,
                  uptimeMs: Math.max(0, deps.now() - info.startedAt),
                },
              };
            } catch {
              return { ...base, state: { kind: "starting" } };
            }
          case "failed": {
            const lastLogLine = await deps.lastLogLine().catch(() => undefined);
            return {
              ...base,
              state: {
                kind: "failed",
                reason: connection.error,
                ...(lastLogLine === undefined ? {} : { lastLogLine }),
              },
            };
          }
          case "stopped":
            return { ...base, state: { kind: "off" } };
          default:
            return { ...base, state: { kind: "starting" } };
        }
      }
      if (failure !== undefined) return { ...base, state: { kind: "failed", ...failure } };
      return { ...base, state: { kind: "off" } };
    },
  };
}

/** The relaunch flag for "run inside the app this session": the setting
 *  stays on, and this launch does not connect. */
export const IN_APP_FLAG = "--jarvis-in-app";

/** The argv a relaunch passes (app.relaunch's `args`, without argv[0]):
 *  the current one with IN_APP_FLAG added or removed. */
export function relaunchArgs(current: readonly string[], inApp: boolean): string[] {
  const rest = current.filter((arg) => arg !== IN_APP_FLAG);
  return inApp ? [...rest, IN_APP_FLAG] : rest;
}
