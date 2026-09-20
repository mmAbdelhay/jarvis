import { describe, expect, it } from "vitest";
import {
  formatBytes,
  formatClockTime,
  formatMbps,
  formatPercent,
  formatSessionElapsed,
  formatTemperature,
  formatUptime,
} from "./format";
import { STRINGS } from "./i18n";

describe("formatBytes", () => {
  it("formats 0 bytes", () => {
    expect(formatBytes(0, "en")).toBe("0 B");
  });

  it("formats 1536 bytes as 1.5 KiB", () => {
    expect(formatBytes(1536, "en")).toBe("1.5 KiB");
  });

  it("formats exactly 8 GiB with no trailing decimal", () => {
    expect(formatBytes(8 * 1024 ** 3, "en")).toBe("8 GiB");
  });

  it("uses Latin digits in Arabic too", () => {
    expect(formatBytes(1536, "ar")).toBe("1.5 KiB");
  });

  it("never returns a negative or non-finite value", () => {
    expect(formatBytes(Number.NaN, "en")).toBe("0 B");
    expect(formatBytes(-5, "en")).toBe("0 B");
  });
});

describe("formatPercent", () => {
  it("rounds to the nearest integer", () => {
    expect(formatPercent(45.4)).toBe("45%");
    expect(formatPercent(45.5)).toBe("46%");
  });

  it("formats 0 and 100 exactly", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(100)).toBe("100%");
  });
});

describe("formatMbps", () => {
  it("formats a fractional value with one decimal", () => {
    expect(formatMbps(12.34, "en")).toBe("12.3 Mbps");
  });

  it("drops a trailing .0", () => {
    expect(formatMbps(3, "ar")).toBe("3 Mbps");
  });
});

describe("formatUptime", () => {
  it("formats 0 seconds as 0m", () => {
    expect(formatUptime(0, "en")).toBe("0m");
  });

  it("formats 59 seconds as 0m (whole minutes only)", () => {
    expect(formatUptime(59, "en")).toBe("0m");
  });

  it("formats exactly one hour as 1h 0m", () => {
    expect(formatUptime(3600, "en")).toBe("1h 0m");
  });

  it("formats a mixed day+hour duration, dropping minutes", () => {
    // 1 day, 2 hours, 3 minutes, 4 seconds
    expect(formatUptime(93784, "en")).toBe("1d 2h");
  });

  it("formats a plain hours+minutes duration", () => {
    // 3h 12m
    expect(formatUptime(3 * 3600 + 12 * 60, "en")).toBe("3h 12m");
  });
});

describe("formatTemperature", () => {
  it("returns the bilingual unavailable string when undefined", () => {
    expect(formatTemperature(undefined, "en")).toBe(STRINGS["metric.unavailable"].en);
    expect(formatTemperature(undefined, "ar")).toBe(STRINGS["metric.unavailable"].ar);
  });

  it("formats a rounded Celsius value with Latin digits", () => {
    expect(formatTemperature(45.6, "en")).toBe("46°C");
    expect(formatTemperature(45.6, "ar")).toBe("46°C");
  });
});

describe("formatSessionElapsed", () => {
  it("formats under an hour as plain minutes", () => {
    expect(formatSessionElapsed(0)).toBe("0m");
    expect(formatSessionElapsed(12 * 60_000)).toBe("12m");
  });

  it("formats an hour or more as Nh MMm, zero-padded", () => {
    expect(formatSessionElapsed(60 * 60_000)).toBe("1h 00m");
    expect(formatSessionElapsed(64 * 60_000)).toBe("1h 04m");
  });

  it("never returns a negative duration", () => {
    expect(formatSessionElapsed(-5_000)).toBe("0m");
    expect(formatSessionElapsed(Number.NaN)).toBe("0m");
  });
});

describe("formatClockTime", () => {
  it("formats local hours and minutes, zero-padded", () => {
    const date = new Date(2026, 0, 1, 9, 5);
    const expected = `${date.getHours().toString().padStart(2, "0")}:${date
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
    expect(formatClockTime(date.getTime())).toBe(expected);
  });

  it("falls back to epoch for a non-finite value", () => {
    const epoch = new Date(0);
    const expected = `${epoch.getHours().toString().padStart(2, "0")}:${epoch
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
    expect(formatClockTime(Number.NaN)).toBe(expected);
  });
});
