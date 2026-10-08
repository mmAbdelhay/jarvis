// Memory with rolling summaries (design §3.9). After every 20 turns and at
// session end the active model writes a ≤ 200-word summary and up to 5
// facts; approved actions from the audit log become facts by themselves.
// Everything stored is redacted first, and tool inputs never enter the
// transcript (names only). Recall: the top 5 memories by cosine over local
// embeddings, or by keyword coverage, within a time window when the question
// names one ("last week"), go to the model as one fenced <memory-notes> block.
// Storage and keys are injected (platform/store/memory-store.ts); a null
// backend means the keyring is unavailable and memory is off. Pure.
import type { AuditEntry, MemoryItem, MemoryKind } from "./contract.js";
import { MEMORY_TEXT } from "./messages.js";
import { buildSystemPrompt } from "./safety.js";
import { type TextEmbedder, cosine, createBm25Index, tokenize } from "./text-index.js";
import { type ModelMessage, isRecord } from "./types.js";

export const SUMMARY_EVERY_TURNS = 20;
export const MAX_SUMMARY_WORDS = 200;
export const MAX_FACTS = 5;
export const MAX_FACT_CHARS = 200;
export const RECALL_LIMIT = 5;
export const COSINE_RELEVANCE = 0.55;
export const KEYWORD_RELEVANCE = 0.5;
export const SESSION_IDLE_MS = 30 * 60_000;
export const TRANSCRIPT_MAX_CHARS = 12_000;
const TOOL_PREVIEW_CHARS = 400;
const SUMMARY_TIMEOUT_MS = 60_000;
const DAY_MS = 86_400_000;

export type MemoryRecord = {
  id: string;
  kind: MemoryKind;
  text: string;
  createdAt: number;
  embedding: Float32Array | null;
  embeddingModel: string | null;
};
export type NewMemory = Omit<MemoryRecord, "id">;

export interface MemoryBackend {
  add(memory: NewMemory): Promise<string>;
  list(limit: number): Promise<MemoryRecord[]>;
  all(): Promise<MemoryRecord[]>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
}

export interface MemoryService {
  afterTurn(turnMessages: readonly ModelMessage[]): void;
  endSession(): Promise<void>;
  recordAudit(entry: AuditEntry): void;
  recall(query: string): Promise<string[]>;
  list(limit: number): Promise<MemoryItem[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
  idle(): Promise<void>;
}

/** Stemmed time words (tokenize) → how far back a question looks. */
const TIME_WINDOWS: ReadonlyMap<string, number> = new Map([
  ["today", 2 * DAY_MS],
  ["yesterday", 2 * DAY_MS],
  ["week", 14 * DAY_MS],
  ["month", 62 * DAY_MS],
  ["recent", 30 * DAY_MS],
  ["recently", 30 * DAY_MS],
  ["ago", 30 * DAY_MS],
  ["last", 30 * DAY_MS],
  ["earlier", 30 * DAY_MS],
]);

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
const FENCE_TAGS = /<\s*(\/?)\s*(memory-notes|untrusted-data|safety-rules)/gi;

export function renderTranscript(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      lines.push(`User: ${message.text}`);
    } else if (message.role === "assistant") {
      if (message.text.trim() !== "") lines.push(`Jarvis: ${message.text.trim()}`);
      // Names only: inputs can carry secrets the card collected.
      if (message.toolCalls.length > 0) {
        lines.push(`Jarvis used: ${message.toolCalls.map((call) => call.name).join(", ")}`);
      }
    } else {
      for (const result of message.results) {
        lines.push(`Result of ${result.name}: ${result.content.slice(0, TOOL_PREVIEW_CHARS)}`);
      }
    }
  }
  let text = lines.join("\n");
  if (text.length > TRANSCRIPT_MAX_CHARS) {
    text = text.slice(text.length - TRANSCRIPT_MAX_CHARS);
    const newline = text.indexOf("\n");
    if (newline >= 0) text = text.slice(newline + 1);
  }
  return text;
}

export function parseSummaryReply(
  text: string,
  redact: (text: string) => string,
): { summary: string; facts: string[] } | null {
  let parsed: unknown;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      parsed = undefined;
    }
  }
  let summary = text;
  let facts: string[] = [];
  if (isRecord(parsed)) {
    summary = typeof parsed["summary"] === "string" ? parsed["summary"] : "";
    const rawFacts = parsed["facts"];
    facts = Array.isArray(rawFacts)
      ? rawFacts.filter((fact): fact is string => typeof fact === "string")
      : [];
  }
  summary = collapse(redact(summary)).split(" ").slice(0, MAX_SUMMARY_WORDS).join(" ");
  facts = facts
    .map((fact) => collapse(redact(fact)).slice(0, MAX_FACT_CHARS))
    .filter((fact) => fact !== "")
    .slice(0, MAX_FACTS);
  return summary === "" && facts.length === 0 ? null : { summary, facts };
}

export function factFromAudit(entry: AuditEntry): string | null {
  if (entry.decision !== "approved" || entry.result !== "ok") return null;
  return MEMORY_TEXT.auditFact(entry.title, entry.tool, isoDate(entry.ts));
}

export function recencyWindowMs(terms: readonly string[]): number | null {
  const windows = terms.flatMap((term) => {
    const window = TIME_WINDOWS.get(term);
    return window === undefined ? [] : [window];
  });
  return windows.length === 0 ? null : Math.min(...windows);
}

export function memoryNotes(
  records: readonly { kind: MemoryKind; text: string; createdAt: number }[],
): string {
  const lines = records.map(
    (record) =>
      `- [${isoDate(record.createdAt)}, ${record.kind}] ${record.text.replace(
        FENCE_TAGS,
        (_match, slash: string, tag: string) => `‹${slash}${tag.replace("-", "_")}`,
      )}`,
  );
  return `<memory-notes>\n${MEMORY_TEXT.notesHeader}\n${lines.join("\n")}\n</memory-notes>`;
}

const newestFirst = (records: readonly MemoryRecord[]) =>
  [...records].sort((a, b) => b.createdAt - a.createdAt);

export function createMemoryService(deps: {
  enabled(): boolean;
  backend(): Promise<MemoryBackend | null>;
  reset(): Promise<void>;
  summarize(system: string, transcript: string, signal: AbortSignal): Promise<string>;
  embedder: TextEmbedder | null;
  redact(text: string): string;
  now(): number;
  log(line: string): void;
}): MemoryService {
  let transcript: ModelMessage[] = [];
  let turns = 0;
  let pending: Promise<void> = Promise.resolve();

  const enqueue = (job: () => Promise<void>) => {
    pending = pending.then(job).catch((error: unknown) => {
      deps.log(`[memory] ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  async function store(backend: MemoryBackend, kind: MemoryKind, text: string): Promise<void> {
    let embedding: Float32Array | null = null;
    let embeddingModel: string | null = null;
    if (deps.embedder !== null) {
      try {
        embedding = (await deps.embedder.embed([text], "document"))[0] ?? null;
        embeddingModel = embedding === null ? null : deps.embedder.model;
      } catch {
        // Stored without a vector; recall finds it by keywords.
      }
    }
    await backend.add({ kind, text, createdAt: deps.now(), embedding, embeddingModel });
  }

  async function writeSummary(batch: readonly ModelMessage[]): Promise<void> {
    const backend = await deps.backend();
    if (backend === null) return;
    const reply = await deps.summarize(
      buildSystemPrompt(MEMORY_TEXT.summaryPrompt),
      renderTranscript(batch),
      AbortSignal.timeout(SUMMARY_TIMEOUT_MS),
    );
    const parsed = parseSummaryReply(reply, deps.redact);
    if (parsed === null) return;
    if (parsed.summary !== "") await store(backend, "summary", parsed.summary);
    for (const fact of parsed.facts) await store(backend, "fact", fact);
  }

  function flush(): void {
    if (turns === 0) return;
    const batch = transcript;
    transcript = [];
    turns = 0;
    enqueue(() => writeSummary(batch));
  }

  async function semantic(
    query: string,
    candidates: readonly MemoryRecord[],
  ): Promise<MemoryRecord[] | undefined> {
    const embedder = deps.embedder;
    if (embedder === null) return undefined;
    const withVectors = candidates.filter(
      (record) => record.embedding !== null && record.embeddingModel === embedder.model,
    );
    if (withVectors.length === 0) return undefined;
    try {
      const [queryVector] = await embedder.embed([query], "query");
      if (queryVector === undefined) return undefined;
      return withVectors
        .map((record) => ({ record, score: cosine(queryVector, record.embedding ?? []) }))
        .filter((entry) => entry.score >= COSINE_RELEVANCE)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.record);
    } catch {
      return undefined;
    }
  }

  function keyword(terms: readonly string[], candidates: readonly MemoryRecord[]): MemoryRecord[] {
    const byId = new Map(candidates.map((record) => [record.id, record]));
    return createBm25Index(candidates.map((record) => ({ id: record.id, text: record.text })))
      .search(terms)
      .filter((hit) => hit.matched / hit.of >= KEYWORD_RELEVANCE)
      .flatMap((hit) => {
        const record = byId.get(hit.id);
        return record === undefined ? [] : [record];
      });
  }

  return {
    afterTurn(turnMessages) {
      if (!deps.enabled()) return;
      transcript.push(...turnMessages);
      turns++;
      if (turns >= SUMMARY_EVERY_TURNS) flush();
    },

    async endSession() {
      if (deps.enabled()) flush();
      await pending;
    },

    recordAudit(entry) {
      if (!deps.enabled()) return;
      const fact = factFromAudit(entry);
      if (fact === null) return;
      enqueue(async () => {
        const backend = await deps.backend();
        if (backend !== null) await store(backend, "fact", deps.redact(fact));
      });
    },

    async recall(query) {
      if (!deps.enabled()) return [];
      const backend = await deps.backend();
      if (backend === null) return [];
      const records = await backend.all();
      const terms = tokenize(query);
      const window = recencyWindowMs(terms);
      const now = deps.now();
      const candidates =
        window === null ? records : records.filter((record) => record.createdAt >= now - window);
      if (candidates.length === 0) return [];
      const content = terms.filter((term) => !TIME_WINDOWS.has(term));
      let chosen: MemoryRecord[];
      if (content.length === 0) {
        chosen = window === null ? [] : newestFirst(candidates);
      } else {
        const ranked = await semantic(query, candidates);
        const unvectored =
          ranked === undefined
            ? candidates
            : candidates.filter(
                (record) =>
                  record.embedding === null || record.embeddingModel !== deps.embedder?.model,
              );
        chosen = [...(ranked ?? []), ...keyword(content, unvectored)];
      }
      const top = chosen.slice(0, RECALL_LIMIT);
      return top.length === 0 ? [] : [memoryNotes(top)];
    },

    async list(limit) {
      const backend = await deps.backend();
      if (backend === null) return [];
      return (await backend.list(limit)).map(({ id, kind, text, createdAt }) => ({
        id,
        kind,
        text,
        createdAt,
      }));
    },

    async delete(id) {
      const backend = await deps.backend();
      if (backend !== null) await backend.delete(id);
    },

    async clear() {
      transcript = [];
      turns = 0;
      const backend = await deps.backend();
      if (backend === null) await deps.reset();
      else await backend.clear();
    },

    idle: () => pending,
  };
}
