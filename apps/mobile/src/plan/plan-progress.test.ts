import { describe, expect, it } from "vitest";
import { currentStep, planProgressOf } from "./plan-progress";

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

describe("currentStep", () => {
  it("is the first unticked task item, without its markup", () => {
    const doc = {
      blocks: [
        { kind: "paragraph", source: "- [ ] not a list block" },
        { kind: "list", source: "- [x] Design it\n- [ ] Run **against** dev\n- [ ] Ship" },
      ],
    };
    expect(currentStep(doc)).toBe("Run against dev");
  });

  it("is undefined when everything is ticked or nothing is a task", () => {
    expect(currentStep({ blocks: [{ kind: "list", source: "- [x] a\n- plain" }] })).toBeUndefined();
    expect(currentStep({})).toBeUndefined();
  });
});
