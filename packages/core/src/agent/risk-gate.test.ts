import { describe, expect, it } from "vitest";
import type { AgentEvent, AuditEntry, Card } from "./contract.js";
import { AGENT_TEXT } from "./messages.js";
import { createRiskGate, DESCRIBE_CONCURRENCY, GateError, type GateCall } from "./risk-gate.js";
import type { RegisteredTool } from "./tool-registry.js";
import type { ToolOutcome } from "./types.js";

function registered(name: string, extra: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    name,
    modelName: name.replace(".", "_"),
    server: "jarvis-pkg",
    description: name,
    risk: "confirm",
    hidden: false,
    secrets: [],
    batchItems: false,
    inputSchema: { type: "object", properties: {} },
    modelSchema: { type: "object", properties: {} },
    ...extra,
  };
}

function harness() {
  const events: AgentEvent[] = [];
  const audit: AuditEntry[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  let ids = 0;
  const gate = createRiskGate({
    emit: (event) => events.push(event),
    describe: async (tool, input) => ({
      title: `Run ${tool.name}`,
      detail: JSON.stringify(input),
      source: JSON.stringify(input).includes("flatpak") ? "flathub" : "debian",
    }),
    audit: async (entry) => {
      audit.push(entry);
    },
    now: () => 1_000,
    newId: () => `card${++ids}`,
    timers: {
      setTimeout: (callback) => {
        const id = nextTimer++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
    log: () => {},
  });
  const cardOf = async (): Promise<Card> => {
    for (let i = 0; i < 100; i++) {
      const event = events.find((e) => e.type === "card");
      if (event?.type === "card") return event.card;
      await Promise.resolve();
    }
    throw new Error("no card emitted");
  };
  const fireTimers = () => {
    for (const [id, callback] of [...timers]) {
      timers.delete(id);
      callback();
    }
  };
  return { gate, events, audit, cardOf, fireTimers };
}

const ok = (text = "done"): ToolOutcome => ({ ok: true, data: { text }, text });

const calls: GateCall[] = [
  {
    callId: "a",
    tool: registered("pkg.install"),
    input: { items: [{ source: "apt", id: "vlc" }] },
  },
  {
    callId: "b",
    tool: registered("pkg.install"),
    input: { items: [{ source: "apt", id: "gimp" }] },
  },
  {
    callId: "c",
    tool: registered("pkg.install"),
    input: { items: [{ source: "flatpak", id: "com.spotify.Client" }] },
  },
];

describe("RiskGate", () => {
  it("shows ONE card for the batch and runs only the ticked items", async () => {
    const { gate, events, audit, cardOf } = harness();
    const ran: string[] = [];
    const pending = gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls,
      execute: async (call) => {
        ran.push(call.callId);
        return ok();
      },
    });
    const card = await cardOf();
    expect(card).toMatchObject({ cardId: "card1", turnId: "t1", expiresAt: 301_000 });
    expect(card.items.map((i) => i.itemId)).toEqual(["item-1", "item-2", "item-3"]);
    expect(card.items[0]).toMatchObject({
      tool: "pkg.install",
      title: "Run pkg.install",
      source: "debian",
      risk: "confirm",
      secretFields: [],
    });
    gate.confirm({ cardId: card.cardId, approve: true, ticked: ["item-1", "item-3"], secrets: {} });
    const results = await pending;
    expect(ran).toEqual(["a", "c"]);
    expect(results.map((r) => r.status)).toEqual(["ran", "unticked", "ran"]);
    expect(events.filter((e) => e.type === "card")).toHaveLength(1);
    expect(events).toContainEqual({ type: "card-closed", cardId: "card1", decision: "approved" });
    expect(audit.map((a) => [a.decision, a.result])).toEqual([
      ["approved", "ok"],
      ["denied", "skipped"],
      ["approved", "ok"],
    ]);
  });

  it("runs nothing on Deny, and nothing when Approve comes with nothing ticked", async () => {
    for (const answer of [
      { approve: false, ticked: ["item-1", "item-2", "item-3"] },
      { approve: true, ticked: [] as string[] },
    ]) {
      const { gate, events, cardOf } = harness();
      let ran = 0;
      const pending = gate.runBatch({
        turnId: "t1",
        via: "desktop",
        calls,
        execute: async () => {
          ran++;
          return ok();
        },
      });
      const card = await cardOf();
      gate.confirm({ cardId: card.cardId, secrets: {}, ...answer });
      expect((await pending).map((r) => r.status)).toEqual(["denied", "denied", "denied"]);
      expect(ran).toBe(0);
      expect(events).toContainEqual({
        type: "card-closed",
        cardId: card.cardId,
        decision: "denied",
      });
    }
  });

  it("treats no answer in 5 minutes as Deny", async () => {
    const { gate, events, audit, cardOf, fireTimers } = harness();
    const pending = gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls: calls.slice(0, 1),
      execute: async () => ok(),
    });
    const card = await cardOf();
    fireTimers();
    expect((await pending)[0]?.status).toBe("timeout");
    expect(events).toContainEqual({
      type: "card-closed",
      cardId: card.cardId,
      decision: "timeout",
    });
    expect(audit[0]).toMatchObject({ decision: "timeout", result: "skipped", via: "desktop" });
  });

  it("closes an open card as denied on Stop, running nothing", async () => {
    const { gate, events, cardOf } = harness();
    const controller = new AbortController();
    let ran = 0;
    const pending = gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls,
      signal: controller.signal,
      execute: async () => {
        ran++;
        return ok();
      },
    });
    const card = await cardOf();
    controller.abort();
    expect((await pending).map((r) => r.status)).toEqual(["denied", "denied", "denied"]);
    expect(ran).toBe(0);
    expect(events).toContainEqual({ type: "card-closed", cardId: card.cardId, decision: "denied" });
  });

  it("lets the running item finish after Stop and skips the rest", async () => {
    const { gate, audit, cardOf } = harness();
    const controller = new AbortController();
    const ran: string[] = [];
    const pending = gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls,
      signal: controller.signal,
      execute: async (call) => {
        ran.push(call.callId);
        controller.abort(); // Stop pressed while the first install runs.
        return ok();
      },
    });
    const card = await cardOf();
    gate.confirm({
      cardId: card.cardId,
      approve: true,
      ticked: ["item-1", "item-2", "item-3"],
      secrets: {},
    });
    expect((await pending).map((r) => r.status)).toEqual(["ran", "stopped", "stopped"]);
    expect(ran).toEqual(["a"]);
    expect(audit.map((a) => [a.decision, a.result])).toEqual([
      ["approved", "ok"],
      ["approved", "skipped"],
      ["approved", "skipped"],
    ]);
  });

  it("passes card secrets to the tool only, scrubs echoes, audits [hidden]", async () => {
    const { gate, events, audit, cardOf } = harness();
    const wifi = registered("net.wifi_connect", {
      server: "jarvis-diag",
      secrets: ["password"],
      inputSchema: {
        type: "object",
        properties: {
          ssid: { type: "string" },
          password: { type: "string", title: "Wi-Fi password" },
        },
      },
    });
    let received: Record<string, unknown> = {};
    const pending = gate.runBatch({
      turnId: null,
      via: "doctor",
      calls: [{ callId: "w", tool: wifi, input: { ssid: "Home" } }],
      execute: async (_call, input) => {
        received = input;
        return {
          ok: false,
          data: { note: "bad password hunter2" },
          text: "auth failed for hunter2",
          code: "failed",
        };
      },
    });
    const card = await cardOf();
    expect(card.items[0]?.secretFields).toEqual([{ name: "password", label: "Wi-Fi password" }]);
    gate.confirm({
      cardId: card.cardId,
      approve: true,
      ticked: ["item-1"],
      secrets: { "item-1": { password: "hunter2" } },
    });
    const [result] = await pending;
    expect(received).toEqual({ ssid: "Home", password: "hunter2" });
    expect(result?.outcome?.text).toBe("auth failed for [hidden]");
    expect(JSON.stringify(result?.outcome?.data)).not.toContain("hunter2");
    expect(JSON.stringify(events)).not.toContain("hunter2");
    expect(audit[0]).toMatchObject({
      input: { ssid: "Home", password: "[hidden]" },
      via: "doctor",
      result: "failed",
    });
    expect(JSON.stringify(audit)).not.toContain("hunter2");
  });

  it("criterion 8: one item per package, untick GIMP, ONE install call with the other two", async () => {
    const { gate, audit, cardOf } = harness();
    const install = registered("pkg.install", { batchItems: true });
    const executed: Record<string, unknown>[] = [];
    const pending = gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls: [
        {
          callId: "i",
          tool: install,
          input: {
            items: [
              { source: "apt", id: "vlc" },
              { source: "apt", id: "gimp" },
              { source: "flatpak", id: "com.spotify.Client" },
            ],
          },
        },
      ],
      execute: async (_call, input) => {
        executed.push(input);
        return ok();
      },
    });
    const card = await cardOf();
    expect(card.items.map((i) => [i.itemId, i.source])).toEqual([
      ["item-1", "debian"],
      ["item-2", "debian"],
      ["item-3", "flathub"],
    ]);
    expect(card.items[1]?.detail).toBe('{"items":[{"source":"apt","id":"gimp"}]}');
    gate.confirm({ cardId: card.cardId, approve: true, ticked: ["item-1", "item-3"], secrets: {} });
    const [result] = await pending;
    expect(result).toMatchObject({ callId: "i", status: "ran", skippedItems: 1 });
    expect(executed).toEqual([
      {
        items: [
          { source: "apt", id: "vlc" },
          { source: "flatpak", id: "com.spotify.Client" },
        ],
      },
    ]);
    expect(
      audit.map((a) => [
        (a.input as { items: { id: string }[] }).items[0]?.id,
        a.decision,
        a.result,
      ]),
    ).toEqual([
      ["vlc", "approved", "ok"],
      ["gimp", "denied", "skipped"],
      ["com.spotify.Client", "approved", "ok"],
    ]);
  });

  it("does not call a batch tool at all when every element is unticked or denied", async () => {
    const { gate, cardOf } = harness();
    let calls = 0;
    const pending = gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls: [
        {
          callId: "i",
          tool: registered("pkg.install", { batchItems: true }),
          input: {
            items: [
              { source: "apt", id: "vlc" },
              { source: "apt", id: "gimp" },
            ],
          },
        },
        { callId: "j", tool: registered("svc.restart"), input: { unit: "cups" } },
      ],
      execute: async () => {
        calls++;
        return ok();
      },
    });
    const card = await cardOf();
    expect(card.items).toHaveLength(3);
    gate.confirm({ cardId: card.cardId, approve: true, ticked: ["item-3"], secrets: {} });
    expect((await pending).map((r) => [r.callId, r.status])).toEqual([
      ["i", "unticked"],
      ["j", "ran"],
    ]);
    expect(calls).toBe(1);
  });

  it("refuses more ticks than maxTicked (the doctor's Wi-Fi pick card)", async () => {
    const { gate, cardOf } = harness();
    const wifi = registered("net.wifi_connect", { secrets: ["password"] });
    const pending = gate.runBatch({
      turnId: null,
      via: "doctor",
      maxTicked: 1,
      calls: [
        { callId: "a", tool: wifi, input: { ssid: "A" } },
        { callId: "b", tool: wifi, input: { ssid: "B" } },
      ],
      execute: async () => ok(),
    });
    const card = await cardOf();
    expect(() =>
      gate.confirm({
        cardId: card.cardId,
        approve: true,
        ticked: ["item-1", "item-2"],
        secrets: {},
      }),
    ).toThrow(GateError);
    gate.confirm({
      cardId: card.cardId,
      approve: true,
      ticked: ["item-2"],
      secrets: { "item-2": { password: "pw" } },
    });
    expect((await pending).map((r) => r.status)).toEqual(["unticked", "ran"]);
  });

  it("carries password-risk items on the same card", async () => {
    const { gate, cardOf } = harness();
    const pending = gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls: [
        { callId: "p", tool: registered("sys.admin_thing", { risk: "password" }), input: {} },
      ],
      execute: async () => ok(),
    });
    const card = await cardOf();
    expect(card.items[0]?.risk).toBe("password");
    gate.confirm({ cardId: card.cardId, approve: true, ticked: ["item-1"], secrets: {} });
    expect((await pending)[0]?.status).toBe("ran");
  });

  it("refuses answers that do not fit the card", async () => {
    const { gate, cardOf } = harness();
    const pending = gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls: calls.slice(0, 1),
      execute: async () => ok(),
    });
    const card = await cardOf();
    expect(() => gate.confirm({ cardId: "nope", approve: true, ticked: [], secrets: {} })).toThrow(
      GateError,
    );
    expect(() =>
      gate.confirm({ cardId: card.cardId, approve: true, ticked: ["item-9"], secrets: {} }),
    ).toThrow(GateError);
    expect(() =>
      gate.confirm({
        cardId: card.cardId,
        approve: true,
        ticked: ["item-1"],
        secrets: { "item-1": { password: "x" } },
      }),
    ).toThrow(GateError);
    expect(gate.openCards()).toHaveLength(1);
    gate.confirm({ cardId: card.cardId, approve: true, ticked: ["item-1"], secrets: {} });
    await pending;
    // A second answer (double tap) finds the card closed.
    expect(() =>
      gate.confirm({ cardId: card.cardId, approve: true, ticked: ["item-1"], secrets: {} }),
    ).toThrow(GateError);
    expect(gate.openCards()).toHaveLength(0);
  });

  it("keeps going when the audit write fails", async () => {
    const lines: string[] = [];
    const failing = createRiskGateWithFailingAudit(lines);
    const pending = failing.gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls: calls.slice(0, 1),
      execute: async () => ok(),
    });
    const card = await failing.cardOf();
    failing.gate.confirm({ cardId: card.cardId, approve: true, ticked: ["item-1"], secrets: {} });
    expect((await pending)[0]?.status).toBe("ran");
    expect(lines.join("\n")).toMatch(/audit/);
  });
});

function createRiskGateWithFailingAudit(lines: string[]) {
  const events: AgentEvent[] = [];
  const gate = createRiskGate({
    emit: (event) => events.push(event),
    describe: async (tool) => ({ title: tool.name, detail: "", source: "system" }),
    audit: async () => {
      throw new Error("disk full");
    },
    now: () => 0,
    newId: () => "c",
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    log: (line) => lines.push(line),
  });
  const cardOf = async (): Promise<Card> => {
    for (let i = 0; i < 100; i++) {
      const event = events.find((e) => e.type === "card");
      if (event?.type === "card") return event.card;
      await Promise.resolve();
    }
    throw new Error("no card");
  };
  return { gate, cardOf };
}

describe("RiskGate with large update batches (M2 contracts §2)", () => {
  const applyTool = registered("updates.apply", {
    batchItems: true,
    inputSchema: {
      type: "object",
      properties: { items: { type: "array", minItems: 1, maxItems: 200 } },
      required: ["items"],
    },
  });
  const updateItems = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ source: "apt", id: `pkg${i + 1}` }));

  function bigHarness() {
    const events: AgentEvent[] = [];
    const audit: AuditEntry[] = [];
    let inflight = 0;
    let peak = 0;
    const gate = createRiskGate({
      emit: (event) => events.push(event),
      describe: async (tool, input) => {
        inflight++;
        peak = Math.max(peak, inflight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inflight--;
        const items = input["items"] as { id: string }[] | undefined;
        return {
          title: `${tool.name} ${items?.[0]?.id ?? ""}`.trim(),
          detail: "",
          source: "debian",
        };
      },
      audit: async (entry) => {
        audit.push(entry);
      },
      now: () => 1_000,
      newId: () => "card1",
      timers: { setTimeout: () => 0, clearTimeout: () => {} },
      log: () => {},
    });
    const waitForCard = async (): Promise<Card> => {
      for (let i = 0; i < 1_000; i++) {
        const event = events.find((e) => e.type === "card");
        if (event?.type === "card") return event.card;
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error("no card emitted");
    };
    return { gate, events, audit, waitForCard, peak: () => peak };
  }

  it("describes 150 items at most 8 at a time, keeps their order, and runs the tool once with every ticked item", async () => {
    const h = bigHarness();
    const executed: Record<string, unknown>[] = [];
    const running = h.gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls: [{ callId: "a", tool: applyTool, input: { items: updateItems(150) } }],
      execute: async (_call, input) => {
        executed.push(input);
        return ok();
      },
    });
    const card = await h.waitForCard();
    expect(card.items).toHaveLength(150);
    expect(card.items[0]).toMatchObject({
      itemId: "item-1",
      tool: "updates.apply",
      title: "updates.apply pkg1",
    });
    expect(card.items[149]).toMatchObject({ itemId: "item-150", title: "updates.apply pkg150" });
    expect(h.peak()).toBeGreaterThan(1);
    expect(h.peak()).toBeLessThanOrEqual(DESCRIBE_CONCURRENCY);
    h.gate.confirm({
      cardId: card.cardId,
      approve: true,
      ticked: card.items.map((item) => item.itemId),
      secrets: {},
    });
    const [result] = await running;
    expect(result).toMatchObject({ callId: "a", status: "ran", skippedItems: 0 });
    expect(executed).toEqual([{ items: updateItems(150) }]);
    expect(h.audit).toHaveLength(150);
  });

  it("refuses a batch over the tool's maxItems without a card, an audit line or a run", async () => {
    const h = bigHarness();
    let runs = 0;
    const results = await h.gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls: [{ callId: "a", tool: applyTool, input: { items: updateItems(201) } }],
      execute: async () => {
        runs++;
        return ok();
      },
    });
    expect(results).toEqual([
      {
        callId: "a",
        status: "ran",
        outcome: { ok: false, data: null, text: AGENT_TEXT.tooManyItems(200), code: "invalid" },
        skippedItems: 0,
      },
    ]);
    expect(h.events).toEqual([]);
    expect(h.audit).toEqual([]);
    expect(runs).toBe(0);
  });

  it("still shows the step's other calls on the card", async () => {
    const h = bigHarness();
    const running = h.gate.runBatch({
      turnId: "t1",
      via: "desktop",
      calls: [
        { callId: "a", tool: applyTool, input: { items: updateItems(201) } },
        { callId: "b", tool: registered("svc.restart"), input: { unit: "cups" } },
      ],
      execute: async () => ok(),
    });
    const card = await h.waitForCard();
    expect(card.items.map((item) => item.tool)).toEqual(["svc.restart"]);
    h.gate.confirm({ cardId: card.cardId, approve: true, ticked: ["item-1"], secrets: {} });
    const results = await running;
    expect(results.map((r) => [r.callId, r.status, r.outcome?.code])).toEqual([
      ["a", "ran", "invalid"],
      ["b", "ran", undefined],
    ]);
  });
});
