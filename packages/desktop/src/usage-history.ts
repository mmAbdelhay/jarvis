import type { CapacitySample, Session } from "@jarvis/core";

/** What the Dashboard's usage charts draw. Built here, in main, so the
 *  renderer never sees a raw sample table or a session row it does not
 *  need — only the points it plots. */
export type UsageHistory = {
  /** Per account, its primary window's remaining percent over the last
   *  CAPACITY_WINDOW_MS, oldest first. Accounts with no reading in the
   *  window are left out. */
  capacity: { id: string; points: { at: number; left: number }[] }[];
  /** Sessions started on each of the last SESSION_DAYS local days, oldest
   *  first, every day present — a day with none is a 0, not a gap. `day`
   *  is that day's local midnight in epoch ms. */
  sessionsPerDay: { day: number; count: number }[];
};

export const CAPACITY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const SESSION_DAYS = 14;

/** Local midnight of the day `at` falls in. */
function startOfDay(at: number): number {
  const date = new Date(at);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function buildUsageHistory(
  samples: readonly CapacitySample[],
  sessions: readonly Pick<Session, "startedAt">[],
  now: number,
): UsageHistory {
  const byId = new Map<string, { at: number; left: number }[]>();
  for (const sample of samples) {
    if (sample.at < now - CAPACITY_WINDOW_MS || sample.at > now) continue;
    const left = Math.max(0, Math.min(100, 100 - sample.usedPercent));
    const points = byId.get(sample.id) ?? [];
    points.push({ at: sample.at, left });
    byId.set(sample.id, points);
  }
  const capacity = [...byId.entries()].map(([id, points]) => ({
    id,
    points: points.sort((a, b) => a.at - b.at),
  }));

  // Day boundaries walk by calendar date, not by 24h steps, so a day
  // with a daylight-saving change is still exactly one bar.
  const days: number[] = [];
  const cursor = new Date(startOfDay(now));
  for (let i = 0; i < SESSION_DAYS; i++) {
    days.unshift(cursor.getTime());
    cursor.setDate(cursor.getDate() - 1);
  }
  const counts = new Map(days.map((day) => [day, 0]));
  for (const session of sessions) {
    const day = startOfDay(session.startedAt);
    const count = counts.get(day);
    if (count !== undefined) counts.set(day, count + 1);
  }
  return {
    capacity,
    sessionsPerDay: days.map((day) => ({ day, count: counts.get(day) ?? 0 })),
  };
}
