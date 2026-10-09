// The Jarvis OS agent behind the control socket: one model provider, the
// MCP servers' tools, the tool loop, the risk gate, the network doctor and
// the audit log, composed from injected pieces (os-daemon-main.ts passes the
// real ones). Every push goes out through `push` on the contract §3.2
// channels.
//
// No electron here (core/no-electron.test.ts).
import {
  CU_IDLE_STATE,
  CU_MODEL_TEXT,
  CU_TEXT,
  CU_TURN_MAX_STEPS,
  type ComputerUse,
  type CuClient,
  type CuState,
  MAX_STEPS,
  SCREEN_TOOL_MODEL_NAMES,
  createComputerUse,
  withImagePolicy,
  withScreenTools,
  modelSupportsVision,
  AGENT_TEXT,
  BACKUP_BASE_URL,
  BACKUP_PROVIDER_ID,
  FULL_PROFILE,
  SIMPLE_PROFILE,
  simpleToolSpecs,
  withSimpleProfile,
  DEFAULT_LANG,
  type Lang,
  turnLanguage,
  USER_TEXT,
  type Card,
  CONTROL_TEXT,
  type ConfirmFrom,
  createUndoStack,
  LOCAL_CONFIRM,
  NO_VOICE,
  parseUndo,
  stepTitle,
  undoFamily,
  type UndoRequest,
  undoRequestOf,
  type UndoResult,
  type VoiceAvailability,
  CORE_TOOLS,
  createMemoryService,
  type MemoryItem,
  redactSecrets,
  selectTools,
  SESSION_IDLE_MS,
  type TextEmbedder,
  toModelName,
  CONTEXT_TOKENS,
  DEFAULT_CONTEXT_TOKENS,
  createFailoverProvider,
  type FailoverProvider,
  isLocalBaseUrl,
  isLoopbackBaseUrl,
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
  parseRegistryList,
  type RegistryEntry,
  type RegistryListResult,
  parseSysHealth,
  buildSysSnapshot,
  type SysSnapshot,
  type ProbeResult,
  type ProviderDraft,
  type RecipeEngine,
  runTurn,
  type ToolRegistry,
  TRUSTED_MCP_SERVERS,
  trimHistory,
  type UpdatesCheckResult,
} from "@jarvis/core";
import type { SecretStore } from "@jarvis/platform/model";
import { type CuSetEnabledRequest, OS_CONTROL_PUSHES } from "@jarvis/wire";
import {
  type ComputerUseSettings,
  isEmptyComputerUse,
  pruneComputerUse,
  writeComputerUse,
} from "./cu-config.js";
import { createBackupProvider } from "./backup-model.js";
import type { LockStore } from "./lock-store.js";
import type { MemoryOpener } from "./memory-backend.js";
import type { ConfigIo, ProviderSection } from "./provider-config.js";
import { EMPTY_REGISTRY, type LoadedRegistry, type Registration } from "./registry-servers.js";
import { createLazyKeyProvider, unavailableProvider } from "./provider-factory.js";
import { hasProviderKey, type ProviderKeyStores, readProviderKey } from "./provider-keys.js";
import {
  emptyBrain,
  type OsBrainConfig,
  type ProviderEntry,
  readOsBrainConfig,
  writeOsMemoryEnabled,
  writeOsProviders,
  writeOsLanguage,
} from "./provider-list-config.js";
import { createProviderMonitor } from "./provider-monitor.js";
import { createSysMonitor } from "./sys-monitor.js";
import { createUpdatesMonitor, UpdatesCheckError } from "./updates-monitor.js";

export class OsAgentError extends Error {
  constructor(
    readonly code: "bad-request" | "unsupported" | "internal" | "locked" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "OsAgentError";
  }
}

export type OsAgentDeps = {
  /** v1.1 §2: jarvis-cu (cu-client.ts) and a capture digest (SHA-256). Absent: no computer use. */
  computerUse?: { client: CuClient; hash(pngBase64: string): Promise<string> };
  /** M4 §4: runs recipes locally with one card item per step. */
  recipes?: RecipeEngine;
  defaultLanguage?: Lang;
  push(channel: string, payload: unknown): void;
  configPath: string;
  configIo: ConfigIo;
  secrets: SecretStore;
  /** Provider keys by id (M2.5 contracts §1: attribute provider=<id>). `secrets`
   *  stays the account-keyed store (M1 keys, read once for migration). */
  providerKeys: SecretStore;
  makeProvider(section: ProviderSection, apiKey: string | undefined): ModelProvider;
  /** Set only from JARVIS_FAKE_PROVIDER (contracts §5). */
  fakeScript?: readonly FakeTurn[];
  connectMcp(): Promise<McpSession[]>;
  /** Rafiq M3 §5.14: true when the graphical session's environment changed
   *  since the host servers started (session-env.ts); they restart before
   *  the next turn. */
  sessionChanged?(): Promise<boolean>;
  /** M4 §1: the catalog's backup model tag (backup-model.ts readBackupTag);
   *  null or absent: no backup. Read at start and after provider:save. */
  readBackupTag?(): Promise<string | null>;
  readVisionTags?(): Promise<ReadonlySet<string>>;
  readOllamaVision?(baseUrl: string, model: string): Promise<boolean>;
  /** Add-on servers from mcp.d (registry-servers.ts); none when absent. */
  registryServers?: { load(): Promise<LoadedRegistry> };
  /** Calls onChange when mcp.d changes; returns a stop function. */
  watchRegistry?(onChange: () => void): () => void;
  /** /var/lib/jarvis/model-state.json (M2 contracts §5); null when absent or
   *  unreadable. Never throws (model-state-reader.ts). */
  readModelState(): Promise<ModelState | null>;
  audit: {
    append(entry: AuditEntry): Promise<void>;
    list(query: AuditQuery): Promise<AuditEntry[]>;
  };
  /** Local embeddings (loopback Ollama) for tool search; absent → keywords.
   *  May cache tool descriptions in clear (~/.cache/jarvis/tool-index.sqlite). */
  embedder?: TextEmbedder | null;
  /** Embeddings for memory: MUST be built without a cache, so memory text and
   *  its vectors never reach a file in clear (design §3.9). Never falls back
   *  to `embedder`; absent → memory recall by keywords. */
  memoryEmbedder?: TextEmbedder | null;
  /** M2.5 contracts §7 #14: "readonly" (JARVIS_TOOL_PROFILE=readonly, the
   *  Docker image) offers only effectively-safe tools. Default "full". */
  toolProfile?: "full" | "readonly";
  /** The encrypted memory store (memory-backend.ts); absent → memory off. */
  memory?: MemoryOpener;
  /** Rafiq M3 §2/§3: the lock state's copy in $XDG_RUNTIME_DIR. Absent: memory only. */
  lockStore?: LockStore;
  /** sys:snapshot.voice. Absent: voice unavailable. */
  voiceAvailability?(): VoiceAvailability;
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
  language(): Lang;
  setLanguage(lang: Lang): Promise<null>;
  start(): Promise<void>;
  prompt(text: string, from?: ConfirmFrom): { turnId: string };
  stop(turnId: string): null;
  confirm(answer: ConfirmAnswer, from?: ConfirmFrom): null;
  /** agent:undo (M3 §2): runs the newest stored undo call. */
  undo(from?: ConfirmFrom): Promise<UndoResult>;
  /** sys:setLocked (M3 §3) — the router checks the caller is jarvis-lock. */
  setLocked(locked: boolean): Promise<null>;
  isLocked(): boolean;
  /** An open card, for voice answers. */
  card(cardId: string): Card | undefined;
  currentTurnId(): string | undefined;
  /** Every agent:events payload, as it is pushed. */
  onEvent(listener: (event: AgentEvent) => void): () => void;
  providerList(): Promise<ProviderListResult>;
  probe(draft: ProviderDraft & { id?: string }): Promise<ProbeResult>;
  save(request: ProviderSaveRequest): Promise<ProviderSaveResult>;
  doctorStart(): DoctorState;
  doctorSkip(stepId: DoctorStepId): DoctorState;
  auditList(query: AuditQuery): Promise<AuditEntry[]>;
  /** registry:list (M2.5 contracts §2). */
  registryList(): Promise<RegistryListResult>;
  memoryList(limit: number): Promise<MemoryItem[]>;
  memoryDelete(id: string): Promise<null>;
  memoryClear(): Promise<null>;
  /** memory:setEnabled (M2.5 contracts §7 #9); persisted in jarvis.yaml. */
  memorySetEnabled(enabled: boolean): Promise<null>;
  /** cu:state now (v1.1 §2). */
  cuState(): CuState;
  /** cu:stop: ends the session and stops the running turn. */
  cuStop(): Promise<null>;
  /** cu:resume: resumes a paused session. */
  cuResume(): Promise<null>;
  /** cu:setEnabled (v1.1 §2). Enabling needs a vision model. */
  cuSetEnabled(request: CuSetEnabledRequest): Promise<null>;
  /** cu:consent (v1.1 §2, §4.8): screenshots may go to this provider from now on; `revoke` withdraws it. */
  cuConsent(providerId: string, revoke?: boolean): Promise<null>;
  /** updates:check (M2 contracts §2). */
  checkUpdates(): Promise<UpdatesCheckResult>;
  /** A shell (re)connected: re-push what a broadcast it missed would have said. */
  resync(): void;
  shutdown(): Promise<void>;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createOsAgent(deps: OsAgentDeps): OsAgent {
  const listeners = new Set<(event: AgentEvent) => void>();
  const undoStack = createUndoStack();
  let locked = false;
  const emit = (event: AgentEvent) => {
    deps.push(OS_CONTROL_PUSHES.agentEvents, event);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        deps.log(`[agent] event listener failed: ${describeError(error)}`);
      }
    }
    // A finished install or removal changes mcp.d: reload add-ons before the next turn.
    if (
      event.type === "tool" &&
      (event.name === "registry.install" || event.name === "registry.remove") &&
      event.status !== "running"
    ) {
      addOnsDirty = true;
    }
    // An upgrade changes what is pending: refresh the badge (M2 contracts §2).
    if (event.type === "tool" && event.name === "updates.apply" && event.status !== "running") {
      updates.check().catch((error: unknown) => {
        deps.log(`[updates] re-check after updates.apply failed: ${describeError(error)}`);
      });
    }
  };
  let uiLanguage: Lang = deps.defaultLanguage ?? DEFAULT_LANG;
  let provider: ModelProvider = unavailableProvider(() => USER_TEXT[uiLanguage].noProvider);
  let brain: OsBrainConfig = emptyBrain();
  let failover: FailoverProvider | undefined;
  const keyStores = (): ProviderKeyStores => ({
    providerKeys: deps.providerKeys,
    legacy: deps.secrets,
    migrateLegacy: brain.migratedFromLegacy,
    log: deps.log,
  });
  let backupTag: string | null = null;
  let visionTags: ReadonlySet<string> = new Set();
  const ollamaVision = new Set<string>();
  const visionOf = (entry: ProviderEntry): boolean =>
    modelSupportsVision(entry.kind, entry.model, visionTags) ||
    (entry.kind === "ollama" && ollamaVision.has(entry.id));
  /** The backup as a provider entry (fixed loopback URL, M4 §1). */
  function backupEntry(): ProviderEntry | null {
    return backupTag === null
      ? null
      : {
          id: BACKUP_PROVIDER_ID,
          kind: "ollama",
          baseUrl: BACKUP_BASE_URL,
          model: backupTag,
          auth: "api-key",
          supportsTools: true,
        };
  }
  /** The provider answering now; the first one before any answer. */
  function activeEntry(): ProviderEntry | null {
    const id = failover?.status().activeId;
    if (id === BACKUP_PROVIDER_ID) return backupEntry();
    return brain.providers.find((entry) => entry.id === id) ?? brain.providers[0] ?? backupEntry();
  }
  /** The smallest context in the chain: a failover mid-turn must still fit. */
  function contextTokens(): number {
    const backup = backupEntry();
    const sizes = [...brain.providers, ...(backup === null ? [] : [backup])].map(
      (entry) => CONTEXT_TOKENS[entry.kind] ?? DEFAULT_CONTEXT_TOKENS,
    );
    return sizes.length === 0 ? DEFAULT_CONTEXT_TOKENS : Math.min(...sizes);
  }
  const embedder = deps.embedder ?? null;
  const safeOnly = deps.toolProfile === "readonly";
  const memoryOn = () => brain.memoryEnabled && deps.fakeScript === undefined;
  const memory = createMemoryService({
    enabled: memoryOn,
    backend: () => deps.memory?.open() ?? Promise.resolve(null),
    reset: () => deps.memory?.reset() ?? Promise.resolve(),
    // The user's own model writes the summary; the request ends with SAFETY_RULES.
    summarize: async (system, transcript, signal) => {
      let text = "";
      for await (const event of provider.chat({
        system,
        messages: [{ role: "user", text: transcript }],
        tools: [],
        signal,
      })) {
        if (event.type === "text") text += event.delta;
        else if (event.type === "done") break;
      }
      return text;
    },
    embedder: deps.memoryEmbedder ?? null,
    redact: redactSecrets,
    now: deps.now,
    log: deps.log,
  });
  let idleTimer: unknown;
  const touchSession = () => {
    if (idleTimer !== undefined) deps.timers.clearTimeout(idleTimer);
    idleTimer = deps.timers.setTimeout(() => {
      idleTimer = undefined;
      void memory.endSession();
    }, SESSION_IDLE_MS);
  };
  const coreToolNames = new Set(CORE_TOOLS.map(toModelName));
  const cuCoreToolNames = new Set([...coreToolNames, ...SCREEN_TOOL_MODEL_NAMES]);
  let lastSearchNote = "";
  const logSearchOnce = (line: string) => {
    if (line === lastSearchNote) return;
    lastSearchNote = line;
    deps.log(line);
  };
  let hostSessions: McpSession[] = [];
  let hostStale = false;
  let addOns: LoadedRegistry = EMPTY_REGISTRY;
  let addOnsDirty = true;
  let stopWatching: () => void = () => {};
  let registry: ToolRegistry | undefined;
  let loading: Promise<ToolRegistry> | undefined;
  let history: ModelMessage[] = [];
  let turn: { turnId: string; controller: AbortController } | undefined;
  let doctorNote: string | undefined;

  /** Host servers reconnect when one died; add-ons reload only when asked
   *  (before a turn) and something changed, never under a running turn. */
  function ensureRegistry(options: { reloadAddOns?: boolean } = {}): Promise<ToolRegistry> {
    const hostOk = !hostStale && hostSessions.length > 0 && hostSessions.every((s) => s.alive);
    const reloadAddOns =
      deps.registryServers !== undefined &&
      addOnsDirty &&
      (registry === undefined || options.reloadAddOns === true);
    if (registry !== undefined && hostOk && !reloadAddOns) {
      return Promise.resolve(registry);
    }
    if (loading !== undefined) return loading;
    loading = (async () => {
      if (!hostOk) {
        hostStale = false;
        for (const old of hostSessions) old.close();
        try {
          hostSessions = await deps.connectMcp();
        } catch (error) {
          deps.log(`[agent] the MCP servers did not start: ${describeError(error)}`);
          hostSessions = [];
        }
      }
      if (reloadAddOns && deps.registryServers !== undefined) {
        for (const old of addOns.sessions) old.close();
        addOnsDirty = false;
        try {
          addOns = await deps.registryServers.load();
        } catch (error) {
          deps.log(`[registry] loading add-on servers failed: ${describeError(error)}`);
          addOns = EMPTY_REGISTRY;
        }
      }
      // Host servers first: on a name collision the host tool wins.
      // An add-on never takes a host server's name: trust is by name, so a
      // registry "jarvis-files" would otherwise be trusted as host and shadow
      // the built-in one (contracts §5.1: jarvisd ignores it).
      const hostNames = new Set<string>(TRUSTED_MCP_SERVERS);
      const addOnSessions = addOns.sessions.filter((s) => {
        if (!hostNames.has(s.name)) return true;
        deps.log(`[registry] ${s.name}: reuses a host server name; ignored`);
        return false;
      });
      registry = await loadToolRegistry([...hostSessions, ...addOnSessions], {
        trusted: hostNames,
        trustOf: (name) => addOns.tiers.get(name) ?? "unknown",
        safeOnly,
        log: deps.log,
      });
      return registry;
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  }

  /** Before a turn (never under one): a new display or desktop restarts the
   *  host servers so they spawn with it (Rafiq M3 §5.14). */
  async function checkSession(): Promise<void> {
    if (deps.sessionChanged === undefined) return;
    try {
      if (await deps.sessionChanged()) hostStale = true;
    } catch (error) {
      deps.log(`[agent] could not read the session environment: ${describeError(error)}`);
    }
  }

  const gate = createRiskGate({
    language: () => uiLanguage,
    emit,
    describe: async (tool, input, lang) => (await ensureRegistry()).describe(tool, input, lang),
    audit: async (entry) => {
      await deps.audit.append(entry);
      memory.recordAudit(entry);
    },
    now: deps.now,
    newId: deps.newId,
    timers: deps.timers,
    log: deps.log,
    onRan: (ran) => {
      const tools = registry;
      if (tools === undefined) return;
      const undo = parseUndo(
        ran.outcome.data,
        ran.tool,
        (name) => tools.get(name),
        new Set<string>(TRUSTED_MCP_SERVERS),
      );
      if (undo === undefined) return;
      undoStack.push({
        title: stepTitle(ran.titles, uiLanguage),
        tool: undo.tool.name,
        input: undo.input,
        server: undo.tool.server,
        family: undoFamily(undo.tool.name) ?? "",
        at: deps.now(),
      });
      void sys.refresh();
    },
  });

  /** null when computer use may run for `entry` now, else why not (model-facing).
   *  Contracts §2 + design §2.2/§2.6/§2.9; asked before every screen call. */
  function cuBlocked(entry: ProviderEntry | null): string | null {
    if (deps.computerUse === undefined || safeOnly) return CU_MODEL_TEXT.off;
    if (locked) return CU_MODEL_TEXT.locked;
    if (entry === null || entry.id === BACKUP_PROVIDER_ID) return CU_MODEL_TEXT.notEnabled;
    if (brain.computerUse.enabled[entry.id] !== true) return CU_MODEL_TEXT.notEnabled;
    if (!visionOf(entry)) return CU_MODEL_TEXT.noVision;
    if (
      !isLoopbackBaseUrl(entry.baseUrl) &&
      brain.computerUse.cloudConsent[entry.id] === undefined
    ) {
      return CU_MODEL_TEXT.noConsent;
    }
    return null;
  }

  const computerUse: ComputerUse | undefined =
    deps.computerUse === undefined
      ? undefined
      : createComputerUse({
          client: deps.computerUse.client,
          gate,
          audit: (entry) => deps.audit.append(entry),
          emitState: (state) => deps.push(OS_CONTROL_PUSHES.cuState, state),
          available: () => cuBlocked(activeEntry()),
          hash: deps.computerUse.hash,
          now: deps.now,
          newId: deps.newId,
          timers: deps.timers,
          log: deps.log,
        });

  const monitor = createProviderMonitor({
    check: () => provider.reachable(),
    active: () => failover?.status() ?? { activeId: null, fallbackReason: null },
    push: (status) => deps.push(OS_CONTROL_PUSHES.providerStatus, status),
    timers: deps.timers,
  });

  const doctor = createNetworkDoctor({
    language: () => uiLanguage,
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
      locked,
      voice: deps.voiceAvailability?.() ?? NO_VOICE,
      undo: (() => {
        const last = undoStack.peek();
        return { available: last !== undefined, title: last?.title ?? null };
      })(),
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
  function keyedProvider(target: ProviderSection, keyOf: ProviderEntry): ModelProvider {
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
    if (brain.language !== null) uiLanguage = brain.language;
    visionTags = new Set();
    ollamaVision.clear();
    try {
      visionTags = (await deps.readVisionTags?.()) ?? new Set();
    } catch {
      deps.log("[vision] catalog unavailable");
    }
    await Promise.all(
      brain.providers.map(async (entry) => {
        if (entry.kind !== "ollama" || visionOf(entry)) return;
        try {
          if (await deps.readOllamaVision?.(entry.baseUrl, entry.model)) ollamaVision.add(entry.id);
        } catch {
          deps.log("[vision] capabilities unavailable");
        }
      }),
    );
    failover = undefined;
    // JARVIS_FAKE_PROVIDER replaces the configured providers entirely (contracts §6 #11).
    if (deps.fakeScript !== undefined) {
      provider = createFakeProvider(deps.fakeScript);
      return;
    }
    backupTag = null;
    if (deps.readBackupTag !== undefined) {
      try {
        backupTag = await deps.readBackupTag();
      } catch (error) {
        deps.log(`[backup] ${describeError(error)}`);
      }
    }
    const backup =
      backupTag === null
        ? undefined
        : {
            id: BACKUP_PROVIDER_ID,
            locality: "local" as const,
            provider: withImagePolicy(
              withSimpleProfile(
                createBackupProvider({
                  tag: backupTag,
                  make: (section) => deps.makeProvider(section, undefined),
                }),
                () => (registry === undefined ? [] : simpleToolSpecs(registry)),
              ),
              () => false,
            ),
          };
    if (brain.providers.length === 0 && backup === undefined) {
      provider = unavailableProvider(() => USER_TEXT[uiLanguage].noProvider);
      return;
    }
    failover = createFailoverProvider({
      entries: brain.providers.map((entry) => ({
        id: entry.id,
        locality: isLocalBaseUrl(entry.baseUrl) ? ("local" as const) : ("cloud" as const),
        provider: withImagePolicy(keyedProvider(entry, entry), () => cuBlocked(entry) === null),
      })),
      allowCloudFallback: brain.allowCloudFallback,
      ...(backup === undefined ? {} : { backup }),
      timers: deps.timers,
      language: () => uiLanguage,
      onSwitch: (change) => {
        deps.log(`[provider] ${change.fromId} -> ${change.toId}: ${change.reason}`);
        monitor.noteActive();
      },
    });
    provider = failover;
  }

  /** A stored key is reused only from a saved entry with the same kind and
   *  base URL (and the same id when one is given): a changed URL never
   *  receives the old key. */
  async function saveComputerUse(next: ComputerUseSettings): Promise<null> {
    try {
      await writeComputerUse(deps.configPath, next, deps.configIo);
    } catch (error) {
      throw new OsAgentError("internal", describeError(error));
    }
    brain = { ...brain, computerUse: next };
    return null;
  }
  function configuredEntry(providerId: string): ProviderEntry {
    const entry = brain.providers.find((candidate) => candidate.id === providerId);
    if (entry === undefined)
      throw new OsAgentError("bad-request", CU_TEXT[uiLanguage].noSuchProvider(providerId));
    return entry;
  }

  function draftProvider(draft: ProviderDraft & { id?: string }): ModelProvider {
    const target: ProviderSection = {
      kind: draft.kind,
      baseUrl: draft.baseUrl,
      model: draft.model,
      auth: "api-key",
      supportsTools: true,
    };
    if (draft.apiKey !== undefined) return deps.makeProvider(target, draft.apiKey);
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

  async function runUndo(request: UndoRequest, from: ConfirmFrom): Promise<UndoResult> {
    if (locked) throw new OsAgentError("locked", CONTROL_TEXT[uiLanguage].locked);
    const step = undoStack.pop(request.kind === "files" ? (s) => s.family === "files." : undefined);
    if (step === undefined) return { undone: null };
    const tools = await ensureRegistry();
    // The registry may have been reloaded since: the same name must still be
    // served by the same host server, or nothing runs.
    if (tools.get(step.tool)?.server !== step.server) {
      throw new OsAgentError("internal", CONTROL_TEXT[uiLanguage].undoMoved(step.title));
    }
    const outcome = await tools.call(step.tool, step.input);
    try {
      await deps.audit.append({
        ts: deps.now(),
        tool: step.tool,
        title: CONTROL_TEXT[uiLanguage].undoTitle(step.title),
        input: step.input,
        decision: "approved",
        via: from.via,
        result: outcome.ok ? "ok" : "failed",
        ...(outcome.ok ? {} : { message: outcome.text.slice(0, 500) }),
      });
    } catch (error) {
      deps.log(`[undo] audit write failed: ${describeError(error)}`);
    }
    if (!outcome.ok) {
      throw new OsAgentError(
        "internal",
        CONTROL_TEXT[uiLanguage].undoFailed(step.title, outcome.text.slice(0, 200)),
      );
    }
    void sys.refresh();
    return { undone: step.title };
  }

  /** A typed or spoken "undo" is answered here, never by the model. */
  function promptUndo(text: string, request: UndoRequest, from: ConfirmFrom): { turnId: string } {
    const turnId = deps.newId();
    turn = { turnId, controller: new AbortController() };
    emit({ type: "turn-start", turnId, text });
    void (async () => {
      let reply: string;
      try {
        const result = await runUndo(request, from);
        reply =
          result.undone === null
            ? CONTROL_TEXT[uiLanguage].nothingToUndo
            : CONTROL_TEXT[uiLanguage].undone(result.undone);
      } catch (error) {
        reply = describeError(error);
      }
      emit({ type: "text", turnId, delta: reply });
      emit({ type: "turn-end", turnId, reason: "done" });
      if (turn?.turnId === turnId) turn = undefined;
    })();
    return { turnId };
  }

  return {
    async start() {
      try {
        locked = (await deps.lockStore?.read()) ?? false;
      } catch (error) {
        locked = true;
        deps.log(`[lock] could not read the lock state, staying locked: ${describeError(error)}`);
      }
      await loadProvider();
      monitor.start();
      void ensureRegistry();
      stopWatching =
        deps.watchRegistry?.(() => {
          addOnsDirty = true;
        }) ?? (() => {});
      sys.start();
      updates.start();
    },

    prompt(text, from = LOCAL_CONFIRM) {
      if (turn !== undefined)
        throw new OsAgentError("bad-request", USER_TEXT[uiLanguage].turnRunning);
      if (doctor.running)
        throw new OsAgentError("bad-request", USER_TEXT[uiLanguage].doctorRunning);
      const undoRequest = undoRequestOf(text);
      if (undoRequest !== undefined) return promptUndo(text, undoRequest, from);
      const turnId = deps.newId();
      const controller = new AbortController();
      turn = { turnId, controller };
      const context = doctorNote;
      doctorNote = undefined;
      void (async () => {
        try {
          await checkSession();
          const tools = await ensureRegistry({ reloadAddOns: true });
          const notes = await memory.recall(text).catch(() => []);
          const before = history.length;
          failover?.beginTurn();
          const cuOn = computerUse !== undefined && cuBlocked(activeEntry()) === null;
          const turnTools = cuOn ? withScreenTools(tools) : tools;
          computerUse?.beginTurn();
          const result = await runTurn(
            {
              ...(deps.recipes === undefined ? {} : { recipes: deps.recipes }),
              ...(computerUse === undefined ? {} : { computerUse }),
              maxSteps: () => (computerUse?.active() === true ? CU_TURN_MAX_STEPS : MAX_STEPS),
              provider,
              registry: turnTools,
              gate,
              contextTokens: contextTokens(),
              toolsEnabled: deps.fakeScript !== undefined || activeEntry()?.supportsTools !== false,
              profile: () =>
                failover?.status().activeId === BACKUP_PROVIDER_ID ? SIMPLE_PROFILE : FULL_PROFILE,
              emit,
              newId: deps.newId,
              selectTools: (query, all) =>
                selectTools(all, query, {
                  coreModelNames: cuOn ? cuCoreToolNames : coreToolNames,
                  embedder,
                  log: logSearchOnce,
                }),
            },
            {
              turnId,
              lang: turnLanguage(uiLanguage, text),
              history,
              text,
              via: from.via,
              signal: controller.signal,
              ...(context === undefined ? {} : { context }),
              ...(notes.length === 0 ? {} : { notes }),
            },
          );
          memory.afterTurn(result.messages.slice(before));
          touchSession();
          history = trimHistory(result.messages);
          if (result.reason !== "error") monitor.reportOk();
          else if (result.errorKind === "network" || result.errorKind === "auth") {
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
          // A session never outlives its turn. endSession drops the session
          // synchronously; the helper's `end` finishes after the turn is free.
          const ending = computerUse?.endSession("turn-end");
          if (turn?.turnId === turnId) turn = undefined;
          await ending;
        }
      })();
      return { turnId };
    },

    stop(turnId) {
      if (turn?.turnId === turnId) turn.controller.abort();
      return null;
    },

    confirm(answer, from = LOCAL_CONFIRM) {
      // Rafiq M3 §2: no card is answered while the screen is locked, by anyone.
      if (locked) throw new OsAgentError("locked", CONTROL_TEXT[uiLanguage].locked);
      try {
        gate.confirm(answer, from);
      } catch (error) {
        if (error instanceof GateError) throw new OsAgentError(error.code, error.message);
        throw error;
      }
      return null;
    },

    async undo(from = LOCAL_CONFIRM) {
      if (locked) throw new OsAgentError("locked", CONTROL_TEXT[uiLanguage].locked);
      if (turn !== undefined)
        throw new OsAgentError("bad-request", USER_TEXT[uiLanguage].turnRunning);
      return runUndo({ kind: "any" }, from);
    },

    async setLocked(next) {
      if (locked !== next) {
        locked = next;
        // Design §2.9: the lock ends computer use at once.
        if (next) void computerUse?.endSession("locked");
        deps.log(`[lock] ${next ? "locked" : "unlocked"}`);
        const current = sys.current();
        if (current !== undefined) deps.push(OS_CONTROL_PUSHES.sysSnapshot, { ...current, locked });
        void sys.refresh();
      }
      try {
        await deps.lockStore?.write(next);
      } catch (error) {
        deps.log(`[lock] could not save the lock state: ${describeError(error)}`);
      }
      return null;
    },

    isLocked: () => locked,
    card: (cardId) => gate.openCards().find((card) => card.cardId === cardId),
    currentTurnId: () => turn?.turnId,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async providerList() {
      const providers = await Promise.all(
        brain.providers.map(async (entry) => ({
          id: entry.id,
          kind: entry.kind,
          baseUrl: entry.baseUrl,
          model: entry.model,
          hasKey: await hasProviderKey(entry, keyStores()),
          vision: visionOf(entry),
          computerUse: {
            enabled: brain.computerUse.enabled[entry.id] === true,
            consentAt: brain.computerUse.cloudConsent[entry.id] ?? null,
          },
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
        throw new OsAgentError("bad-request", USER_TEXT[uiLanguage].pickModel);
      }
      // Contracts §7 #11: probe only new or changed providers (or ones that
      // carry a key); an unchanged saved entry keeps its saved supportsTools.
      const savedById = new Map(brain.providers.map((entry) => [entry.id, entry]));
      const probed = await Promise.all(
        request.providers.map(async (draft): Promise<readonly [string, ProbeResult]> => {
          const saved = savedById.get(draft.id);
          const unchanged =
            saved !== undefined &&
            draft.apiKey === undefined &&
            saved.kind === draft.kind &&
            saved.baseUrl === draft.baseUrl &&
            saved.model === draft.model;
          if (unchanged) {
            return [draft.id, { ok: true, supportsTools: saved.supportsTools, models: [] }];
          }
          return [draft.id, await draftProvider(draft).probe()];
        }),
      );
      const results: Record<string, ProbeResult> = Object.fromEntries(probed);
      if (!probed.every(([, result]) => result.ok)) return { ok: false, results };
      const previous = brain.providers;
      // v1.1: enable and consent survive only for a provider whose endpoint is unchanged.
      const keptComputerUse = pruneComputerUse(brain.computerUse, (id) => {
        const old = savedById.get(id);
        const next = request.providers.find((draft) => draft.id === id);
        return (
          old !== undefined &&
          next !== undefined &&
          old.kind === next.kind &&
          old.baseUrl === next.baseUrl
        );
      });
      try {
        for (const draft of request.providers) {
          if (draft.apiKey !== undefined) await deps.providerKeys.set(draft.id, draft.apiKey);
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
            ...(isEmptyComputerUse(brain.computerUse) ? {} : { computerUse: keptComputerUse }),
          },
          deps.configIo,
        );
      } catch (error) {
        const message = describeError(error);
        return {
          ok: false,
          results: Object.fromEntries(
            probed.map(([id, result]) => [id, { ...result, ok: false, error: message }]),
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
            deps.log(`[keys] could not remove the key of ${draft.id}: ${describeError(error)}`);
          });
        }
      }
      const kept = new Set(request.providers.map((draft) => draft.id));
      for (const old of previous) {
        if (kept.has(old.id)) continue;
        await deps.providerKeys.remove(old.id).catch((error: unknown) => {
          deps.log(`[keys] could not remove the key of ${old.id}: ${describeError(error)}`);
        });
      }
      await loadProvider();
      void monitor.recheck();
      void sys.refresh();
      return { ok: true, results };
    },

    doctorStart() {
      if (turn !== undefined)
        throw new OsAgentError("bad-request", USER_TEXT[uiLanguage].turnRunning);
      return doctor.start();
    },

    doctorSkip(stepId) {
      return doctor.skip(stepId);
    },

    auditList(query) {
      return deps.audit.list(query);
    },

    async registryList() {
      const tools = await ensureRegistry();
      // jarvis-pkg's registry.list is {installed, available} (Go registryList).
      let available: RegistryEntry[] = [];
      let indexedInstalled: RegistryEntry[] = [];
      if (tools.get("registry.list") !== undefined) {
        const found = await tools.call("registry.list", {});
        if (found.ok) {
          const listed = parseRegistryList(found.data);
          available = listed.available;
          indexedInstalled = listed.installed;
        }
      }
      const stub = (reg: Registration): RegistryEntry => ({
        id: reg.id,
        name: reg.id,
        description: "",
        tier: reg.tier,
        version: reg.version,
        artifact: { url: "", sha256: "", runtime: reg.runtime },
        permissions: {
          network: reg.permissions.network,
          paths: [...reg.permissions.paths],
        },
        tools: reg.tools.map((tool) => ({ ...tool })),
      });
      const same = (reg: { id: string; version: string }) => (entry: RegistryEntry) =>
        entry.id === reg.id && entry.version === reg.version;
      const installed = addOns.installed.map(
        (reg) => indexedInstalled.find(same(reg)) ?? available.find(same(reg)) ?? stub(reg),
      );
      // Installed per jarvis-pkg but not (yet) loaded by jarvisd.
      for (const entry of indexedInstalled) {
        if (!installed.some((known) => known.id === entry.id)) installed.push(entry);
      }
      return { installed, available };
    },

    async memoryList(limit) {
      if (!memoryOn() || deps.memory === undefined) {
        throw new OsAgentError("unsupported", USER_TEXT[uiLanguage].memoryOff);
      }
      // No keyring (or locked) → open() yields null → memory is off (§7 #9).
      if ((await deps.memory?.open()) == null) {
        throw new OsAgentError("unsupported", USER_TEXT[uiLanguage].memoryOff);
      }
      return memory.list(limit);
    },

    async memoryDelete(id) {
      // Memory off: never open (and so never create) the store.
      if (!memoryOn()) return null;
      await memory.delete(id);
      return null;
    },

    async memoryClear() {
      if (!memoryOn()) {
        // Off: only wipe what exists (file + key); never open a new store.
        await deps.memory?.reset();
        return null;
      }
      await memory.clear();
      return null;
    },

    async cuSetEnabled({ providerId, enabled }) {
      const entry = configuredEntry(providerId);
      if (enabled && !visionOf(entry))
        throw new OsAgentError("bad-request", CU_TEXT[uiLanguage].noVisionModel);
      return saveComputerUse({
        enabled: { ...brain.computerUse.enabled, [providerId]: enabled },
        cloudConsent: { ...brain.computerUse.cloudConsent },
      });
    },

    cuState: () => computerUse?.state() ?? CU_IDLE_STATE,

    async cuStop() {
      await computerUse?.stop();
      turn?.controller.abort();
      return null;
    },

    async cuResume() {
      if (locked) throw new OsAgentError("locked", CONTROL_TEXT[uiLanguage].locked);
      await computerUse?.resume();
      return null;
    },

    async cuConsent(providerId, revoke) {
      configuredEntry(providerId);
      const cloudConsent = { ...brain.computerUse.cloudConsent };
      if (revoke === true) delete cloudConsent[providerId];
      else cloudConsent[providerId] = new Date(deps.now()).toISOString();
      return saveComputerUse({ enabled: { ...brain.computerUse.enabled }, cloudConsent });
    },

    async memorySetEnabled(enabled) {
      try {
        await writeOsMemoryEnabled(deps.configPath, enabled, deps.configIo);
      } catch (error) {
        throw new OsAgentError("internal", describeError(error));
      }
      brain = { ...brain, memoryEnabled: enabled };
      return null;
    },

    async checkUpdates() {
      try {
        const summary = await updates.check();
        return { count: summary.count, security: summary.security };
      } catch (error) {
        if (error instanceof UpdatesCheckError && error.code === "not_found") {
          throw new OsAgentError("unsupported", USER_TEXT[uiLanguage].updatesUnavailable);
        }
        throw new OsAgentError(
          "internal",
          USER_TEXT[uiLanguage].updatesCheckFailed(describeError(error)),
        );
      }
    },

    language: () => uiLanguage,
    async setLanguage(lang) {
      try {
        await writeOsLanguage(deps.configPath, lang, deps.configIo);
      } catch (error) {
        throw new OsAgentError("internal", describeError(error));
      }
      brain = { ...brain, language: lang };
      uiLanguage = lang;
      deps.push(OS_CONTROL_PUSHES.uiLanguage, { lang });
      return null;
    },
    resync() {
      deps.push(OS_CONTROL_PUSHES.uiLanguage, { lang: uiLanguage });
      deps.push(OS_CONTROL_PUSHES.cuState, computerUse?.state() ?? CU_IDLE_STATE);
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
      await computerUse?.endSession("stopped");
      doctor.cancel();
      gate.closeAll();
      if (idleTimer !== undefined) deps.timers.clearTimeout(idleTimer);
      // Session end (design §3.9), bounded so a dead provider cannot hold the stop.
      await Promise.race([memory.endSession(), sleep(20_000)]);
      deps.memory?.close();
      monitor.stop();
      sys.stop();
      updates.stop();
      stopWatching();
      for (const open of [...hostSessions, ...addOns.sessions]) open.close();
    },
  };
}
