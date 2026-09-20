import { describe, expect, it } from "vitest";
import { firstRowTargets, threadOrigin, threadPath, threadPaths } from "./link-layout.js";

const CARD = { top: 400, left: 20, width: 180, height: 104 };

describe("firstRowTargets", () => {
  it("keeps only the cards in the grid's first visible row band, as top-centre points", () => {
    const cards = [
      CARD,
      { ...CARD, left: 220 },
      { ...CARD, top: 530, left: 20 }, // second row
    ];
    expect(firstRowTargets(cards, 400)).toEqual([
      { x: 110, y: 400 },
      { x: 310, y: 400 },
    ]);
  });

  it("follows a scrolled row: whatever row occupies the band gets the threads", () => {
    // Grid scrolled 60px: row 1 sits above the band, row 2 inside it.
    const cards = [
      { ...CARD, top: 340 },
      { ...CARD, top: 470 },
    ];
    expect(firstRowTargets(cards, 400)).toEqual([{ x: 110, y: 470 }]);
  });

  it("is empty with no cards (filter matched nothing)", () => {
    expect(firstRowTargets([], 400)).toEqual([]);
  });
});

describe("threadOrigin", () => {
  it("leaves straight down for a card directly underneath", () => {
    const origin = threadOrigin({ x: 500, y: 300 }, 100, { x: 500, y: 600 });
    expect(origin.x).toBeCloseTo(500, 5);
    expect(origin.y).toBeCloseTo(400, 5);
  });

  it("moves along the lower arc toward an off-centre card, never past the clamp", () => {
    const left = threadOrigin({ x: 500, y: 300 }, 100, { x: 0, y: 600 });
    const farLeft = threadOrigin({ x: 500, y: 300 }, 100, { x: -5000, y: 600 });
    expect(left.x).toBeLessThan(500);
    expect(left.y).toBeLessThan(400);
    expect(farLeft.x).toBeCloseTo(500 - Math.cos(Math.PI / 2 - 0.55) * 100, 3);
  });
});

describe("threadPath", () => {
  it("is a cubic bézier arriving at the card straight up", () => {
    expect(threadPath({ x: 860, y: 300 }, { x: 110, y: 400 })).toBe(
      "M 860 300 C 770 355, 110 345, 110 400",
    );
  });

  it("keeps a minimum bend when the card is close under the origin", () => {
    expect(threadPath({ x: 100, y: 300 }, { x: 100, y: 310 })).toBe(
      "M 100 300 C 100 324, 100 286, 100 310",
    );
  });
});

describe("threadPaths", () => {
  it("builds one path per first-row card, each from its own arc origin", () => {
    // Centre between the two cards, so their leans differ; both far to one
    // side would clamp to the same arc point, which is fine visually.
    const paths = threadPaths(
      { centre: { x: 210, y: 200 }, radius: 100 },
      [CARD, { ...CARD, left: 220 }],
      400,
    );
    expect(paths).toHaveLength(2);
    const starts = paths.map((path) => path.split(" C ")[0]);
    expect(new Set(starts).size).toBe(2);
  });
});
