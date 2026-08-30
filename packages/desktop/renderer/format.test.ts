import { describe, expect, it } from "vitest";
import { detectLanguage, formatBytes, formatUptime } from "./format.js";

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
