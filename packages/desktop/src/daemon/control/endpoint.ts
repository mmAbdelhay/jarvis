// Where the daemon's local control transport lives (Phase 2, task 2.4).
// Everything sits in one per-user run dir, `~/.config/jarvis/run`: on Unix a
// 0700 directory owned by the user, on Windows under the user profile, whose
// ACL already restricts it to its owner.
//
// Unix: a fixed socket path in that dir; the dir's mode is the access check.
// Windows: named pipes live in one machine-wide namespace any user can create
// names in, so the name is `jarvisd-` plus 16 random hex chosen at every
// daemon start and published in `control.endpoint` beside the secret. A name
// derived from the user (the first design) let another local user create the
// pipe first and pose as the daemon (task 20 review, C1).
import { posix, win32 } from "node:path";
import type { ControlFs } from "./deps.js";

export interface ControlPaths {
  runDirectory: string;
  socketPath: string;
  secretPath: string;
  endpointPath: string;
  pidPath: string;
}

export const WINDOWS_PIPE_PATTERN = /^\\\\\.\\pipe\\jarvisd-[0-9a-f]{16}$/;

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

export function runDirectoryFor(options: { platform: NodeJS.Platform; home: string }): string {
  return pathFor(options.platform).join(options.home, ".config", "jarvis", "run");
}

export function controlPaths(platform: NodeJS.Platform, runDirectory: string): ControlPaths {
  const path = pathFor(platform);
  return {
    runDirectory,
    socketPath: path.join(runDirectory, "jarvisd.sock"),
    secretPath: path.join(runDirectory, "control.secret"),
    endpointPath: path.join(runDirectory, "control.endpoint"),
    pidPath: path.join(runDirectory, "jarvisd.pid"),
  };
}

/** `random` must be 8 bytes from a CSPRNG. */
export function windowsPipeName(random: Uint8Array): string {
  return `\\\\.\\pipe\\jarvisd-${Buffer.from(random).toString("hex")}`;
}

/** The endpoint a client dials: the fixed socket on Unix, the published pipe name on Windows. */
export async function endpointFor(options: {
  platform: NodeJS.Platform;
  runDirectory: string;
  fs: Pick<ControlFs, "readFile">;
}): Promise<string> {
  const paths = controlPaths(options.platform, options.runDirectory);
  if (options.platform !== "win32") return paths.socketPath;
  const name = (await options.fs.readFile(paths.endpointPath, "utf8")).trim();
  if (!WINDOWS_PIPE_PATTERN.test(name)) {
    throw new Error("The published control endpoint is not a jarvisd pipe name");
  }
  return name;
}
