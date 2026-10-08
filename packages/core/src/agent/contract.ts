// Contracts §3.3, copied because @jarvis/core imports no workspace package.
// packages/desktop/src/daemon/os/contract-types.test.ts asserts each type
// here equals @jarvis/wire's; change both or neither.

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
/** The provider:status push. Not "ProviderStatus": core already exports one. */
export type ProviderListEntry = ProviderConfig & { id: string };
export type ProviderDraftEntry = ProviderDraft & { id: string };
export type ProviderListResult = {
  providers: ProviderListEntry[];
  activeId: string | null;
  allowCloudFallback: boolean;
  kinds: ProviderKind[];
};
export type ProviderSaveRequest = { providers: ProviderDraftEntry[]; allowCloudFallback: boolean };
export type ProviderSaveResult = { ok: boolean; results: Record<string, ProbeResult> };
export type ProviderReachability = {
  reachable: boolean;
  error?: string;
  activeId: string | null;
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

/** The sys:snapshot push (contracts §6 #8, M2 §2, §5). */
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

/** Rafiq M3 §2 (copied from @jarvis/wire; contract-types.test.ts pins them equal). */
export type AuditVia = "desktop" | "doctor" | `phone:${string}`;
export type VoiceLang = "en" | "ar";
export type VoiceAction = "prompt" | "approve" | "deny" | "ignored";
export type VoiceAvailability = {
  available: boolean;
  stt: string | null;
  tts: string | null;
  speak: boolean;
};
export type UndoResult = { undone: string | null };
