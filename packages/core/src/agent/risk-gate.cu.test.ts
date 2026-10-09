// packages/core/src/agent/risk-gate.cu.test.ts
import { describe, expect, it } from "vitest";
import type { Card } from "./contract.js";
import { createRiskGate, GateError } from "./risk-gate.js";
import { CU_BEGIN_REGISTERED, SCREEN_REGISTERED } from "./screen-tools.js";
import type { RegisteredTool } from "./tool-registry.js";

function gateWithCard(tool = CU_BEGIN_REGISTERED) {
  let card: Card | undefined;
  const gate = createRiskGate({
    emit: (event) => {
      if (event.type === "card") card = event.card;
    },
    describe: async () => ({ title: "t", detail: "", source: "system" }),
    audit: async () => {},
    now: () => 0,
    newId: () => "c1",
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    log: () => {},
  });
  const run = gate.runBatch({
    turnId: "t",
    via: "desktop",
    calls: [{ callId: "x", tool, input: {} }],
    execute: async () => ({ ok: true, data: null, text: "" }),
  });
  return { gate, run, card: () => card as Card };
}

describe("computer-use cards are approved on the computer only (v1.1 ruling)", () => {
  for (const tool of [CU_BEGIN_REGISTERED, SCREEN_REGISTERED[1] as RegisteredTool]) {
    it(`refuses a phone approval of ${tool.name}`, async () => {
      const { gate, run, card } = gateWithCard(tool);
      for (let i = 0; i < 100 && card() === undefined; i++)
        await new Promise((r) => setTimeout(r, 0));
      const answer = {
        cardId: card().cardId,
        approve: true,
        ticked: [card().items[0]?.itemId ?? ""],
        secrets: {},
      };
      expect(() => gate.confirm(answer, { via: "phone:Pixel", allowPassword: false })).toThrow(
        GateError,
      );
      // A phone may still deny it.
      gate.confirm(
        { ...answer, approve: false, ticked: [] },
        { via: "phone:Pixel", allowPassword: false },
      );
      await expect(run).resolves.toMatchObject([{ status: "denied" }]);
    });
  }
});
