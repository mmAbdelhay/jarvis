import { describe, expect, it } from "vitest";
import {
  type CapacityCard,
  capacityFor,
  capacityTone,
  parseProviderCapacity,
  resetLabel,
} from "./home-capacity";

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

describe("weekly capacity", () => {
  function payload(secondary?: unknown) {
    return [
      {
        id: "claude-main",
        vendor: "anthropic",
        capacity: {
          state: "known",
          primary: { usedPercent: 37.6, resetsAt: "2026-10-03T14:00:00Z" },
          ...(secondary === undefined ? {} : { secondary }),
        },
      },
    ];
  }

  it("secondary window parsed into weekLeft", () => {
    for (const [usedPercent, left] of [
      [37.6, 62],
      [-10, 100],
      [120, 0],
    ]) {
      expect(parseProviderCapacity(payload({ usedPercent }))[0]?.weekLeft).toBe(left);
    }
  });

  it("payload without secondary still parses (weekLeft undefined)", () => {
    for (const secondary of [
      undefined,
      null,
      {},
      { usedPercent: "20" },
      { usedPercent: NaN },
      { usedPercent: Infinity },
    ]) {
      const cards = parseProviderCapacity(payload(secondary));
      expect(cards).toHaveLength(1);
      expect(cards[0]?.left).toBe(62);
      expect(cards[0]?.weekLeft).toBeUndefined();
    }
  });

  it("capacityFor anthropic", () => {
    expect(
      capacityFor([card({ id: "codex", left: 10 }), card({ weekLeft: 75 })], "anthropic"),
    ).toEqual({ sessionUsed: 38, weekUsed: 25 });
    expect(capacityFor(parseProviderCapacity(payload({ usedPercent: 20 })), "anthropic")).toEqual({
      sessionUsed: 38,
      weekUsed: 20,
    });
    expect(capacityFor([card({})], "anthropic")).toEqual({ sessionUsed: 38 });
    expect(capacityFor([], "anthropic")).toEqual({});
    expect(capacityFor([card({ id: "codex" })], "anthropic")).toEqual({});
  });
});
