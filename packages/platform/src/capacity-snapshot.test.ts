import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSnapshotCapacityReader,
  parseRateLimitSnapshot,
  rateLimitSnapshotPath,
} from "./capacity-snapshot.js";

// Exactly what scripts/claude-usage-snapshot.sh writes.
const SNAPSHOT = JSON.stringify({
  five_hour_pct: 5,
  five_hour_resets_at: 1789924800,
  seven_day_pct: 72,
  seven_day_resets_at: 1790193600,
  updated_at: 1789910669,
});

describe("rateLimitSnapshotPath", () => {
  it("is <configDir>/usage/rate-limits.json", () => {
    // rateLimitSnapshotPath builds this with `join()` (platform-correct —
    // backslash-joined on win32), so the expected value is built the same
    // way rather than as a POSIX-literal regex.
    expect(rateLimitSnapshotPath("/home/u/.claude-work")).toBe(
      join("/home/u/.claude-work", "usage", "rate-limits.json"),
    );
  });
});

describe("parseRateLimitSnapshot", () => {
  it("reads both windows, converting epoch seconds to ISO instants, and carries updated_at as readAt (ms)", () => {
    expect(parseRateLimitSnapshot(SNAPSHOT)).toEqual({
      ok: true,
      primary: { usedPercent: 5, resetsAt: "2026-09-20T17:20:00.000Z" },
      secondary: { usedPercent: 72, resetsAt: "2026-09-23T20:00:00.000Z" },
      readAt: 1789910669000,
    });
  });

  it("keeps the five-hour figure when the seven-day window is null (the hook writes null for a missing figure)", () => {
    const text = JSON.stringify({
      five_hour_pct: 40,
      five_hour_resets_at: 1789924800,
      seven_day_pct: null,
      seven_day_resets_at: null,
      updated_at: 1789910669,
    });
    const reading = parseRateLimitSnapshot(text);
    expect(reading.ok).toBe(true);
    if (reading.ok) {
      expect(reading.primary.usedPercent).toBe(40);
      expect(reading.secondary).toBeUndefined();
    }
  });

  it("omits readAt when updated_at is missing, so the monitor falls back to its own clock", () => {
    const text = JSON.stringify({ five_hour_pct: 1, five_hour_resets_at: 1789924800 });
    const reading = parseRateLimitSnapshot(text);
    expect(reading.ok).toBe(true);
    expect(reading).not.toHaveProperty("readAt");
  });

  it.each([
    ["not JSON", "{nope"],
    ["an array", "[1,2]"],
    ["no five-hour window", JSON.stringify({ seven_day_pct: 3, seven_day_resets_at: 1789924800 })],
    [
      "a five-hour pct out of range",
      JSON.stringify({ five_hour_pct: 420, five_hour_resets_at: 1789924800 }),
    ],
    [
      "a five-hour pct that is a string",
      JSON.stringify({ five_hour_pct: "5", five_hour_resets_at: 1789924800 }),
    ],
    [
      "a five-hour reset that is not epoch seconds",
      JSON.stringify({ five_hour_pct: 5, five_hour_resets_at: "soon" }),
    ],
  ])("is unavailable — never a guess — for %s", (_label, text) => {
    expect(parseRateLimitSnapshot(text)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("rounds a fractional percentage", () => {
    const text = JSON.stringify({ five_hour_pct: 33.6, five_hour_resets_at: 1789924800 });
    const reading = parseRateLimitSnapshot(text);
    expect(reading.ok && reading.primary.usedPercent).toBe(34);
  });
});

describe("createSnapshotCapacityReader", () => {
  it("reads the account's own snapshot file and parses it", async () => {
    const seen: string[] = [];
    const read = createSnapshotCapacityReader({
      readFile: async (path) => {
        seen.push(path);
        return SNAPSHOT;
      },
    });
    const reading = await read("/home/u/.claude-work");
    expect(seen).toEqual([rateLimitSnapshotPath("/home/u/.claude-work")]);
    expect(reading.ok).toBe(true);
  });

  it("is unavailable, not a rejection, when the file is missing [bite-proof: let ENOENT escape and every account's refresh fails together]", async () => {
    const read = createSnapshotCapacityReader({
      readFile: async () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(read("/nowhere")).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("never touches the network or spawns anything: the only dependency is readFile", () => {
    // Structural: the factory takes readFile and nothing else.
    expect(createSnapshotCapacityReader.length).toBeLessThanOrEqual(1);
  });
});
