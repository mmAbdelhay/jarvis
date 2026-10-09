// The directory Jarvis keeps its files in: `~/.config/jarvis`, or
// JARVIS_CONFIG_DIR when that is an absolute path. Rafiq's Jarvis Workspace
// wrapper sets it to `~/.config/jarvis-workspace` (M4 contracts §6.16) so the
// Electron app — its jarvis.yaml, logs and control socket — never shares
// jarvisd's. A relative value is ignored rather than resolved against
// whatever directory the app happened to start in.
//
// No electron here (core/no-electron.test.ts).
import * as nativePath from "node:path";
import { posix, win32 } from "node:path";

export type ConfigDirEnv = Readonly<Record<string, string | undefined>>;

export function jarvisConfigDir(options: {
  home: string;
  platform?: NodeJS.Platform;
  env?: ConfigDirEnv;
}): string {
  // No platform: this process's own path flavour (the convention keeps
  // process.platform to the impure edges, platform-convention.test.ts).
  const path =
    options.platform === undefined ? nativePath : options.platform === "win32" ? win32 : posix;
  const override = (options.env ?? process.env).JARVIS_CONFIG_DIR;
  if (override !== undefined && override !== "" && path.isAbsolute(override)) {
    const normal = path.normalize(override);
    return normal.length > 1 && normal.endsWith(path.sep) ? normal.slice(0, -1) : normal;
  }
  return path.join(options.home, ".config", "jarvis");
}
