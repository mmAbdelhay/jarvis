// Two independent throttles the `/rpc` side leans on before it ever calls a
// handler: a per-connection sliding-window request limiter (rule 5/6), and a
// per-source auth-failure backoff the hub consults before a socket is even
// handed a `Connection` (rule 10). Both are pure over an injected `Clock` —
// no timers of their own, since a limiter only ever needs "what time is it
// right now", never "call me later".

import type { Clock } from "./io.js";
import { MAX_REQUESTS_PER_WINDOW, REQUEST_WINDOW_MS } from "./protocol.js";

export const AUTH_BACKOFF_BASE_MS = 1_000;
export const AUTH_BACKOFF_MAX_MS = 60_000;
export const MAX_TRACKED_SOURCES = 1024;

export type RateLimiter = { take(): boolean };

/**
 * A sliding log of at most `max` timestamps (rule 1): `take()` first drops
 * every stamp that has aged out (`stamp <= now - windowMs`), then allows the
 * call — and records `now()` — only if fewer than `max` stamps remain.
 */
export function createRateLimiter(
  now: Clock,
  windowMs: number = REQUEST_WINDOW_MS,
  max: number = MAX_REQUESTS_PER_WINDOW,
): RateLimiter {
  const stamps: number[] = [];

  return {
    take() {
      const cutoff = now() - windowMs;
      while (stamps.length > 0 && (stamps[0] as number) <= cutoff) stamps.shift();
      if (stamps.length >= max) return false;
      stamps.push(now());
      return true;
    },
  };
}

export type AuthBackoff = {
  isBlocked(source: string): boolean;
  fail(source: string): void;
  succeed(source: string): void;
  /** I4: true the first time it is called for a source's current block
   *  period, false on every call after — the hub's own "log at most one
   *  `auth-failed backoff` audit line per source per block period" without
   *  a second, unbounded tracking structure of its own: the flag lives on
   *  the exact same per-source `Entry` this file already caps at
   *  `MAX_TRACKED_SOURCES` and already evicts/deletes on `fail()`'s
   *  eviction and `succeed()`. */
  shouldLogBlocked(source: string): boolean;
  /** Test-only: how many sources are currently tracked, for asserting the
   *  eviction cap actually holds rather than trusting it from the outside. */
  size(): number;
};

type Entry = { failures: number; blockedUntil: number; logged: boolean };

/**
 * Per-source auth-failure backoff (rule 2): the delay after the nth
 * consecutive failure is `min(60_000, 1_000 * 2^(n-1))` — 1s, 2s, 4s, ...,
 * capped at 60s. Failures are tracked in a `Map`, deleted and re-set on
 * every `fail()` so insertion order tracks recency; once a genuinely new
 * source would push the map past `MAX_TRACKED_SOURCES` entries, the oldest
 * (first) key is evicted. `succeed()` deletes the source outright.
 */
export function createAuthBackoff(now: Clock): AuthBackoff {
  const sources = new Map<string, Entry>();

  return {
    isBlocked(source) {
      const entry = sources.get(source);
      return entry !== undefined && now() < entry.blockedUntil;
    },

    fail(source) {
      const previous = sources.get(source);
      const isNewSource = previous === undefined;
      const failures = (previous?.failures ?? 0) + 1;
      const delay = Math.min(AUTH_BACKOFF_MAX_MS, AUTH_BACKOFF_BASE_MS * 2 ** (failures - 1));

      // Delete-then-set (rather than an in-place update) so this source's
      // key moves to the end of the map's iteration order, marking it most
      // recently active for the eviction below. `logged: false` — a fresh
      // failure always (re-)starts a new block period, which gets its own
      // shouldLogBlocked() line again.
      sources.delete(source);
      sources.set(source, { failures, blockedUntil: now() + delay, logged: false });

      if (isNewSource && sources.size > MAX_TRACKED_SOURCES) {
        const oldest = sources.keys().next().value;
        if (oldest !== undefined) sources.delete(oldest);
      }
    },

    succeed(source) {
      sources.delete(source);
    },

    shouldLogBlocked(source) {
      const entry = sources.get(source);
      if (entry === undefined || now() >= entry.blockedUntil || entry.logged) return false;
      entry.logged = true;
      return true;
    },

    size() {
      return sources.size;
    },
  };
}
