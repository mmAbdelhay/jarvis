// Short-lived child processes the core spawns on its own (the Reviews
// service's `gh` calls), tracked so shutdown can kill them and wait for
// their exit. On Windows a running child holds its cwd open: a `gh repo
// view` still running in a project directory keeps that directory from
// being deleted after the core has shut down.

export type TrackableChild = {
  kill(): unknown;
  once(event: "close" | "error", listener: (...args: unknown[]) => void): unknown;
};

export type ChildTracker = {
  /** Tracks `child` until it closes. After stopAll it is killed at once
   *  and false is returned. */
  track(child: TrackableChild): boolean;
  /** Kills every tracked child; resolves when all have closed or errored.
   *  Final: later children are refused. */
  stopAll(): Promise<void>;
};

export function createChildTracker(): ChildTracker {
  const live = new Map<TrackableChild, Promise<void>>();
  let stopped = false;

  return {
    track(child) {
      if (stopped) {
        child.kill();
        return false;
      }
      const ended = new Promise<void>((resolve) => {
        const end = (): void => {
          live.delete(child);
          resolve();
        };
        child.once("close", end);
        child.once("error", end);
      });
      live.set(child, ended);
      return true;
    },
    async stopAll() {
      stopped = true;
      const waits = [...live.entries()].map(([child, ended]) => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        return ended;
      });
      await Promise.all(waits);
    },
  };
}
