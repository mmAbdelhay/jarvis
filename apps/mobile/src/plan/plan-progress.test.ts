import { describe, expect, it } from "vitest";
import { planProgressOf } from "./plan-progress";

describe("planProgressOf", () => {
  it("reads done and total", () => {
    expect(planProgressOf({ progress: { done: 3, total: 7 } })).toEqual({ done: 3, total: 7 });
  });

  it("reads nothing from a doc without a sound count", () => {
    expect(planProgressOf({ blocks: [] })).toBeUndefined();
    expect(planProgressOf({ progress: { done: 8, total: 7 } })).toBeUndefined();
    expect(planProgressOf({ progress: { done: 0, total: 0 } })).toBeUndefined();
    expect(planProgressOf({ progress: { done: "1", total: 2 } })).toBeUndefined();
    expect(planProgressOf(undefined)).toBeUndefined();
  });
});
