import { describe, expect, it } from "vitest";
import { CONTROL_TEXT } from "./messages.js";
import { createRiskGate } from "./risk-gate.js";

describe("gate errors in the UI language (M4 §3)", () => {
  it("refuses an answer to a closed card in Arabic", () => {
    const gate = createRiskGate({
      emit: () => {},
      describe: async (tool) => ({ title: tool.name, detail: "", source: "system" }),
      audit: async () => {},
      now: () => 0,
      newId: () => "c1",
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
      log: () => {},
      language: () => "ar",
    });
    expect(() => gate.confirm({ cardId: "gone", approve: true, ticked: [], secrets: {} })).toThrow(
      CONTROL_TEXT.ar.cardClosed,
    );
  });
});
