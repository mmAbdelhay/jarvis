export type PrKey = string;

export function prKey(repo: string, number: number): PrKey {
  return `${repo}#${number}`;
}

export type PullRequest = {
  repo: string;
  number: number;
  title: string;
  headRef: string;
  author: string;
  url: string;
  isDraft: boolean;
  role: "mine" | "review-requested";
};

export type ReviewComment = {
  id: string;
  kind: "issue" | "review-inline" | "review-body";
  author: string;
  isBot: boolean;
  body: string;
  path?: string;
  line?: number;
  diffHunk?: string;
  createdAt: number;
  inReplyTo?: string;
};

export type QueuedComment = {
  prKey: PrKey;
  comment: ReviewComment;
  state: "queued" | "delivered" | "own" | "history";
  deliveredTo?: string;
  deliveredAt?: number;
};

export type ReviewsConfig = {
  enabled: boolean;
  intervalSeconds: number;
  repos: Record<string, boolean>;
  authors: string[];
  requireText: string;
  ignoreBots: boolean;
  autoLink: boolean;
  batchSeconds: number;
  notify: { comment: boolean; queued: boolean; requested: boolean };
};

export const DEFAULT_REVIEWS_CONFIG: ReviewsConfig = {
  enabled: true,
  intervalSeconds: 60,
  repos: {},
  authors: [],
  requireText: "",
  ignoreBots: true,
  autoLink: true,
  batchSeconds: 30,
  notify: { comment: true, queued: true, requested: true },
};

export const REVIEW_MARKER = "<!-- jarvis:auto -->";

export type ReviewsGh = {
  status(): Promise<{ kind: "ok"; login: string } | { kind: "no-gh" } | { kind: "logged-out" }>;
  repoOf(cwd: string): Promise<string | undefined>;
  listPrs(repo: string, login: string): Promise<PullRequest[]>;
  listComments(
    pr: PullRequest,
    cursor: { etag?: string; since?: number },
  ): Promise<
    | { kind: "unchanged" }
    | { kind: "ok"; comments: ReviewComment[]; etag?: string; remainingRatio?: number }
    | { kind: "rate-limited"; retryAt: number }
  >;
  postComment(pr: PullRequest, body: string): Promise<ReviewComment>;
  replyToReviewComment(pr: PullRequest, commentId: string, body: string): Promise<ReviewComment>;
};

/** File-backed operations resolve after the serialized read or write completes. */
export type ReviewsStore = {
  cursor(prKey: PrKey): Promise<{ etag?: string; since: number } | undefined>;
  setCursor(prKey: PrKey, cursor: { etag?: string; since: number }): Promise<void>;
  isFirstRun(repo: string): Promise<boolean>;
  markSeeded(repo: string, at: number): Promise<void>;
  upsertComments(
    prKey: PrKey,
    comments: ReviewComment[],
    state: "queued" | "history",
  ): Promise<void>;
  /** IDs use the store's composite key: PR key + comment kind + GitHub id. */
  markDelivered(ids: readonly string[], paneKey: string, at: number): Promise<void>;
  markOwn(prKey: PrKey, comment: ReviewComment): Promise<void>;
  listQueued(prKey?: PrKey): Promise<QueuedComment[]>;
  thread(prKey: PrKey): Promise<QueuedComment[]>;
  manualLinks(): Promise<Map<PrKey, string | null>>;
  setManualLink(prKey: PrKey, paneKey: string | null): Promise<void>;
  paused(): Promise<Set<string>>;
  setPaused(paneKey: string, paused: boolean): Promise<void>;
  wasNotified(key: string): Promise<boolean>;
  markNotified(key: string): Promise<void>;
};
