// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { batteryState, initBattery, topbarDate, type BatteryLike } from "./topbar-status.js";

describe("topbarDate", () => {
  it("writes weekday, day and month", () => {
    expect(topbarDate(new Date(2026, 9, 20, 14, 5))).toBe("Tue 20 Oct");
  });
});

describe("batteryState", () => {
  it("is charging whenever plugged in, whatever the level", () => {
    expect(batteryState(0.05, true)).toBe("charging");
  });
  it("steps critical ≤10%, low ≤20%, mid ≤50%, good above", () => {
    expect(batteryState(0.1, false)).toBe("critical");
    expect(batteryState(0.2, false)).toBe("low");
    expect(batteryState(0.11, false)).toBe("low");
    expect(batteryState(0.21, false)).toBe("mid");
    expect(batteryState(0.5, false)).toBe("mid");
    expect(batteryState(0.51, false)).toBe("good");
  });
});

class FakeBattery extends EventTarget implements BatteryLike {
  constructor(
    public level: number,
    public charging: boolean,
  ) {
    super();
  }
}

describe("the topbar battery chip", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    const chip = document.createElement("span");
    chip.id = "battery-chip";
    chip.hidden = true;
    const text = document.createElement("span");
    text.id = "battery-text";
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const fill = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    fill.setAttribute("class", "battery-fill");
    svg.append(fill);
    chip.append(svg, text);
    document.body.append(chip);
  });

  const chip = (): HTMLElement => document.getElementById("battery-chip") as HTMLElement;

  it("shows the rounded percentage and its state", async () => {
    await initBattery({ getBattery: async () => new FakeBattery(0.876, false) });
    expect(chip().hidden).toBe(false);
    expect(document.getElementById("battery-text")?.textContent).toBe("88%");
    expect(chip().dataset.batteryState).toBe("good");
    expect(chip().querySelector(".battery-fill")?.getAttribute("width")).toBe("14.9");
    expect(chip().title).toContain("88%");
  });

  it("follows level and charging changes", async () => {
    const battery = new FakeBattery(0.5, false);
    await initBattery({ getBattery: async () => battery });
    battery.level = 0.08;
    battery.dispatchEvent(new Event("levelchange"));
    expect(document.getElementById("battery-text")?.textContent).toBe("8%");
    expect(chip().dataset.batteryState).toBe("critical");
    expect(chip().querySelector(".battery-fill")?.getAttribute("width")).toBe("1.4");
    battery.charging = true;
    battery.dispatchEvent(new Event("chargingchange"));
    expect(chip().dataset.batteryState).toBe("charging");
  });

  it("stays hidden when the API is missing or fails", async () => {
    await initBattery({});
    expect(chip().hidden).toBe(true);
    await initBattery({ getBattery: async () => Promise.reject(new Error("no")) });
    expect(chip().hidden).toBe(true);
  });
});
