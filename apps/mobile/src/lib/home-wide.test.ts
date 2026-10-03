import { describe, expect, it } from "vitest";
import {
  bannerFits,
  homeSubtitle,
  meterTone,
  PROJECT_TOOLS,
  tileDays,
  tileWidth,
  todayCount,
} from "./home-wide";

describe("meterTone", () => {
  it("is accent below 70, warning from 70, danger from 90", () => {
    expect(meterTone(34)).toBe("accent");
    expect(meterTone(71)).toBe("warning");
    expect(meterTone(95)).toBe("danger");
  });
});

describe("homeSubtitle", () => {
  it("joins the waiting text and the connection", () => {
    expect(homeSubtitle("en", 1, "MacBook connected")).toBe(
      "1 waiting for your answer · MacBook connected",
    );
  });
  it("shows the all-clear text with nothing waiting, and no connection text", () => {
    expect(homeSubtitle("en", 0, undefined)).toBe("Nothing needs you right now");
  });
});

describe("tiles", () => {
  it("takes today from the last bucket", () => {
    expect(todayCount([1, 2, 6])).toBe(6);
    expect(todayCount([])).toBe(0);
  });
  it("pads the days to a full row", () => {
    expect(tileDays([3], 4)).toEqual([0, 0, 0, 3]);
    expect(tileDays([1, 2, 3, 4, 5], 4)).toEqual([2, 3, 4, 5]);
  });
  it("splits the row width between the tiles", () => {
    expect(tileWidth(1000, 4, 14)).toBe(239);
    expect(tileWidth(500, 2, 14)).toBe(243);
  });
});

describe("banner and tools", () => {
  it("uses the banner for three options or fewer", () => {
    expect(bannerFits(3)).toBe(true);
    expect(bannerFits(4)).toBe(false);
  });
  it("keeps the project tools in order", () => {
    expect(PROJECT_TOOLS).toEqual(["terminal", "docker", "api", "editor"]);
  });
});
