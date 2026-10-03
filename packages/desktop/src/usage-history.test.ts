import { describe, expect, it } from "vitest";
import { buildUsageHistory, CAPACITY_WINDOW_MS, SESSION_DAYS } from "./usage-history.js";

const HOUR = 60 * 60 * 1000;
const now = new Date(2026, 9, 2, 15, 0, 0).getTime();

describe("buildUsageHistory", () => {
  it("turns readings into remaining percent per account, in order, within the window", () => {
    const history = buildUsageHistory(
      [
        { id: "claude", at: now - 2 * HOUR, usedPercent: 70 },
        { id: "claude", at: now - 5 * HOUR, usedPercent: 20 },
        { id: "codex", at: now - HOUR, usedPercent: 105 },
        { id: "claude", at: now - CAPACITY_WINDOW_MS - 1, usedPercent: 1 },
      ],
      [],
      now,
    );
    expect(history.capacity).toEqual([
      {
        id: "claude",
        points: [
          { at: now - 5 * HOUR, left: 80 },
          { at: now - 2 * HOUR, left: 30 },
        ],
      },
      { id: "codex", points: [{ at: now - HOUR, left: 0 }] },
    ]);
  });

  it("counts sessions per local day over the last two weeks, with every day present", () => {
    const today = new Date(2026, 9, 2).getTime();
    const yesterday = new Date(2026, 9, 1).getTime();
    const history = buildUsageHistory(
      [],
      [
        { startedAt: today + HOUR },
        { startedAt: today + 2 * HOUR },
        { startedAt: yesterday + 3 * HOUR },
        { startedAt: new Date(2026, 7, 1).getTime() },
      ],
      now,
    );
    expect(history.sessionsPerDay).toHaveLength(SESSION_DAYS);
    expect(history.sessionsPerDay.at(-1)).toEqual({ day: today, count: 2 });
    expect(history.sessionsPerDay.at(-2)).toEqual({ day: yesterday, count: 1 });
    expect(history.sessionsPerDay.slice(0, -2).every((entry) => entry.count === 0)).toBe(true);
  });
});
