import { describe, expect, it } from "vitest";
import { ARROW_STEP_PX, arrowsFor } from "./arrow-pad";

describe("arrowsFor", () => {
  it("sends one arrow per step along the axis that moved more", () => {
    expect(arrowsFor(ARROW_STEP_PX * 2 + 5, 4)).toEqual({
      arrows: ["right", "right"],
      used: { x: ARROW_STEP_PX * 2, y: 0 },
    });
    expect(arrowsFor(3, -ARROW_STEP_PX)).toEqual({
      arrows: ["up"],
      used: { x: 0, y: -ARROW_STEP_PX },
    });
    expect(arrowsFor(-ARROW_STEP_PX, 0).arrows).toEqual(["left"]);
    expect(arrowsFor(0, ARROW_STEP_PX * 3).arrows).toEqual(["down", "down", "down"]);
  });

  it("sends nothing short of a step, and keeps the rest for the next move", () => {
    expect(arrowsFor(ARROW_STEP_PX - 1, 0)).toEqual({ arrows: [], used: { x: 0, y: 0 } });
  });
});
