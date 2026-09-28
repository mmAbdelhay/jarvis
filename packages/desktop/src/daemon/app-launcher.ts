// `<Jarvis binary> --jarvis-daemon`: the app binary starting jarvisd.
//
// The binary runs itself again as plain Node (ELECTRON_RUN_AS_NODE) on the
// daemon's script, which then takes its own single-instance lock.
//
//   - Nothing supervising (Windows' Run value and its start button): the
//     daemon is started detached, without a console window, and this
//     process exits at once — no window, no core, no second anything.
//   - Under a service manager (JARVISD_SUPERVISOR; a Linux AppImage's
//     systemd unit, service-linux.ts): this process stays as the daemon's
//     parent, passes the stop signals on, and exits with its code. The
//     unit's main process then lives exactly as long as the daemon, so
//     systemd's stop, restart (exit 75) and status all mean the daemon —
//     and the AppImage's mount, which the daemon runs from, stays up.
//
// No electron here (core/no-electron.test.ts): main.ts injects app.exit.
import { SUPERVISOR_ENV } from "./env.js";

type Signal = "SIGTERM" | "SIGINT" | "SIGHUP";

export type LaunchedDaemon = {
  onExit(listener: (code: number | null) => void): void;
  onError(listener: (error: Error) => void): void;
  kill(signal: Signal): void;
  unref(): void;
};

export type AppLauncherDeps = {
  execPath: string;
  script: string;
  env: NodeJS.ProcessEnv;
  spawn(
    command: string,
    args: readonly string[],
    options: {
      env: NodeJS.ProcessEnv;
      detached: boolean;
      windowsHide: true;
      stdio: "ignore" | "inherit";
    },
  ): LaunchedDaemon;
  onSignal(signal: Signal, listener: () => void): void;
  exit(code: number): void;
  log(line: string): void;
};

export function launchDaemonFromApp(deps: AppLauncherDeps): void {
  const supervised = deps.env[SUPERVISOR_ENV] !== undefined;
  const env = { ...deps.env, ELECTRON_RUN_AS_NODE: "1" };
  const describe = (error: Error) => deps.log(`jarvisd failed to start: ${error.message}`);
  let child: LaunchedDaemon;
  try {
    child = deps.spawn(deps.execPath, [deps.script, "run"], {
      env,
      detached: !supervised,
      windowsHide: true,
      stdio: supervised ? "inherit" : "ignore",
    });
  } catch (error) {
    describe(error instanceof Error ? error : new Error(String(error)));
    deps.exit(1);
    return;
  }
  if (!supervised) {
    child.onError(describe);
    child.unref();
    deps.exit(0);
    return;
  }
  child.onError((error) => {
    describe(error);
    deps.exit(1);
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    deps.onSignal(signal, () => child.kill(signal));
  }
  child.onExit((code) => deps.exit(code ?? 1));
}
