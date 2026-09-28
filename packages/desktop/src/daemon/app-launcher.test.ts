import { describe, expect, it } from "vitest";
import { launchDaemonFromApp } from "./app-launcher.js";

// `<Jarvis binary> --jarvis-daemon`: detached where nothing supervises it
// (Windows' Run value, its start button); in the foreground under a
// service manager (a Linux AppImage's systemd unit), so the unit's main
// process is the daemon's parent for as long as the daemon runs.

type Signal = "SIGTERM" | "SIGINT" | "SIGHUP";

function harness(supervised: boolean) {
  const events: string[] = [];
  const signals = new Map<Signal, () => void>();
  let exitChild: (code: number | null) => void = () => {};
  const spawned: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
  launchDaemonFromApp({
    execPath: "/tmp/.mount_x/jarvis",
    script: "/tmp/.mount_x/resources/app.asar/dist/src/daemon-main.js",
    env: { PATH: "/bin", ...(supervised ? { JARVISD_SUPERVISOR: "systemd" } : {}) },
    spawn(command, args, options) {
      spawned.push({ command, args, options });
      return {
        onExit: (listener) => {
          exitChild = listener;
        },
        onError: () => {},
        kill: (signal) => void events.push(`kill ${signal}`),
        unref: () => void events.push("unref"),
      };
    },
    onSignal: (signal, listener) => void signals.set(signal, listener),
    exit: (code) => void events.push(`exit ${code}`),
    log: () => {},
  });
  return { events, signals, spawned, exitChild: (code: number | null) => exitChild(code) };
}

describe("launchDaemonFromApp", () => {
  it("unsupervised: starts the daemon detached, as Node, and exits at once", () => {
    const h = harness(false);
    expect(h.spawned).toEqual([
      {
        command: "/tmp/.mount_x/jarvis",
        args: ["/tmp/.mount_x/resources/app.asar/dist/src/daemon-main.js", "run"],
        options: {
          env: { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" },
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        },
      },
    ]);
    expect(h.events).toEqual(["unref", "exit 0"]);
  });

  it("supervised: stays, forwards the stop signals, and exits with the daemon's code", () => {
    const h = harness(true);
    expect(h.spawned[0]?.options).toEqual({
      env: { PATH: "/bin", JARVISD_SUPERVISOR: "systemd", ELECTRON_RUN_AS_NODE: "1" },
      detached: false,
      windowsHide: true,
      stdio: "inherit",
    });
    expect(h.events).toEqual([]);
    h.signals.get("SIGTERM")?.();
    expect(h.events).toEqual(["kill SIGTERM"]);
    // A restart exit (75) is passed on, for systemd to start it again.
    h.exitChild(75);
    expect(h.events).toEqual(["kill SIGTERM", "exit 75"]);
  });

  it("supervised: a daemon killed by a signal is a failure", () => {
    const h = harness(true);
    h.exitChild(null);
    expect(h.events).toEqual(["exit 1"]);
  });
});
