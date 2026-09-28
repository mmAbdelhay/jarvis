// The jarvisd CLI's argument parser: pure, argv in, command out. `run` is
// the daemon itself (daemon-main.ts, which parses its own flags); every
// other command talks to a running daemon over the control socket
// (commands.ts).
//
// Unlike daemon-main, a bare `jarvisd` is a usage error rather than a
// foreground daemon: typing the name alone asks what it does, and the
// service definitions start daemon-main.js directly (service.ts).
//
// No electron here (core/no-electron.test.ts).

export type CliCommand =
  | { kind: "run" }
  | { kind: "help" }
  | { kind: "status" }
  | { kind: "set-password"; stdin: boolean }
  | { kind: "pair" }
  | { kind: "devices" }
  | { kind: "revoke"; id: string }
  | { kind: "sign-out-all"; yes: boolean }
  | { kind: "web"; enabled: boolean }
  | { kind: "stop" };

export type UsageProblem =
  | { code: "missing-command" }
  | { code: "unknown-command"; value: string }
  | { code: "unknown-option"; value: string }
  | { code: "unexpected-argument"; value: string }
  | { code: "missing-argument"; value: string }
  | { code: "bad-web-value"; value: string };

export type CliArgs = CliCommand | { kind: "usage-error"; problem: UsageProblem };

/** Options each command accepts; a flag is valid only on its own command. */
const OPTIONS: Record<string, Record<string, string>> = {
  "set-password": { "--stdin": "stdin" },
  "sign-out-all": { "--yes": "yes", "-y": "yes" },
};

/** How many positional arguments each command takes. */
const POSITIONALS: Record<string, number> = {
  run: 0,
  help: 0,
  status: 0,
  "set-password": 0,
  pair: 0,
  devices: 0,
  revoke: 1,
  "sign-out-all": 0,
  web: 1,
  stop: 0,
};

const usage = (problem: UsageProblem): CliArgs => ({ kind: "usage-error", problem });

export function parseCliArgs(argv: readonly string[]): CliArgs {
  if (argv.includes("--help") || argv.includes("-h")) return { kind: "help" };
  const [command, ...rest] = argv;
  if (command === undefined) return usage({ code: "missing-command" });
  if (!Object.hasOwn(POSITIONALS, command)) {
    return command.startsWith("-")
      ? usage({ code: "unknown-option", value: command })
      : usage({ code: "unknown-command", value: command });
  }

  const allowed = OPTIONS[command] ?? {};
  const flags = new Set<string>();
  const positionals: string[] = [];
  let onlyPositionals = false;
  for (const arg of rest) {
    if (!onlyPositionals && arg === "--") {
      onlyPositionals = true;
    } else if (!onlyPositionals && arg.startsWith("-") && arg.length > 1) {
      const flag = Object.hasOwn(allowed, arg) ? allowed[arg] : undefined;
      if (flag === undefined) return usage({ code: "unknown-option", value: arg });
      flags.add(flag);
    } else {
      positionals.push(arg);
    }
  }
  const wanted = POSITIONALS[command] ?? 0;
  if (positionals.length > wanted) {
    return usage({ code: "unexpected-argument", value: positionals[wanted] ?? "" });
  }
  const [first] = positionals;
  if (wanted > 0 && (first === undefined || first === "")) {
    return usage({ code: "missing-argument", value: command });
  }

  switch (command) {
    case "run":
    case "help":
    case "status":
    case "pair":
    case "devices":
    case "stop":
      return { kind: command };
    case "set-password":
      return { kind: "set-password", stdin: flags.has("stdin") };
    case "sign-out-all":
      return { kind: "sign-out-all", yes: flags.has("yes") };
    case "revoke":
      return { kind: "revoke", id: first ?? "" };
    default: {
      // web
      if (first !== "on" && first !== "off") {
        return usage({ code: "bad-web-value", value: first ?? "" });
      }
      return { kind: "web", enabled: first === "on" };
    }
  }
}
