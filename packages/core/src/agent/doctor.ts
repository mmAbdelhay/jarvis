// The Network doctor (spec §7): a fixed checklist over jarvis-diag tools for
// when no model is reachable. Same confirm cards as the agent (turnId null,
// audited via "doctor"), no model anywhere. After every fix net.status runs
// again. When it finishes, onFinished hands the agent a one-line summary for
// the next prompt.
import { DOCTOR_STEP_IDS, type DoctorState, type DoctorStepId } from "./contract.js";
import type { Lang } from "./i18n.js";
import { DOCTOR_TEXT, type DoctorText } from "./messages.js";
import type { GateItemResult, RiskGate } from "./risk-gate.js";
import type { RegisteredTool } from "./tool-registry.js";
import { type ToolOutcome, isRecord } from "./types.js";

export const MAX_DOCTOR_NETWORKS = 10;
export const DOCTOR_LOG_LINES = 20;

export type NetStatus = {
  nmRunning: boolean;
  connectivity: "full" | "limited" | "portal" | "none" | "unknown";
  devices: { name: string; type: string; state: string; connection: string }[];
  dnsOk: boolean;
  gatewayPingOk: boolean;
  wifiSoftBlocked: boolean;
  wifiHardBlocked: boolean;
};
type WifiNetwork = DoctorState["networks"][number];

const CONNECTIVITY: ReadonlySet<string> = new Set(["full", "limited", "portal", "none", "unknown"]);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function parseNetStatus(data: unknown): NetStatus | undefined {
  if (!isRecord(data)) return undefined;
  const {
    nmRunning,
    connectivity,
    devices,
    dnsOk,
    gatewayPingOk,
    wifiSoftBlocked,
    wifiHardBlocked,
  } = data;
  if (
    typeof nmRunning !== "boolean" ||
    typeof dnsOk !== "boolean" ||
    typeof gatewayPingOk !== "boolean" ||
    typeof wifiSoftBlocked !== "boolean" ||
    typeof wifiHardBlocked !== "boolean" ||
    typeof connectivity !== "string" ||
    !CONNECTIVITY.has(connectivity)
  ) {
    return undefined;
  }
  return {
    nmRunning,
    connectivity: connectivity as NetStatus["connectivity"],
    devices: (Array.isArray(devices) ? devices : []).flatMap((device) =>
      isRecord(device) && typeof device["name"] === "string"
        ? [
            {
              name: device["name"],
              type: text(device["type"]),
              state: text(device["state"]),
              connection: text(device["connection"]),
            },
          ]
        : [],
    ),
    dnsOk,
    gatewayPingOk,
    wifiSoftBlocked,
    wifiHardBlocked,
  };
}

export function parseWifiScan(data: unknown): WifiNetwork[] {
  const networks = isRecord(data) && Array.isArray(data["networks"]) ? data["networks"] : [];
  return networks.flatMap((network) => {
    if (!isRecord(network) || typeof network["ssid"] !== "string" || network["ssid"] === "")
      return [];
    const signal =
      typeof network["signal"] === "number"
        ? Math.max(0, Math.min(100, Math.round(network["signal"])))
        : 0;
    return [
      {
        ssid: network["ssid"],
        signal,
        security: text(network["security"]),
        known: network["known"] === true,
      },
    ];
  });
}

export function isConnected(status: NetStatus): boolean {
  return (
    status.connectivity === "full" ||
    status.connectivity === "limited" ||
    status.connectivity === "portal" ||
    status.devices.some((device) => device.state === "connected")
  );
}

export type DoctorDeps = {
  /** Makes sure the MCP servers are up before the first call. */
  prepare(): Promise<void>;
  tool(name: string): RegisteredTool | undefined;
  callTool(name: string, input: Record<string, unknown>): Promise<ToolOutcome>;
  gate: RiskGate;
  providerReachable(): Promise<boolean>;
  emitState(state: DoctorState): void;
  onFinished(summary: string): void;
  log(line: string): void;
  /** The UI language (M4 §3); read when a run starts. Default en. */
  language?(): Lang;
};

export interface NetworkDoctor {
  start(): DoctorState;
  skip(stepId: DoctorStepId): DoctorState;
  state(): DoctorState;
  readonly running: boolean;
  /** Shutdown: closes an open card and skips what is left. */
  cancel(): void;
}

type StepResult = {
  status: "ok" | "fixed" | "problem" | "skipped";
  detail: string;
  /** English detail of a fix, for the model-facing note. */
  en?: string;
};
type FixOutcome = "fixed" | "declined" | "failed" | "unavailable" | "skipped";

function idleState(text: DoctorText): DoctorState {
  return {
    active: false,
    steps: DOCTOR_STEP_IDS.map((stepId) => ({
      stepId,
      label: text.labels[stepId],
      status: "pending",
      detail: "",
    })),
    networks: [],
    done: null,
  };
}

export function createNetworkDoctor(deps: DoctorDeps): NetworkDoctor {
  let lang: Lang = deps.language?.() ?? "en";
  let msg: DoctorText = DOCTOR_TEXT[lang];
  let state = idleState(msg);
  let running = false;
  let current: { stepId: DoctorStepId; controller: AbortController } | undefined;
  const skipped = new Set<DoctorStepId>();
  const fixes: string[] = [];

  const snapshot = (): DoctorState => JSON.parse(JSON.stringify(state)) as DoctorState;
  const publish = () => deps.emitState(snapshot());
  const setStep = (
    id: DoctorStepId,
    status: DoctorState["steps"][number]["status"],
    detail: string,
  ) => {
    state = {
      ...state,
      steps: state.steps.map((s) => (s.stepId === id ? { ...s, status, detail } : s)),
    };
    publish();
  };

  async function netStatus(): Promise<NetStatus | undefined> {
    const outcome = await deps.callTool("net.status", {});
    return outcome.ok ? parseNetStatus(outcome.data) : undefined;
  }

  async function scan(): Promise<WifiNetwork[]> {
    const outcome = await deps.callTool("net.wifi_scan", {});
    return outcome.ok ? parseWifiScan(outcome.data) : [];
  }

  async function nmLogLines(): Promise<string[]> {
    const outcome = await deps.callTool("logs.query", {
      unit: "NetworkManager",
      priority: 7,
      sinceMinutes: 60,
      limit: DOCTOR_LOG_LINES,
    });
    const lines =
      outcome.ok && isRecord(outcome.data) && Array.isArray(outcome.data["lines"])
        ? outcome.data["lines"]
        : [];
    return lines.flatMap((line) =>
      isRecord(line) && typeof line["message"] === "string" ? [line["message"]] : [],
    );
  }

  async function propose(
    stepId: DoctorStepId,
    calls: { tool: string; input: Record<string, unknown> }[],
    options: { maxTicked?: number } = {},
  ): Promise<FixOutcome> {
    const tools = calls.map((call) => deps.tool(call.tool));
    if (tools.some((tool) => tool === undefined)) return "unavailable";
    const controller = new AbortController();
    current = { stepId, controller };
    let results: GateItemResult[];
    try {
      results = await deps.gate.runBatch({
        turnId: null,
        via: "doctor",
        signal: controller.signal,
        ...(options.maxTicked === undefined ? {} : { maxTicked: options.maxTicked }),
        calls: calls.map((call, i) => ({
          callId: `doctor-${stepId}-${i + 1}`,
          tool: tools[i] as RegisteredTool,
          input: call.input,
        })),
        execute: (call, input) => deps.callTool(call.tool.name, input),
      });
    } finally {
      current = undefined;
    }
    if (skipped.has(stepId)) return "skipped";
    const ran = results.filter((result) => result.status === "ran");
    if (ran.length === 0) return "declined";
    return ran.some((result) => result.outcome?.ok === true) ? "fixed" : "failed";
  }

  function settle(outcome: FixOutcome, fixedDetail: (m: DoctorText) => string): StepResult {
    switch (outcome) {
      case "fixed":
        return { status: "fixed", detail: fixedDetail(msg), en: fixedDetail(DOCTOR_TEXT.en) };
      case "declined":
        return { status: "problem", detail: msg.declined };
      case "failed":
        return { status: "problem", detail: msg.fixFailed };
      case "unavailable":
        return { status: "problem", detail: msg.toolMissing };
      case "skipped":
        return { status: "skipped", detail: msg.skipped };
    }
  }

  async function step(id: DoctorStepId, body: () => Promise<StepResult>): Promise<void> {
    if (skipped.has(id)) {
      setStep(id, "skipped", msg.skipped);
      return;
    }
    setStep(id, "running", "");
    let result: StepResult;
    try {
      result = await body();
    } catch (error) {
      result = {
        status: "problem",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    if (skipped.has(id)) result = { status: "skipped", detail: msg.skipped };
    if (result.status === "fixed") fixes.push(`${DOCTOR_TEXT.en.labels[id]}: ${result.en ?? result.detail}`);
    setStep(id, result.status, result.detail);
  }

  async function finalStep(net: NetStatus | undefined): Promise<void> {
    let reachable = false;
    await step("provider", async () => {
      reachable = await deps.providerReachable();
      if (reachable) return { status: "ok", detail: msg.providerOk };
      const summary = net === undefined ? msg.diagMissing : msg.statusSummary(net);
      return { status: "problem", detail: msg.stillBroken(summary, await nmLogLines()) };
    });
    state = { ...state, active: false, done: reachable ? "fixed" : "unfixed" };
    publish();
  }

  async function run(): Promise<void> {
    await deps.prepare();
    const initial = await netStatus();
    if (initial === undefined) {
      for (const id of ["radio", "nm", "connection", "wifi", "dns"] as const)
        setStep(id, "problem", msg.diagMissing);
      await finalStep(undefined);
      return;
    }
    let net: NetStatus = initial;
    const refresh = async () => {
      net = (await netStatus()) ?? net;
    };

    await step("radio", async () => {
      if (!net.wifiSoftBlocked) {
        return {
          status: "ok",
          detail: net.wifiHardBlocked ? msg.hardBlocked : msg.radioOk,
        };
      }
      setStep("radio", "problem", msg.radioOff);
      const outcome = await propose("radio", [{ tool: "net.radio_on", input: {} }]);
      await refresh();
      return settle(outcome, (m) => m.radioFixed);
    });

    await step("nm", async () => {
      if (net.nmRunning) return { status: "ok", detail: msg.nmOk };
      setStep("nm", "problem", msg.nmDown);
      const outcome = await propose("nm", [
        { tool: "svc.restart", input: { unit: "NetworkManager" } },
      ]);
      await refresh();
      return settle(outcome, (m) => m.nmFixed);
    });

    let visible: WifiNetwork[] | undefined;
    await step("connection", async () => {
      if (isConnected(net)) {
        const active = net.devices.find((device) => device.state === "connected")?.connection ?? "";
        return { status: "ok", detail: msg.connected(active) };
      }
      visible = await scan();
      const known = [...visible].filter((n) => n.known).sort((a, b) => b.signal - a.signal)[0];
      if (known === undefined) return { status: "problem", detail: msg.noKnown };
      setStep("connection", "problem", msg.notConnected);
      const outcome = await propose("connection", [
        { tool: "net.connection_up", input: { id: known.ssid } },
      ]);
      await refresh();
      return settle(outcome, (m) => m.connectionFixed(known.ssid));
    });

    await step("wifi", async () => {
      if (isConnected(net)) return { status: "ok", detail: msg.wifiNotNeeded };
      const networks = [...(visible ?? (await scan()))]
        .sort((a, b) => b.signal - a.signal)
        .slice(0, MAX_DOCTOR_NETWORKS);
      state = { ...state, networks };
      publish();
      if (networks.length === 0) return { status: "problem", detail: msg.noNetworks };
      setStep("wifi", "problem", msg.pickNetwork);
      // One item per network, in DoctorState.networks order, none ticked by
      // the shell; the user ticks exactly one and its password rides in
      // secrets["item-N"].password (contracts §6 #9). jarvisd refuses more.
      const outcome = await propose(
        "wifi",
        networks.map((network) => ({ tool: "net.wifi_connect", input: { ssid: network.ssid } })),
        { maxTicked: 1 },
      );
      await refresh();
      return settle(outcome, (m) => m.wifiFixed);
    });

    await step("dns", async () => {
      if (!isConnected(net)) return { status: "skipped", detail: msg.dnsNeedsConnection };
      if (net.dnsOk) return { status: "ok", detail: msg.dnsOk };
      setStep("dns", "problem", msg.dnsBroken);
      // Without systemd-resolved, NetworkManager owns DNS (contracts §6 #13).
      const resolved = await deps.callTool("svc.status", { unit: "systemd-resolved" });
      const unit =
        !resolved.ok && resolved.code === "not_found" ? "NetworkManager" : "systemd-resolved";
      const outcome = await propose("dns", [{ tool: "svc.restart", input: { unit } }]);
      await refresh();
      return settle(outcome, (m) => (unit === "NetworkManager" ? m.dnsFixedViaNm : m.dnsFixed));
    });

    await finalStep(net);
  }

  return {
    start() {
      if (running) return snapshot();
      lang = deps.language?.() ?? "en";
      msg = DOCTOR_TEXT[lang];
      running = true;
      skipped.clear();
      fixes.length = 0;
      state = { ...idleState(msg), active: true };
      publish();
      void run()
        .catch((error: unknown) => {
          deps.log(`[doctor] ${error instanceof Error ? error.message : String(error)}`);
          state = { ...state, active: false, done: "unfixed" };
          publish();
        })
        .finally(() => {
          running = false;
          deps.onFinished(DOCTOR_TEXT.en.summary(state.done === "fixed" ? "fixed" : "unfixed", fixes));
        });
      return snapshot();
    },
    skip(stepId) {
      if (!running) return snapshot();
      skipped.add(stepId);
      if (current?.stepId === stepId) current.controller.abort();
      if (state.steps.find((s) => s.stepId === stepId)?.status === "pending") {
        setStep(stepId, "skipped", msg.skipped);
      }
      return snapshot();
    },
    state: snapshot,
    get running() {
      return running;
    },
    cancel() {
      for (const id of DOCTOR_STEP_IDS) skipped.add(id);
      current?.controller.abort();
    },
  };
}
