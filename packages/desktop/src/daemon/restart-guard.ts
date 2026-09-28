// A daemon that answers restart-required again right after being restarted
// is not going to be fixed by another restart — a stale service definition
// pointing at an old build, say. The app restarts it through the service
// manager at most `max` times in `windowMs`, then stops and says so.
//
// No electron here (core/no-electron.test.ts).

export const MAX_DAEMON_RESTARTS = 3;
export const DAEMON_RESTART_WINDOW_MS = 10 * 60_000;

export type RestartGuard = {
  /** Records a restart and answers whether it may happen. A refused
   *  attempt is not recorded. */
  allow(): boolean;
};

export function createRestartGuard(deps: {
  now(): number;
  max?: number;
  windowMs?: number;
}): RestartGuard {
  const max = deps.max ?? MAX_DAEMON_RESTARTS;
  const windowMs = deps.windowMs ?? DAEMON_RESTART_WINDOW_MS;
  const recent: number[] = [];
  return {
    allow() {
      const now = deps.now();
      while (recent.length > 0 && now - (recent[0] as number) >= windowMs) recent.shift();
      if (recent.length >= max) return false;
      recent.push(now);
      return true;
    },
  };
}
