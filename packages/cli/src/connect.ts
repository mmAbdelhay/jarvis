// Dialling jarvisd's control socket the way the shell does (M1 contracts §3,
// §6 #6): send the build in /usr/lib/jarvis/daemon/build-stamp.json; if the
// daemon answers restart-required (another build, or no stamp at all), dial
// once more with the build it named. The secret stays inside connectControl.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import {
  type ControlClient,
  ControlRestartRequired,
  connectControl,
} from "../../desktop/src/daemon/control/client.js";
import {
  type ControlDeps,
  errorCode,
  nodeControlDeps,
} from "../../desktop/src/daemon/control/deps.js";
import { runDirectoryFor } from "../../desktop/src/daemon/control/endpoint.js";

export const DEFAULT_BUILD_STAMP = "/usr/lib/jarvis/daemon/build-stamp.json";

export class NotRunningError extends Error {
  constructor() {
    super("Jarvis isn't running. Start it with: systemctl --user start jarvisd");
  }
}

export class VersionMismatchError extends Error {
  constructor() {
    super(
      "jarvis and jarvisd don't agree on a version. Restart it with: systemctl --user restart jarvisd",
    );
  }
}

export interface ConnectOptions {
  platform?: NodeJS.Platform;
  runDirectory?: string;
  buildStampPath?: string;
  deps?: Pick<ControlDeps, "fs" | "net" | "clock" | "randomBytes">;
}

const NOT_RUNNING_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTDIR", "EACCES"]);

export async function readBuildStamp(path: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return "";
    const build = (parsed as { build?: unknown }).build;
    return typeof build === "string" ? build : "";
  } catch {
    return "";
  }
}

export async function connectJarvis(
  env: NodeJS.ProcessEnv,
  options: ConnectOptions = {},
): Promise<ControlClient> {
  const platform = options.platform ?? process.platform;
  const runDirectory = options.runDirectory ?? runDirectoryFor({ platform, home: homedir() });
  const deps = options.deps ?? nodeControlDeps();
  const stampPath = options.buildStampPath ?? env.JARVIS_BUILD_STAMP ?? DEFAULT_BUILD_STAMP;
  const dial = (build: string) => connectControl({ platform, runDirectory, build, deps });
  try {
    return await dial(await readBuildStamp(stampPath));
  } catch (error) {
    if (!(error instanceof ControlRestartRequired)) throw explain(error);
    try {
      return await dial(error.build);
    } catch (again) {
      if (again instanceof ControlRestartRequired) throw new VersionMismatchError();
      throw explain(again);
    }
  }
}

function explain(error: unknown): Error {
  const code = errorCode(error);
  if (code !== undefined && NOT_RUNNING_CODES.has(code)) return new NotRunningError();
  return error instanceof Error ? error : new Error(String(error));
}
