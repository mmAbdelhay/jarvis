import { describe, expect, it } from "vitest";
import { createNetworkDoctor, type DoctorDeps } from "./doctor.js";
import { DOCTOR_TEXT } from "./messages.js";
import type { RiskGate } from "./risk-gate.js";

const deps = (language: "en" | "ar"): DoctorDeps => ({
  prepare: async () => {},
  tool: () => undefined,
  callTool: async () => ({ ok: false, data: null, text: "", code: "not_found" }),
  gate: {} as RiskGate,
  providerReachable: async () => false,
  emitState: () => {},
  onFinished: () => {},
  log: () => {},
  language: () => language,
});

describe("network doctor language (M4 §3)", () => {
  it("labels its steps in the UI language", () => {
    expect(createNetworkDoctor(deps("ar")).state().steps[0]?.label).toBe(
      DOCTOR_TEXT.ar.labels.radio,
    );
    expect(createNetworkDoctor(deps("en")).state().steps[0]?.label).toBe(
      DOCTOR_TEXT.en.labels.radio,
    );
  });

  it("says jarvis-diag is missing in Arabic", async () => {
    const states: string[] = [];
    const doctor = createNetworkDoctor({
      ...deps("ar"),
      emitState: (state) => {
        for (const step of state.steps) if (step.detail !== "") states.push(step.detail);
      },
    });
    doctor.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toContain(DOCTOR_TEXT.ar.diagMissing);
  });
});
