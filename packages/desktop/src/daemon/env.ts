// What jarvisd takes out of its own environment before anything else runs.
//
// ELECTRON_RUN_AS_NODE=1 is how the packaged daemon runs at all (main.ts's
// --jarvis-daemon, the launchd and systemd definitions), and it is needed
// only at exec time. Left in process.env it would reach every child the core
// starts — every Terminal tab, agent run and sidecar builds its env from
// process.env — and any Electron app launched from a Jarvis terminal (VS
// Code, another Jarvis) would then start as bare Node and break.
//
// JARVISD_SUPERVISOR names the service manager that started the daemon and
// will start it again after a restart exit (service-darwin.ts,
// service-linux.ts). It is read once, here, and not passed on either.
//
// No electron here (core/no-electron.test.ts).

export type DaemonSupervisor = "launchd" | "systemd";

export const SUPERVISOR_ENV = "JARVISD_SUPERVISOR";

/** Removes the daemon-only variables from `env` (process.env, in
 *  daemon-main.ts) and answers which service manager, if any, runs it. */
export function takeDaemonEnv(env: NodeJS.ProcessEnv): { supervisor?: DaemonSupervisor } {
  const supervisor = env[SUPERVISOR_ENV];
  delete env.ELECTRON_RUN_AS_NODE;
  delete env[SUPERVISOR_ENV];
  return supervisor === "launchd" || supervisor === "systemd" ? { supervisor } : {};
}
