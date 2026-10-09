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
  /** The failover provider switched: re-push if activeId/fallbackReason changed. */
  noteActive(): void;
  current(): ProviderReachability | undefined;
};

type Base = { reachable: boolean; error?: string };
const NO_ACTIVE = { activeId: null, fallbackReason: null };

export function createProviderMonitor(deps: {
  check(): Promise<{ ok: boolean; error?: string }>;
  /** M2.5 §2: which provider answers and why it is not the first. */
  active?(): { activeId: string | null; fallbackReason: string | null };
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

  function set(base: Base): void {
    if (stopped) return;
    const status: ProviderReachability = { ...base, ...(deps.active?.() ?? NO_ACTIVE) };
    const changed =
      current === undefined ||
      current.reachable !== status.reachable ||
      current.error !== status.error ||
      current.activeId !== status.activeId ||
      current.fallbackReason !== status.fallbackReason;
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
    let base: Base;
    try {
      const result = await deps.check();
      base = result.ok
        ? { reachable: true }
        : { reachable: false, error: result.error ?? "unreachable" };
    } catch (error) {
      base = { reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
    set(base);
    return current ?? { ...base, ...NO_ACTIVE };
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
    reportOk: () => set({ reachable: true }),
    reportFailure: (error) => set({ reachable: false, error }),
    noteActive() {
      if (current === undefined) return;
      set({
        reachable: current.reachable,
        ...(current.error === undefined ? {} : { error: current.error }),
      });
    },
    current: () => current,
  };
}
