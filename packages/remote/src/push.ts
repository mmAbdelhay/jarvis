// The Expo push sender (M10 Task 2): the bridge's own outbound HTTP client,
// the first (and only) one — a per-device Expo push token goes out over an
// injected `fetch`, batched, retried on transport failure only, and cleared
// the instant Expo says a token is dead. `bridge.ts`/`hub.ts` only ever
// answer "who is watching" and store tokens; nothing about HTTP lives there.
//
// The Expo host (EXPO_PUSH_URL/EXPO_RECEIPTS_URL) is a constant, never config —
// a configurable push endpoint would be an exfiltration knob in a security-
// relevant position (ruling 3). A source-grep guard
// (import-direction.test.ts) asserts the Expo host appears nowhere else in this
// package.
//
// No `node:*` import beyond types: `Clock`/`Timers` come from io.ts (itself
// node-free); `AbortSignal.timeout` is the global, not a network import
// (rule 12). Every log line here is built from counts and outcome words
// only — never a token, a title or a body.

import type { Clock, Timers } from "./io.js";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
export const EXPO_PUSH_BATCH = 100;
export const EXPO_RECEIPTS_BATCH = 1_000;
export const PUSH_TTL_SECONDS = 1_800;
export const PUSH_QUEUE_MAX = 200;
export const PUSH_FLUSH_MS = 500;
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;
export const PUSH_RETRY_DELAYS_MS = [1_000, 4_000] as const;
export const MAX_PUSHES_PER_TOKEN_PER_MINUTE = 6;
export const RECEIPT_DELAY_MS = 900_000;

/** The trailing window a token's accepted pushes are counted over, for MAX_PUSHES_PER_TOKEN_PER_MINUTE. */
const RATE_WINDOW_MS = 60_000;

export type ExpoPushMessage = {
  to: string;
  title: string;
  body: string;
  data: Record<string, string>;
  sound: "default";
  priority: "high";
  channelId: string;
  ttl: number;
};

export type ExpoTicket =
  | { status: "ok"; id: string }
  | { status: "error"; error: string | undefined };
export type ExpoReceipt = { status: "ok" } | { status: "error"; error: string | undefined };

export type FetchLike = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** `items` sliced into arrays of at most `size`, preserving order; an empty input gives `[]`. */
function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Chunks `messages` into arrays of at most EXPO_PUSH_BATCH, preserving order — pure (behaviour rule 7). */
export function buildExpoRequests(
  messages: readonly ExpoPushMessage[],
): { url: string; body: string }[] {
  return chunk(messages, EXPO_PUSH_BATCH).map((batch) => ({
    url: EXPO_PUSH_URL,
    body: JSON.stringify(batch),
  }));
}

function ticketErrorOf(entry: Record<string, unknown>): string | undefined {
  const details = entry.details;
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  const error = (details as Record<string, unknown>).error;
  return typeof error === "string" ? error : undefined;
}

/**
 * Expects `{ data: array }` of exactly `expected` entries, each `{status:
 * "ok", id: string}` or `{status: "error", details?: {error?: string}}`; any
 * other shape (wrong length, `data` not an array, a malformed entry) answers
 * `undefined` for the whole value rather than a partial result (behaviour
 * rule 8) — a caller must always be able to tell "nothing usable came back"
 * from "here are the tickets".
 */
export function parseExpoTickets(json: unknown, expected: number): ExpoTicket[] | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const data = (json as Record<string, unknown>).data;
  if (!Array.isArray(data) || data.length !== expected) return undefined;

  const tickets: ExpoTicket[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
    const record = entry as Record<string, unknown>;
    if (record.status === "ok") {
      const id = record.id;
      if (typeof id !== "string") return undefined;
      tickets.push({ status: "ok", id });
      continue;
    }
    if (record.status === "error") {
      tickets.push({ status: "error", error: ticketErrorOf(record) });
      continue;
    }
    return undefined;
  }
  return tickets;
}

/**
 * `{ data: { [id]: receipt } }` -> a map; a malformed entry is skipped, a
 * malformed envelope answers an empty map (behaviour rule 9) — unlike
 * `parseExpoTickets`, a receipt fetch covering many ids should still credit
 * whichever of them parsed even if one entry didn't.
 */
export function parseExpoReceipts(json: unknown): Map<string, ExpoReceipt> {
  const result = new Map<string, ExpoReceipt>();
  if (typeof json !== "object" || json === null || Array.isArray(json)) return result;
  const data = (json as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return result;

  for (const [id, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    if (record.status === "ok") {
      result.set(id, { status: "ok" });
      continue;
    }
    if (record.status === "error") {
      result.set(id, { status: "error", error: ticketErrorOf(record) });
    }
    // any other status: skipped, not stored
  }
  return result;
}

export type SendOutcome = { tickets: ExpoTicket[]; unregistered: string[]; retryable: boolean };

type SendDetail = SendOutcome & {
  retryMessages: ExpoPushMessage[];
  ticketMessages: { ticket: ExpoTicket; message: ExpoPushMessage }[];
};

/**
 * Sends one chunk and answers its parsed tickets, or `undefined` for
 * anything the caller should retry the whole batch for: a rejected `fetch`,
 * HTTP 429/5xx, or a body that fails `parseExpoTickets`. A non-429 4xx
 * top-level `errors` array is terminal and becomes one error ticket per
 * message in this chunk.
 */
async function sendOneBatch(
  chunkOfMessages: readonly ExpoPushMessage[],
  fetchLike: FetchLike,
): Promise<ExpoTicket[] | undefined> {
  let response: { status: number; json(): Promise<unknown> };
  try {
    response = await fetchLike(EXPO_PUSH_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(chunkOfMessages),
      signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
    });
  } catch {
    return undefined;
  }
  if (response.status === 429 || response.status >= 500) return undefined;

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return undefined;
  }
  if (
    typeof json === "object" &&
    json !== null &&
    !Array.isArray(json) &&
    Array.isArray((json as Record<string, unknown>).errors)
  ) {
    if (response.status >= 400 && response.status < 500) {
      return Array.from({ length: chunkOfMessages.length }, () => ({
        status: "error" as const,
        error: undefined,
      }));
    }
    return undefined;
  }
  return parseExpoTickets(json, chunkOfMessages.length);
}

/**
 * Sends `messages` in EXPO_PUSH_BATCH chunks, in order (behaviour rule 10).
 * A retryable chunk contributes no tickets to the outcome and sets
 * `retryable: true` for the whole call — the caller (`createPushSender`)
 * decides what "retryable" means for the batch as a whole. Every
 * `DeviceNotRegistered` error ticket's message `to` lands in `unregistered`
 * (deduplicated). Logs one line per chunk — counts only, never a token, a
 * title or a body.
 */
async function sendExpoPushDetailed(
  messages: readonly ExpoPushMessage[],
  deps: { fetch: FetchLike; log(line: string): void },
): Promise<SendDetail> {
  const chunks = chunk(messages, EXPO_PUSH_BATCH);
  const tickets: ExpoTicket[] = [];
  const unregistered = new Set<string>();
  const retryMessages: ExpoPushMessage[] = [];
  const ticketMessages: { ticket: ExpoTicket; message: ExpoPushMessage }[] = [];
  let retryable = false;

  for (let batchIndex = 0; batchIndex < chunks.length; batchIndex++) {
    const batch = chunks[batchIndex] as ExpoPushMessage[];
    let ok = 0;
    let errors = 0;

    const parsed = await sendOneBatch(batch, deps.fetch);
    if (parsed === undefined) {
      retryable = true;
      retryMessages.push(...batch);
      deps.log(`push: send failed batch=${batchIndex} n=${batch.length}`);
    } else {
      for (let i = 0; i < parsed.length; i++) {
        const ticket = parsed[i] as ExpoTicket;
        const message = batch[i] as ExpoPushMessage;
        tickets.push(ticket);
        ticketMessages.push({ ticket, message });
        if (ticket.status === "ok") {
          ok += 1;
        } else {
          errors += 1;
          if (ticket.error === "DeviceNotRegistered") {
            unregistered.add(message.to);
          }
        }
      }
      deps.log(`push: sent batch=${batchIndex} n=${batch.length} ok=${ok} errors=${errors}`);
    }
  }

  return { tickets, unregistered: [...unregistered], retryable, retryMessages, ticketMessages };
}

export async function sendExpoPush(
  messages: readonly ExpoPushMessage[],
  deps: { fetch: FetchLike; log(line: string): void },
): Promise<SendOutcome> {
  const { tickets, unregistered, retryable } = await sendExpoPushDetailed(messages, deps);
  return { tickets, unregistered, retryable };
}

export type PushSenderDeps = {
  fetch: FetchLike;
  now: Clock;
  timers: Timers;
  log(line: string): void;
  onUnregistered(token: string): void;
};

export type PushSender = {
  enqueue(message: ExpoPushMessage): "queued" | "dropped-full" | "dropped-rate";
  flush(): Promise<void>;
  stop(): void;
  pending(): number;
};

/**
 * The bounded queue, batcher and backoff behind `enqueue`/`flush`/`stop`
 * (behaviour rule 11). No real network: every send goes through
 * `deps.fetch`, every delay through `deps.timers` (the receipt wait and the
 * retry backoff), so a test drives the whole lifecycle with fake timers and
 * a fake `fetch`, never a real clock or socket.
 */
export function createPushSender(deps: PushSenderDeps): PushSender {
  const { fetch: fetchLike, now, timers, log, onUnregistered } = deps;

  let queue: ExpoPushMessage[] = [];
  let flushTimer: unknown;
  let fullLoggedAt: number | undefined;
  const rateWindow = new Map<string, number[]>();
  const rateLimitLoggedAt = new Map<string, number>();

  // Every retry/receipt timer this sender has armed, so `stop()` can clear
  // all of them at once — a rejecting `fetch` must never leave one ticking
  // after stop (a bite-proof this package's tests check for directly).
  const retryTimers = new Set<unknown>();
  const receiptTimers = new Set<unknown>();

  // `id -> to`, bounded to EXPO_RECEIPTS_BATCH entries (oldest dropped),
  // for turning a `DeviceNotRegistered` receipt back into a token to clear.
  let receiptOrder: string[] = [];
  const receiptFor = new Map<string, string>();

  let stopped = false;

  function safeOnUnregistered(token: string): void {
    try {
      onUnregistered(token);
    } catch {
      // The callback is handed the token, so its exception may embed that
      // secret. Its category is useful; its message is never safe to log.
      log("push: onUnregistered threw");
    }
  }

  /** Prunes `to`'s accepted timestamps older than RATE_WINDOW_MS and answers what's left. */
  function acceptedInWindow(to: string, atNow: number): number[] {
    const list = rateWindow.get(to) ?? [];
    const kept = list.filter((t) => atNow - t < RATE_WINDOW_MS);
    if (kept.length > 0) rateWindow.set(to, kept);
    else rateWindow.delete(to);
    return kept;
  }

  function enqueue(message: ExpoPushMessage): "queued" | "dropped-full" | "dropped-rate" {
    if (stopped) return "dropped-full";
    const atNow = now();

    if (queue.length >= PUSH_QUEUE_MAX) {
      if (fullLoggedAt === undefined || atNow - fullLoggedAt >= PUSH_FLUSH_MS) {
        log("push: queue full, dropping");
        fullLoggedAt = atNow;
      }
      return "dropped-full";
    }

    const kept = acceptedInWindow(message.to, atNow);
    if (kept.length >= MAX_PUSHES_PER_TOKEN_PER_MINUTE) {
      // No device id and no token in this line (rule 11) — the sender
      // never learns a device id, and the token is a secret regardless.
      const lastLogged = rateLimitLoggedAt.get(message.to);
      if (lastLogged === undefined || atNow - lastLogged >= RATE_WINDOW_MS) {
        log(`push: rate-limited n=${kept.length}`);
        rateLimitLoggedAt.set(message.to, atNow);
      }
      return "dropped-rate";
    }

    kept.push(atNow);
    rateWindow.set(message.to, kept);
    queue.push(message);
    if (flushTimer === undefined) {
      flushTimer = timers.setTimeout(() => {
        flushTimer = undefined;
        void doFlush();
      }, PUSH_FLUSH_MS);
    }
    return "queued";
  }

  /** Takes everything queued as one batch and sends it — the queue's own flush, whether fired by the timer or called directly. */
  async function doFlush(): Promise<void> {
    if (flushTimer !== undefined) {
      timers.clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (stopped || queue.length === 0) return;
    const batch = queue;
    queue = [];
    await sendBatch(batch, 0);
  }

  /**
   * Sends `messages` as one batch. A retryable outcome re-arms only its
   * failed chunks with `PUSH_RETRY_DELAYS_MS[attempt]`; after the third
   * failed send, that remaining batch is dropped. New messages queued
   * meanwhile form their own, independent batch (rule 11/ruling 13).
   */
  async function sendBatch(
    messages: ExpoPushMessage[],
    attempt: number,
    clearedTokens = new Set<string>(),
  ): Promise<void> {
    if (stopped) return;
    const outcome = await sendExpoPushDetailed(messages, { fetch: fetchLike, log });
    if (stopped) return; // a stop() during the send must arm nothing further

    for (const token of outcome.unregistered) {
      if (clearedTokens.has(token)) continue;
      clearedTokens.add(token);
      safeOnUnregistered(token);
    }
    armReceiptFetch(outcome.ticketMessages);

    if (outcome.retryable) {
      if (attempt >= 2) {
        log(`push: batch dropped n=${messages.length}`);
        return;
      }
      const delay = PUSH_RETRY_DELAYS_MS[attempt] as number;
      const handle = timers.setTimeout(() => {
        retryTimers.delete(handle);
        void sendBatch(outcome.retryMessages, attempt + 1, clearedTokens);
      }, delay);
      retryTimers.add(handle);
      return;
    }
  }

  /** Remembers each `ok` ticket's id -> to (bounded), and arms one receipt fetch for this batch. */
  function armReceiptFetch(
    ticketMessages: { ticket: ExpoTicket; message: ExpoPushMessage }[],
  ): void {
    const okIds: string[] = [];
    for (const { ticket, message } of ticketMessages) {
      if (ticket.status !== "ok") continue;
      receiptFor.set(ticket.id, message.to);
      receiptOrder.push(ticket.id);
      okIds.push(ticket.id);
      while (receiptOrder.length > EXPO_RECEIPTS_BATCH) {
        const oldest = receiptOrder.shift();
        if (oldest !== undefined) receiptFor.delete(oldest);
      }
    }
    if (okIds.length === 0 || stopped) return;

    const handle = timers.setTimeout(() => {
      receiptTimers.delete(handle);
      void fetchReceipts(okIds);
    }, RECEIPT_DELAY_MS);
    receiptTimers.add(handle);
  }

  /** Fetches receipts for `ids` once; never retried on failure (rule 13). */
  async function fetchReceipts(ids: string[]): Promise<void> {
    if (stopped) return;
    let response: { status: number; json(): Promise<unknown> };
    try {
      response = await fetchLike(EXPO_RECEIPTS_URL, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(PUSH_REQUEST_TIMEOUT_MS),
      });
    } catch {
      log("push: receipts fetch failed");
      return;
    }
    if (response.status >= 400) {
      log("push: receipts fetch failed");
      return;
    }
    if (stopped) return;

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      log("push: receipts fetch failed");
      return;
    }

    for (const [id, receipt] of parseExpoReceipts(json)) {
      if (receipt.status === "error" && receipt.error === "DeviceNotRegistered") {
        const to = receiptFor.get(id);
        if (to !== undefined) safeOnUnregistered(to);
      }
    }
  }

  function stop(): void {
    stopped = true;
    if (flushTimer !== undefined) {
      timers.clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    for (const handle of retryTimers) timers.clearTimeout(handle);
    retryTimers.clear();
    for (const handle of receiptTimers) timers.clearTimeout(handle);
    receiptTimers.clear();
    queue = [];
    receiptFor.clear();
    receiptOrder = [];
    rateWindow.clear();
    rateLimitLoggedAt.clear();
  }

  return {
    enqueue,
    flush: doFlush,
    stop,
    pending: () => queue.length,
  };
}
