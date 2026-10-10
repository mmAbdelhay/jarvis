// packages/wire/src/os-control.v11.test.ts
import { describe, expect, it } from "vitest";
import {
  CU_MAX_STEPS,
  CU_PAUSE_REASONS,
  type CuState,
  OS_CONTROL_PUSHES,
  OS_CONTROL_REQUESTS,
  parseCuConsent,
  parseCuSetEnabled,
} from "./os-control.js";

describe("Rafiq v1.1 computer-use channels (contracts §2)", () => {
  it("names the channels exactly", () => {
    expect(OS_CONTROL_REQUESTS.cuStop).toBe("cu:stop");
    expect(OS_CONTROL_REQUESTS.cuResume).toBe("cu:resume");
    expect(OS_CONTROL_REQUESTS.cuSetEnabled).toBe("cu:setEnabled");
    expect(OS_CONTROL_REQUESTS.cuConsent).toBe("cu:consent");
    expect(OS_CONTROL_PUSHES.cuState).toBe("cu:state");
    expect(CU_MAX_STEPS).toBe(50);
    expect(CU_PAUSE_REASONS).toEqual(["physical-input", "esc", "locked", "excluded-focus"]);
  });

  it("describes cu:state with the contract's fields", () => {
    const state: CuState = {
      active: true,
      sessionId: "s1",
      goal: "export beach.xcf as PNG",
      apps: ["org.gimp.GIMP"],
      step: 1,
      maxSteps: CU_MAX_STEPS,
      steps: [{ title: "Click “File”", status: "running" }],
      paused: null,
    };
    expect(Object.keys(state).sort()).toEqual(
      ["active", "apps", "goal", "maxSteps", "paused", "sessionId", "step", "steps"].sort(),
    );
  });

  it("parses cu:setEnabled field by field", () => {
    expect(parseCuSetEnabled([{ providerId: "work", enabled: true }])).toEqual({
      ok: true,
      value: { providerId: "work", enabled: true },
    });
    expect(parseCuSetEnabled([{ providerId: "work", enabled: false, extra: 1 }])).toEqual({
      ok: true,
      value: { providerId: "work", enabled: false },
    });
    for (const bad of [
      [],
      [{}],
      [{ providerId: "work" }],
      [{ providerId: "work", enabled: "yes" }],
      [{ providerId: "Work", enabled: true }],
      [{ providerId: "backup", enabled: true }],
      [{ providerId: "__proto__", enabled: true }],
      [{ providerId: "work", enabled: true }, {}],
    ]) {
      expect(parseCuSetEnabled(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("parses cu:consent field by field", () => {
    expect(parseCuConsent([{ providerId: "work" }])).toEqual({
      ok: true,
      value: { providerId: "work" },
    });
    for (const bad of [[], [{}], [{ providerId: 7 }], [{ providerId: "backup" }], ["work"]]) {
      expect(parseCuConsent(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("cu:consent revocation (contracts §4.8)", () => {
  it("preserves optional boolean revoke and ignores extra fields", () => {
    for (const revoke of [true, false]) {
      expect(parseCuConsent([{ providerId: "work", revoke, extra: 1 }])).toEqual({
        ok: true,
        value: { providerId: "work", revoke },
      });
    }
    expect(parseCuConsent([{ providerId: "work", extra: 1 }])).toEqual({
      ok: true,
      value: { providerId: "work" },
    });
  });
  it("rejects malformed consent requests", () => {
    for (const bad of [
      [{ providerId: "Work" }],
      [{ providerId: "__proto__" }],
      [{ providerId: "work" }, {}],
      [null],
      [[]],
      ...["yes", 1, null, {}].map((revoke) => [{ providerId: "work", revoke }]),
    ]) {
      expect(parseCuConsent(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it("describes the idle state from section 4.9", () => {
    const idle: CuState = {
      active: false,
      sessionId: null,
      goal: "",
      apps: [],
      step: 0,
      maxSteps: CU_MAX_STEPS,
      steps: [],
      paused: null,
    };
    expect(idle.maxSteps).toBe(50);
    expect(idle.sessionId).toBeNull();
  });
});
