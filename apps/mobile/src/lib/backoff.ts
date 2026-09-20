// Reconnect backoff for the RPC client (Task 4): 1 000ms doubling to a
// 30 000ms cap, with +-20% jitter so many phones reconnecting at once don't
// all hit the laptop in lockstep. `random` is injected so tests get exact,
// reproducible delays.

const INITIAL_DELAY_MS = 1_000;
const CAP_MS = 30_000;
const JITTER_FRACTION = 0.2;

export function createBackoff(random: () => number): { next(): number; reset(): void } {
  let attempt = 0;

  function next(): number {
    const base = Math.min(INITIAL_DELAY_MS * 2 ** attempt, CAP_MS);
    attempt += 1;
    const jitterRange = base * JITTER_FRACTION;
    const jitter = (random() * 2 - 1) * jitterRange;
    return Math.round(base + jitter);
  }

  function reset(): void {
    attempt = 0;
  }

  return { next, reset };
}
