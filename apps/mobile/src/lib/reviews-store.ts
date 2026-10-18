// PR review comments, as the laptop's review service reports them over
// `reviews:list` / `reviews:thread`, plus the two phone actions (reply on
// GitHub, Deliver now). The app imports `@jarvis/core` type-only, and the
// list/thread shapes live in the desktop package, so the minimal wire
// shapes are mirrored here and every value is rebuilt field by field from
// `unknown` (plans-store.ts's store pattern, wire/push.ts's parse
// discipline): a malformed item is dropped, never thrown on, and any extra
// key on the wire is left behind.
import type { RpcClient, RpcResult } from "./rpc-client";

export type PrKey = string;

/** `owner/name#N`, bounded — the laptop's `PushData.pr` check, plus no
 *  owner or name made only of dots (`..` is never a GitHub name). */
const PR_KEY_PATTERN = /^[\w.-]+\/[\w.-]+#\d+$/;
const DOTS_ONLY = /(^|\/)\.+(\/|#)/;
const MAX_PR_KEY_CHARS = 140;

export function isPrKey(value: unknown): value is PrKey {
  return (
    typeof value === "string" &&
    value.length <= MAX_PR_KEY_CHARS &&
    PR_KEY_PATTERN.test(value) &&
    !DOTS_ONLY.test(value)
  );
}

/** The thread route for an already-validated key, as one path segment. */
export function reviewRoute(key: PrKey): string {
  return `/reviews/${encodeURIComponent(key)}`;
}

export type ReviewPr = {
  repo: string;
  number: number;
  title: string;
  headRef: string;
  author: string;
  url: string;
  isDraft: boolean;
  role: "mine" | "review-requested";
};

export type ReviewLink =
  | { kind: "linked"; paneKey: string; how: "manual" | "auto" }
  | { kind: "none" }
  | { kind: "ambiguous"; paneKeys: string[] };

export const WAIT_REASONS = [
  "no-link",
  "ambiguous",
  "no-agent",
  "approval-prompt",
  "busy",
  "typing",
  "batching",
  "paused",
  "nothing",
] as const;
export type ReviewWaitReason = (typeof WAIT_REASONS)[number];

export type ReviewListItem = {
  key: PrKey;
  pr: ReviewPr;
  link: ReviewLink;
  queued: number;
  delivered: number;
  waitReason?: ReviewWaitReason;
  lastActivity?: number;
};

export type ReviewCommentData = {
  id: string;
  kind: "issue" | "review-inline" | "review-body";
  author: string;
  isBot: boolean;
  body: string;
  path?: string;
  line?: number;
  createdAt: number;
  inReplyTo?: string;
};

export type ReviewCommentState = "queued" | "delivered" | "own" | "history";

export type ReviewThreadComment = {
  comment: ReviewCommentData;
  state: ReviewCommentState;
  deliveredTo?: string;
  deliveredAt?: number;
};

export type ReviewThread = {
  key: PrKey;
  pr: ReviewPr;
  link: ReviewLink;
  waitReason?: ReviewWaitReason;
  comments: ReviewThreadComment[];
};

type Raw = Record<string, unknown>;

function record(value: unknown): Raw | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Raw)
    : undefined;
}

function str(value: unknown): value is string {
  return typeof value === "string";
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function time(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parsePr(value: unknown): ReviewPr | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const { repo, number, title, headRef, author, url, isDraft, role } = raw;
  if (!str(repo) || !count(number) || !str(title) || !str(headRef) || !str(author)) {
    return undefined;
  }
  if (!str(url) || typeof isDraft !== "boolean") return undefined;
  if (role !== "mine" && role !== "review-requested") return undefined;
  if (!isPrKey(`${repo}#${number}`)) return undefined;
  return { repo, number, title, headRef, author, url, isDraft, role };
}

function parseLink(value: unknown): ReviewLink | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  if (raw.kind === "none") return { kind: "none" };
  if (raw.kind === "linked") {
    if (!str(raw.paneKey) || (raw.how !== "manual" && raw.how !== "auto")) return undefined;
    return { kind: "linked", paneKey: raw.paneKey, how: raw.how };
  }
  if (raw.kind === "ambiguous") {
    if (!Array.isArray(raw.paneKeys) || !raw.paneKeys.every(str)) return undefined;
    return { kind: "ambiguous", paneKeys: [...raw.paneKeys] };
  }
  return undefined;
}

function parseWait(value: unknown): ReviewWaitReason | undefined {
  return typeof value === "string" && (WAIT_REASONS as readonly string[]).includes(value)
    ? (value as ReviewWaitReason)
    : undefined;
}

function parseItem(value: unknown): ReviewListItem | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const pr = parsePr(raw.pr);
  const link = parseLink(raw.link);
  if (pr === undefined || link === undefined) return undefined;
  if (!count(raw.queued) || !count(raw.delivered)) return undefined;
  const waitReason = parseWait(raw.waitReason);
  const lastActivity = time(raw.lastActivity) ? raw.lastActivity : undefined;
  return {
    key: `${pr.repo}#${pr.number}`,
    pr,
    link,
    queued: raw.queued,
    delivered: raw.delivered,
    ...(waitReason === undefined ? {} : { waitReason }),
    ...(lastActivity === undefined ? {} : { lastActivity }),
  };
}

/** `reviews:list`'s value; a malformed item is dropped. */
export function parseReviewList(value: unknown): ReviewListItem[] {
  if (!Array.isArray(value)) return [];
  const items: ReviewListItem[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (item !== undefined) items.push(item);
  }
  return items;
}

function parseComment(value: unknown): ReviewCommentData | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const { id, kind, author, isBot, body, path, line, createdAt, inReplyTo } = raw;
  if (!str(id) || !str(author) || typeof isBot !== "boolean" || !str(body)) return undefined;
  if (kind !== "issue" && kind !== "review-inline" && kind !== "review-body") return undefined;
  if (!time(createdAt)) return undefined;
  if (path !== undefined && !str(path)) return undefined;
  if (line !== undefined && !count(line)) return undefined;
  if (inReplyTo !== undefined && !str(inReplyTo)) return undefined;
  return {
    id,
    kind,
    author,
    isBot,
    body,
    createdAt,
    ...(path === undefined ? {} : { path }),
    ...(line === undefined ? {} : { line }),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
  };
}

function parseThreadComment(value: unknown): ReviewThreadComment | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const comment = parseComment(raw.comment);
  const state = raw.state;
  if (comment === undefined) return undefined;
  if (state !== "queued" && state !== "delivered" && state !== "own" && state !== "history") {
    return undefined;
  }
  const deliveredTo = str(raw.deliveredTo) ? raw.deliveredTo : undefined;
  const deliveredAt = time(raw.deliveredAt) ? raw.deliveredAt : undefined;
  return {
    comment,
    state,
    ...(deliveredTo === undefined ? {} : { deliveredTo }),
    ...(deliveredAt === undefined ? {} : { deliveredAt }),
  };
}

/** `reviews:thread`'s value; undefined when the PR or link is malformed. */
export function parseReviewThread(value: unknown): ReviewThread | undefined {
  const raw = record(value);
  if (raw === undefined) return undefined;
  const pr = parsePr(raw.pr);
  const link = parseLink(raw.link);
  if (pr === undefined || link === undefined) return undefined;
  const comments: ReviewThreadComment[] = [];
  if (Array.isArray(raw.comments)) {
    for (const entry of raw.comments) {
      const parsed = parseThreadComment(entry);
      if (parsed !== undefined) comments.push(parsed);
    }
  }
  const waitReason = parseWait(raw.waitReason);
  return {
    key: `${pr.repo}#${pr.number}`,
    pr,
    link,
    ...(waitReason === undefined ? {} : { waitReason }),
    comments,
  };
}

// ---- view models -----------------------------------------------------------

/** Nothing can receive the comments: no pane, several panes, or no agent. */
function blocked(reason: ReviewWaitReason | undefined): boolean {
  return reason === "no-link" || reason === "ambiguous" || reason === "no-agent";
}

export type ReviewCardChip =
  | { kind: "queued"; count: number }
  | { kind: "waiting"; count: number }
  | { kind: "delivered" }
  | { kind: "none" };

export type ReviewCardModel = {
  tone: "warning" | "danger" | "success" | "muted";
  linked: boolean;
  chip: ReviewCardChip;
  repoName: string;
  /** No pane will take the comments; the card says where to open one. */
  needsTerminal: boolean;
};

export function reviewCardModel(item: ReviewListItem): ReviewCardModel {
  const repoName = item.pr.repo.split("/").at(-1) ?? item.pr.repo;
  const linked = item.link.kind === "linked";
  const stuck = item.queued > 0 && (blocked(item.waitReason) || item.link.kind !== "linked");
  if (stuck) {
    return {
      tone: "danger",
      linked,
      chip: { kind: "waiting", count: item.queued },
      repoName,
      needsTerminal: item.link.kind !== "linked",
    };
  }
  if (item.queued > 0) {
    return {
      tone: "warning",
      linked,
      chip: { kind: "queued", count: item.queued },
      repoName,
      needsTerminal: false,
    };
  }
  if (item.delivered > 0) {
    return { tone: "success", linked, chip: { kind: "delivered" }, repoName, needsTerminal: false };
  }
  return { tone: "muted", linked, chip: { kind: "none" }, repoName, needsTerminal: false };
}

/** "now", "5m", "2h", "3d" — Latin digits in both languages, like format.ts. */
export function reviewAge(now: number, at: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Items that need the user first: stuck, then queued, then newest. */
export function sortReviewItems(items: readonly ReviewListItem[]): ReviewListItem[] {
  const rank = (item: ReviewListItem): number => {
    const tone = reviewCardModel(item).tone;
    return tone === "danger" ? 0 : tone === "warning" ? 1 : 2;
  };
  return [...items].sort(
    (a, b) => rank(a) - rank(b) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0),
  );
}

export type ReviewThreadEntry = ReviewThreadComment & {
  replies: ReviewThreadComment[];
  /** One of the replies is yours (sent from the phone or the session). */
  replied: boolean;
};

/** Top-level comments in order, each with its replies nested under it. */
export function reviewThreadEntries(thread: ReviewThread): ReviewThreadEntry[] {
  const ids = new Set(thread.comments.map((item) => item.comment.id));
  const entries: ReviewThreadEntry[] = [];
  const byId = new Map<string, ReviewThreadEntry>();
  const sorted = [...thread.comments].sort((a, b) => a.comment.createdAt - b.comment.createdAt);
  for (const item of sorted) {
    const parent = item.comment.inReplyTo;
    if (parent !== undefined && ids.has(parent)) continue;
    const entry = { ...item, replies: [], replied: false };
    entries.push(entry);
    byId.set(item.comment.id, entry);
  }
  for (const item of sorted) {
    const parent = item.comment.inReplyTo;
    if (parent === undefined || !ids.has(parent)) continue;
    const entry = byId.get(parent);
    if (entry === undefined) continue;
    entry.replies.push(item);
    if (item.state === "own") entry.replied = true;
  }
  return entries;
}

// ---- store -----------------------------------------------------------------

export type ReviewsErrorCode = "loadFailed" | "replyFailed" | "deliverFailed";
export type ReviewsError = { code: ReviewsErrorCode; detail?: string };

export type ReviewsState = {
  items?: ReviewListItem[];
  thread?: ReviewThread;
  error?: ReviewsError;
};

export type ReviewsStore = {
  state: ReviewsState;
  load(): Promise<void>;
  openThread(key: string): Promise<void>;
  reply(body: string, inReplyTo?: string): Promise<boolean>;
  deliverNow(): Promise<boolean>;
  clearError(): void;
  subscribe(cb: () => void): () => void;
};

export type ReviewsStoreDeps = {
  client: Pick<RpcClient, "call" | "onPush" | "subscribe" | "unsubscribe">;
};

function rpcError(result: RpcResult, code: ReviewsErrorCode): ReviewsError {
  if (!result.ok && result.error.kind === "remote") return { code, detail: result.error.text };
  return { code };
}

/** A mutate call succeeded unless the laptop answered `{ok: false, reason}`. */
function refusal(value: unknown): string | undefined {
  const raw = record(value);
  if (raw === undefined || raw.ok !== false) return undefined;
  return str(raw.reason) ? raw.reason : "refused";
}

export function createReviewsStore(deps: ReviewsStoreDeps): ReviewsStore {
  const state: ReviewsState = {};
  const listeners = new Set<() => void>();
  let stopPush: (() => void) | undefined;
  let threadKey: PrKey | undefined;
  let threadSequence = 0;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  async function load(): Promise<void> {
    const result = await deps.client.call("reviews:list", []);
    if (!result.ok) state.error = rpcError(result, "loadFailed");
    else {
      state.items = parseReviewList(result.value);
      if (state.error?.code === "loadFailed") state.error = undefined;
    }
    emit();
  }

  async function openThread(key: string): Promise<void> {
    if (!isPrKey(key)) {
      state.error = { code: "loadFailed" };
      emit();
      return;
    }
    if (threadKey !== key) state.thread = undefined;
    threadKey = key;
    const sequence = ++threadSequence;
    const result = await deps.client.call("reviews:thread", [key]);
    if (sequence !== threadSequence) return;
    const thread = result.ok ? parseReviewThread(result.value) : undefined;
    if (thread === undefined) state.error = rpcError(result, "loadFailed");
    else {
      state.thread = thread;
      if (state.error?.code === "loadFailed") state.error = undefined;
    }
    emit();
  }

  async function mutate(
    channel: string,
    args: unknown[],
    code: ReviewsErrorCode,
  ): Promise<boolean> {
    const result = await deps.client.call(channel, args);
    const refused = result.ok ? refusal(result.value) : undefined;
    if (!result.ok || refused !== undefined) {
      state.error = result.ok ? { code, detail: refused } : rpcError(result, code);
      emit();
      return false;
    }
    state.error = undefined;
    if (threadKey !== undefined) await openThread(threadKey);
    return true;
  }

  async function reply(body: string, inReplyTo?: string): Promise<boolean> {
    const text = body.trim();
    if (threadKey === undefined || text.length === 0) return false;
    const args = inReplyTo === undefined ? [threadKey, text] : [threadKey, text, inReplyTo];
    return mutate("reviews:reply", args, "replyFailed");
  }

  async function deliverNow(): Promise<boolean> {
    if (threadKey === undefined) return false;
    return mutate("reviews:deliverNow", [threadKey], "deliverFailed");
  }

  function clearError(): void {
    if (state.error === undefined) return;
    state.error = undefined;
    emit();
  }

  function subscribe(cb: () => void): () => void {
    listeners.add(cb);
    if (listeners.size === 1) {
      stopPush = deps.client.onPush("reviews:changed", (payload) => {
        void load();
        if (threadKey !== undefined && (payload === null || payload === threadKey)) {
          void openThread(threadKey);
        }
      });
      deps.client.subscribe("reviews:changed");
    }
    return () => {
      listeners.delete(cb);
      if (listeners.size === 0) {
        stopPush?.();
        stopPush = undefined;
        deps.client.unsubscribe("reviews:changed");
      }
    };
  }

  return { state, load, openThread, reply, deliverNow, clearError, subscribe };
}
