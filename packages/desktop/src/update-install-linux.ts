// Installing a verified Linux update. Only the AppImage build can replace
// itself: the download is copied to `<APPIMAGE>.new` and made executable, and
// after the app quits a detached sh script moves it over the AppImage and
// starts it. The systemd unit points at the same path, so it keeps working.
// File access goes through the injected deps.

import { dirname } from "node:path";
import { swapScript } from "./update-swap-script.js";

export type PrepareLinuxDeps = {
  /** The verified download. */
  file: string;
  /** `process.env.APPIMAGE`; unset when not running as an AppImage. */
  appImage: string | undefined;
  copy(src: string, dest: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  writable(dir: string): boolean;
};

export type PrepareLinuxResult =
  | { ok: true; staged: string }
  | { ok: false; reason: "not-appimage" | "read-only" | "io" };

/** Stages the download as an executable `<appImage>.new`. */
export async function prepareLinux(deps: PrepareLinuxDeps): Promise<PrepareLinuxResult> {
  const { appImage } = deps;
  if (appImage === undefined || appImage === "") return { ok: false, reason: "not-appimage" };
  if (!deps.writable(dirname(appImage))) return { ok: false, reason: "read-only" };
  const staged = `${appImage}.new`;
  try {
    await deps.copy(deps.file, staged);
    await deps.chmod(staged, 0o755);
  } catch {
    return { ok: false, reason: "io" };
  }
  return { ok: true, staged };
}

export type LinuxSwapOptions = {
  pid: number;
  appImage: string;
  staged: string;
  /** Test only: command that starts the AppImage given as its last word, in
   *  place of the default `nohup`. It runs in the background with output
   *  discarded. */
  launch?: string;
};

/** The sh script that swaps `staged` in for `appImage` after `pid` exits.
 *  Starting the new AppImage is best effort: `nohup … &` always reports
 *  success, so a launch failure here does not roll the swap back. */
export function linuxSwapScript(opts: LinuxSwapOptions): string {
  return swapScript({
    pid: opts.pid,
    current: opts.appImage,
    staged: opts.staged,
    launchLine: `${opts.launch ?? "nohup"} "$app" >/dev/null 2>&1 &`,
  });
}
