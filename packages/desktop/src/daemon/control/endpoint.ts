// Where the daemon's local control transport lives (Phase 2, task 2.4).
// Unix: a socket in a 0700 directory beside the config. Windows: a named pipe
// in the machine-wide pipe namespace, so its name carries a per-user suffix;
// the secret file sits under the user profile, which the profile's ACL
// already restricts to its owner.
import { createHash } from "node:crypto";
import { posix, win32 } from "node:path";

export interface EndpointOptions {
  platform: NodeJS.Platform;
  home: string;
  username: string;
}

export interface ControlPaths {
  runDirectory: string;
  endpoint: string;
  secretPath: string;
}

export function controlPaths(options: EndpointOptions): ControlPaths {
  const path = options.platform === "win32" ? win32 : posix;
  const runDirectory = path.join(options.home, ".config", "jarvis", "run");
  return {
    runDirectory,
    endpoint: endpointFor(options),
    secretPath: path.join(runDirectory, "control.secret"),
  };
}

export function endpointFor(options: EndpointOptions): string {
  if (options.platform === "win32") {
    const suffix = createHash("sha256").update(options.username).digest("hex").slice(0, 16);
    return `\\\\.\\pipe\\jarvisd-${suffix}`;
  }
  return posix.join(options.home, ".config", "jarvis", "run", "jarvisd.sock");
}
