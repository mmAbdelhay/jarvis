import { describe, expect, it } from "vitest";
import { type CapacityCard, capacityTone, resetLabel } from "./home-capacity";

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
function card(overrides: Partial<CapacityCard>): CapacityCard {
  return { id: "Claude", window: "5h", left: 62, resetsAt: NOW + 100 * 60_000, ...overrides };
}

describe("resetLabel", () => {
  it("shows the time left for a 5h window", () => {
    expect(resetLabel(card({}), NOW, "en")).toBe("resets in 1h 40m");
  });

  it("shows a date for the month window", () => {
    const label = resetLabel(
      card({ window: "month", resetsAt: Date.UTC(2026, 10, 1, 12) }),
      NOW,
      "en",
    );
    expect(label).toBe("resets Nov 1");
  });

  it("shows a date for a reset 48 hours or more away", () => {
    expect(resetLabel(card({ resetsAt: NOW + 49 * 3_600_000 }), NOW, "en")).toBe("resets Oct 5");
  });

  it("says due once passed", () => {
    expect(resetLabel(card({ resetsAt: NOW - 1 }), NOW, "en")).toBe("reset due");
  });
});

describe("capacityTone", () => {
  it("uses accent for 5h and success for month", () => {
    expect(capacityTone(card({}))).toBe("accent");
    expect(capacityTone(card({ window: "month", left: 38 }))).toBe("success");
  });

  it("warns at 30 or less and goes danger at 10 or less", () => {
    expect(capacityTone(card({ left: 30, window: "month" }))).toBe("warning");
    expect(capacityTone(card({ left: 10 }))).toBe("danger");
  });
});
