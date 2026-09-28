// Where the daemon's entry script is, for the one place that launches it
// from the app binary (main.ts's --jarvis-daemon) and the service
// definitions that name it (service.ts).
//
// The build emits it beside main.js: dist/src/daemon-main.js. Packaged, dist
// sits inside app.asar with the node_modules it imports, so that is where
// the script is too — Electron's asar support stays on under
// ELECTRON_RUN_AS_NODE, and node-pty is already unpacked (asarUnpack).
//
// The joins use the path rules of `platform`, never the host's, so the
// Windows answer can be checked anywhere (path.win32).
//
// No electron here (core/no-electron.test.ts).
import { posix, win32 } from "node:path";

export function daemonScriptPath(options: {
  platform: NodeJS.Platform;
  packaged: boolean;
  /** process.resourcesPath, when packaged. */
  resourcesPath: string;
  /** The compiled dist/src directory, from the caller's import.meta.url. */
  distSrcDir: string;
}): string {
  const { join } = options.platform === "win32" ? win32 : posix;
  return options.packaged
    ? join(options.resourcesPath, "app.asar", "dist", "src", "daemon-main.js")
    : join(options.distSrcDir, "daemon-main.js");
}
