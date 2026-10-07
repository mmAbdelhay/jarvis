import { describe, expect, it } from "vitest";
import type { AgentEvent, Card, ConfirmAnswer, DoctorState } from "./contract.js";
import { createNetworkDoctor } from "./doctor.js";
import { createRiskGate, type RiskGate } from "./risk-gate.js";
import type { RegisteredTool } from "./tool-registry.js";
import type { ToolOutcome } from "./types.js";

const connected = {
  nmRunning: true,
  connectivity: "full",
  devices: [{ name: "wlan0", type: "wifi", state: "connected", connection: "Home" }],
  ips: [{ dev: "wlan0", addr: "192.168.1.5/24" }],
  defaultRoute: "192.168.1.1 dev wlan0",
  dnsOk: true,
  gatewayPingOk: true,
  wifiSoftBlocked: false,
  wifiHardBlocked: false,
};
const offline = {
  ...connected,
  connectivity: "none",
  devices: [{ name: "wlan0", type: "wifi", state: "disconnected", connection: "" }],
  defaultRoute: null,
  dnsOk: false,
  gatewayPingOk: false,
};

const DIAG = [
  "net.radio_on",
  "svc.restart",
  "net.connection_up",
  "net.wifi_connect",
  "net.status",
  "net.wifi_scan",
  "logs.query",
  "svc.status",
];
const registered = (name: string): RegisteredTool => ({
  name,
  modelName: name.replace(".", "_"),
  server: "jarvis-diag",
  description: name,
  risk: ["net.status", "net.wifi_scan", "logs.query", "svc.status"].includes(name)
    ? "safe"
    : "confirm",
  hidden: false,
  secrets: name === "net.wifi_connect" ? ["password"] : [],
  batchItems: false,
  inputSchema: { type: "object", properties: {} },
  modelSchema: { type: "object", properties: {} },
});

function harness(options: {
  statuses: unknown[];
  scan?: unknown;
  reachable?: boolean[];
  answer?: (card: Card) => Omit<ConfirmAnswer, "cardId"> | "ignore";
  statusFails?: boolean;
  /** svc.status systemd-resolved answers not_found (contracts §6 #13). */
  resolvedMissing?: boolean;
}) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const states: DoctorState[] = [];
  const events: AgentEvent[] = [];
  const statuses = [...options.statuses];
  const reachable = [...(options.reachable ?? [true])];
  let summary: string | undefined;
  let gate: RiskGate | undefined;
  let ids = 0;
  gate = createRiskGate({
    emit: (event) => {
      events.push(event);
      if (event.type === "card" && options.answer !== undefined) {
        const card = event.card;
        const answer = options.answer(card);
        if (answer !== "ignore")
          queueMicrotask(() => gate?.confirm({ cardId: card.cardId, ...answer }));
      }
    },
    describe: async (tool, input) => ({
      title: `${tool.name} ${JSON.stringify(input)}`,
      detail: "",
      source: "network",
    }),
    audit: async () => {},
    now: () => 0,
    newId: () => `card${++ids}`,
    timers: { setTimeout: () => 0, clearTimeout: () => {} },
    log: () => {},
  });
  const callTool = async (name: string, input: Record<string, unknown>): Promise<ToolOutcome> => {
    calls.push({ name, input });
    if (name === "net.status") {
      if (options.statusFails === true)
        return { ok: false, data: null, text: "no jarvis-diag", code: "failed" };
      const next = statuses.length > 1 ? statuses.shift() : statuses[0];
      return { ok: true, data: next, text: "" };
    }
    if (name === "net.wifi_scan")
      return { ok: true, data: options.scan ?? { networks: [] }, text: "" };
    if (name === "svc.status") {
      return options.resolvedMissing === true
        ? {
            ok: false,
            data: { code: "not_found", message: "no such unit" },
            text: "no such unit",
            code: "not_found",
          }
        : {
            ok: true,
            data: {
              unit: input["unit"],
              scope: "system",
              active: "active",
              sub: "running",
              result: "success",
              since: "2026-10-07T09:00:00Z",
              lastLines: [],
            },
            text: "",
          };
    }
    if (name === "logs.query") {
      return {
        ok: true,
        data: {
          lines: [
            {
              ts: "2026-10-07T09:59:58Z",
              unit: "NetworkManager",
              priority: 4,
              message: "dhcp4 (wlan0): request timed out",
            },
          ],
          truncated: false,
        },
        text: "",
      };
    }
    return { ok: true, data: {}, text: "" };
  };
  const doctor = createNetworkDoctor({
    prepare: async () => {},
    tool: (name) => (DIAG.includes(name) ? registered(name) : undefined),
    callTool,
    gate,
    providerReachable: async () =>
      reachable.length > 1 ? (reachable.shift() as boolean) : (reachable[0] as boolean),
    emitState: (state) => states.push(state),
    onFinished: (text) => {
      summary = text;
    },
    log: () => {},
  });
  const finished = async () => {
    for (let i = 0; i < 500 && doctor.running; i++)
      await new Promise((resolve) => setTimeout(resolve, 0));
    return states.at(-1) as DoctorState;
  };
  return {
    doctor,
    calls,
    states,
    events,
    finished,
    summary: () => summary,
    gate: () => gate as RiskGate,
  };
}

const approveAll = (card: Card) => ({
  approve: true,
  ticked: card.items.map((i) => i.itemId),
  secrets: {},
});
const stepStatus = (state: DoctorState) =>
  Object.fromEntries(state.steps.map((s) => [s.stepId, s.status]));
const actions = (calls: { name: string; input: Record<string, unknown> }[]) =>
  calls.filter(
    (c) => !["net.status", "net.wifi_scan", "logs.query", "svc.status"].includes(c.name),
  );

describe("NetworkDoctor", () => {
  it("reports all ok and done fixed when nothing is wrong", async () => {
    const h = harness({ statuses: [connected] });
    const first = h.doctor.start();
    expect(first.active).toBe(true);
    const last = await h.finished();
    expect(stepStatus(last)).toEqual({
      radio: "ok",
      nm: "ok",
      connection: "ok",
      wifi: "ok",
      dns: "ok",
      provider: "ok",
    });
    expect(last).toMatchObject({ active: false, done: "fixed" });
    expect(h.events.some((e) => e.type === "card")).toBe(false);
  });

  it("1: Wi-Fi soft-blocked -> net.radio_on card", async () => {
    const h = harness({
      statuses: [{ ...offline, wifiSoftBlocked: true }, connected],
      answer: approveAll,
    });
    h.doctor.start();
    const last = await h.finished();
    expect(actions(h.calls)).toEqual([{ name: "net.radio_on", input: {} }]);
    expect(stepStatus(last).radio).toBe("fixed");
    expect(last.done).toBe("fixed");
    const card = h.events.find((e) => e.type === "card");
    expect(card?.type === "card" && card.card.turnId).toBeNull();
  });

  it("2: NetworkManager not running -> svc.restart NetworkManager card", async () => {
    const h = harness({
      statuses: [{ ...offline, nmRunning: false }, connected],
      answer: approveAll,
    });
    h.doctor.start();
    const last = await h.finished();
    expect(actions(h.calls)).toEqual([{ name: "svc.restart", input: { unit: "NetworkManager" } }]);
    expect(stepStatus(last).nm).toBe("fixed");
  });

  it("3: no active connection, a known one in range -> net.connection_up", async () => {
    const h = harness({
      statuses: [offline, connected],
      scan: {
        networks: [
          { ssid: "Cafe", signal: 80, security: "WPA2", known: false },
          { ssid: "Home", signal: 60, security: "WPA2", known: true },
        ],
      },
      answer: approveAll,
    });
    h.doctor.start();
    const last = await h.finished();
    expect(actions(h.calls)).toEqual([{ name: "net.connection_up", input: { id: "Home" } }]);
    expect(stepStatus(last)).toMatchObject({ connection: "fixed", wifi: "ok" });
  });

  it("4: no known network -> one wifi card item per network; the picked one joins with its password", async () => {
    const networks = [
      { ssid: "Weak", signal: 20, security: "WPA2", known: false },
      { ssid: "Strong", signal: 90, security: "WPA2", known: false },
      { ssid: "Open", signal: 50, security: "", known: false },
    ];
    const h = harness({
      statuses: [offline, connected],
      scan: { networks },
      answer: () => ({
        approve: true,
        ticked: ["item-2"],
        secrets: { "item-2": { password: "pw" } },
      }),
    });
    h.doctor.start();
    const last = await h.finished();
    const published = h.states.find((s) => s.networks.length > 0);
    expect(published?.networks.map((n) => n.ssid)).toEqual(["Strong", "Open", "Weak"]);
    const card = h.events.find((e) => e.type === "card");
    expect(card?.type === "card" && card.card.items.map((i) => i.title)).toEqual([
      'net.wifi_connect {"ssid":"Strong"}',
      'net.wifi_connect {"ssid":"Open"}',
      'net.wifi_connect {"ssid":"Weak"}',
    ]);
    expect(actions(h.calls)).toEqual([
      { name: "net.wifi_connect", input: { ssid: "Open", password: "pw" } },
    ]);
    expect(stepStatus(last).wifi).toBe("fixed");
  });

  it("5: connected but DNS fails -> svc.restart systemd-resolved", async () => {
    const h = harness({
      statuses: [{ ...connected, dnsOk: false }, connected],
      answer: approveAll,
    });
    h.doctor.start();
    const last = await h.finished();
    expect(actions(h.calls)).toEqual([
      { name: "svc.restart", input: { unit: "systemd-resolved" } },
    ]);
    expect(stepStatus(last).dns).toBe("fixed");
  });

  it("5b: DNS fix restarts NetworkManager when systemd-resolved is not installed (contracts §6 #13)", async () => {
    const h = harness({
      statuses: [{ ...connected, dnsOk: false }, connected],
      resolvedMissing: true,
      answer: approveAll,
    });
    h.doctor.start();
    const last = await h.finished();
    expect(h.calls).toContainEqual({ name: "svc.status", input: { unit: "systemd-resolved" } });
    expect(actions(h.calls)).toEqual([{ name: "svc.restart", input: { unit: "NetworkManager" } }]);
    expect(last.steps.find((s) => s.stepId === "dns")).toMatchObject({
      status: "fixed",
      detail: "NetworkManager restarted to repair name lookup.",
    });
  });

  it("4b: the Wi-Fi pick card accepts exactly one network (contracts §6 #9)", async () => {
    const h = harness({
      statuses: [offline, connected],
      scan: {
        networks: [
          { ssid: "A", signal: 90, security: "WPA2", known: false },
          { ssid: "B", signal: 80, security: "WPA2", known: false },
        ],
      },
      answer: () => "ignore",
    });
    h.doctor.start();
    for (let i = 0; i < 100 && !h.events.some((e) => e.type === "card"); i++)
      await new Promise((r) => setTimeout(r, 0));
    const card = h.events.find((e) => e.type === "card");
    if (card?.type !== "card") throw new Error("no card");
    expect(() =>
      h.gate().confirm({
        cardId: card.card.cardId,
        approve: true,
        ticked: ["item-1", "item-2"],
        secrets: {},
      }),
    ).toThrow();
    h.gate().confirm({
      cardId: card.card.cardId,
      approve: true,
      ticked: ["item-2"],
      secrets: { "item-2": { password: "pw" } },
    });
    await h.finished();
    expect(actions(h.calls)).toEqual([
      { name: "net.wifi_connect", input: { ssid: "B", password: "pw" } },
    ]);
  });

  it("6: still broken -> summary, last NetworkManager log lines, Ethernet/hotspot advice; done unfixed", async () => {
    const h = harness({ statuses: [offline], scan: { networks: [] }, reachable: [false] });
    h.doctor.start();
    const last = await h.finished();
    const provider = last.steps.find((s) => s.stepId === "provider");
    expect(provider?.status).toBe("problem");
    expect(provider?.detail).toContain("Connectivity: none.");
    expect(provider?.detail).toContain("dhcp4 (wlan0): request timed out");
    expect(provider?.detail).toContain("phone hotspot");
    expect(h.calls).toContainEqual({
      name: "logs.query",
      input: { unit: "NetworkManager", priority: 7, sinceMinutes: 60, limit: 20 },
    });
    expect(last.done).toBe("unfixed");
  });

  it("changes nothing on Deny", async () => {
    const h = harness({
      statuses: [{ ...offline, nmRunning: false }],
      reachable: [false],
      answer: () => ({ approve: false, ticked: [], secrets: {} }),
    });
    h.doctor.start();
    const last = await h.finished();
    expect(actions(h.calls)).toEqual([]);
    expect(last.steps.find((s) => s.stepId === "nm")).toMatchObject({
      status: "problem",
      detail: "Fix declined. Nothing was changed.",
    });
  });

  it("skipping the step whose card is open closes the card and moves on", async () => {
    const h = harness({
      statuses: [{ ...connected, wifiSoftBlocked: true, connectivity: "full" }],
      answer: () => "ignore",
    });
    h.doctor.start();
    for (let i = 0; i < 100 && !h.events.some((e) => e.type === "card"); i++)
      await new Promise((r) => setTimeout(r, 0));
    h.doctor.skip("radio");
    const last = await h.finished();
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "card-closed", decision: "denied" }),
    );
    expect(stepStatus(last)).toMatchObject({ radio: "skipped", nm: "ok", provider: "ok" });
  });

  it("without jarvis-diag every check is a problem and the doctor ends unfixed", async () => {
    const h = harness({ statuses: [], statusFails: true, reachable: [false] });
    h.doctor.start();
    const last = await h.finished();
    expect(stepStatus(last)).toMatchObject({
      radio: "problem",
      nm: "problem",
      provider: "problem",
    });
    expect(last.done).toBe("unfixed");
  });

  it("does not start twice and reports what it did when finished", async () => {
    const h = harness({
      statuses: [{ ...offline, nmRunning: false }, connected],
      answer: approveAll,
    });
    h.doctor.start();
    h.doctor.start();
    await h.finished();
    expect(h.calls.filter((c) => c.name === "svc.restart")).toHaveLength(1);
    expect(h.summary()).toContain("NetworkManager running: NetworkManager restarted.");
  });
});
