import { describe, expect, it } from "vitest";
import { mapLimit } from "./map-limit.js";

describe("mapLimit", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let inflight = 0;
    let peak = 0;
    const out = await mapLimit([30, 10, 20, 5, 1], 2, async (ms, index) => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inflight--;
      return `${index}:${ms}`;
    });
    expect(out).toEqual(["0:30", "1:10", "2:20", "3:5", "4:1"]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    await expect(mapLimit([], 4, async () => 1)).resolves.toEqual([]);
  });
});
