import { isIpLiteral as isAddressLiteral } from "./address.js";
import { DEVICE_ID_PATTERN } from "./protocol.js";

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
  /** Contracts §5 #10. a: [{on}], v: null. */
  voiceSetSpeak: "voice:setSpeak",
  /** Rafiq M3 contracts §2. a: [], v: null — stops speech. */
  voiceStop: "voice:stop",
  /** Rafiq M3 contracts §2. a: [], v: UndoResult. */
  agentUndo: "agent:undo",
  /** Rafiq M3 contracts §2. a: [PairingAnswer], v: null. */
  pairingAnswer: "pairing:answer",
  /** Rafiq M3 contracts §3: from /usr/bin/jarvis-lock only (peer-checked). a: [{locked}], v: null. */
  sysSetLocked: "sys:setLocked",
  /** Additive (plan N gap): the shell's phone settings; local connections only. */
  remoteStatus: "remote:status",
  remoteConfigure: "remote:configure",
  remoteSetOwnerPassword: "remote:setOwnerPassword",
  remoteRevoke: "remote:revoke",
  pairingOpen: "pairing:open",
  pairingCancel: "pairing:cancel",
  /** Rafiq M4 §3: a: [{lang: "en"|"ar"}], v: null. jarvisd writes os.language
   *  in jarvis.yaml and pushes ui:language to every client. */
  uiSetLanguage: "ui:setLanguage",
  /** Rafiq v1.1 §2: a: [], v: null — ends the computer-use session and stops the turn. Local only. */
  cuStop: "cu:stop",
  /** Rafiq v1.1 §2: a: [], v: null — resumes a paused session. Local only. */
  cuResume: "cu:resume",
  /** Rafiq v1.1 §2: a: [{providerId, enabled}], v: null. Local only. */
  cuSetEnabled: "cu:setEnabled",
  /** Rafiq v1.1 §4.8: a: [{providerId, revoke?}], v: null — consent for non-loopback screenshots. Local only. */
  cuConsent: "cu:consent",
  /** Plan Y §2.4: a: [], v: AccountStatusResult. The only account channel a phone may call. */
  accountStatus: "account:status",
  /** Plan Y §2.4: a: [{account}], v: null; progress on account:state. Local only. */
  accountInstall: "account:install",
  /** Plan Y §2.4: a: [{account}], v: null; awaiting-browser then signed-in | failed. Local only. */
  accountLogin: "account:login",
  /** Plan Y §2.4: a: [{account}], v: null — the CLI's logout, then its config dir is deleted. Local only. */
  accountLogout: "account:logout",
  /** Plan Y §2.4: a: [{account}], v: null — signs out first, then removes the CLI. Local only. */
  accountUninstall: "account:uninstall",
} as const;

export const OS_CONTROL_PUSHES = {
  agentEvents: "agent:events",
  providerStatus: "provider:status",
  doctorState: "doctor:state",
  /** Contracts §6 #8: every 10 s and on change, and on every new connection. */
  sysSnapshot: "sys:snapshot",
  /** Rafiq M3 contracts §2. */
  voiceState: "voice:state",
  pairingPending: "pairing:pending",
  /** Additive (plan N gap): OsRemoteStatus on every change and on connect. */
  remoteStatus: "remote:status",
  /** Rafiq M4 §3: {lang}; on every change and first on every new connection. */
  uiLanguage: "ui:language",
  /** Rafiq v1.1 §2: CuState on every change and on every new connection. */
  cuState: "cu:state",
  /** Plan Y §2.4: AccountStatePush, on every install/login step. */
  accountState: "account:state",
} as const;

export const PROVIDER_KINDS = [
  "anthropic",
  "openai-compatible",
  "ollama",
  "gemini",
  "account",
] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Plan Y §2.1: the accounts a user can sign in with. */
export const ACCOUNT_IDS = ["claude", "chatgpt", "gemini", "copilot"] as const;
export type AccountId = (typeof ACCOUNT_IDS)[number];
export function isAccountId(value: unknown): value is AccountId {
  return typeof value === "string" && (ACCOUNT_IDS as readonly string[]).includes(value);
}
/** Plan Y §2.1: "set to the vendor's fixed value for display only". */
export const ACCOUNT_BASE_URLS: Readonly<Record<AccountId, string>> = {
  claude: "https://claude.ai",
  chatgpt: "https://chatgpt.com",
  gemini: "https://gemini.google.com",
  copilot: "https://github.com/copilot",
};

export type ProviderConfig = {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  account?: AccountId;
};
export type ProviderDraft = {
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  account?: AccountId;
};

export type ProbeResult = { ok: boolean; supportsTools: boolean; models: string[]; error?: string };
/** M2.5 contracts §1: lower-case letters, digits and "-", up to 32. */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const MAX_PROVIDERS = 8;
/** Rafiq v1.1 §4.8: computer-use state per provider. */
export type ProviderComputerUse = { enabled: boolean; consentAt: string | null };
export type ProviderListEntry = ProviderConfig & {
  id: string;
  vision: boolean;
  computerUse: ProviderComputerUse;
};
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
  locked: boolean;
  voice: VoiceAvailability;
  undo: { available: boolean; title: string | null };
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
  via: AuditVia;
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
  if (a === undefined) return fail("expected {kind, baseUrl, model, apiKey?, account?}");
  const { kind, model, apiKey, account } = a;
  if (typeof kind !== "string" || !(PROVIDER_KINDS as readonly string[]).includes(kind)) {
    return fail(`kind must be one of ${PROVIDER_KINDS.join(", ")}`);
  }
  // "" is allowed: provider:probe with an empty model lists models only
  // (contracts §6 #10). provider:save refuses it (parseProviderSave).
  if (typeof model !== "string" || model.length > MAX_MODEL_CHARS || CONTROL_CHARS.test(model)) {
    return fail("model must be at most 200 printable characters");
  }
  if (kind === "account") {
    // Plan Y §2.1: no apiKey; the base URL is the vendor's, for display only.
    if (!isAccountId(account)) return fail(`account must be one of ${ACCOUNT_IDS.join(", ")}`);
    if (apiKey !== undefined) return fail("an account provider takes no apiKey");
    return ok({ kind: "account", account, baseUrl: ACCOUNT_BASE_URLS[account], model });
  }
  if (account !== undefined) return fail("account is only for kind account");
  const baseUrl = parseBaseUrl(a["baseUrl"]);
  if (baseUrl === undefined) return fail("baseUrl must be an http(s) URL without credentials");
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

/** Rafiq M4 §1: ids jarvisd uses for itself; no configured provider may take one. */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set(["backup"]);

const isProviderId = (value: unknown): value is string =>
  typeof value === "string" && PROVIDER_ID_PATTERN.test(value) && !RESERVED_PROVIDER_IDS.has(value);

export function parseProviderDraft(args: readonly unknown[]): Parsed<ProviderProbeDraft> {
  if (args.length !== 1) return fail("expected [{kind, baseUrl, model, apiKey?, id?}]");
  const parsed = parseDraftFields(args[0]);
  if (!parsed.ok) return parsed;
  const id = fields(args[0])?.["id"];
  if (id === undefined) return parsed;
  if (!isProviderId(id))
    return fail('id must be a-z, 0-9 and -, up to 32 characters (not "backup")');
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
    if (!isProviderId(id))
      return fail('each provider needs an id: a-z, 0-9 and -, up to 32 (not "backup")');
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

/** Blob requests (the control socket's existing blob lane). */
export const OS_CONTROL_BLOBS = {
  /** Rafiq M3 contracts §2: 16 kHz mono WAV ≤ 4 MiB. */
  voiceUtterance: "voice:utterance",
} as const;

// ── Rafiq M3 (contracts §2) ─────────────────────────────────────────────

export type VoiceLang = "en" | "ar";
export type VoiceAction = "prompt" | "approve" | "deny" | "ignored";
export type VoiceStateName = "idle" | "listening" | "transcribing" | "speaking";
export type VoiceStatePush = { state: VoiceStateName; lang?: VoiceLang };
/** stt: the whisper model in use ("ggml-base"/"ggml-small"), tts: Piper voices installed. */
export type VoiceAvailability = {
  available: boolean;
  stt: string | null;
  tts: string | null;
  speak: boolean;
};
/** `ticked` is additive (plan N gap): the shell's current ticks; absent = every item. */
export type VoiceUtteranceMeta = { lang: "auto" | "en" | "ar"; cardId?: string; ticked?: string[] };
export type VoiceUtteranceResult = { text: string; lang: VoiceLang; action: VoiceAction };
export type UndoResult = { undone: string | null };
/** Contracts §5 #9: answers are tied to the pending request. */
export type PairingPending = {
  requestId: string;
  deviceName: string;
  address: string;
  expiresAt: number;
};
export type PairingAnswer = { requestId: string; approve: boolean };
export type PairingOpenResult = { uri: string; expiresAt: number };
export type OsRemoteStatus = {
  enabled: boolean;
  listening: { host: string; port: number; fingerprint: string } | null;
  pairing: "closed" | "open" | "confirming";
  devices: { id: string; name: string; connected: boolean; lastSeenAt: number | null }[];
  hasOwnerPassword: boolean;
  problem: string | null;
};
export type RemoteConfigureRequest = { enabled: boolean; bindAddress?: string; port?: number };
export type OwnerPasswordRequest = { current?: string; next: string };
export type OwnerPasswordResult = { ok: true } | { ok: false; code: string };

const VOICE_LANGS = ["auto", "en", "ar"] as const;
const MAX_PASSWORD_CHARS = 1_024;

function isTickList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_TICKED &&
    value.every(isId) &&
    new Set(value).size === value.length
  );
}

export function isIpLiteral(value: unknown): value is string {
  return typeof value === "string" && isAddressLiteral(value);
}

export function parseVoiceUtteranceMeta(args: readonly unknown[]): Parsed<VoiceUtteranceMeta> {
  if (args.length === 0) return ok({ lang: "auto" });
  const a = single(args);
  if (a === undefined) return fail("expected [{lang?, cardId?, ticked?}]");
  const { lang, cardId, ticked } = a;
  const meta: VoiceUtteranceMeta = { lang: "auto" };
  if (lang !== undefined) {
    if (typeof lang !== "string" || !(VOICE_LANGS as readonly string[]).includes(lang)) {
      return fail("lang must be auto, en or ar");
    }
    meta.lang = lang as VoiceUtteranceMeta["lang"];
  }
  if (cardId !== undefined) {
    if (!isId(cardId)) return fail("cardId must be an id");
    meta.cardId = cardId;
  }
  if (ticked !== undefined) {
    if (!isTickList(ticked)) return fail("ticked must be a list of item ids");
    meta.ticked = [...ticked];
  }
  return ok(meta);
}

export function parsePairingAnswer(args: readonly unknown[]): Parsed<PairingAnswer> {
  const a = single(args);
  if (a === undefined || typeof a["approve"] !== "boolean" || !isId(a["requestId"])) {
    return fail("expected [{requestId, approve}]");
  }
  return ok({ requestId: a["requestId"], approve: a["approve"] });
}

export function parseSetLocked(args: readonly unknown[]): Parsed<{ locked: boolean }> {
  const a = single(args);
  if (a === undefined || typeof a["locked"] !== "boolean") return fail("expected [{locked}]");
  return ok({ locked: a["locked"] });
}

export function parseRemoteConfigure(args: readonly unknown[]): Parsed<RemoteConfigureRequest> {
  const a = single(args);
  if (a === undefined || typeof a["enabled"] !== "boolean") {
    return fail("expected [{enabled, bindAddress?, port?}]");
  }
  const request: RemoteConfigureRequest = { enabled: a["enabled"] };
  const { bindAddress, port } = a;
  if (bindAddress !== undefined) {
    if (!isIpLiteral(bindAddress)) return fail("bindAddress must be an IP address");
    request.bindAddress = bindAddress;
  }
  if (port !== undefined) {
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535) {
      return fail("port must be a whole number from 1 to 65535");
    }
    request.port = port;
  }
  return ok(request);
}

const isPassword = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_PASSWORD_CHARS;

export function parseOwnerPassword(args: readonly unknown[]): Parsed<OwnerPasswordRequest> {
  const a = single(args);
  if (a === undefined) return fail("expected [{current?, next}]");
  const { current, next } = a;
  // Never put the value in the error: it is a password.
  if (!isPassword(next)) return fail("next must be 1-1024 characters");
  if (current === undefined) return ok({ next });
  if (!isPassword(current)) return fail("current must be 1-1024 characters");
  return ok({ current, next });
}

export function parseRemoteRevoke(args: readonly unknown[]): Parsed<{ deviceId: string }> {
  const a = single(args);
  const deviceId = a?.["deviceId"];
  if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
    return fail("deviceId must be a device id");
  }
  return ok({ deviceId });
}

/** Contracts §5 #10: computer speech preference. */
export function parseSetSpeak(args: readonly unknown[]): Parsed<{ on: boolean }> {
  const a = single(args);
  if (a === undefined || typeof a["on"] !== "boolean") return fail("expected [{on}]");
  return ok({ on: a["on"] });
}

export type AuditVia = "desktop" | "doctor" | `phone:${string}`;

// ── Rafiq M4 (contracts §3) ─────────────────────────────────────────────

export const UI_LANGUAGES = ["en", "ar"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];
export type UiLanguagePush = { lang: UiLanguage };

export function parseUiSetLanguage(args: readonly unknown[]): Parsed<{ lang: UiLanguage }> {
  const lang = single(args)?.["lang"];
  if (typeof lang !== "string" || !(UI_LANGUAGES as readonly string[]).includes(lang)) {
    return fail('expected [{lang: "en" | "ar"}]');
  }
  return ok({ lang: lang as UiLanguage });
}

// ── Rafiq v1.1 computer use (contracts §2) ──────────────────────────────

/** Max actions per computer-use goal (design §2.7). */
export const CU_MAX_STEPS = 50;
export type CuStepStatus = "done" | "running" | "pending" | "failed";
export type CuStep = { title: string; status: CuStepStatus };
export const CU_PAUSE_REASONS = ["physical-input", "esc", "locked", "excluded-focus"] as const;
export type CuPauseReason = (typeof CU_PAUSE_REASONS)[number];
/** The cu:state push. With no session: active false, sessionId null, goal "",
 *  apps [], step 0, maxSteps 50, steps [], paused null (contracts §4.9). */
export type CuState = {
  active: boolean;
  sessionId: string | null;
  goal: string;
  apps: string[];
  step: number;
  maxSteps: number;
  steps: CuStep[];
  paused: CuPauseReason | null;
};
export type CuSetEnabledRequest = { providerId: string; enabled: boolean };
export type CuConsentRequest = { providerId: string; revoke?: boolean };

function isConfigurableProviderId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    PROVIDER_ID_PATTERN.test(value) &&
    !RESERVED_PROVIDER_IDS.has(value)
  );
}

export function parseCuSetEnabled(args: readonly unknown[]): Parsed<CuSetEnabledRequest> {
  const a = single(args);
  const providerId = a?.["providerId"];
  const enabled = a?.["enabled"];
  if (!isConfigurableProviderId(providerId)) return fail("providerId must be a provider id");
  if (typeof enabled !== "boolean") return fail("enabled must be true or false");
  return ok({ providerId, enabled });
}

export function parseCuConsent(args: readonly unknown[]): Parsed<CuConsentRequest> {
  const a = single(args);
  const providerId = a?.["providerId"];
  const revoke = a?.["revoke"];
  if (!isConfigurableProviderId(providerId)) return fail("providerId must be a provider id");
  if (revoke === undefined) return ok({ providerId });
  if (typeof revoke !== "boolean") return fail("revoke must be true or false");
  return ok({ providerId, revoke });
}

/** Plan Y §2.4: account:status. */
export type AccountStatus = {
  account: AccountId;
  installed: boolean;
  version: string | null;
  signedIn: boolean;
  identity: string | null;
};
export type AccountStatusResult = { accounts: AccountStatus[] };
export const ACCOUNT_PHASES = [
  "installing",
  "installed",
  "failed",
  "awaiting-browser",
  "signed-in",
] as const;
export type AccountPhase = (typeof ACCOUNT_PHASES)[number];
/** Plan Y §2.4: the account:state push. `url`/`code` only with awaiting-browser,
 *  `identity` only with signed-in, `message` with installing/installed/failed. */
export type AccountStatePush = {
  account: AccountId;
  phase: AccountPhase;
  message?: string;
  url?: string;
  code?: string;
  identity?: string;
};

export function parseAccountRequest(args: readonly unknown[]): Parsed<{ account: AccountId }> {
  const account = single(args)?.["account"];
  if (!isAccountId(account))
    return fail(`expected [{account}] with account one of ${ACCOUNT_IDS.join(", ")}`);
  return ok({ account });
}
