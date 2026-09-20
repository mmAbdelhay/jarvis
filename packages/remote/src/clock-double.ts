// A fake Clock+Timers pair for tests: time only moves when a test calls
// `advance`, and every due callback fires with `now()` reporting its own
// scheduled time, not the final target — the same distinction a real
// `setTimeout` callback sees the instant it runs versus how far advance()
// was asked to jump.

import type { Clock, Timers } from "./io.js";

type ScheduledTimer = { id: number; at: number; callback: () => void };

export function fakeClock(start = 0): {
  now: Clock;
  timers: Timers;
  advance(ms: number): void;
  pending(): number;
} {
  let time = start;
  let nextId = 1;
  const scheduled = new Map<number, ScheduledTimer>();

  const timers: Timers = {
    setTimeout(callback, ms) {
      const id = nextId++;
      scheduled.set(id, { id, at: time + ms, callback });
      return id;
    },
    clearTimeout(handle) {
      scheduled.delete(handle as number);
    },
  };

  return {
    now: () => time,
    timers,

    advance(ms) {
      const target = time + ms;
      for (;;) {
        // The earliest-due timer still pending, ties broken by id (insertion
        // order) so two timers scheduled for the same instant fire in the
        // order they were set, like a real event loop's FIFO queue.
        let due: ScheduledTimer | undefined;
        for (const candidate of scheduled.values()) {
          if (candidate.at > target) continue;
          if (
            due === undefined ||
            candidate.at < due.at ||
            (candidate.at === due.at && candidate.id < due.id)
          ) {
            due = candidate;
          }
        }
        if (due === undefined) break;
        scheduled.delete(due.id);
        time = due.at;
        due.callback();
      }
      time = target;
    },

    pending: () => scheduled.size,
  };
}
