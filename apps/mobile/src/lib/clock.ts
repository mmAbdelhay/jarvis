// A tiny seam over time so every timer in the RPC client (Task 4) and its
// tests goes through one injectable interface — no `setTimeout`/`Date.now`
// calls sprinkled through the client, and no real timers in tests.

export type Clock = {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type PendingTimer = { fireAt: number; seq: number; fn: () => void };

/**
 * A controllable clock for tests: `advance(ms)` moves time forward and
 * fires every timer due at or before the new time, in due-time order and,
 * for timers due at the same time, in the order they were scheduled. A
 * timer's callback may schedule further timers (e.g. the next reconnect
 * attempt) — those are picked up by the same `advance` call if they fall
 * within its window.
 */
export function createFakeClock(): Clock & { advance(ms: number): void; now(): number } {
  let currentTime = 0;
  let nextHandle = 1;
  let nextSeq = 0;
  const timers = new Map<number, PendingTimer>();

  function fakeSetTimeout(fn: () => void, ms: number): unknown {
    const handle = nextHandle++;
    timers.set(handle, { fireAt: currentTime + Math.max(0, ms), seq: nextSeq++, fn });
    return handle;
  }

  function fakeClearTimeout(handle: unknown): void {
    timers.delete(handle as number);
  }

  function advance(ms: number): void {
    const target = currentTime + ms;
    for (;;) {
      let dueHandle: number | undefined;
      let due: PendingTimer | undefined;
      for (const [handle, timer] of timers) {
        if (timer.fireAt > target) continue;
        if (
          due === undefined ||
          timer.fireAt < due.fireAt ||
          (timer.fireAt === due.fireAt && timer.seq < due.seq)
        ) {
          due = timer;
          dueHandle = handle;
        }
      }
      if (due === undefined || dueHandle === undefined) break;
      timers.delete(dueHandle);
      currentTime = due.fireAt;
      due.fn();
    }
    currentTime = target;
  }

  return {
    now: () => currentTime,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    advance,
  };
}
