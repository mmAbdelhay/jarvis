// jarvisd's command line. Today it has one command, `run` — the daemon in
// the foreground, which is also what a bare `jarvisd` does and what every
// service definition starts (service.ts). The admin commands that talk to
// a running daemon arrive with the CLI (Task 24).
//
// No electron here (core/no-electron.test.ts).

export const DAEMON_USAGE = `Usage: jarvisd [run]

  run     Run the Jarvis daemon in the foreground (the default).
  --help  Show this help.
`;

/** Exit codes a service manager or a script can act on. */
export const DAEMON_EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  busy: 3,
  /** A restart asked for (Settings' Restart): non-zero, so launchd's
   *  KeepAlive {SuccessfulExit: false} and systemd's Restart=on-failure
   *  start the daemon again. 75 is EX_TEMPFAIL. */
  restart: 75,
} as const;

export type DaemonArgs = { kind: "run" } | { kind: "help" } | { kind: "error"; message: string };

export function parseDaemonArgs(argv: readonly string[]): DaemonArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [command = "run", ...rest] = argv;
  if (command !== "run") return { kind: "error", message: `Unknown command: ${command}` };
  if (rest.length > 0) return { kind: "error", message: `Unexpected argument: ${rest[0]}` };
  return { kind: "run" };
}
