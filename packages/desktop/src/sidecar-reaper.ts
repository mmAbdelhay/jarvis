/**
 * When to stop a sidecar nobody is looking at.
 *
 * code-server, dbgate-serve and headlamp-server are each started once per
 * project and, before this existed, never stopped until quit. code-server
 * alone is 150-250 MB, so three projects' editors opened across a day was
 * ~600 MB held for nothing.
 *
 * The decision cannot live inside the managers. Nothing calls their open()
 * again while you type in the editor, so a "last used" stamp kept on their
 * side goes stale on the one instance you are actually using — and stopping
 * that is the worst thing this could do. Only the workspace's tabs know what
 * is still needed, so the caller passes that set in and this holds the grace
 * period over it.
 *
 * The grace period is the whole point. Closing an editor tab and reopening it
 * ten seconds later is ordinary, and a restart is ~1.2s warm — long enough to
 * be felt. Ten minutes of nothing needing it is not an accident.
 */
export type SidecarReaperDeps = {
  /** Every instance currently alive, by the key `stop` takes. */
  runningKeys(): string[];
  stop(key: string): void;
  now(): number;
  /** How long a key must go unneeded before it is stopped. 0 disables the
   *  reaper entirely — nothing is stopped before quit, which is what every
   *  manager did before this file existed. */
  idleMs: number;
};

export type SidecarReaper = {
  /** `needed` is every key some live tab still requires. Call it as often as
   *  you like: the grace period runs from the first sweep in which a key was
   *  absent from `needed`, not from this call. */
  sweep(needed: ReadonlySet<string>): void;
};

export function createSidecarReaper(deps: SidecarReaperDeps): SidecarReaper {
  /** Key to the time it was first seen unneeded. */
  const unneededSince = new Map<string, number>();

  return {
    sweep(needed) {
      if (deps.idleMs <= 0) return;
      const now = deps.now();
      const running = new Set(deps.runningKeys());

      // A key that died on its own — crashed, or killed by hand — must not
      // keep its old timestamp. The next instance started under that key
      // would inherit a grace period that had already run out and be stopped
      // the moment it came up, which reads as a sidecar that refuses to
      // start at all.
      for (const key of [...unneededSince.keys()]) {
        if (!running.has(key)) unneededSince.delete(key);
      }

      for (const key of running) {
        if (needed.has(key)) {
          unneededSince.delete(key);
          continue;
        }
        const since = unneededSince.get(key);
        if (since === undefined) {
          unneededSince.set(key, now);
          continue;
        }
        if (now - since < deps.idleMs) continue;
        unneededSince.delete(key);
        deps.stop(key);
      }
    },
  };
}
