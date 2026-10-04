// Installing a verified macOS update. The dmg is mounted read-only, its
// Jarvis.app copied with `ditto` to `<bundle>.new` beside the running bundle
// and un-quarantined (the app is unsigned), and the image is always detached.
// The swap itself happens after the app quits, in a detached sh script.
// Every command goes through the injected `exec`; nothing here touches
// electron, the file system or child processes directly.

import { dirname } from "node:path";
import { swapScript } from "./update-swap-script.js";

const HDIUTIL = "/usr/bin/hdiutil";

const BUNDLE = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/;

/** The `.app` bundle that holds `execPath`, or undefined when not in one. */
export function appBundleOf(execPath: string): string | undefined {
  return BUNDLE.exec(execPath)?.[1];
}

export type InstallBlocker = "translocated" | "read-only";

/** Why the bundle cannot be replaced in place: macOS runs a quarantined app
 *  from a random read-only App Translocation path, and the swap needs to
 *  write next to the bundle. */
export function installBlocker(
  bundle: string,
  writable: (dir: string) => boolean,
): InstallBlocker | undefined {
  if (bundle.includes("/AppTranslocation/")) return "translocated";
  if (!writable(dirname(bundle))) return "read-only";
  return undefined;
}

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export type PrepareDarwinDeps = {
  dmg: string;
  bundle: string;
  /** Where the image is mounted (under a random name). */
  workDir: string;
  exec: Exec;
};

export type PrepareDarwinFailure = "attach-failed" | "no-app" | "copy-failed" | "quarantine";

export type PrepareResult =
  | { ok: true; staged: string }
  | { ok: false; reason: PrepareDarwinFailure };

/** A command's exit code, with a rejected spawn counted as a failure. */
async function run(exec: Exec, cmd: string, args: string[]): Promise<number> {
  try {
    return (await exec(cmd, args)).code;
  } catch {
    return -1;
  }
}

/** The first `mount-point` string in `hdiutil attach -plist` output. */
function mountPoint(plist: string): string | undefined {
  return /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
}

/** Copies the dmg's Jarvis.app to `<bundle>.new`, ready for the swap. A
 *  failure removes the partial copy; the image is detached either way. */
export async function prepareDarwin(deps: PrepareDarwinDeps): Promise<PrepareResult> {
  const { exec, bundle } = deps;
  let mount: string | undefined;
  try {
    const attached = await exec(HDIUTIL, [
      "attach",
      "-nobrowse",
      "-readonly",
      "-plist",
      "-mountrandom",
      deps.workDir,
      deps.dmg,
    ]);
    if (attached.code === 0) mount = mountPoint(attached.stdout);
  } catch {
    mount = undefined;
  }
  if (mount === undefined) return { ok: false, reason: "attach-failed" };

  const staged = `${bundle}.new`;
  try {
    const app = `${mount}/Jarvis.app`;
    if ((await run(exec, "/bin/test", ["-d", app])) !== 0) return { ok: false, reason: "no-app" };
    let reason: PrepareDarwinFailure | undefined;
    if ((await run(exec, "/bin/rm", ["-rf", staged])) !== 0) reason = "copy-failed";
    else if ((await run(exec, "/usr/bin/ditto", [app, staged])) !== 0) reason = "copy-failed";
    else if ((await run(exec, "/usr/bin/xattr", ["-dr", "com.apple.quarantine", staged])) !== 0) {
      reason = "quarantine";
    }
    if (reason !== undefined) {
      await run(exec, "/bin/rm", ["-rf", staged]);
      return { ok: false, reason };
    }
    return { ok: true, staged };
  } finally {
    if ((await run(exec, HDIUTIL, ["detach", mount])) !== 0) {
      await run(exec, HDIUTIL, ["detach", mount, "-force"]);
    }
  }
}

export type DarwinSwapOptions = {
  pid: number;
  bundle: string;
  staged: string;
  /** Command that starts a bundle given as its last word; `open` by default. */
  launch?: string;
};

/** The sh script that swaps `staged` in for `bundle` after `pid` exits. */
export function darwinSwapScript(opts: DarwinSwapOptions): string {
  return swapScript({
    pid: opts.pid,
    current: opts.bundle,
    staged: opts.staged,
    launchLine: `${opts.launch ?? "open"} "$app"`,
  });
}
