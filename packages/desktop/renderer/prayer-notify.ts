import type { PrayerConfig } from "../src/config.js";

/** `prayer.notify`'s resolved shape — always concrete (never a partial
 *  object), the same way `location` resolves against Alexandria at the
 *  point of use rather than at parse time. Kept as a plain object type
 *  (not re-exported from config.ts) so this module never needs a runtime
 *  import of config.ts, which pulls in node:fs/node:path/node:os — the
 *  same reason prayer.ts keeps its own ALEXANDRIA literal instead of
 *  importing one from config.ts. */
export type PrayerNotifyConfig = {
  before: boolean;
  beforeMinutes: number;
  atTime: boolean;
};

export const DEFAULT_PRAYER_NOTIFY: PrayerNotifyConfig = {
  before: true,
  beforeMinutes: 10,
  atTime: true,
};

/** The subset of `nextPrayer`'s return value the decision needs. Declared
 *  locally rather than imported from prayer.ts so the dependency runs one
 *  way only (prayer.ts imports this module, not the reverse). */
export type PrayerTickState = {
  name: string;
  remaining: number;
  previousName: string;
  sincePrevious: number;
};

export type DuePrayerNotification = {
  kind: "before" | "at";
  /** Fajr/Dhuhr/Asr/Maghrib/Isha — MESSAGES.prayerName resolves it. */
  name: string;
  /** Epoch ms of the prayer instant this notification is about; also half
   *  of its dedupe key (with `kind`), so the same instant never fires the
   *  same kind of notification twice. */
  time: number;
};

// Shorter than the header chip's own 5-minute "now" window (prayer.ts) —
// "Maghrib now" arriving several minutes late would read as a stale
// notification, not a timely one.
const AT_WINDOW_MS = 60_000;
// Dedupe keys are pruned once they are this old so `fired` cannot grow
// unbounded over an app that stays open for weeks.
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * What to fire *this* tick, given `now`/`prayerState`/`config` and the set
 * of dedupe keys already fired. The only side effect is on `fired` itself:
 * it adds the keys this call returns and prunes stale ones, so the
 * caller's one long-lived Map is the entire "already fired" memory — no
 * module state lives in this file, which keeps every case below a fresh
 * Map and a fixed `now` away from any other test.
 *
 * Deliberately time-based rather than "did remaining cross a threshold
 * since the last tick": there is no previous tick on the very first call
 * after launch, so a delta-based version would have to invent one.
 * Comparing `now` against the absolute prayer times instead means a long-
 * past event (hours ago, e.g. before the app was even open) never
 * satisfies either window on any tick — nothing to special-case for
 * startup.
 *
 * "before" only ever targets the *next* (future) prayer — `remaining > 0`
 * is nextPrayer's own contract for "next" — and "at" only ever targets the
 * *previous* (past) one, so the two kinds can never both fire for the same
 * prayer instant on the same tick.
 */
export function duePrayerNotifications(
  now: Date,
  prayerState: PrayerTickState,
  config: PrayerConfig,
  fired: Map<string, number>,
): DuePrayerNotification[] {
  const nowMs = now.getTime();
  pruneFired(fired, nowMs);
  if (!config.enabled) return [];
  const notify = config.notify ?? DEFAULT_PRAYER_NOTIFY;
  const notifications: DuePrayerNotification[] = [];

  if (
    notify.before &&
    prayerState.remaining > 0 &&
    prayerState.remaining <= notify.beforeMinutes * 60_000
  ) {
    const time = nowMs + prayerState.remaining;
    const key = `before:${time}`;
    if (!fired.has(key)) {
      fired.set(key, time);
      notifications.push({ kind: "before", name: prayerState.name, time });
    }
  }

  if (
    notify.atTime &&
    prayerState.sincePrevious >= 0 &&
    prayerState.sincePrevious <= AT_WINDOW_MS
  ) {
    const time = nowMs - prayerState.sincePrevious;
    const key = `at:${time}`;
    if (!fired.has(key)) {
      fired.set(key, time);
      notifications.push({ kind: "at", name: prayerState.previousName, time });
    }
  }

  return notifications;
}

function pruneFired(fired: Map<string, number>, nowMs: number): void {
  for (const [key, time] of fired) {
    if (nowMs - time > PRUNE_AFTER_MS) fired.delete(key);
  }
}
