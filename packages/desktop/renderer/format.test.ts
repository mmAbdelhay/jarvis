import { describe, expect, it } from "vitest";
import { detectLanguage, formatAgo, formatBytes, formatDiskUsage, formatEndedAt, formatUptime } from "./format.js";

describe("formatBytes", () => {
  it("formats gigabytes with one decimal", () => {
    expect(formatBytes(21_474_836_480)).toBe("21.5 GB");
  });

  it("formats terabytes", () => {
    expect(formatBytes(1_099_511_627_776)).toBe("1.1 TB");
  });

  it("formats zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });
});

describe("formatUptime", () => {
  it("formats days and hours", () => {
    expect(formatUptime(367_200)).toBe("4d 06h");
  });

  it("formats hours and minutes below a day", () => {
    expect(formatUptime(3_900)).toBe("1h 05m");
  });

  it("formats minutes below an hour", () => {
    expect(formatUptime(120)).toBe("2m");
  });
});

describe("formatDiskUsage", () => {
  it("shows the unit once, on the total, using the total's unit for the used value", () => {
    expect(formatDiskUsage(335_007_449_088, 1_067_755_798_528)).toEqual({
      used: "0.3",
      total: "/ 1.1 TB",
    });
  });

  it("matches the artboard's single-line GB pattern", () => {
    expect(formatDiskUsage(312_000_000_000, 994_000_000_000)).toEqual({
      used: "312.0",
      total: "/ 994.0 GB",
    });
  });

  it("handles zero used bytes", () => {
    expect(formatDiskUsage(0, 994_000_000_000)).toEqual({
      used: "0",
      total: "/ 994.0 GB",
    });
  });
});

describe("detectLanguage", () => {
  it("detects Arabic script", () => {
    expect(detectLanguage("افتح مشروع سعودي سيل")).toBe("ar");
  });

  it("detects English", () => {
    expect(detectLanguage("run the tests")).toBe("en");
  });

  it("treats mixed text with any Arabic as Arabic", () => {
    expect(detectLanguage("run الاختبارات now")).toBe("ar");
  });

  it("treats digits and punctuation as English", () => {
    expect(detectLanguage("123 !?")).toBe("en");
  });

  it("treats empty input as English", () => {
    expect(detectLanguage("")).toBe("en");
  });
});

describe("formatAgo", () => {
  const now = 1_700_000_000_000;

  it("counts minutes and hours the way the artboard does", () => {
    expect(formatAgo(now - 6 * 60_000, now)).toBe("6m ago");
    expect(formatAgo(now - 90 * 60_000, now)).toBe("1h ago");
    expect(formatAgo(now - 50 * 60 * 60_000, now)).toBe("2d ago");
  });

  it("says just now under a minute, and never shows a negative age", () => {
    expect(formatAgo(now - 5_000, now)).toBe("just now");
    expect(formatAgo(now + 60_000, now)).toBe("just now");
  });
});

describe("formatEndedAt", () => {
  // Exact wall-clock text is timezone-dependent (CI may run in any TZ), so
  // this asserts the shape rather than a fixed string.
  it("formats as a two-digit day, short month, and 24h time", () => {
    expect(formatEndedAt(Date.UTC(2026, 7, 30, 18, 42))).toMatch(
      /^\d{2} \w{3} · \d{2}:\d{2}$/,
    );
  });
});
