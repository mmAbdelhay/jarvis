// The detached POSIX sh script that replaces the installed app with a staged
// update once the running app has quit. Shared by the macOS bundle swap and
// the Linux AppImage swap: both are "wait for the pid, move current aside,
// move staged in, start it, drop the old copy", with a rollback that puts the
// original back exactly when the move-in fails.

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

export type SwapScriptOptions = {
  pid: number;
  /** The installed app: a bundle directory or an AppImage file. */
  current: string;
  /** The verified copy next to it, moved over `current`. */
  staged: string;
  /** One sh line that starts the app at "$app"; it always stands on a line
   *  of its own, so it may end in `&`. */
  launchLine: string;
};

/**
 * Waits up to 60s (0.5s polls) for `pid` to exit, then swaps. A timeout or a
 * missing staged copy changes nothing. A stale `<current>.old` from an earlier
 * failed run is removed before the first move, only while `current` exists.
 * The only `rm -rf` is of `<current>.old`, after the new app was started.
 */
export function swapScript(opts: SwapScriptOptions): string {
  const pid = checkPid(opts.pid);
  return `#!/bin/sh
# Jarvis update: replace the app once the running copy has quit.
pid=${pid}
app=${shQuote(opts.current)}
staged=${shQuote(opts.staged)}
old=${shQuote(`${opts.current}.old`)}

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

if [ -e "$app" ]; then
  if [ -e "$old" ]; then rm -rf "$old"; fi
  if [ -e "$old" ] || ! mv "$app" "$old"; then
    ${opts.launchLine}
    exit 1
  fi
fi

if ! mv "$staged" "$app"; then
  if [ -e "$old" ]; then mv "$old" "$app"; fi
  ${opts.launchLine}
  exit 1
fi

${opts.launchLine}
rm -rf "$old"
exit 0
`;
}
