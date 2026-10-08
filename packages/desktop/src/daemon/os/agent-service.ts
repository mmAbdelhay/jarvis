// The Jarvis OS agent behind the control socket: one model provider, the
// MCP servers' tools, the tool loop, the risk gate, the network doctor and
// the audit log, composed from injected pieces (os-daemon-main.ts passes the
// real ones). Every push goes out through `push` on the contract §3.2
// channels.
//
// No electron here (core/no-electron.test.ts).
import {
  AGENT_TEXT,
  CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  createFailoverProvider,
  type FailoverProvider,
  isLocalBaseUrl,
  type ProviderListResult,
  type ProviderSaveRequest,
  type ProviderSaveResult,
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
  modelDownloadFor,
  type McpSession,
  type ModelMessage,
  type ModelState,
  type ModelProvider,
  PROVIDER_KINDS,
  parseNetStatus,
  parseFailedUnitNames,
  parseSysHealth,
  buildSysSnapshot,
  type SysSnapshot,
  type ProbeResult,
  type ProviderDraft,
  runTurn,
  type ToolRegistry,
  TRUSTED_MCP_SERVERS,
  trimHistory,
  type UpdatesCheckResult,
} from "@jarvis/core";
import type { SecretStore } from "@jarvis/platform/model";
import { OS_CONTROL_PUSHES } from "@jarvis/wire";
import type { ConfigIo, ProviderSection } from "./provider-config.js";
import {
  createLazyKeyProvider,
  unavailableProvider,
} from "./provider-factory.js";
import {
  hasProviderKey,
  type ProviderKeyStores,
  readProviderKey,
} from "./provider-keys.js";
import {
  emptyBrain,
  type OsBrainConfig,
  type ProviderEntry,
  readOsBrainConfig,
  writeOsProviders,
} from "./provider-list-config.js";
import { createProviderMonitor } from "./provider-monitor.js";
import { createSysMonitor } from "./sys-monitor.js";
import { createUpdatesMonitor, UpdatesCheckError } from "./updates-monitor.js";

export class OsAgentError extends Error {
  constructor(
    readonly code: "bad-request" | "unsupported" | "internal",
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
  /** Provider keys by id (M2.5 contracts §1: attribute provider=<id>). `secrets`
   *  stays the account-keyed store (M1 keys, read once for migration). */
  providerKeys: SecretStore;
  makeProvider(
    section: ProviderSection,
    apiKey: string | undefined,
  ): ModelProvider;
  /** Set only from JARVIS_FAKE_PROVIDER (contracts §5). */
  fakeScript?: readonly FakeTurn[];
  connectMcp(): Promise<McpSession[]>;
  /** /var/lib/jarvis/model-state.json (M2 contracts §5); null when absent or
   *  unreadable. Never throws (model-state-reader.ts). */
  readModelState(): Promise<ModelState | null>;
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
  providerList(): Promise<ProviderListResult>;
  probe(draft: ProviderDraft & { id?: string }): Promise<ProbeResult>;
  save(request: ProviderSaveRequest): Promise<ProviderSaveResult>;
  doctorStart(): DoctorState;
  doctorSkip(stepId: DoctorStepId): DoctorState;
  auditList(query: AuditQuery): Promise<AuditEntry[]>;
  /** updates:check (M2 contracts §2). */
  checkUpdates(): Promise<UpdatesCheckResult>;
  /** A shell (re)connected: re-push what a broadcast it missed would have said. */
  resync(): void;
  shutdown(): Promise<void>;
}

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function createOsAgent(deps: OsAgentDeps): OsAgent {
  const emit = (event: AgentEvent) => {
    deps.push(OS_CONTROL_PUSHES.agentEvents, event);
    // An upgrade changes what is pending: refresh the badge (M2 contracts §2).
    if (
      event.type === "tool" &&
      event.name === "updates.apply" &&
      event.status !== "running"
    ) {
      updates.check().catch((error: unknown) => {
        deps.log(
          `[updates] re-check after updates.apply failed: ${describeError(error)}`,
        );
      });
    }
  };
  let provider: ModelProvider = unavailableProvider(AGENT_TEXT.noProvider);
  let brain: OsBrainConfig = emptyBrain();
  let failover: FailoverProvider | undefined;
  const keyStores = (): ProviderKeyStores => ({
    providerKeys: deps.providerKeys,
    legacy: deps.secrets,
    migrateLegacy: brain.migratedFromLegacy,
    log: deps.log,
  });
  /** The provider answering now; the first one before any answer. */
  function activeEntry(): ProviderEntry | null {
    const id = failover?.status().activeId;
    return (
      brain.providers.find((entry) => entry.id === id) ??
      brain.providers[0] ??
      null
    );
  }
  /** The smallest context in the list: a failover mid-turn must still fit. */
  function contextTokens(): number {
    const sizes = brain.providers.map(
      (entry) => CONTEXT_TOKENS[entry.kind] ?? DEFAULT_CONTEXT_TOKENS,
    );
    return sizes.length === 0 ? DEFAULT_CONTEXT_TOKENS : Math.min(...sizes);
  }
  let sessions: McpSession[] = [];
  let registry: ToolRegistry | undefined;
  let loading: Promise<ToolRegistry> | undefined;
  let history: ModelMessage[] = [];
  let turn: { turnId: string; controller: AbortController } | undefined;
  let doctorNote: string | undefined;

  function ensureRegistry(): Promise<ToolRegistry> {
    if (
      registry !== undefined &&
      sessions.length > 0 &&
      sessions.every((s) => s.alive)
    ) {
      return Promise.resolve(registry);
    }
    if (loading !== undefined) return loading;
    loading = (async () => {
      for (const old of sessions) old.close();
      try {
        sessions = await deps.connectMcp();
      } catch (error) {
        deps.log(
          `[agent] the MCP servers did not start: ${describeError(error)}`,
        );
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
    describe: async (tool, input) =>
      (await ensureRegistry()).describe(tool, input),
    audit: (entry) => deps.audit.append(entry),
    now: deps.now,
    newId: deps.newId,
    timers: deps.timers,
    log: deps.log,
  });

  const monitor = createProviderMonitor({
    check: () => provider.reachable(),
    active: () =>
      failover?.status() ?? { activeId: null, fallbackReason: null },
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
    const modelState = await deps.readModelState();
    return buildSysSnapshot({
      ...(parsedHealth === undefined ? {} : { health: parsedHealth }),
      ...(parsedNet === undefined ? {} : { net: parsedNet }),
      failedUnits,
      model: (() => {
        const active = activeEntry();
        return active === null
          ? null
          : {
              kind: active.kind,
              model: active.model,
              baseUrl: active.baseUrl,
              supportsTools: active.supportsTools,
              download: modelDownloadFor(active, modelState),
            };
      })(),
      updates: updates.current(),
    });
  }

  const sys = createSysMonitor({
    collect: collectSnapshot,
    push: (snapshot) => deps.push(OS_CONTROL_PUSHES.sysSnapshot, snapshot),
    timers: deps.timers,
    log: deps.log,
  });

  // sys:snapshot.updates (M2 contracts §2): 2 min after start, then daily.
  const updates = createUpdatesMonitor({
    list: async () => (await ensureRegistry()).call("updates.list", {}),
    onChange: () => void sys.refresh(),
    now: deps.now,
    timers: deps.timers,
    log: deps.log,
  });

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      deps.timers.setTimeout(resolve, ms);
    });

  /** The key is read at first use and retried (contracts §6 #12). */
  function keyedProvider(
    target: ProviderSection,
    keyOf: ProviderEntry,
  ): ModelProvider {
    return createLazyKeyProvider({
      readKey: () => readProviderKey(keyOf, keyStores()),
      build: (key) => deps.makeProvider(target, key),
      sleep,
    });
  }

  async function loadProvider(): Promise<void> {
    try {
      brain = await readOsBrainConfig(deps.configPath, deps.configIo);
    } catch (error) {
      deps.log(`[agent] ${describeError(error)}`);
      brain = emptyBrain();
    }
    failover = undefined;
    // JARVIS_FAKE_PROVIDER replaces the configured providers entirely (contracts §6 #11).
    if (deps.fakeScript !== undefined) {
      provider = createFakeProvider(deps.fakeScript);
      return;
    }
    if (brain.providers.length === 0) {
      provider = unavailableProvider(AGENT_TEXT.noProvider);
      return;
    }
    failover = createFailoverProvider({
      entries: brain.providers.map((entry) => ({
        id: entry.id,
        locality: isLocalBaseUrl(entry.baseUrl)
          ? ("local" as const)
          : ("cloud" as const),
        provider: keyedProvider(entry, entry),
      })),
      allowCloudFallback: brain.allowCloudFallback,
      timers: deps.timers,
      onSwitch: (change) => {
        deps.log(
          `[provider] ${change.fromId} -> ${change.toId}: ${change.reason}`,
        );
        monitor.noteActive();
      },
    });
    provider = failover;
  }

  /** A stored key is reused only from a saved entry with the same kind and
   *  base URL (and the same id when one is given): a changed URL never
   *  receives the old key. */
  function draftProvider(
    draft: ProviderDraft & { id?: string },
  ): ModelProvider {
    const target: ProviderSection = {
      kind: draft.kind,
      baseUrl: draft.baseUrl,
      model: draft.model,
      auth: "api-key",
      supportsTools: true,
    };
    if (draft.apiKey !== undefined)
      return deps.makeProvider(target, draft.apiKey);
    const saved = brain.providers.find(
      (entry) =>
        (draft.id === undefined || entry.id === draft.id) &&
        entry.kind === draft.kind &&
        entry.baseUrl === draft.baseUrl,
    );
    return saved === undefined
      ? deps.makeProvider(target, undefined)
      : keyedProvider(target, saved);
  }

  return {
    async start() {
      await loadProvider();
      monitor.start();
      void ensureRegistry();
      sys.start();
      updates.start();
    },

    prompt(text) {
      if (turn !== undefined)
        throw new OsAgentError("bad-request", AGENT_TEXT.turnRunning);
      if (doctor.running)
        throw new OsAgentError("bad-request", AGENT_TEXT.doctorRunning);
      const turnId = deps.newId();
      const controller = new AbortController();
      turn = { turnId, controller };
      const context = doctorNote;
      doctorNote = undefined;
      void (async () => {
        try {
          const tools = await ensureRegistry();
          failover?.beginTurn();
          const result = await runTurn(
            {
              provider,
              registry: tools,
              gate,
              contextTokens: contextTokens(),
              toolsEnabled:
                deps.fakeScript !== undefined ||
                activeEntry()?.supportsTools !== false,
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
          else if (
            result.errorKind === "network" ||
            result.errorKind === "auth"
          ) {
            monitor.reportFailure(result.error ?? "unreachable");
          }
        } catch (error) {
          emit({
            type: "turn-end",
            turnId,
            reason: "error",
            error: describeError(error),
          });
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
        if (error instanceof GateError)
          throw new OsAgentError("bad-request", error.message);
        throw error;
      }
      return null;
    },

    async providerList() {
      const providers = await Promise.all(
        brain.providers.map(async (entry) => ({
          id: entry.id,
          kind: entry.kind,
          baseUrl: entry.baseUrl,
          model: entry.model,
          hasKey: await hasProviderKey(entry, keyStores()),
        })),
      );
      return {
        providers,
        activeId: failover?.status().activeId ?? null,
        allowCloudFallback: brain.allowCloudFallback,
        kinds: [...PROVIDER_KINDS],
      };
    },

    async probe(draft) {
      const candidate = draftProvider(draft);
      if (draft.model === "") {
        // Contracts §6 #10: an empty model lists models without the tool test.
        try {
          return {
            ok: true,
            supportsTools: false,
            models: await candidate.listModels(),
          };
        } catch (error) {
          return {
            ok: false,
            supportsTools: false,
            models: [],
            error: describeError(error),
          };
        }
      }
      return candidate.probe();
    },

    async save(request) {
      if (request.providers.some((draft) => draft.model === "")) {
        throw new OsAgentError("bad-request", "Pick a model before saving");
      }
      // Contracts §7 #11: probe only new or changed providers (or ones that
      // carry a key); an unchanged saved entry keeps its saved supportsTools.
      const savedById = new Map(
        brain.providers.map((entry) => [entry.id, entry]),
      );
      const probed = await Promise.all(
        request.providers.map(
          async (draft): Promise<readonly [string, ProbeResult]> => {
            const saved = savedById.get(draft.id);
            const unchanged =
              saved !== undefined &&
              draft.apiKey === undefined &&
              saved.kind === draft.kind &&
              saved.baseUrl === draft.baseUrl &&
              saved.model === draft.model;
            if (unchanged) {
              return [
                draft.id,
                { ok: true, supportsTools: saved.supportsTools, models: [] },
              ];
            }
            return [draft.id, await draftProvider(draft).probe()];
          },
        ),
      );
      const results: Record<string, ProbeResult> = Object.fromEntries(probed);
      if (!probed.every(([, result]) => result.ok))
        return { ok: false, results };
      const previous = brain.providers;
      try {
        for (const draft of request.providers) {
          if (draft.apiKey !== undefined)
            await deps.providerKeys.set(draft.id, draft.apiKey);
        }
        await writeOsProviders(
          deps.configPath,
          {
            providers: request.providers.map((draft) => ({
              id: draft.id,
              kind: draft.kind,
              baseUrl: draft.baseUrl,
              model: draft.model,
              auth: "api-key" as const,
              supportsTools: results[draft.id]?.supportsTools ?? true,
            })),
            allowCloudFallback: request.allowCloudFallback,
          },
          deps.configIo,
        );
      } catch (error) {
        const message = describeError(error);
        return {
          ok: false,
          results: Object.fromEntries(
            probed.map(([id, result]) => [
              id,
              { ...result, ok: false, error: message },
            ]),
          ),
        };
      }
      // A keyless draft whose kind or base URL changed must not inherit the
      // old key: the runtime reads keys by id alone.
      for (const draft of request.providers) {
        const old = previous.find((entry) => entry.id === draft.id);
        if (
          draft.apiKey === undefined &&
          old !== undefined &&
          (old.kind !== draft.kind || old.baseUrl !== draft.baseUrl)
        ) {
          await deps.providerKeys.remove(draft.id).catch((error: unknown) => {
            deps.log(
              `[keys] could not remove the key of ${draft.id}: ${describeError(error)}`,
            );
          });
        }
      }
      const kept = new Set(request.providers.map((draft) => draft.id));
      for (const old of previous) {
        if (kept.has(old.id)) continue;
        await deps.providerKeys.remove(old.id).catch((error: unknown) => {
          deps.log(
            `[keys] could not remove the key of ${old.id}: ${describeError(error)}`,
          );
        });
      }
      await loadProvider();
      void monitor.recheck();
      void sys.refresh();
      return { ok: true, results };
    },

    doctorStart() {
      if (turn !== undefined)
        throw new OsAgentError("bad-request", AGENT_TEXT.turnRunning);
      return doctor.start();
    },

    doctorSkip(stepId) {
      return doctor.skip(stepId);
    },

    auditList(query) {
      return deps.audit.list(query);
    },

    async checkUpdates() {
      try {
        const summary = await updates.check();
        return { count: summary.count, security: summary.security };
      } catch (error) {
        if (error instanceof UpdatesCheckError && error.code === "not_found") {
          throw new OsAgentError("unsupported", AGENT_TEXT.updatesUnavailable);
        }
        throw new OsAgentError(
          "internal",
          AGENT_TEXT.updatesCheckFailed(describeError(error)),
        );
      }
    },

    resync() {
      // Contracts §6 #7: on every new connection, re-push provider:status,
      // doctor:state, sys:snapshot and every open card (the shell de-dups
      // cards by cardId).
      const status = monitor.current();
      if (status !== undefined)
        deps.push(OS_CONTROL_PUSHES.providerStatus, status);
      deps.push(OS_CONTROL_PUSHES.doctorState, doctor.state());
      const snapshot = sys.current();
      if (snapshot !== undefined)
        deps.push(OS_CONTROL_PUSHES.sysSnapshot, snapshot);
      for (const card of gate.openCards()) emit({ type: "card", card });
    },

    async shutdown() {
      turn?.controller.abort();
      doctor.cancel();
      gate.closeAll();
      monitor.stop();
      sys.stop();
      updates.stop();
      for (const open of sessions) open.close();
    },
  };
}
