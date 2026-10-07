// The Jarvis OS agent behind the control socket: one model provider, the
// MCP servers' tools, the tool loop, the risk gate, the network doctor and
// the audit log, composed from injected pieces (os-daemon-main.ts passes the
// real ones). Every push goes out through `push` on the contract §3.2
// channels.
//
// No electron here (core/no-electron.test.ts).
import {
  AGENT_TEXT,
  type AgentEvent,
  type AuditEntry,
  type AuditQuery,
  type ConfirmAnswer,
  createFakeProvider,
  createNetworkDoctor,
  createRiskGate,
  type DoctorState,
  type DoctorStepId,
  type FakeTurn,
  GateError,
  loadToolRegistry,
  type McpSession,
  type ModelMessage,
  type ModelProvider,
  PROVIDER_KINDS,
  parseNetStatus,
  parseFailedUnitNames,
  parseSysHealth,
  buildSysSnapshot,
  type SysSnapshot,
  type ProbeResult,
  type ProviderConfig,
  type ProviderDraft,
  type ProviderKind,
  runTurn,
  type ToolRegistry,
  TRUSTED_MCP_SERVERS,
  trimHistory,
} from "@jarvis/core";
import { providerAccount, type SecretStore } from "@jarvis/platform/model";
import { OS_CONTROL_PUSHES } from "@jarvis/wire";
import {
  type ConfigIo,
  type ProviderSection,
  readProviderSection,
  writeProviderSection,
} from "./provider-config.js";
import { createLazyKeyProvider, unavailableProvider } from "./provider-factory.js";
import { createProviderMonitor } from "./provider-monitor.js";
import { createSysMonitor } from "./sys-monitor.js";

export class OsAgentError extends Error {
  constructor(
    readonly code: "bad-request" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "OsAgentError";
  }
}

export type OsAgentDeps = {
  push(channel: string, payload: unknown): void;
  configPath: string;
  configIo: ConfigIo;
  secrets: SecretStore;
  makeProvider(section: ProviderSection, apiKey: string | undefined): ModelProvider;
  /** Set only from JARVIS_FAKE_PROVIDER (contracts §5). */
  fakeScript?: readonly FakeTurn[];
  connectMcp(): Promise<McpSession[]>;
  audit: {
    append(entry: AuditEntry): Promise<void>;
    list(query: AuditQuery): Promise<AuditEntry[]>;
  };
  now(): number;
  newId(): string;
  timers: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  log(line: string): void;
};

export interface OsAgent {
  start(): Promise<void>;
  prompt(text: string): { turnId: string };
  stop(turnId: string): null;
  confirm(answer: ConfirmAnswer): null;
  providerList(): Promise<{ active: ProviderConfig | null; kinds: ProviderKind[] }>;
  probe(draft: ProviderDraft): Promise<ProbeResult>;
  save(draft: ProviderDraft): Promise<ProbeResult>;
  doctorStart(): DoctorState;
  doctorSkip(stepId: DoctorStepId): DoctorState;
  auditList(query: AuditQuery): Promise<AuditEntry[]>;
  /** A shell (re)connected: re-push what a broadcast it missed would have said. */
  resync(): void;
  shutdown(): Promise<void>;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createOsAgent(deps: OsAgentDeps): OsAgent {
  const emit = (event: AgentEvent) => deps.push(OS_CONTROL_PUSHES.agentEvents, event);
  let provider: ModelProvider = unavailableProvider(AGENT_TEXT.noProvider);
  let section: ProviderSection | null = null;
  let sessions: McpSession[] = [];
  let registry: ToolRegistry | undefined;
  let loading: Promise<ToolRegistry> | undefined;
  let history: ModelMessage[] = [];
  let turn: { turnId: string; controller: AbortController } | undefined;
  let doctorNote: string | undefined;

  function ensureRegistry(): Promise<ToolRegistry> {
    if (registry !== undefined && sessions.length > 0 && sessions.every((s) => s.alive)) {
      return Promise.resolve(registry);
    }
    if (loading !== undefined) return loading;
    loading = (async () => {
      for (const old of sessions) old.close();
      try {
        sessions = await deps.connectMcp();
      } catch (error) {
        deps.log(`[agent] the MCP servers did not start: ${describeError(error)}`);
        sessions = [];
      }
      registry = await loadToolRegistry(sessions, {
        trusted: new Set(TRUSTED_MCP_SERVERS),
        log: deps.log,
      });
      return registry;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  const gate = createRiskGate({
    emit,
    describe: async (tool, input) => (await ensureRegistry()).describe(tool, input),
    audit: (entry) => deps.audit.append(entry),
    now: deps.now,
    newId: deps.newId,
    timers: deps.timers,
    log: deps.log,
  });

  const monitor = createProviderMonitor({
    check: () => provider.reachable(),
    push: (status) => deps.push(OS_CONTROL_PUSHES.providerStatus, status),
    timers: deps.timers,
  });

  const doctor = createNetworkDoctor({
    prepare: async () => {
      await ensureRegistry();
    },
    tool: (name) => registry?.get(name),
    callTool: async (name, input) => (await ensureRegistry()).call(name, input),
    gate,
    providerReachable: async () => (await monitor.recheck()).reachable,
    emitState: (state) => deps.push(OS_CONTROL_PUSHES.doctorState, state),
    onFinished: (summary) => {
      doctorNote = AGENT_TEXT.doctorNote(summary);
      void sys.refresh();
    },
    log: deps.log,
  });

  // sys:snapshot (contracts §6 #8), built from sys.health + net.status (and
  // svc.list_failed for the unit names when sys.health counts any).
  async function collectSnapshot(): Promise<SysSnapshot> {
    const tools = await ensureRegistry();
    const [health, net] = await Promise.all([
      tools.call("sys.health", {}),
      tools.call("net.status", {}),
    ]);
    const parsedHealth = health.ok ? parseSysHealth(health.data) : undefined;
    const parsedNet = net.ok ? parseNetStatus(net.data) : undefined;
    let failedUnits: string[] = [];
    if (parsedHealth !== undefined && parsedHealth.failedUnits > 0) {
      const failed = await tools.call("svc.list_failed", {});
      failedUnits = failed.ok ? parseFailedUnitNames(failed.data) : [];
    }
    return buildSysSnapshot({
      ...(parsedHealth === undefined ? {} : { health: parsedHealth }),
      ...(parsedNet === undefined ? {} : { net: parsedNet }),
      failedUnits,
      model:
        section === null
          ? null
          : {
              kind: section.kind,
              model: section.model,
              baseUrl: section.baseUrl,
              supportsTools: section.supportsTools,
            },
    });
  }

  const sys = createSysMonitor({
    collect: collectSnapshot,
    push: (snapshot) => deps.push(OS_CONTROL_PUSHES.sysSnapshot, snapshot),
    timers: deps.timers,
    log: deps.log,
  });

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      deps.timers.setTimeout(resolve, ms);
    });

  /** The key is read at first use and retried (contracts §6 #12): the
   *  keyring unlocks with the session, possibly after jarvisd started. */
  function keyedProvider(target: ProviderSection): ModelProvider {
    return createLazyKeyProvider({
      readKey: () => deps.secrets.get(providerAccount(target.kind, target.baseUrl)),
      build: (key) => deps.makeProvider(target, key),
      sleep,
    });
  }

  async function loadProvider(): Promise<void> {
    try {
      section = await readProviderSection(deps.configPath, deps.configIo);
    } catch (error) {
      deps.log(`[agent] ${describeError(error)}`);
      section = null;
    }
    // JARVIS_FAKE_PROVIDER replaces the configured provider entirely, and
    // works with none configured (contracts §6 #11).
    if (deps.fakeScript !== undefined) {
      provider = createFakeProvider(deps.fakeScript);
      return;
    }
    provider =
      section === null ? unavailableProvider(AGENT_TEXT.noProvider) : keyedProvider(section);
  }

  function draftProvider(draft: ProviderDraft): ModelProvider {
    const target: ProviderSection = {
      kind: draft.kind,
      baseUrl: draft.baseUrl,
      model: draft.model,
      auth: "api-key",
      supportsTools: true,
    };
    // No apiKey in the draft: use the stored one (contracts §6 #10).
    return draft.apiKey === undefined
      ? keyedProvider(target)
      : deps.makeProvider(target, draft.apiKey);
  }

  return {
    async start() {
      await loadProvider();
      monitor.start();
      void ensureRegistry();
      sys.start();
    },

    prompt(text) {
      if (turn !== undefined) throw new OsAgentError("bad-request", AGENT_TEXT.turnRunning);
      if (doctor.running) throw new OsAgentError("bad-request", AGENT_TEXT.doctorRunning);
      const turnId = deps.newId();
      const controller = new AbortController();
      turn = { turnId, controller };
      const context = doctorNote;
      doctorNote = undefined;
      void (async () => {
        try {
          const tools = await ensureRegistry();
          const result = await runTurn(
            {
              provider,
              registry: tools,
              gate,
              toolsEnabled: deps.fakeScript !== undefined || section?.supportsTools !== false,
              emit,
              newId: deps.newId,
            },
            {
              turnId,
              history,
              text,
              signal: controller.signal,
              ...(context === undefined ? {} : { context }),
            },
          );
          history = trimHistory(result.messages);
          if (result.reason !== "error") monitor.reportOk();
          else if (result.errorKind === "network" || result.errorKind === "auth") {
            monitor.reportFailure(result.error ?? "unreachable");
          }
        } catch (error) {
          emit({ type: "turn-end", turnId, reason: "error", error: describeError(error) });
        } finally {
          if (turn?.turnId === turnId) turn = undefined;
        }
      })();
      return { turnId };
    },

    stop(turnId) {
      if (turn?.turnId === turnId) turn.controller.abort();
      return null;
    },

    confirm(answer) {
      try {
        gate.confirm(answer);
      } catch (error) {
        if (error instanceof GateError) throw new OsAgentError("bad-request", error.message);
        throw error;
      }
      return null;
    },

    async providerList() {
      const kinds = [...PROVIDER_KINDS];
      if (section === null) return { active: null, kinds };
      let hasKey = false;
      try {
        hasKey =
          (await deps.secrets.get(providerAccount(section.kind, section.baseUrl))) !== undefined;
      } catch {
        hasKey = false;
      }
      return {
        active: { kind: section.kind, baseUrl: section.baseUrl, model: section.model, hasKey },
        kinds,
      };
    },

    async probe(draft) {
      const candidate = draftProvider(draft);
      if (draft.model === "") {
        // Contracts §6 #10: an empty model lists models without the tool test.
        try {
          return { ok: true, supportsTools: false, models: await candidate.listModels() };
        } catch (error) {
          return { ok: false, supportsTools: false, models: [], error: describeError(error) };
        }
      }
      return candidate.probe();
    },

    async save(draft) {
      if (draft.model === "") throw new OsAgentError("bad-request", "Pick a model before saving");
      const result = await draftProvider(draft).probe();
      if (!result.ok) return result;
      try {
        if (draft.apiKey !== undefined) {
          await deps.secrets.set(providerAccount(draft.kind, draft.baseUrl), draft.apiKey);
        }
        await writeProviderSection(
          deps.configPath,
          {
            kind: draft.kind,
            baseUrl: draft.baseUrl,
            model: draft.model,
            auth: "api-key",
            supportsTools: result.supportsTools,
          },
          deps.configIo,
        );
      } catch (error) {
        return { ...result, ok: false, error: describeError(error) };
      }
      await loadProvider();
      void monitor.recheck();
      void sys.refresh();
      return result;
    },

    doctorStart() {
      if (turn !== undefined) throw new OsAgentError("bad-request", AGENT_TEXT.turnRunning);
      return doctor.start();
    },

    doctorSkip(stepId) {
      return doctor.skip(stepId);
    },

    auditList(query) {
      return deps.audit.list(query);
    },

    resync() {
      // Contracts §6 #7: on every new connection, re-push provider:status,
      // doctor:state, sys:snapshot and every open card (the shell de-dups
      // cards by cardId).
      const status = monitor.current();
      if (status !== undefined) deps.push(OS_CONTROL_PUSHES.providerStatus, status);
      deps.push(OS_CONTROL_PUSHES.doctorState, doctor.state());
      const snapshot = sys.current();
      if (snapshot !== undefined) deps.push(OS_CONTROL_PUSHES.sysSnapshot, snapshot);
      for (const card of gate.openCards()) emit({ type: "card", card });
    },

    async shutdown() {
      turn?.controller.abort();
      doctor.cancel();
      gate.closeAll();
      monitor.stop();
      sys.stop();
      for (const open of sessions) open.close();
    },
  };
}
