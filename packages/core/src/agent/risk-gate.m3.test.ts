import { describe, expect, it } from "vitest";
import type { AgentEvent, AuditEntry, Card } from "./contract.js";
import {
  createRiskGate,
  type GateCall,
  GateError,
  type GateRan,
  LOCAL_CONFIRM,
} from "./risk-gate.js";
import type { RegisteredTool } from "./tool-registry.js";
import type { ToolOutcome } from "./types.js";

function tool(name: string, risk: "confirm" | "password"): RegisteredTool {
  return {
    name,
    modelName: name.replace(".", "_"),
    server: "jarvis-settings",
    description: name,
    risk,
    hidden: false,
    secrets: [],
    batchItems: false,
    inputSchema: { type: "object", properties: {} },
    modelSchema: { type: "object", properties: {} },
  };
}

const RESULT: ToolOutcome = {
  ok: true,
  data: {
    previous: 40,
    current: 80,
    undo: { tool: "settings.brightness", input: { percent: 40 } },
  },
  text: "{}",
};

function harness() {
  const events: AgentEvent[] = [];
  const audit: AuditEntry[] = [];
  const ran: GateRan[] = [];
  let ids = 0;
  const gate = createRiskGate({
    emit: (event) => events.push(event),
    describe: async (t) => ({ title: `Do ${t.name}`, detail: "", source: "system" }),
    audit: async (entry) => {
      audit.push(entry);
    },
    now: () => 1,
    newId: () => `c${++ids}`,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    log: () => {},
    onRan: (r) => ran.push(r),
  });
  async function open(calls: GateCall[], via: "desktop" | "doctor" = "desktop") {
    const done = gate.runBatch({ turnId: "t1", via, calls, execute: async () => RESULT });
    for (let i = 0; i < 50 && !events.some((e) => e.type === "card"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const event = events.find((e) => e.type === "card");
    if (event?.type !== "card") throw new Error("no card");
    return { done, card: event.card as Card };
  }
  return { gate, events, audit, ran, open };
}

const call = (name: string, risk: "confirm" | "password"): GateCall => ({
  callId: `call-${name}`,
  tool: tool(name, risk),
  input: { percent: 80 },
});
const all = (card: Card) => card.items.map((item) => item.itemId);

describe("who approved a card (Rafiq M3 §2)", () => {
  it("audits a phone approval as phone:<deviceName>", async () => {
    const h = harness();
    const { done, card } = await h.open([call("settings.brightness", "confirm")]);
    h.gate.confirm(
      { cardId: card.cardId, approve: true, ticked: all(card), secrets: {} },
      { via: "phone:Pixel 8", allowPassword: false },
    );
    await done;
    expect(h.audit.map((a) => a.via)).toEqual(["phone:Pixel 8"]);
  });

  it("a phone cannot approve a password-tier item; the card stays open", async () => {
    const h = harness();
    const { done, card } = await h.open([call("users.add", "password")]);
    let thrown: unknown;
    try {
      h.gate.confirm(
        { cardId: card.cardId, approve: true, ticked: all(card), secrets: {} },
        { via: "phone:Pixel 8", allowPassword: false },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GateError);
    expect((thrown as GateError).code).toBe("forbidden");
    expect(h.gate.openCards().map((c) => c.cardId)).toEqual([card.cardId]);
    // A deny from the phone is fine.
    h.gate.confirm(
      { cardId: card.cardId, approve: false, ticked: [], secrets: {} },
      { via: "phone:Pixel 8", allowPassword: false },
    );
    await done;
    expect(h.audit[0]).toMatchObject({ decision: "denied", via: "phone:Pixel 8" });
  });

  it("a phone may approve the confirm items it ticks when a password item is left unticked", async () => {
    const h = harness();
    const { done, card } = await h.open([
      call("settings.brightness", "confirm"),
      call("users.add", "password"),
    ]);
    const confirmItem = card.items.find((i) => i.risk === "confirm")?.itemId as string;
    h.gate.confirm(
      { cardId: card.cardId, approve: true, ticked: [confirmItem], secrets: {} },
      { via: "phone:Pixel 8", allowPassword: false },
    );
    await done;
    expect(h.audit.map((a) => [a.tool, a.decision])).toEqual([
      ["settings.brightness", "approved"],
      ["users.add", "denied"],
    ]);
  });

  it("keeps doctor cards audited as doctor when answered on the computer", async () => {
    const h = harness();
    const { done, card } = await h.open([call("settings.brightness", "confirm")], "doctor");
    h.gate.confirm({ cardId: card.cardId, approve: true, ticked: all(card), secrets: {} });
    await done;
    expect(h.audit[0]?.via).toBe("doctor");
    expect(LOCAL_CONFIRM).toEqual({ via: "desktop", allowPassword: true });
  });

  it("tells onRan what ran, with the card titles and the result", async () => {
    const h = harness();
    const { done, card } = await h.open([call("settings.brightness", "confirm")]);
    h.gate.confirm({ cardId: card.cardId, approve: true, ticked: all(card), secrets: {} });
    await done;
    expect(h.ran).toHaveLength(1);
    expect(h.ran[0]).toMatchObject({
      titles: ["Do settings.brightness"],
      input: { percent: 80 },
      via: "desktop",
    });
    expect(h.ran[0]?.tool.name).toBe("settings.brightness");
    expect(h.ran[0]?.outcome.data).toEqual(RESULT.data);
  });

  it("does not call onRan for a denied card", async () => {
    const h = harness();
    const { done, card } = await h.open([call("settings.brightness", "confirm")]);
    h.gate.confirm({ cardId: card.cardId, approve: false, ticked: [], secrets: {} });
    await done;
    expect(h.ran).toEqual([]);
  });
});
