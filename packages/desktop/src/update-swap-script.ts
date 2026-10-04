// The detached POSIX sh script that replaces the installed app with a staged
// update once the running app has quit. Shared by the macOS bundle swap and
// the Linux AppImage swap: both are "wait for the pid, move current aside,
// move staged in, start it, drop the old copy", with a rollback that puts the
// original back exactly when the move-in fails.

import { posix } from "node:path";

/** `value` as one single-quoted sh word; an embedded `'` becomes `'\''`. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Throws unless `pid` is a positive safe integer, so it can go into the
 *  script unquoted. */
export function checkPid(pid: number): number {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid: ${pid}`);
  return pid;
}

/** Throws unless `path` is absolute, normalised (no `.`/`..`, no doubled or
 *  trailing slash), not `/`, and has a non-empty last segment. */
export function checkSwapPath(path: string): string {
  if (
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.endsWith("/") ||
    posix.basename(path) === ""
  ) {
    throw new Error(`invalid swap path: ${JSON.stringify(path)}`);
  }
  return path;
}

export type SwapScriptOptions = {
  pid: number;
  /** The installed app: a bundle directory or an AppImage file. */
  current: string;
  /** The verified copy next to it, moved over `current`. */
  staged: string;
  /** One sh line that starts the app at "$app"; it always stands on a line
   *  of its own, so it may end in `&`. Its exit status decides whether the
   *  new app started (a backgrounded `cmd &` always reports success). */
  launchLine: string;
};

/**
 * Waits up to 60s (0.5s polls) for `pid` to exit, then swaps. A timeout or a
 * missing staged copy changes nothing. A stale `<current>.old` from an earlier
 * failed run is removed before the first move, and only while `current`
 * exists (otherwise `mv` would move the app into it). After that, `.old` is
 * moved or removed only once this run created it (`moved=1`): if the new app
 * cannot be moved in or fails to start, it goes back to `staged` and the
 * original is restored and reopened; `.old` is removed only after the new app
 * started.
 */
export function swapScript(opts: SwapScriptOptions): string {
  const pid = checkPid(opts.pid);
  const current = checkSwapPath(opts.current);
  const staged = checkSwapPath(opts.staged);
  return `#!/bin/sh
# Jarvis update: replace the app once the running copy has quit.
pid=${pid}
app=${shQuote(current)}
staged=${shQuote(staged)}
old=${shQuote(`${current}.old`)}

tries=0
while kill -0 "$pid" 2>/dev/null; do
  tries=$((tries + 1))
  if [ "$tries" -ge 120 ]; then exit 1; fi
  sleep 0.5
done

if [ ! -e "$staged" ]; then
  if [ -e "$app" ]; then
    ${opts.launchLine}
  fi
  exit 1
fi

moved=0
if [ -e "$app" ]; then
  if [ -e "$old" ]; then rm -rf "$old"; fi
  if [ -e "$old" ] || ! mv "$app" "$old"; then
    ${opts.launchLine}
    exit 1
  fi
  moved=1
fi

if ! mv "$staged" "$app"; then
  if [ "$moved" = 1 ]; then
    mv "$old" "$app"
    ${opts.launchLine}
  fi
  exit 1
fi

${opts.launchLine}
started=$?
if [ "$started" = 0 ]; then
  if [ "$moved" = 1 ]; then rm -rf "$old"; fi
  exit 0
fi

if [ "$moved" = 1 ] && mv "$app" "$staged"; then
  if mv "$old" "$app"; then
    ${opts.launchLine}
  else
    mv "$staged" "$app"
  fi
fi
exit 1
`;
}
