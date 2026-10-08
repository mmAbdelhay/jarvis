// Jarvis OS control-socket channels (contracts §3): what jarvis-shell says to
// jarvisd after the existing handshake. Pure — no node:*, no other package
// (no-node-imports.test.ts). The C++ shell's CI test reads
// ../os-control.json; packages/desktop/src/daemon/os/os-control-json.test.ts
// keeps that file equal to these constants.
//
// Every parser picks exact fields and checks type, bounds and allowed strings
// (conventions: "Parse wire values field by field"). Records built from
// shell input are null-prototype, and a "__proto__" key is refused outright.

export const OS_CONTROL_REQUESTS = {
  agentPrompt: "agent:prompt",
  agentStop: "agent:stop",
  agentConfirm: "agent:confirm",
  providerList: "provider:list",
  providerProbe: "provider:probe",
  providerSave: "provider:save",
  doctorStart: "doctor:start",
  doctorSkip: "doctor:skip",
  auditList: "audit:list",
  /** M2 contracts §2: run updates.list now. a: [], v: UpdatesCheckResult. */
  updatesCheck: "updates:check",
  /** M2.5 §2: MemoryItem[] newest first; a: [{limit: 1-500}]. */
  memoryList: "memory:list",
  /** M2.5 §2: a: [{id}], v: null. */
  memoryDelete: "memory:delete",
  /** M2.5 §2: a: [], v: null. */
  memoryClear: "memory:clear",
  /** M2.5 §7 #9: a: [{enabled: boolean}], v: null. */
  memorySetEnabled: "memory:setEnabled",
  /** M2.5 §2: a: [], v: {installed, available}. */
  registryList: "registry:list",
} as const;

export const OS_CONTROL_PUSHES = {
  agentEvents: "agent:events",
  providerStatus: "provider:status",
  doctorState: "doctor:state",
  /** Contracts §6 #8: every 10 s and on change, and on every new connection. */
  sysSnapshot: "sys:snapshot",
} as const;

export const PROVIDER_KINDS = ["anthropic", "openai-compatible", "ollama", "gemini"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export type ProviderConfig = {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasKey: boolean;
};
export type ProviderDraft = { kind: ProviderKind; baseUrl: string; model: string; apiKey?: string };
export type ProbeResult = { ok: boolean; supportsTools: boolean; models: string[]; error?: string };
/** M2.5 contracts §1: lower-case letters, digits and "-", up to 32. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_PROVIDERS = 8;
export type ProviderListEntry = ProviderConfig & { id: string };
export type ProviderDraftEntry = ProviderDraft & { id: string };
/** provider:probe's draft; `id` lets a probe without apiKey use that provider's stored key. */
export type ProviderProbeDraft = ProviderDraft & { id?: string };
export type ProviderListResult = {
  providers: ProviderListEntry[];
  activeId: string | null;
  allowCloudFallback: boolean;
  kinds: ProviderKind[];
};
export type ProviderSaveRequest = { providers: ProviderDraftEntry[]; allowCloudFallback: boolean };
export type ProviderSaveResult = { ok: boolean; results: Record<string, ProbeResult> };
export type ProviderStatusPush = {
  reachable: boolean;
  error?: string;
  /** The provider answering now (M2.5 §2); null with none configured or the fake provider. */
  activeId: string | null;
  /** Why activeId is not the first provider, e.g. "work returned an error (503)". */
  fallbackReason: string | null;
};

export type MemoryKind = "summary" | "fact";
export type MemoryItem = { id: string; kind: MemoryKind; text: string; createdAt: number };

export type RegistryTier = "official" | "reviewed" | "community";
export type RegistryRuntime = "go-static" | "node" | "python";
export type RegistryEntry = {
  id: string;
  name: string;
  description: string;
  tier: RegistryTier;
  version: string;
  artifact: { url: string; sha256: string; runtime: RegistryRuntime };
  permissions: { network: boolean; paths: string[] };
  tools: { name: string; risk: "safe" | "confirm" }[];
};
export type RegistryListResult = { installed: RegistryEntry[]; available: RegistryEntry[] };

/** M2 contracts §2: pending updates as of checkedAt (epoch ms, null before the first check). */
export type UpdatesSummary = { count: number; security: number; checkedAt: number | null };
/** M2 contracts §5: /var/lib/jarvis/model-state.json, as the shell sees it. */
export type ModelDownloadState = "pending" | "downloading" | "ready" | "failed";
export type ModelDownload = { state: ModelDownloadState; percent: number };
/** The updates:check answer. */
export type UpdatesCheckResult = { count: number; security: number };

/** Contracts §6 #8 + M2 §2, §5. The shell offers the Network doctor only when
 *  provider:status.reachable === false AND online === false. */
export type SysSnapshot = {
  online: boolean;
  network: { connectivity: string; wifiSsid: string | null };
  memTotalBytes: number;
  memUsedBytes: number;
  disk: { mount: "/"; sizeBytes: number; usedBytes: number };
  failedUnits: string[];
  model: {
    kind: ProviderKind;
    model: string;
    local: boolean;
    supportsTools: boolean;
    /** Non-null only for loopback ollama with a matching tag (:latest normalised). */
    download: ModelDownload | null;
  } | null;
  updates: UpdatesSummary;
};

export type CardSource = "debian" | "flathub" | "system" | "network";
export type CardItem = {
  itemId: string;
  tool: string;
  title: string;
  detail: string;
  source: CardSource;
  risk: "confirm" | "password";
  secretFields: { name: string; label: string }[];
};
export type Card = { cardId: string; turnId: string | null; expiresAt: number; items: CardItem[] };

export type AgentEvent =
  | { type: "turn-start"; turnId: string; text: string }
  | { type: "text"; turnId: string; delta: string }
  | {
      type: "tool";
      turnId: string;
      callId: string;
      name: string;
      status: "running" | "ok" | "error";
      summary: string;
    }
  | { type: "card"; card: Card }
  | { type: "card-closed"; cardId: string; decision: "approved" | "denied" | "timeout" }
  | {
      type: "turn-end";
      turnId: string;
      reason: "done" | "stopped" | "step-limit" | "error";
      error?: string;
    };

export const DOCTOR_STEP_IDS = ["radio", "nm", "connection", "wifi", "dns", "provider"] as const;
export type DoctorStepId = (typeof DOCTOR_STEP_IDS)[number];
export type DoctorStep = {
  stepId: DoctorStepId;
  label: string;
  status: "pending" | "running" | "ok" | "problem" | "fixed" | "skipped";
  detail: string;
};
export type DoctorState = {
  active: boolean;
  steps: DoctorStep[];
  networks: { ssid: string; signal: number; security: string; known: boolean }[];
  done: "fixed" | "unfixed" | null;
};

export type AuditEntry = {
  ts: number;
  tool: string;
  title: string;
  input: unknown;
  decision: "approved" | "denied" | "timeout";
  via: "desktop" | "doctor";
  result: "ok" | "failed" | "skipped";
  message?: string;
};

export type ConfirmAnswer = {
  cardId: string;
  approve: boolean;
  ticked: string[];
  secrets: Record<string, Record<string, string>>;
};
export type AuditQuery = { limit: number; beforeTs?: number };

export const CARD_TIMEOUT_MS = 300_000;
export const MAX_PROMPT_CHARS = 8_000;
// updates.apply takes 1-200 items, each its own card item (M2 contracts §2).
const MAX_TICKED = 200;
const MAX_SECRET_FIELDS = 8;
const MAX_SECRET_CHARS = 1_024;
const MAX_MODEL_CHARS = 200;
const MAX_KEY_CHARS = 4_096;
const MAX_URL_CHARS = 2_048;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function fields(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function single(args: readonly unknown[]): Record<string, unknown> | undefined {
  return args.length === 1 ? fields(args[0]) : undefined;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Own keys only, and never "__proto__": JSON.parse makes it an own key. */
function safeKeys(record: Record<string, unknown>): string[] | undefined {
  const keys = Object.keys(record);
  return keys.includes("__proto__") ? undefined : keys;
}

export function parseNoArgs(args: readonly unknown[]): Parsed<null> {
  return args.length === 0 ? ok(null) : fail("expected no arguments");
}

export function parseAgentPrompt(args: readonly unknown[]): Parsed<{ text: string }> {
  const a = single(args);
  if (a === undefined) return fail("expected [{text}]");
  const text = a["text"];
  if (typeof text !== "string" || text.trim().length === 0) {
    return fail("text must be a non-empty string");
  }
  if (text.length > MAX_PROMPT_CHARS) {
    return fail(`text must be at most ${MAX_PROMPT_CHARS} characters`);
  }
  return ok({ text });
}

export function parseAgentStop(args: readonly unknown[]): Parsed<{ turnId: string }> {
  const a = single(args);
  if (a === undefined || !isId(a["turnId"])) return fail("expected [{turnId}]");
  return ok({ turnId: a["turnId"] });
}

export function parseAgentConfirm(args: readonly unknown[]): Parsed<ConfirmAnswer> {
  const a = single(args);
  if (a === undefined) return fail("expected [{cardId, approve, ticked, secrets}]");
  const { cardId, approve, ticked, secrets } = a;
  if (!isId(cardId)) return fail("cardId must be an id");
  if (typeof approve !== "boolean") return fail("approve must be true or false");
  if (!Array.isArray(ticked) || ticked.length > MAX_TICKED || !ticked.every(isId)) {
    return fail("ticked must be a list of item ids");
  }
  if (new Set(ticked).size !== ticked.length) return fail("ticked must not repeat an item");
  const secretsIn = secrets === undefined ? {} : fields(secrets);
  const itemKeys = secretsIn === undefined ? undefined : safeKeys(secretsIn);
  if (secretsIn === undefined || itemKeys === undefined || itemKeys.length > MAX_TICKED) {
    return fail("secrets must be {itemId: {field: string}}");
  }
  const parsedSecrets: Record<string, Record<string, string>> = Object.create(null);
  for (const itemId of itemKeys) {
    const values = fields(secretsIn[itemId]);
    const fieldKeys = values === undefined ? undefined : safeKeys(values);
    if (!isId(itemId) || values === undefined || fieldKeys === undefined) {
      return fail("secrets must be {itemId: {field: string}}");
    }
    if (fieldKeys.length > MAX_SECRET_FIELDS) return fail("too many secret fields");
    const item: Record<string, string> = Object.create(null);
    for (const name of fieldKeys) {
      const value = values[name];
      if (
        !FIELD_PATTERN.test(name) ||
        typeof value !== "string" ||
        value.length > MAX_SECRET_CHARS
      ) {
        return fail("secret values must be strings of at most 1024 characters");
      }
      item[name] = value;
    }
    parsedSecrets[itemId] = item;
  }
  return ok({ cardId, approve, ticked: [...ticked], secrets: parsedSecrets });
}

export function parseBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_CHARS) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  // A key typed into the URL would land in jarvis.yaml; keys go in the keyring.
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function parseDraftFields(value: unknown): Parsed<ProviderDraft> {
  const a = fields(value);
  if (a === undefined) return fail("expected {kind, baseUrl, model, apiKey?}");
  const { kind, model, apiKey } = a;
  if (typeof kind !== "string" || !(PROVIDER_KINDS as readonly string[]).includes(kind)) {
    return fail(`kind must be one of ${PROVIDER_KINDS.join(", ")}`);
  }
  const baseUrl = parseBaseUrl(a["baseUrl"]);
  if (baseUrl === undefined) return fail("baseUrl must be an http(s) URL without credentials");
  // "" is allowed: provider:probe with an empty model lists models only
  // (contracts §6 #10). provider:save refuses it (parseProviderSave).
  if (typeof model !== "string" || model.length > MAX_MODEL_CHARS || CONTROL_CHARS.test(model)) {
    return fail("model must be at most 200 printable characters");
  }
  const draft: ProviderDraft = { kind: kind as ProviderKind, baseUrl, model };
  if (apiKey !== undefined) {
    if (
      typeof apiKey !== "string" ||
      apiKey.length === 0 ||
      apiKey.length > MAX_KEY_CHARS ||
      /\s/.test(apiKey) ||
      CONTROL_CHARS.test(apiKey)
    ) {
      return fail("apiKey must be 1-4096 characters with no spaces");
    }
    draft.apiKey = apiKey;
  }
  return ok(draft);
}

const isProviderId = (value: unknown): value is string =>
  typeof value === "string" && PROVIDER_ID_PATTERN.test(value);

export function parseProviderDraft(args: readonly unknown[]): Parsed<ProviderProbeDraft> {
  if (args.length !== 1) return fail("expected [{kind, baseUrl, model, apiKey?, id?}]");
  const parsed = parseDraftFields(args[0]);
  if (!parsed.ok) return parsed;
  const id = fields(args[0])?.["id"];
  if (id === undefined) return parsed;
  if (!isProviderId(id)) return fail("id must be a-z, 0-9 and -, up to 32 characters");
  return ok({ ...parsed.value, id });
}

export function parseProviderSave(args: readonly unknown[]): Parsed<ProviderSaveRequest> {
  const a = single(args);
  if (a === undefined) return fail("expected [{providers, allowCloudFallback}]");
  const { providers, allowCloudFallback } = a;
  if (typeof allowCloudFallback !== "boolean") {
    return fail("allowCloudFallback must be true or false");
  }
  if (!Array.isArray(providers) || providers.length > MAX_PROVIDERS) {
    return fail(`providers must be a list of at most ${MAX_PROVIDERS}`);
  }
  const seen = new Set<string>();
  const out: ProviderDraftEntry[] = [];
  for (const raw of providers) {
    const parsed = parseDraftFields(raw);
    if (!parsed.ok) return parsed;
    const id = fields(raw)?.["id"];
    if (!isProviderId(id)) return fail("each provider needs an id: a-z, 0-9 and -, up to 32");
    if (seen.has(id)) return fail("provider ids must be unique");
    if (parsed.value.model === "") return fail("model must not be empty when saving");
    seen.add(id);
    out.push({ id, ...parsed.value });
  }
  return ok({ providers: out, allowCloudFallback });
}

export function parseMemoryList(args: readonly unknown[]): Parsed<{ limit: number }> {
  const limit = single(args)?.["limit"];
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    return fail("expected [{limit}] with an integer from 1 to 500");
  }
  return ok({ limit });
}

export function parseMemoryDelete(args: readonly unknown[]): Parsed<{ id: string }> {
  const id = single(args)?.["id"];
  if (!isId(id)) return fail("expected [{id}]");
  return ok({ id });
}

export function parseMemorySetEnabled(args: readonly unknown[]): Parsed<{ enabled: boolean }> {
  const enabled = single(args)?.["enabled"];
  if (typeof enabled !== "boolean") return fail("expected [{enabled}] with true or false");
  return ok({ enabled });
}

export function parseDoctorSkip(args: readonly unknown[]): Parsed<{ stepId: DoctorStepId }> {
  const a = single(args);
  const stepId = a?.["stepId"];
  if (typeof stepId !== "string" || !(DOCTOR_STEP_IDS as readonly string[]).includes(stepId)) {
    return fail(`stepId must be one of ${DOCTOR_STEP_IDS.join(", ")}`);
  }
  return ok({ stepId: stepId as DoctorStepId });
}

export function parseAuditList(args: readonly unknown[]): Parsed<AuditQuery> {
  const a = single(args);
  if (a === undefined) return fail("expected [{limit, beforeTs?}]");
  const { limit, beforeTs } = a;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    return fail("limit must be an integer from 1 to 500");
  }
  if (beforeTs === undefined) return ok({ limit });
  if (typeof beforeTs !== "number" || !Number.isFinite(beforeTs)) {
    return fail("beforeTs must be a finite number");
  }
  return ok({ limit, beforeTs });
}
