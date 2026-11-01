import { MESSAGES, PRIMARY_LANGUAGE } from "../src/messages.js";

// The topbar's ambient facts beside the clock: today's date and the battery.
// The battery comes from Chromium's Battery Status API (navigator.getBattery),
// so no main-process call or IPC channel is involved. A renderer without it
// (a test harness, a platform that doesn't expose it) keeps the chip hidden.

/** The part of BatteryManager this reads. */
export interface BatteryLike extends EventTarget {
  level: number;
  charging: boolean;
}

// Draining steps green (good) → amber (mid, low) → red (critical), so the
// chip says how much is left before the number is read.
export type BatteryState = "charging" | "good" | "mid" | "low" | "critical";

/** Inner width of the glyph's fill bar at 100% (viewBox units). */
const BATTERY_FILL_WIDTH = 17;

/** The topbar's date, e.g. "Tue 20 Oct" — en-GB like the clock beside it. */
export function topbarDate(now: Date): string {
  return now
    .toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })
    .replace(",", "");
}

export function batteryState(level: number, charging: boolean): BatteryState {
  if (charging) return "charging";
  if (level <= 0.1) return "critical";
  if (level <= 0.2) return "low";
  if (level <= 0.5) return "mid";
  return "good";
}

/** Wires #battery-chip. Absent markup or a missing/failing API is a no-op. */
export async function initBattery(nav: { getBattery?: () => Promise<BatteryLike> }): Promise<void> {
  const chip = document.getElementById("battery-chip");
  const text = document.getElementById("battery-text");
  const fill = chip?.querySelector<SVGRectElement>(".battery-fill") ?? null;
  if (chip === null || text === null || typeof nav.getBattery !== "function") return;

  let battery: BatteryLike;
  try {
    battery = await nav.getBattery();
  } catch {
    return;
  }

  const render = (): void => {
    const percent = Math.round(battery.level * 100);
    text.textContent = `${percent}%`;
    chip.dataset.batteryState = batteryState(battery.level, battery.charging);
    // The fill shrinks with the charge; a sliver stays at 1% so it never
    // reads as a missing glyph.
    const level = Math.min(1, Math.max(0, battery.level));
    fill?.setAttribute("width", Math.max(1, BATTERY_FILL_WIDTH * level).toFixed(1));
    const label = MESSAGES.batteryLabel(percent, battery.charging, PRIMARY_LANGUAGE);
    chip.title = label;
    chip.setAttribute("aria-label", label);
    chip.hidden = false;
  };

  render();
  battery.addEventListener("levelchange", render);
  battery.addEventListener("chargingchange", render);
}
