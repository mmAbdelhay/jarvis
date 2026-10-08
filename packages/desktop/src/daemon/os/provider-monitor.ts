// provider:status (contracts §3.2): whether the model provider answers. It
// pushes only on change; while unreachable it re-checks every 30 s, which is
// how the shell learns the network doctor's fix (or a cable) worked. Turns
// report what they saw, so a dead provider shows up without waiting.
//
// No electron here (core/no-electron.test.ts).
import type { ProviderReachability } from "@jarvis/core";

export const UNREACHABLE_RECHECK_MS = 30_000;

export type ProviderMonitor = {
  start(): void;
  stop(): void;
  recheck(): Promise<ProviderReachability>;
  reportOk(): void;
  reportFailure(error: string): void;
  current(): ProviderReachability | undefined;
};

export function createProviderMonitor(deps: {
  check(): Promise<{ ok: boolean; error?: string }>;
  push(status: ProviderReachability): void;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
}): ProviderMonitor {
  let current: ProviderReachability | undefined;
  let timer: unknown;
  let stopped = false;

  const clear = () => {
    if (timer !== undefined) deps.timers.clearTimeout(timer);
    timer = undefined;
  };

  function set(status: ProviderReachability): void {
    if (stopped) return;
    const changed =
      current === undefined ||
      current.reachable !== status.reachable ||
      current.error !== status.error;
    current = status;
    if (changed) deps.push(status);
    clear();
    if (!status.reachable) {
      timer = deps.timers.setTimeout(() => {
        timer = undefined;
        void recheck();
      }, UNREACHABLE_RECHECK_MS);
    }
  }

  async function recheck(): Promise<ProviderReachability> {
    let status: ProviderReachability;
    try {
      const result = await deps.check();
      status = result.ok
        ? { reachable: true, activeId: null, fallbackReason: null }
        : {
            reachable: false,
            error: result.error ?? "unreachable",
            activeId: null,
            fallbackReason: null,
          };
    } catch (error) {
      status = {
        reachable: false,
        error: error instanceof Error ? error.message : String(error),
        activeId: null,
        fallbackReason: null,
      };
    }
    set(status);
    return status;
  }

  return {
    start() {
      void recheck();
    },
    stop() {
      stopped = true;
      clear();
    },
    recheck,
    reportOk: () => set({ reachable: true, activeId: null, fallbackReason: null }),
    reportFailure: (error) =>
      set({ reachable: false, error, activeId: null, fallbackReason: null }),
    current: () => current,
  };
}
