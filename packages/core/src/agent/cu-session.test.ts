import { describe, expect, it } from "vitest";
import { CU_IDLE_STATE, createCuSession } from "./cu-session.js";

const start = (maxSteps?: number) =>
  createCuSession({
    sessionId: "s1",
    goal: "export beach.xcf",
    apps: ["org.gimp.GIMP"],
    lang: "en",
    via: "desktop",
    ...(maxSteps === undefined ? {} : { maxSteps }),
  });

describe("computer-use session state (design §2.7)", () => {
  it("lists steps with their status and counts them", () => {
    const s = start();
    const a = s.startStep("Click “File”");
    expect(a).toBe(0);
    s.finishStep(a as number, true);
    const b = s.startStep("Press ctrl+s") as number;
    s.markStep(b, "pending");
    expect(s.state()).toEqual({
      active: true,
      sessionId: "s1",
      goal: "export beach.xcf",
      apps: ["org.gimp.GIMP"],
      step: 2,
      maxSteps: 50,
      steps: [
        { title: "Click “File”", status: "done" },
        { title: "Press ctrl+s", status: "pending" },
      ],
      paused: null,
    });
  });

  it("refuses the step after the cap", () => {
    const s = start(2);
    s.startStep("a");
    s.startStep("b");
    expect(s.startStep("c")).toBe("cap");
    expect(s.stepCount()).toBe(2);
  });

  it("calls the fifth identical capture in a row stuck", () => {
    const s = start();
    expect(["h1", "h1", "h2", "h2", "h2", "h2"].map((h) => s.noteCapture(h))).toEqual([
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
      "ok",
    ]);
    expect(s.noteCapture("h2")).toBe("stuck");
  });

  it("pauses, resumes and ends with an explanation", () => {
    const s = start();
    s.startStep("Click “Export”");
    s.pause("physical-input");
    expect(s.state().paused).toBe("physical-input");
    s.resume();
    expect(s.state().paused).toBeNull();
    const final = s.end("stuck");
    expect(final.active).toBe(false);
    expect(final.paused).toBeNull();
    expect(final.steps).toEqual([
      { title: "Click “Export”", status: "failed" },
      { title: "Stopped: the screen did not change after 5 looks.", status: "failed" },
    ]);
  });

  it("has an idle state", () => {
    expect(CU_IDLE_STATE).toEqual({
      active: false,
      sessionId: null,
      goal: "",
      apps: [],
      step: 0,
      maxSteps: 50,
      steps: [],
      paused: null,
    });
  });
});

it("isolates state snapshots and preserves completed steps when ending", () => {
  const s = start();
  const index = s.startStep("Click") as number;
  s.finishStep(index, true);
  const snapshot = s.state();
  snapshot.apps.length = 0;
  snapshot.steps[0]!.status = "failed";
  s.markStep(999, "pending");
  expect(s.end("done").steps).toEqual([{ title: "Click", status: "done" }]);
  expect(s.state().apps).toEqual(["org.gimp.GIMP"]);
});

it("keeps the session app selection fixed when the caller changes its array", () => {
  const apps = ["org.gimp.GIMP"];
  const s = createCuSession({ sessionId: "s1", goal: "export", apps, lang: "en", via: "desktop" });
  apps.push("org.example.Other");
  expect(s.state().apps).toEqual(["org.gimp.GIMP"]);
  expect(s.apps).toEqual(["org.gimp.GIMP"]);
});
