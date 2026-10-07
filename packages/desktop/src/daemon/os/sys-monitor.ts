// Drives sys:snapshot (contracts §6 #8): one collection at start, then every
// 10 s (pushed each time, so a shell always has a fresh one), plus refresh()
// after something changed (a provider save, a doctor run), which pushes only
// when the snapshot differs. Collections never overlap: net.status pings and
// resolves, and a slow one must not pile up.
//
// No electron here (core/no-electron.test.ts).
import type { SysSnapshot } from "@jarvis/core";

export const SYS_SNAPSHOT_INTERVAL_MS = 10_000;

export type SysMonitor = {
  start(): void;
  stop(): void;
  refresh(): Promise<void>;
  current(): SysSnapshot | undefined;
};

export function createSysMonitor(deps: {
  collect(): Promise<SysSnapshot>;
  push(snapshot: SysSnapshot): void;
  timers: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  log(line: string): void;
  intervalMs?: number;
}): SysMonitor {
  let current: SysSnapshot | undefined;
  let handle: unknown;
  let busy = false;
  let stopped = false;

  async function collect(always: boolean): Promise<void> {
    if (busy || stopped) return;
    busy = true;
    try {
      const next = await deps.collect();
      const changed = JSON.stringify(next) !== JSON.stringify(current);
      current = next;
      if (always || changed) deps.push(next);
    } catch (error) {
      deps.log(`[sys] snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      void collect(true);
      handle = deps.timers.setInterval(
        () => void collect(true),
        deps.intervalMs ?? SYS_SNAPSHOT_INTERVAL_MS,
      );
    },
    stop() {
      stopped = true;
      if (handle !== undefined) deps.timers.clearInterval(handle);
    },
    refresh: () => collect(false),
    current: () => current,
  };
}
