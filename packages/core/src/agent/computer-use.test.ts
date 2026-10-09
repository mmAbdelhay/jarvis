// packages/core/src/agent/computer-use.test.ts
import { describe, expect, it } from "vitest";
import type { AgentEvent, AuditEntry, CuState } from "./contract.js";
import { CU_TURN_MAX_STEPS, type CuCallContext, createComputerUse } from "./computer-use.js";
import { createFakeCuClient } from "./cu-fake-client.js";
import { CU_MODEL_TEXT } from "./cu-text.js";
import { createRiskGate, type RiskGate } from "./risk-gate.js";
import { SCREEN_REGISTERED } from "./screen-tools.js";
import type { RegisteredTool } from "./tool-registry.js";

const tool = (name: string): RegisteredTool =>
  SCREEN_REGISTERED.find((t) => t.name === name) as RegisteredTool;
const LOOK = tool("screen.look");
const CLICK = tool("screen.click");
const TYPE = tool("screen.type");
const KEY = tool("screen.key");
const DONE = tool("screen.done");
const START = { goal: "export beach.xcf as PNG", apps: ["org.gimp.GIMP"] };

function setup(
  options: {
    answer?: (card: Extract<AgentEvent, { type: "card" }>["card"]) => "approve" | "deny" | "hold";
    captures?: string[];
    fail?: Record<
      string,
      "outside" | "excluded" | "paused" | "no-session" | "unsupported" | "failed"
    >;
    available?: () => string | null;
  } = {},
) {
  const fake = createFakeCuClient({
    ...(options.captures === undefined ? {} : { captures: options.captures }),
    ...(options.fail === undefined ? {} : { fail: options.fail }),
  });
  const audit: AuditEntry[] = [];
  const states: CuState[] = [];
  const cards: Extract<AgentEvent, { type: "card" }>["card"][] = [];
  let ids = 0;
  const timers = { setTimeout: () => 0, clearTimeout: () => {} };
  // emit runs after createRiskGate returns (the card waits on describe), so gate is set by then.
  const gate: RiskGate = createRiskGate({
    emit: (event) => {
      if (event.type !== "card") return;
      cards.push(event.card);
      const decision = options.answer?.(event.card) ?? "approve";
      if (decision === "hold") return;
      queueMicrotask(() =>
        gate.confirm({
          cardId: event.card.cardId,
          approve: decision === "approve",
          ticked: decision === "approve" ? event.card.items.map((i) => i.itemId) : [],
          secrets: {},
        }),
      );
    },
    describe: async () => ({ title: "x", detail: "", source: "system" }),
    audit: async (entry) => {
      audit.push(entry);
    },
    now: () => 1_000,
    newId: () => `card${++ids}`,
    timers,
    log: () => {},
  });
  const cu = createComputerUse({
    client: fake.client,
    gate,
    audit: async (entry) => {
      audit.push(entry);
    },
    emitState: (state) => states.push(state),
    available: options.available ?? (() => null),
    hash: async (png) => png,
    now: () => 2_000,
    newId: () => `s${++ids}`,
    timers,
    log: () => {},
  });
  const ctx = (over: Partial<CuCallContext> = {}): CuCallContext => ({
    turnId: "t1",
    lang: "en",
    via: "desktop",
    signal: new AbortController().signal,
    ...over,
  });
  return { cu, fake, audit, states, cards, ctx };
}

describe("computer-use runner (contracts §2)", () => {
  it("asks for goal and apps first, listing the open windows as untrusted data", async () => {
    const { cu, fake, cards, ctx } = setup();
    const result = await cu.run(LOOK, {}, ctx());
    expect(result.isError).toBe(true);
    expect(result.text).toContain("screen.look {goal, apps}");
    expect(result.untrusted).toContain("org.gimp.GIMP");
    expect(cards).toHaveLength(0);
    expect(fake.calls.map((c) => c.op)).toEqual(["apps"]);
    const click = await cu.run(CLICK, { x: 1, y: 1, target: "File" }, ctx());
    expect(click.text).toContain("screen.look {goal, apps}");
  });

  it("shows one session card, begins, and returns the first screenshot", async () => {
    const { cu, fake, cards, audit, states, ctx } = setup();
    const result = await cu.run(LOOK, START, ctx());
    expect(cards).toHaveLength(1);
    expect(cards[0]?.items).toEqual([
      expect.objectContaining({
        tool: "cu.begin",
        title: "Let Jarvis use org.gimp.GIMP to: export beach.xcf as PNG",
        source: "system",
        risk: "confirm",
      }),
    ]);
    expect(fake.calls.map((c) => c.op)).toEqual(["begin", "capture"]);
    expect(fake.calls[0]?.args[1]).toEqual(["org.gimp.GIMP"]);
    expect(fake.calls[1]?.args[0]).toBe(1280);
    expect(result).toMatchObject({ isError: false, image: { mediaType: "image/png" } });
    expect(result.untrusted).toContain("beach.xcf");
    expect(audit[0]).toMatchObject({
      tool: "cu.begin",
      decision: "approved",
      input: expect.objectContaining(START),
    });
    expect(states.at(-1)).toMatchObject({
      active: true,
      goal: START.goal,
      apps: START.apps,
      step: 0,
      maxSteps: 50,
    });
    expect(cu.active()).toBe(true);
  });

  it("does nothing when the session card is denied, and does not ask again this turn", async () => {
    const { cu, fake, ctx } = setup({ answer: () => "deny" });
    const result = await cu.run(LOOK, START, ctx());
    expect(result).toMatchObject({ isError: true, text: CU_MODEL_TEXT.sessionDenied });
    expect(fake.calls).toEqual([]);
    expect((await cu.run(LOOK, START, ctx())).text).toBe(CU_MODEL_TEXT.closedThisTurn);
    cu.beginTurn();
    expect((await cu.run(LOOK, {}, ctx())).text).toContain("screen.look {goal, apps}");
  });

  it("refuses phone-origin turns and unavailable providers before any card", async () => {
    const phone = setup();
    expect((await phone.cu.run(LOOK, START, phone.ctx({ via: "phone:Pixel" }))).text).toBe(
      CU_MODEL_TEXT.phone,
    );
    expect(phone.cards).toHaveLength(0);
    const off = setup({ available: () => CU_MODEL_TEXT.noConsent });
    expect((await off.cu.run(LOOK, START, off.ctx())).text).toBe(CU_MODEL_TEXT.noConsent);
    expect(off.cards).toHaveLength(0);
  });

  it("runs a plain click without a card and audits it, without any screenshot", async () => {
    const { cu, fake, cards, audit, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    const result = await cu.run(CLICK, { x: 10, y: 20, target: "File" }, ctx());
    expect(result).toEqual({ text: CU_MODEL_TEXT.did("Click “File”"), isError: false });
    expect(cards).toHaveLength(1);
    expect(fake.calls.at(-1)).toEqual({ op: "click", args: [10, 20, "left", false] });
    expect(fake.calls.at(-2)).toEqual({ op: "describeAt", args: [10, 20] });
    expect(audit.at(-1)).toMatchObject({
      tool: "screen.click",
      title: "Click “File”",
      input: { x: 10, y: 20, button: "left", double: false, target: "File" },
      decision: "approved",
      via: "desktop",
      result: "ok",
    });
    expect(JSON.stringify(audit)).not.toContain("iVBORw0KGgo");
  });

  it("asks before a consequential click and sends nothing when denied", async () => {
    const { cu, fake, cards, audit, ctx } = setup({
      answer: (card) => (card.items[0]?.tool === "screen.click" ? "deny" : "approve"),
    });
    await cu.run(LOOK, START, ctx());
    const result = await cu.run(CLICK, { x: 5, y: 5, target: "Export" }, ctx());
    expect(cards[1]?.items[0]).toMatchObject({
      tool: "screen.click",
      title: "Click “Export”: this saves a file",
      source: "system",
    });
    expect(result.isError).toBe(true);
    expect(fake.calls.some((c) => c.op === "click")).toBe(false);
    expect(audit.at(-1)).toMatchObject({
      tool: "screen.click",
      decision: "denied",
      result: "skipped",
    });
    expect(cu.state().steps.at(-1)).toEqual({ title: "Click “Export”", status: "failed" });
  });

  it("asks when the accessibility name under the pointer is consequential (contracts section 4)", async () => {
    const { cu, fake, cards, ctx } = setup({
      answer: (card) => (card.items[0]?.tool === "screen.click" ? "deny" : "approve"),
    });
    fake.client.describeAt = async () => ({ role: "button", name: "Delete" });
    await cu.run(LOOK, START, ctx());
    const result = await cu.run(CLICK, { x: 5, y: 5, target: "OK" }, ctx());
    expect(cards[1]?.items[0]).toMatchObject({ tool: "screen.click" });
    expect(result.isError).toBe(true);
    expect(fake.calls.some((c) => c.op === "click")).toBe(false);
  });

  it("runs an approved consequential click once", async () => {
    const { cu, fake, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    const result = await cu.run(CLICK, { x: 5, y: 5, target: "OK", intent: "overwrite" }, ctx());
    expect(result.isError).toBe(false);
    expect(fake.calls.filter((c) => c.op === "click")).toHaveLength(1);
  });

  it("asks before pressing Enter in a message field", async () => {
    const { cu, cards, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    await cu.run(TYPE, { text: "see you at 5", target: "Message" }, ctx());
    await cu.run(KEY, { combo: "enter" }, ctx());
    expect(cards.at(-1)?.items[0]).toMatchObject({
      tool: "screen.key",
      title: "Press enter: this sends something",
    });
  });

  it("redacts secrets from typed text in the audit", async () => {
    const { cu, audit, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    await cu.run(
      TYPE,
      { text: "api_key=sk-ant-abcdefghijklmnopqrstuvwxyz", target: "Notes" },
      ctx(),
    );
    const entry = audit.at(-1);
    expect(JSON.stringify(entry)).not.toContain("abcdefghijklmnop");
    expect(entry?.input).toMatchObject({ chars: 41, target: "Notes" });
  });

  it("stops a stuck loop after five identical screenshots and says why", async () => {
    const same = "iVBORw0KGgoSAME";
    const { cu, fake, states, ctx } = setup({ captures: [same] });
    await cu.run(LOOK, START, ctx());
    for (let i = 0; i < 3; i++) await cu.run(LOOK, {}, ctx());
    const fifth = await cu.run(LOOK, {}, ctx());
    expect(fifth).toMatchObject({ isError: true, text: CU_MODEL_TEXT.stuck });
    expect(fake.calls.at(-1)?.op).toBe("end");
    expect(states.at(-1)?.active).toBe(false);
    expect(states.at(-1)?.steps.at(-1)).toEqual({
      title: "Stopped: the screen did not change after 5 looks.",
      status: "failed",
    });
    expect((await cu.run(LOOK, START, ctx())).text).toBe(CU_MODEL_TEXT.closedThisTurn);
  });

  it("stops at 50 actions", async () => {
    const { cu, fake, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    for (let i = 0; i < 50; i++) {
      expect((await cu.run(CLICK, { x: 1, y: 1, target: "Canvas" }, ctx())).isError).toBe(false);
    }
    const over = await cu.run(CLICK, { x: 1, y: 1, target: "Canvas" }, ctx());
    expect(over.text).toBe(CU_MODEL_TEXT.cap(50));
    expect(fake.calls.filter((c) => c.op === "click")).toHaveLength(50);
    expect(cu.active()).toBe(false);
    expect(CU_TURN_MAX_STEPS).toBeGreaterThan(2 * 50);
  });

  it("after a pause and resume, the next action asks for a fresh look and sends nothing", async () => {
    const { cu, fake, states, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    fake.pause("physical-input");
    expect(states.at(-1)?.paused).toBe("physical-input");
    const pending = cu.run(CLICK, { x: 1, y: 1, target: "Canvas" }, ctx());
    await cu.resume();
    expect(await pending).toEqual({ text: CU_MODEL_TEXT.resumedLookFirst, isError: true });
    expect(fake.calls.filter((c) => c.op === "begin")).toHaveLength(2);
    expect(fake.calls.some((c) => c.op === "click")).toBe(false);
    expect((await cu.run(CLICK, { x: 1, y: 1, target: "Canvas" }, ctx())).text).toBe(
      CU_MODEL_TEXT.lookFirst,
    );
    expect((await cu.run(LOOK, {}, ctx())).isError).toBe(false);
    expect((await cu.run(CLICK, { x: 1, y: 1, target: "Canvas" }, ctx())).isError).toBe(false);
  });

  it("cu:stop while paused ends the session", async () => {
    const { cu, fake, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    fake.pause("esc");
    const pending = cu.run(CLICK, { x: 1, y: 1, target: "Canvas" }, ctx());
    await cu.stop();
    expect(await pending).toEqual({ text: CU_MODEL_TEXT.stoppedByUser, isError: true });
    expect(cu.active()).toBe(false);
  });

  it("a lock push ends the session at once", async () => {
    const { cu, fake, states, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    fake.pause("locked");
    await Promise.resolve();
    expect(cu.active()).toBe(false);
    expect(states.at(-1)?.active).toBe(false);
    expect(fake.calls.at(-1)?.op).toBe("end");
  });

  it("ends the session when the helper goes away", async () => {
    const { cu, fake, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    fake.gone();
    await Promise.resolve();
    expect(cu.active()).toBe(false);
    expect((await cu.run(LOOK, START, ctx())).text).toBe(CU_MODEL_TEXT.closedThisTurn);
  });

  it("ends the session when the provider stops being allowed mid-turn", async () => {
    let reason: string | null = null;
    const { cu, fake, ctx } = setup({ available: () => reason });
    await cu.run(LOOK, START, ctx());
    reason = CU_MODEL_TEXT.noConsent;
    expect((await cu.run(CLICK, { x: 1, y: 1, target: "File" }, ctx())).text).toBe(
      CU_MODEL_TEXT.noConsent,
    );
    expect(cu.active()).toBe(false);
    expect(fake.calls.at(-1)?.op).toBe("end");
  });

  it("maps helper refusals to clear notes", async () => {
    const { cu, ctx } = setup({ fail: { click: "outside" } });
    await cu.run(LOOK, START, ctx());
    expect((await cu.run(CLICK, { x: 1, y: 1, target: "File" }, ctx())).text).toBe(
      CU_MODEL_TEXT.outside,
    );
  });

  it("finishes with screen.done and audits the end", async () => {
    const { cu, fake, audit, ctx } = setup();
    await cu.run(LOOK, START, ctx());
    expect(await cu.run(DONE, { summary: "exported beach.png" }, ctx())).toEqual({
      text: CU_MODEL_TEXT.ended("exported beach.png"),
      isError: false,
    });
    expect(fake.calls.at(-1)?.op).toBe("end");
    expect(audit.at(-1)).toMatchObject({
      tool: "cu.end",
      input: { reason: "done", steps: 0 },
      result: "ok",
    });
  });
});
