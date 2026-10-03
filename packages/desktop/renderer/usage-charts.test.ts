// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { capacitySparkline, renderSessionsChart } from "./usage-charts.js";

const HOUR = 60 * 60 * 1000;
const now = new Date(2026, 9, 2, 15, 0).getTime();

describe("capacitySparkline", () => {
  it("draws nothing for fewer than two readings — one dot is not a history", () => {
    expect(capacitySparkline([], now)).toBeUndefined();
    expect(capacitySparkline([{ at: now, left: 40 }], now)).toBeUndefined();
  });

  it("draws one line through every reading, each hoverable for its value", () => {
    const chart = capacitySparkline(
      [
        { at: now - 6 * HOUR, left: 90 },
        { at: now - 3 * HOUR, left: 55.6 },
        { at: now, left: 10 },
      ],
      now,
    );
    if (chart === undefined) throw new Error("expected a chart");
    const line = chart.querySelector("polyline");
    expect(line?.getAttribute("points")?.split(" ")).toHaveLength(3);
    const titles = [...chart.querySelectorAll("title")].map((title) => title.textContent);
    expect(titles).toHaveLength(3);
    expect(titles[1]).toContain("55");
    expect(chart.getAttribute("aria-label")).not.toBe("");
  });

  it("places a fuller account higher on the same fixed scale", () => {
    const chart = capacitySparkline(
      [
        { at: now - HOUR, left: 100 },
        { at: now, left: 0 },
      ],
      now,
    );
    const [full, empty] = (chart?.querySelector("polyline")?.getAttribute("points") ?? "")
      .split(" ")
      .map((pair) => Number(pair.split(",")[1]));
    expect(full).toBeLessThan(empty ?? 0);
  });
});

describe("renderSessionsChart", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="sessions-chart"></div>';
  });

  const day = (offset: number, count: number) => ({
    day: new Date(2026, 9, 2 - offset).getTime(),
    count,
  });

  it("draws a column per day, a baseline tick for an empty one, and labels the total", () => {
    renderSessionsChart([day(2, 0), day(1, 3), day(0, 1)]);
    const host = document.getElementById("sessions-chart");
    expect(host?.querySelectorAll(".usage-bars__bar")).toHaveLength(2);
    expect(host?.querySelectorAll(".usage-bars__empty")).toHaveLength(1);
    expect(host?.querySelectorAll("title")).toHaveLength(3);
    expect(host?.getAttribute("aria-label")).toContain("4");
  });

  it("scales the tallest day to the full height", () => {
    renderSessionsChart([day(1, 2), day(0, 4)]);
    const heights = [...document.querySelectorAll(".usage-bars__bar")].map((bar) =>
      Number(bar.getAttribute("height")),
    );
    expect(heights[1]).toBe(18);
    expect(heights[0]).toBe(9);
  });

  it("empties for no data rather than drawing a blank chart", () => {
    renderSessionsChart([day(0, 1)]);
    renderSessionsChart([]);
    expect(document.getElementById("sessions-chart")?.childElementCount).toBe(0);
  });
});
