import { describe, expect, it } from "vitest";
import { currentStep, planProgressOf, planSteps } from "./plan-progress";

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

describe("planSteps", () => {
  const doc = (source: string) => ({ blocks: [{ kind: "list", source }] });

  it("marks done, the first open one current, and the rest later", () => {
    expect(planSteps(doc("- [x] A\n- [X] B\n- [ ] C\n- [ ] D"))).toEqual([
      { text: "A", state: "done" },
      { text: "B", state: "done" },
      { text: "C", state: "current" },
      { text: "D", state: "later" },
    ]);
  });

  it("caps at 8 steps around the current one", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `- [${i < 6 ? "x" : " "}] S${i}`).join("\n");
    const steps = planSteps(doc(lines));
    expect(steps).toHaveLength(8);
    expect(steps.map((step) => step.text)).toEqual([
      "S4",
      "S5",
      "S6",
      "S7",
      "S8",
      "S9",
      "S10",
      "S11",
    ]);
    expect(steps[2]?.state).toBe("current");
  });

  it("shows the last 8 when everything is done, and nothing for no tasks", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `- [x] S${i}`).join("\n");
    expect(planSteps(doc(lines)).map((step) => step.text)[0]).toBe("S2");
    expect(planSteps(doc("- plain"))).toEqual([]);
    expect(planSteps(undefined)).toEqual([]);
  });
});
