// Plan Y §2.3: every account CLI process runs as a transient user service.
// Stronger than the M2.5 add-on sandbox where it can be: ProtectHome=tmpfs
// hides ALL of /home, /root and /run/user, and only the account's own config
// dir and temp dir (read-write) and its CLI dir (read-only) are bound back.
// So ~/.ssh, ~/.gnupg, keyrings, jarvis.yaml, the control secret, the other
// accounts and every bus/agent socket are simply not there; the spec's
// InaccessiblePaths list is kept as a floor in case tmpfs is unavailable.
// `env -i` starts the CLI with the invocation's environment only.
//
// No electron here (core/no-electron.test.ts).
import { posix } from "node:path";
import { ACCOUNT_IDS, type AccountId } from "@jarvis/core";
import type { AccountPaths, CliInvocation } from "@jarvis/platform/model";

const SAFE_PATH = /^\/[A-Za-z0-9._@+/-]+$/;
const SAFE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const UNIT_SUFFIX = /^[0-9a-f]{8}$/;

export function accountUnitName(account: AccountId, randomHex: () => string): string {
  const suffix = randomHex();
  if (!UNIT_SUFFIX.test(suffix)) throw new Error("unit suffix must be 8 hex digits");
  return `jarvis-account-${account}-${suffix}`;
}

function checkedPath(path: string): string {
  if (!SAFE_PATH.test(path) || path.split("/").includes(".."))
    throw new Error(`unsafe sandbox path ${JSON.stringify(path)}`);
  return path;
}

function hiddenPaths(inv: CliInvocation, home: string, runtimeDir: string): string[] {
  const others = ACCOUNT_IDS.filter((id) => id !== inv.account).flatMap((id) => [
    posix.join(home, ".config", "jarvis", "accounts", id),
    posix.join(home, ".local", "share", "jarvis", "clis", id),
    posix.join(home, ".cache", "jarvis", "accounts", id),
  ]);
  return [
    posix.join(home, ".ssh"),
    posix.join(home, ".gnupg"),
    posix.join(home, ".local", "share", "keyrings"),
    posix.join(home, ".config", "jarvis", "jarvis.yaml"),
    posix.join(home, ".config", "jarvis", "run"),
    posix.join(home, ".config", "jarvis", "mcp.d"),
    ...others,
    runtimeDir,
    "/run/dbus/system_bus_socket",
    "/tmp/.X11-unix",
    "/tmp/.ICE-unix",
  ];
}

function command(inv: CliInvocation): string[] {
  if (!inv.tty) return inv.argv;
  // script(1) takes one shell command string: only plain words may go in it.
  for (const word of inv.argv) {
    if (!SAFE_WORD.test(word))
      throw new Error(`cannot run ${JSON.stringify(word)} in a terminal safely`);
  }
  return ["/usr/bin/script", "-q", "-e", "-f", "-c", inv.argv.join(" "), "/dev/null"];
}

export function accountSandboxArgv(
  inv: CliInvocation,
  ctx: { home: string; runtimeDir: string; unit: string },
): string[] {
  const props = [
    "NoNewPrivileges=yes",
    `PrivateNetwork=${inv.network ? "no" : "yes"}`,
    "ProtectHome=tmpfs",
    "PrivateTmp=yes",
    "ProtectSystem=strict",
    "RestrictSUIDSGID=yes",
    "LockPersonality=yes",
    "TasksMax=512",
    "MemoryMax=4G",
    `RuntimeMaxSec=${Math.ceil(inv.timeoutMs / 1000) + 30}`,
    ...inv.writable.map((path) => `BindPaths=${checkedPath(path)}`),
    ...inv.readOnly.map((path) => `BindReadOnlyPaths=${checkedPath(path)}`),
    ...hiddenPaths(inv, checkedPath(ctx.home), checkedPath(ctx.runtimeDir)).map(
      (path) => `InaccessiblePaths=-${path}`,
    ),
  ];
  const env = Object.entries(inv.env).map(([key, value]) => {
    if (!ENV_KEY.test(key) || /[\0\n\r]/.test(value))
      throw new Error(`bad environment entry ${key}`);
    return `${key}=${value}`;
  });
  return [
    "systemd-run",
    "--user",
    "--pipe",
    "--quiet",
    "--collect",
    `--unit=${ctx.unit}`,
    `--working-directory=${checkedPath(inv.cwd)}`,
    ...props.flatMap((property) => ["-p", property]),
    "--",
    "/usr/bin/env",
    "-i",
    ...env,
    ...command(inv),
  ];
}

/** The tmpfs home holds exactly the three bound trees' first segments; the
 *  runtime dir, ~/.ssh and jarvis.yaml are gone; the system bus socket cannot
 *  be opened (InaccessiblePaths= leaves a mode-000 node in its place, so it
 *  still exists); the config dir is writable, the CLI dir read-only, /usr
 *  read-only and /tmp private. Paths go in as arguments, never into the
 *  script text. */
export const ACCOUNT_PROBE_SCRIPT =
  "home=$1; rt=$2; w=$3; r=$4; " +
  'test "$(ls -A "$home" | tr "\\n" " ")" = ".cache .config .local " && ' +
  'test ! -e "$rt/bus" && test ! -e "$home/.ssh" && test ! -e "$home/.config/jarvis/jarvis.yaml" && ' +
  "test ! -r /run/dbus/system_bus_socket && test ! -w /run/dbus/system_bus_socket && " +
  'test -w "$w" && test -r "$r" && test ! -w "$r" && ' +
  "! touch /usr/.jarvis-probe 2>/dev/null && " +
  'test -z "$(ls -A /tmp)"';

export function accountSandboxProbe(
  home: string,
  runtimeDir: string,
  paths: AccountPaths,
  unit: string,
): string[] {
  // The probe runs for whichever account asked first; its own dirs must be the
  // bound ones and the OTHER accounts' dirs the hidden ones.
  const account = ACCOUNT_IDS.find((id) => posix.basename(paths.configDir) === id);
  if (account === undefined) throw new Error("probe paths are not an account's paths");
  const inv: CliInvocation = {
    account,
    purpose: "probe",
    argv: [
      "/bin/sh",
      "-c",
      ACCOUNT_PROBE_SCRIPT,
      "sh",
      home,
      runtimeDir,
      paths.configDir,
      paths.cliDir,
    ],
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    cwd: paths.tmpDir,
    network: false,
    writable: [paths.configDir, paths.tmpDir],
    readOnly: [paths.cliDir],
    files: [],
    stdin: "",
    tty: false,
    mergeStderr: false,
    timeoutMs: 30_000,
  };
  return accountSandboxArgv(inv, { home, runtimeDir, unit });
}
